import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  delay,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, ".wa-session");
const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const ADS_FILE = path.join(DATA_DIR, "ads.json");
const PORT = process.env.PORT || 3010;
const API_SECRET = process.env.WA_API_SECRET || "cledson2026";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const logger = pino({ level: "silent" });

// ─── Persistência de Configuração e Anúncios Múltiplos ───
const defaultConfig = {
  selectedGroups: [],
  hiddenGroups: [],
  minDelaySec: 15,
  maxDelaySec: 30,
  shuffleGroups: true,
  simulateTyping: true,
  rotationMode: "round_robin", // "round_robin" (alterna 1, 2, 3...) ou "random" (sorteia)
  history: [],
};

const defaultAds = [
  {
    id: "ad_1",
    name: "Anúncio 1 - iPhone 17E",
    enabled: true,
    caption: `📱 iPhone 17E 256GB

Valor: R$ 4.250,00

 • Novo, lacrado
 • Garantia de 1 ano Apple
 • À pronta entrega
 • Emitimos nota fiscal
 • Parcelamos em até 18x no cartão

📍 Loja física

Aceitamos seu iPhone usado como parte do pagamento mediante avaliação.`,
    imageBase64: null,
  },
  {
    id: "ad_2",
    name: "Anúncio 2",
    enabled: true,
    caption: "",
    imageBase64: null,
  },
  {
    id: "ad_3",
    name: "Anúncio 3",
    enabled: true,
    caption: "",
    imageBase64: null,
  },
];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      const cfg = { ...defaultConfig, ...parsed };
      if (!Array.isArray(cfg.hiddenGroups)) cfg.hiddenGroups = [];
      if (!Array.isArray(cfg.selectedGroups)) cfg.selectedGroups = [];
      const hiddenSet = new Set(cfg.hiddenGroups);
      cfg.selectedGroups = cfg.selectedGroups.filter((id) => !hiddenSet.has(id));
      return cfg;
    }
  } catch (e) {
    console.error("Erro ao carregar config.json:", e);
  }
  return { ...defaultConfig };
}

function loadAds() {
  try {
    if (fs.existsSync(ADS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ADS_FILE, "utf-8"));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.error("Erro ao carregar ads.json:", e);
  }
  return JSON.parse(JSON.stringify(defaultAds));
}

let appConfig = loadConfig();
let appAds = loadAds();

function safeWriteJson(filePath, data) {
  try {
    const tempPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(tempPath, jsonStr, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    console.error(`Erro ao salvar ${filePath} de forma atômica:`, e);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (fallbackErr) {
      console.error(`Falha no fallback de escrita de ${filePath}:`, fallbackErr);
    }
  }
}

function saveConfig() {
  safeWriteJson(CONFIG_FILE, appConfig);
}

function saveAds() {
  safeWriteJson(ADS_FILE, appAds);
}

// ─── Cache em Memória de Mensagens ───
const messageStore = new Map();

function saveMessageToStore(msg) {
  if (!msg || !msg.key || !msg.key.id) return;
  const key = `${msg.key.remoteJid}:${msg.key.id}`;
  messageStore.set(key, msg.message);
  messageStore.set(msg.key.id, msg.message);
  if (messageStore.size > 2000) {
    const firstKey = messageStore.keys().next().value;
    if (firstKey) messageStore.delete(firstKey);
  }
}

class SimpleNodeCache {
  constructor() {
    this.map = new Map();
  }
  get(k) { return this.map.get(k); }
  set(k, v) {
    this.map.set(k, v);
    if (this.map.size > 5000) {
      const firstKey = this.map.keys().next().value;
      if (firstKey) this.map.delete(firstKey);
    }
    return true;
  }
  del(k) { this.map.delete(k); return 1; }
  flushAll() { this.map.clear(); }
}

const msgRetryCounterCache = new SimpleNodeCache();

// ─── Estado Global WhatsApp & Grupos ─────────────────────────────────────────
let waSocket = null;
let waStatus = "DISCONNECTED";
let waQrCode = null;
let waQrRaw = null;
let waUser = null;
let waName = null;
let waInitPromise = null;
let reconnectTimer = null;
let cachedGroups = [];

// ─── Estado do Disparador Anti-Ban (Fila Humana com Rotação) ────────────────
let campaignState = {
  isRunning: false,
  isPaused: false,
  shouldStop: false,
  id: null,
  startedAt: null,
  finishedAt: null,
  totalGroups: 0,
  sentCount: 0,
  failedCount: 0,
  currentGroupName: null,
  currentAdName: null,
  nextActionInSec: 0,
  statusText: "Pronto para disparar",
  logs: [],
};

function addCampaignLog(groupName, status, detail) {
  const time = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" });
  campaignState.logs.unshift({ time, groupName, status, detail });
  if (campaignState.logs.length > 150) campaignState.logs.pop();
}

// Micro-variação invisível anti-ban no texto (zero-width + espaços aleatórios sutis)
function humanizeText(baseText, index) {
  if (!baseText) return "";
  const zwChars = ["\u200B", "\u200C", "\u200D", "\uFEFF"];
  const seed = Date.now() + index * 17;
  const zw1 = zwChars[seed % zwChars.length];
  const zw2 = zwChars[(seed >> 2) % zwChars.length];
  const zw3 = zwChars[(seed >> 4) % zwChars.length];

  const lines = baseText.split("\n");
  if (lines.length > 1) {
    lines[0] = lines[0] + zw1;
    lines[lines.length - 1] = lines[lines.length - 1] + zw2 + zw3;
    return lines.join("\n");
  }
  return baseText + zw1 + zw2;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomInt(min, max) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

// Converte dataURL/base64 em Buffer de forma segura e validada
function parseImageData(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  if (dataUrl.startsWith("/") || dataUrl.startsWith("http")) return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) {
    try {
      const buf = Buffer.from(match[2], "base64");
      return buf.length > 0 ? { mime: match[1], buffer: buf } : null;
    } catch (e) {
      return null;
    }
  }
  try {
    const buf = Buffer.from(dataUrl, "base64");
    return buf.length > 64 ? { mime: "image/jpeg", buffer: buf } : null;
  } catch (e) {
    return null;
  }
}

// Converte objeto de grupo do Baileys para o formato padrão do sistema (com filtros anti-fantasma rigorosos)
function formatGroupObject(g) {
  if (!g || !g.id || !g.id.endsWith("@g.us")) return null;

  const subject = (g.subject || "").trim();
  // Regra 1: Nome obrigatório e não pode ser genérico "Grupo sem nome"
  if (!subject || subject.toLowerCase() === "grupo sem nome") return null;

  const parts = Array.isArray(g.participants) ? g.participants : [];
  const size = parts.length || g.size || 0;
  // Regra 2: Deve ter pelo menos 2 membros reais (evita subgrupos vazios/fantasmas de comunidade)
  if (size < 2) return null;

  let ddd11Count = 0;
  let knownPhoneCount = 0;
  for (const p of parts) {
    const jidStr = p.phoneNumber || p.jid || p.id || "";
    const num = jidStr.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (num.startsWith("55") && num.length >= 12) {
      knownPhoneCount++;
      if (num.slice(2, 4) === "11") ddd11Count++;
    }
  }
  const ddd11Pct = knownPhoneCount > 0 ? Math.round((ddd11Count / knownPhoneCount) * 100) : null;

  return {
    id: g.id,
    subject,
    size,
    ddd11Count,
    knownPhoneCount,
    ddd11Pct,
    announce: !!g.announce,
    restrict: !!g.restrict,
  };
}

// Cache persistente de metadados de grupos para nunca perder nomes resolvidos
const GROUP_META_CACHE_FILE = path.join(DATA_DIR, "group_meta_cache.json");
let groupMetaCache = {};
try {
  if (fs.existsSync(GROUP_META_CACHE_FILE)) {
    groupMetaCache = JSON.parse(fs.readFileSync(GROUP_META_CACHE_FILE, "utf-8"));
  }
} catch (e) {
  groupMetaCache = {};
}

function saveGroupMetaCache() {
  safeWriteJson(GROUP_META_CACHE_FILE, groupMetaCache);
}

let isResolvingMeta = false;

// Resolver metadados dos grupos que o WhatsApp não entregou o nome de primeira (com proteção contra rate-limit)
async function resolveMissingGroupMetadata(groupsList) {
  if (isResolvingMeta || !waSocket || waStatus !== "CONNECTED") return;
  isResolvingMeta = true;

  try {
    const missing = groupsList.filter((g) => !g.subject && g.id);
    if (missing.length === 0) return;

    // Limita a no máximo 25 grupos por ciclo para prevenir bloqueio por requisições em massa
    const toResolve = missing.slice(0, 25);
    console.log(`🔍 [METADATA] Resolvendo nomes de ${toResolve.length} grupos em segundo plano...`);
    let updatedCount = 0;

    for (const item of toResolve) {
      if (groupMetaCache[item.id]?.subject) {
        item.subject = groupMetaCache[item.id].subject;
        item.size = groupMetaCache[item.id].size || item.size;
        updatedCount++;
        continue;
      }

      try {
        const meta = await waSocket.groupMetadata(item.id);
        if (meta && meta.subject) {
          item.subject = meta.subject.trim();
          item.size = meta.size || (Array.isArray(meta.participants) ? meta.participants.length : item.size);
          item.announce = !!meta.announce;
          item.restrict = !!meta.restrict;

          groupMetaCache[item.id] = {
            subject: item.subject,
            size: item.size,
            announce: item.announce,
          };
          updatedCount++;
        }
        await delay(400);
      } catch (err) {
        if (err?.data === 429 || err?.status === 429) {
          console.warn("⚠️ [METADATA] Rate limit temporário do WhatsApp atingido, pausando resolução.");
          break;
        }
      }
    }

    if (updatedCount > 0) {
      saveGroupMetaCache();
      console.log(`✅ [METADATA] ${updatedCount} nomes de grupos resolvidos com sucesso!`);
    }
  } catch (e) {
    console.error("Erro ao resolver metadados:", e);
  } finally {
    isResolvingMeta = false;
  }
}

// Buscar todos os grupos em que o número conectado participa (100% dos grupos resolvidos)
async function refreshGroups() {
  if (!waSocket || waStatus !== "CONNECTED") return cachedGroups;
  try {
    const all = await waSocket.groupFetchAllParticipating();
    const map = new Map();
    const rawList = Object.values(all || {});

    // 1. Aplica cache salvo de nomes para grupos que vieram sem subject
    for (const g of rawList) {
      if (!g.subject && groupMetaCache[g.id]?.subject) {
        g.subject = groupMetaCache[g.id].subject;
        g.size = groupMetaCache[g.id].size || g.size;
        g.announce = groupMetaCache[g.id].announce ?? g.announce;
      }
      const formatted = formatGroupObject(g);
      if (formatted) map.set(formatted.id, formatted);
    }

    const list = Array.from(map.values());
    list.sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"));
    cachedGroups = list;

    // 2. Dispara resolução em background dos que ainda faltam nome
    const stillMissing = rawList.filter((g) => !g.subject);
    if (stillMissing.length > 0) {
      resolveMissingGroupMetadata(stillMissing).then(() => {
        for (const g of stillMissing) {
          if (g.subject) {
            const fmt = formatGroupObject(g);
            if (fmt) map.set(fmt.id, fmt);
          }
        }
        cachedGroups = Array.from(map.values());
        cachedGroups.sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"));
      });
    }

    return cachedGroups;
  } catch (err) {
    console.error("Erro ao buscar grupos:", err.message);
    return cachedGroups;
  }
}

// ─── Fila Persistente do Disparo (sobrevive a quedas e reinícios do servidor) ─
const CAMPAIGN_QUEUE_FILE = path.join(DATA_DIR, "campaign_queue.json");
let campaignQueue = null; // { id, orderedIds, nextIndex, adIndex, sentCount, failedCount, startedAt, source, logs }

function saveCampaignQueue() {
  if (!campaignQueue) return;
  campaignQueue.sentCount = campaignState.sentCount;
  campaignQueue.failedCount = campaignState.failedCount;
  campaignQueue.logs = (campaignState.logs || []).slice(0, 60);
  campaignQueue.isPaused = !!campaignState.isPaused;
  safeWriteJson(CAMPAIGN_QUEUE_FILE, campaignQueue);
}

function clearCampaignQueue() {
  campaignQueue = null;
  try { fs.rmSync(CAMPAIGN_QUEUE_FILE, { force: true }); } catch (e) {}
}

function loadPendingCampaignQueue() {
  try {
    if (!fs.existsSync(CAMPAIGN_QUEUE_FILE)) return null;
    const q = JSON.parse(fs.readFileSync(CAMPAIGN_QUEUE_FILE, "utf-8"));
    if (q && Array.isArray(q.orderedIds) && q.nextIndex < q.orderedIds.length) return q;
  } catch (e) {
    console.error("Erro ao ler fila de disparo pendente:", e.message);
  }
  return null;
}

// Aguarda o WhatsApp voltar a ficar conectado (até maxWaitSec). Retorna true se conectou.
async function waitForConnection(maxWaitSec = 600, label = "") {
  let waited = 0;
  while ((!waSocket || waStatus !== "CONNECTED") && waited < maxWaitSec) {
    if (campaignState.shouldStop) return false;
    campaignState.statusText = `⏳ WhatsApp reconectando... o disparo continua automaticamente (${waited}s)${label}`;
    await delay(1000);
    waited++;
  }
  if (waSocket && waStatus === "CONNECTED" && waited > 0) {
    await delay(3000); // dá um respiro para a sessão estabilizar
  }
  return !!(waSocket && waStatus === "CONNECTED");
}

function isConnectionError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    !waSocket ||
    waStatus !== "CONNECTED" ||
    msg.includes("connection closed") ||
    msg.includes("connection lost") ||
    msg.includes("timed out") ||
    msg.includes("precondition") ||
    msg.includes("internal-server-error") ||
    msg.includes("socket") ||
    msg.includes("stream")
  );
}

let resumeInProgress = false;

// Ao iniciar o servidor, recupera um disparo que estava em andamento
{
  const pending = loadPendingCampaignQueue();
  if (pending) {
    campaignQueue = pending;
    campaignState.totalGroups = pending.orderedIds.length;
    campaignState.sentCount = Number(pending.sentCount) || 0;
    campaignState.failedCount = Number(pending.failedCount) || 0;
    campaignState.logs = Array.isArray(pending.logs) ? pending.logs : [];
    campaignState.statusText = `🔁 Disparo interrompido em ${campaignState.sentCount}/${campaignState.totalGroups}. Retomando automaticamente assim que o WhatsApp conectar...`;
    console.log(`📦 [DISPARO] Fila pendente encontrada (${pending.nextIndex}/${pending.orderedIds.length}). Será retomada ao conectar.`);
  }
}
async function tryResumePendingCampaign() {
  if (resumeInProgress || campaignState.isRunning) return;
  const q = loadPendingCampaignQueue();
  if (!q) return;
  resumeInProgress = true;
  try {
    console.log(`🔁 [DISPARO] Retomando disparo pendente ${q.id} a partir do grupo ${q.nextIndex + 1}/${q.orderedIds.length}...`);
    await startHumanBroadcast({ targetGroupIds: q.orderedIds, source: q.source || "Painel Web", resume: q });
  } catch (e) {
    console.error("❌ Não foi possível retomar o disparo pendente:", e.message);
  } finally {
    resumeInProgress = false;
  }
}

// Ao receber sinal de parada (pm2 restart/stop), salva a fila antes de sair
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try { saveCampaignQueue(); } catch (e) {}
    process.exit(0);
  });
}
process.on("unhandledRejection", (r) => console.error("⚠️ unhandledRejection:", r?.message || r));
process.on("uncaughtException", (e) => {
  console.error("⚠️ uncaughtException:", e?.message || e);
  try { saveCampaignQueue(); } catch (_) {}
});

// ─── Motor de Disparo Humano Anti-Ban com Mesclagem de Anúncios ─────────────
async function startHumanBroadcast({ targetGroupIds, source = "Painel Web", resume = null }) {
  if (campaignState.isRunning) {
    throw new Error("Já existe um disparo em andamento. Aguarde terminar ou pause o atual.");
  }
  if (!waSocket || waStatus !== "CONNECTED") {
    throw new Error("WhatsApp não está conectado no momento.");
  }
  // Um novo disparo manual substitui qualquer fila pendente antiga
  if (!resume) clearCampaignQueue();

  // BLINDAGEM MÁXIMA: Garante que grupos ocultos NUNCA recebam mensagens e remove duplicados
  const hiddenSet = new Set(appConfig.hiddenGroups || []);
  const uniqueTargetIds = Array.from(new Set(targetGroupIds || []));
  const safeTargetGroupIds = uniqueTargetIds.filter((id) => id && !hiddenSet.has(id));

  if (!safeTargetGroupIds || safeTargetGroupIds.length === 0) {
    throw new Error("Selecione pelo menos 1 grupo ativo para disparar (grupos ocultos nunca recebem anúncios).");
  }

  // Filtra apenas anúncios ativos que tenham texto ou foto
  const activeAds = (appAds || []).filter(
    (ad) => ad && ad.enabled && (ad.caption?.trim() || ad.imageBase64)
  );

  if (activeAds.length === 0) {
    throw new Error("Cadastre e ative pelo menos 1 anúncio com foto ou descrição para disparar.");
  }

  if (cachedGroups.length === 0) {
    await refreshGroups().catch(() => {});
  }
  const groupMap = new Map(cachedGroups.map((g) => [g.id, g.subject]));

  const orderedIds = resume
    ? [...resume.orderedIds]
    : (appConfig.shuffleGroups ? shuffleArray(safeTargetGroupIds) : [...safeTargetGroupIds]);
  const startIndex = resume ? Math.max(0, Number(resume.nextIndex) || 0) : 0;

  const ignoredHiddenCount = resume ? 0 : (targetGroupIds || []).length - safeTargetGroupIds.length;
  campaignState = {
    isRunning: true,
    isPaused: resume ? !!resume.isPaused : false,
    shouldStop: false,
    id: resume ? resume.id : "camp_" + Date.now(),
    startedAt: resume ? resume.startedAt : new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    finishedAt: null,
    totalGroups: orderedIds.length,
    sentCount: resume ? Number(resume.sentCount) || 0 : 0,
    failedCount: resume ? Number(resume.failedCount) || 0 : 0,
    currentGroupName: null,
    currentAdName: null,
    nextActionInSec: 0,
    statusText: resume
      ? `Retomando disparo do grupo ${startIndex + 1}/${orderedIds.length}...`
      : `Iniciando disparo mesclado entre ${activeAds.length} anúncios...`,
    logs: resume && Array.isArray(resume.logs) ? resume.logs : [],
  };

  campaignQueue = {
    id: campaignState.id,
    orderedIds,
    nextIndex: startIndex,
    adIndex: resume ? Number(resume.adIndex) || 0 : 0,
    startedAt: campaignState.startedAt,
    source,
  };
  saveCampaignQueue();

  if (resume) {
    addCampaignLog(
      "Sistema",
      "INFO",
      `🔁 Disparo retomado automaticamente a partir do grupo ${startIndex + 1}/${orderedIds.length} (nada foi perdido).`
    );
  } else {
    addCampaignLog(
      "Sistema",
      "INFO",
      `Disparo iniciado (${orderedIds.length} grupos)` +
        (ignoredHiddenCount > 0 ? ` [${ignoredHiddenCount} ocultos protegidos]` : "") +
        ` • Mesclando ${activeAds.length} anúncio(s) [${activeAds.map((a) => a.name).join(", ")}]`
    );
  }

  // Executa em segundo plano
  (async () => {
    let adIndex = campaignQueue.adIndex || 0;
    let abortedForConnection = false;
    try {
      for (let i = startIndex; i < orderedIds.length; i++) {
        if (campaignState.shouldStop) {
          campaignState.statusText = "Disparo interrompido manualmente pelo usuário.";
          addCampaignLog("Sistema", "WARN", "Disparo cancelado manualmente.");
          break;
        }

        // Aguarda enquanto estiver pausado
        while (campaignState.isPaused && !campaignState.shouldStop) {
          campaignState.statusText = `Disparo pausado temporariamente (${campaignState.sentCount}/${orderedIds.length} enviados)...`;
          await delay(1000);
        }
        if (campaignState.shouldStop) break;

        const jid = orderedIds[i];
        const groupName = groupMap.get(jid) || jid;
        campaignState.currentGroupName = groupName;

        // Segurança: se o grupo foi ocultado depois do início, nunca envia
        if ((appConfig.hiddenGroups || []).includes(jid)) {
          campaignQueue.nextIndex = i + 1;
          saveCampaignQueue();
          continue;
        }

        // Escolhe o anúncio da rodada (Round-Robin ou Random)
        let chosenAd;
        if (appConfig.rotationMode === "random") {
          chosenAd = activeAds[Math.floor(Math.random() * activeAds.length)];
        } else {
          chosenAd = activeAds[adIndex % activeAds.length];
          adIndex++;
        }
        if (!chosenAd) chosenAd = activeAds[0];
        if (!chosenAd) {
          throw new Error("Nenhum anúncio ativo encontrado para este disparo.");
        }
        campaignState.currentAdName = chosenAd.name || "Anúncio";

        // Se o WhatsApp caiu, espera reconectar em vez de perder o grupo
        if (!(await waitForConnection(900, ` • próximo: "${groupName}"`))) {
          if (campaignState.shouldStop) break;
          abortedForConnection = true;
          addCampaignLog("Sistema", "WARN", `WhatsApp ficou desconectado por muito tempo. Disparo salvo no grupo ${i + 1}/${orderedIds.length} e será retomado ao reconectar.`);
          break;
        }

        // Até 3 tentativas por grupo quando o erro for de conexão
        let delivered = false;
        let lastErr = null;
        for (let attempt = 1; attempt <= 3 && !delivered && !campaignState.shouldStop; attempt++) {
          try {
            // 1. Simular digitação humana
            if (appConfig.simulateTyping && attempt === 1) {
              const typingSec = randomInt(3, 6);
              campaignState.statusText = `Digitando no grupo "${groupName}" (${i + 1}/${orderedIds.length}) usando [${chosenAd.name}]...`;
              try {
                await waSocket.sendPresenceUpdate("composing", jid);
              } catch (e) {}

              for (let s = typingSec; s > 0; s--) {
                if (campaignState.shouldStop) break;
                campaignState.nextActionInSec = s;
                await delay(1000);
              }

              try {
                await waSocket?.sendPresenceUpdate("paused", jid);
              } catch (e) {}
            }

            if (campaignState.shouldStop) break;

            // 2. Humanizar texto com assinatura invisível única
            const finalCaption = humanizeText(chosenAd.caption || "", i);
            const imgParsed = parseImageData(chosenAd.imageBase64);

            // Validação anti-envio vazio: se não há texto nem imagem, não envia bolha vazia
            if (!finalCaption && (!imgParsed || !imgParsed.buffer)) {
              console.warn(`⚠️ Anúncio "${chosenAd.name}" sem conteúdo válido. Pulando envio.`);
              lastErr = new Error(`Anúncio [${chosenAd.name}] sem texto nem imagem válidos.`);
              break;
            }

            if (!waSocket || waStatus !== "CONNECTED") {
              throw new Error("Connection Closed");
            }

            // 3. Enviar imagem ou texto
            campaignState.statusText = `Enviando para "${groupName}" (${i + 1}/${orderedIds.length}) • ${chosenAd.name}${attempt > 1 ? ` (tentativa ${attempt})` : ""}...`;
            let sentMsg;
            if (imgParsed && imgParsed.buffer) {
              sentMsg = await waSocket.sendMessage(jid, {
                image: imgParsed.buffer,
                mimetype: imgParsed.mime || "image/jpeg",
                caption: finalCaption,
              });
            } else {
              sentMsg = await waSocket.sendMessage(jid, {
                text: finalCaption,
              });
            }
            saveMessageToStore(sentMsg);
            delivered = true;
          } catch (sendErr) {
            lastErr = sendErr;
            if (attempt < 3 && isConnectionError(sendErr)) {
              console.warn(`⚠️ [DISPARO] Falha de conexão em "${groupName}" (tentativa ${attempt}). Aguardando reconectar...`);
              await delay(3000);
              const ok = await waitForConnection(900, ` • reenviando "${groupName}"`);
              if (!ok) break;
            } else {
              break;
            }
          }
        }

        if (delivered) {
          campaignState.sentCount++;
          addCampaignLog(
            groupName,
            "SUCCESS",
            `Enviado [${chosenAd.name}] (${campaignState.sentCount}/${orderedIds.length})`
          );
          console.log(`✅ [DISPARO ${campaignState.sentCount}/${orderedIds.length}] Enviado para ${groupName} com ${chosenAd.name}`);
        } else if (!campaignState.shouldStop) {
          if (lastErr && isConnectionError(lastErr) && (!waSocket || waStatus !== "CONNECTED")) {
            // Não conta como falha: mantém o grupo na fila para retomar depois
            abortedForConnection = true;
            addCampaignLog("Sistema", "WARN", `Conexão perdida. Disparo salvo no grupo ${i + 1}/${orderedIds.length} e será retomado ao reconectar.`);
            break;
          }
          campaignState.failedCount++;
          addCampaignLog(groupName, "ERROR", `Falha: ${lastErr?.message || "erro desconhecido"}`);
          console.error(`❌ [ERRO DISPARO] ${groupName}:`, lastErr?.message);
        }

        if (campaignState.shouldStop && !delivered) break;

        // Salva o progresso após cada grupo (sobrevive a reinícios)
        campaignQueue.nextIndex = i + 1;
        campaignQueue.adIndex = adIndex;
        saveCampaignQueue();

        // 4. Intervalo aleatório anti-ban entre grupos (com limites seguros)
        if (i < orderedIds.length - 1 && !campaignState.shouldStop) {
          const minDelay = Math.max(5, Number(appConfig.minDelaySec) || 15);
          const maxDelay = Math.max(minDelay, Number(appConfig.maxDelaySec) || 30);
          const waitSec = randomInt(minDelay, maxDelay);
          const nextName = groupMap.get(orderedIds[i + 1]) || orderedIds[i + 1];

          for (let remaining = waitSec; remaining > 0; remaining--) {
            if (campaignState.shouldStop) break;

            while (campaignState.isPaused && !campaignState.shouldStop) {
              campaignState.statusText = `Disparo pausado temporariamente (${campaignState.sentCount}/${orderedIds.length} enviados)...`;
              await delay(1000);
            }
            if (campaignState.shouldStop) break;

            campaignState.nextActionInSec = remaining;
            campaignState.statusText = `Intervalo humano anti-ban (${remaining}s) antes do próximo envio ("${nextName}")...`;
            await delay(1000);
          }
        }
      }
    } catch (loopErr) {
      console.error("❌ [DISPARO] Erro inesperado no loop:", loopErr?.message || loopErr);
      addCampaignLog("Sistema", "ERROR", `Erro inesperado: ${loopErr?.message || loopErr}. Progresso salvo.`);
      abortedForConnection = true;
    } finally {
      campaignState.isRunning = false;
      campaignState.nextActionInSec = 0;
      campaignState.currentGroupName = null;
      campaignState.currentAdName = null;

      if (abortedForConnection && !campaignState.shouldStop) {
        // Mantém a fila salva para retomar automaticamente quando reconectar
        saveCampaignQueue();
        campaignState.statusText = `⏸️ Disparo salvo em ${campaignState.sentCount}/${orderedIds.length}. Será retomado automaticamente ao reconectar.`;
        return;
      }
      campaignState.isPaused = false;
      clearCampaignQueue();
      campaignState.finishedAt = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

      if (!campaignState.shouldStop) {
        campaignState.statusText = `Concluído! ${campaignState.sentCount} enviados com sucesso, ${campaignState.failedCount} falhas.`;
        addCampaignLog(
          "Sistema",
          "DONE",
          `Finalizado: ${campaignState.sentCount} enviados, ${campaignState.failedCount} falhas.`
        );
      }

      appConfig.history.unshift({
        id: campaignState.id,
        startedAt: campaignState.startedAt,
        finishedAt: campaignState.finishedAt,
        totalGroups: campaignState.totalGroups,
        sentCount: campaignState.sentCount,
        failedCount: campaignState.failedCount,
        adsUsed: activeAds.map((a) => a.name),
        source,
      });
      if (appConfig.history.length > 30) appConfig.history.pop();
      saveConfig();
    }
  })();

  return campaignState;
}

// ─── Init WhatsApp ───────────────────────────────────────────────────────────
async function initWhatsApp(forceReset = false) {
  if (forceReset) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (waSocket) {
      try { waSocket.end(undefined); } catch (e) {}
    }
    waSocket = null;
    waInitPromise = null;
    waStatus = "DISCONNECTED";
    waQrCode = null;
    waQrRaw = null;
    waUser = null;
    waName = null;
    try {
      if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch (e) {}
  }

  if (waSocket && waStatus === "CONNECTED") return waSocket;
  if (waInitPromise) return waInitPromise;

  waInitPromise = (async () => {
    try {
      if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

      waStatus = "CONNECTING";
      console.log("🔄 [WHATSAPP CLEDSON] Conectando ao WhatsApp...");

      const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
      let version = [2, 3000, 1043857760];
      try {
        const v = await fetchLatestBaileysVersion();
        if (v?.version) version = v.version;
      } catch (e) {}

      const sock = makeWASocket({
        version,
        logger,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache,
        browser: ["WhatsApp Cledson", "Chrome", "124.0.0.0"],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
          if (!key) return undefined;
          const fullKey = `${key.remoteJid}:${key.id}`;
          return messageStore.get(fullKey) || messageStore.get(key.id) || undefined;
        },
      });

      waSocket = sock;
      sock.ev.on("creds.update", saveCreds);

      // ─── Detecção Automática e Instantânea de Novos Grupos (100% sem fantasmas) ───
      // 1. Quando você entra em um grupo ou alguém te adiciona
      sock.ev.on("group-participants.update", async (event) => {
        try {
          const { id, action, participants } = event;
          const myJid = waSocket?.user?.id?.split(":")[0];
          const addedMe = Array.isArray(participants) && participants.some((p) => p.includes(myJid));
          if (action === "add" && (addedMe || !cachedGroups.some((g) => g.id === id))) {
            console.log(`🔔 [AUTO-SYNC] Novo grupo detectado via evento de participantes: ${id}`);
            await delay(1500); // aguarda Baileys atualizar metadados
            try {
              const meta = await waSocket.groupMetadata(id);
              const formatted = formatGroupObject(meta);
              if (formatted) {
                cachedGroups = cachedGroups.filter((g) => g.id !== formatted.id);
                cachedGroups.push(formatted);
                cachedGroups.sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"));
                console.log(`✅ [AUTO-SYNC] Grupo adicionado automaticamente ao sistema: "${formatted.subject}" (${formatted.size} membros)`);
              }
            } catch (metaErr) {
              await refreshGroups().catch(() => {});
            }
          }
        } catch (e) {
          console.error("Erro no listener group-participants.update:", e);
        }
      });

      // 2. Quando um novo chat aparece ou é criado
      sock.ev.on("chats.upsert", async (newChats) => {
        try {
          if (!Array.isArray(newChats)) return;
          for (const chat of newChats) {
            const jid = chat.id;
            if (!jid) continue;
            if (jid.endsWith("@g.us") && !cachedGroups.some((g) => g.id === jid)) {
              console.log(`🔔 [AUTO-SYNC] Novo chat de grupo detectado: ${jid}`);
              await delay(1200);
              try {
                const meta = await waSocket.groupMetadata(jid);
                const formatted = formatGroupObject(meta);
                if (formatted) {
                  cachedGroups = cachedGroups.filter((g) => g.id !== formatted.id);
                  cachedGroups.push(formatted);
                  cachedGroups.sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"));
                  console.log(`✅ [AUTO-SYNC] Grupo sincronizado automaticamente: "${formatted.subject}"`);
                }
              } catch (metaErr) {
                await refreshGroups().catch(() => {});
              }
            }
          }
        } catch (e) {
          console.error("Erro no listener chats.upsert:", e);
        }
      });

      // 3. Atualização de assunto/nome do grupo
      sock.ev.on("groups.update", async (updates) => {
        try {
          if (!Array.isArray(updates)) return;
          for (const u of updates) {
            if (u.id && u.subject) {
              const existing = cachedGroups.find((g) => g.id === u.id);
              if (existing) {
                existing.subject = u.subject.trim();
                cachedGroups.sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"));
              }
            }
          }
        } catch (e) {}
      });

      // Comandos pelo próprio celular
      sock.ev.on("messages.upsert", async ({ messages }) => {
        if (!Array.isArray(messages)) return;
        for (const m of messages) {
          saveMessageToStore(m);
          if (!m.key?.fromMe || !m.message) continue;
          const remoteJid = m.key.remoteJid || "";
          if (remoteJid.endsWith("@g.us") || remoteJid.includes("broadcast")) continue;

          const text =
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            "";

          if (!text) continue;
          const trimmed = text.trim();

          if (/^#pausar$/i.test(trimmed)) {
            if (campaignState.isRunning) {
              campaignState.isPaused = true;
              await sock.sendMessage(remoteJid, { text: "⏸️ Disparo pausado! Envie *#continuar* para retomar ou *#parar* para cancelar." });
            } else {
              await sock.sendMessage(remoteJid, { text: "ℹ️ Nenhum disparo em andamento no momento." });
            }
            continue;
          }

          if (/^#continuar$/i.test(trimmed)) {
            if (campaignState.isRunning && campaignState.isPaused) {
              campaignState.isPaused = false;
              await sock.sendMessage(remoteJid, { text: "▶️ Disparo retomado com sucesso!" });
            } else {
              await sock.sendMessage(remoteJid, { text: "ℹ️ O disparo não está pausado." });
            }
            continue;
          }

          if (/^#parar$/i.test(trimmed)) {
            if (campaignState.isRunning) {
              campaignState.shouldStop = true;
              await sock.sendMessage(remoteJid, { text: "🛑 Parando disparo nos grupos imediatamente!" });
            } else {
              await sock.sendMessage(remoteJid, { text: "ℹ️ Nenhum disparo em andamento no momento." });
            }
            continue;
          }

          if (/^#disparar\b/i.test(trimmed)) {
            const hiddenSet = new Set(appConfig.hiddenGroups || []);
            const validGroups = (appConfig.selectedGroups || []).filter((id) => !hiddenSet.has(id));

            if (validGroups.length === 0) {
              await sock.sendMessage(remoteJid, {
                text: "⚠️ Nenhum grupo de vendas ativo selecionado! Acesse o Painel Web da VPS para marcar os grupos.",
              });
              continue;
            }

            try {
              await startHumanBroadcast({
                targetGroupIds: validGroups,
                source: "Comando WhatsApp (#disparar)",
              });
              await sock.sendMessage(remoteJid, {
                text: `🚀 *Disparo Humano Mesclado Iniciado!*\n\n📦 *Grupos ativos:* ${validGroups.length}\n🎯 *Modo de rotação:* ${appConfig.rotationMode}\n⏱️ *Intervalo Anti-Ban:* ${appConfig.minDelaySec}s a ${appConfig.maxDelaySec}s\n🔒 *Grupos ocultos:* ${appConfig.hiddenGroups?.length || 0} (blindados contra disparos)\n\n_(Envie *#parar* a qualquer momento para cancelar)_`,
              });
            } catch (err) {
              await sock.sendMessage(remoteJid, { text: `❌ Erro ao iniciar disparo: ${err.message}` });
            }
          }
        }
      });

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            waQrRaw = qr;
            waQrCode = await QRCode.toDataURL(qr, { margin: 2, width: 380 });
            waStatus = "SCAN_QR";
            await QRCode.toFile(path.join(__dirname, "qrcode.png"), qr, { margin: 2, width: 400 });
          } catch (e) {}
        }

        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          const reconnect = code !== DisconnectReason.loggedOut;
          waSocket = null;
          waInitPromise = null;
          waStatus = "DISCONNECTED";
          waQrCode = null;
          waQrRaw = null;
          waUser = null;
          waName = null;

          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (reconnect) {
            console.log(`⚠️ [WHATSAPP] Conexão encerrada (código ${code || 'desconhecido'}). Reconectando em 3s...`);
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              initWhatsApp().catch((err) => console.error("Erro na reconexão:", err));
            }, 3000);
          } else {
            console.log("⚠️ [WHATSAPP] Sessão desconectada pelo usuário. Resetando sessão...");
            try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              initWhatsApp().catch((err) => console.error("Erro ao reiniciar após logout:", err));
            }, 2000);
          }
        } else if (connection === "open") {
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          waStatus = "CONNECTED";
          waQrCode = null;
          waQrRaw = null;
          waUser = (sock.user?.id || "").split(":")[0];
          waName = sock.user?.name || "Cledson";
          console.log("✅ [WHATSAPP CLEDSON] Conectado:", waUser, waName);
          setTimeout(() => refreshGroups().catch(() => {}), 2000);
          // Se havia um disparo interrompido (queda/reinício), retoma de onde parou
          setTimeout(() => {
            if (waStatus === "CONNECTED") tryResumePendingCampaign().catch(() => {});
          }, 12000);
        }
      });

      return sock;
    } catch (err) {
      console.error("Erro init WhatsApp:", err);
      waStatus = "DISCONNECTED";
      waInitPromise = null;
      throw err;
    }
  })();

  return waInitPromise;
}

initWhatsApp().catch(() => {});

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Helpers para evitar tráfego de megabytes de Base64 a cada segundo no navegador/celular
function getClientAds() {
  return (appAds || []).map((ad) => ({
    ...ad,
    imageBase64: ad.imageBase64
      ? "/ad-image/" + encodeURIComponent(ad.id) + "?v=" + String(ad.imageBase64.length)
      : null,
  }));
}

function mergeIncomingAds(incomingAds) {
  if (!Array.isArray(incomingAds)) return appAds;
  const existingMap = new Map((appAds || []).map((a) => [a.id, a]));
  return incomingAds.map((ad) => {
    const prev = existingMap.get(ad.id);
    let finalImg = ad.imageBase64 || null;
    if (typeof finalImg === "string" && finalImg.startsWith("/ad-image/")) {
      finalImg = prev ? prev.imageBase64 : null;
    }
    return {
      ...ad,
      imageBase64: finalImg,
    };
  });
}

// GET /ad-image/:id — serve a foto do anúncio diretamente em binário com cache HTTP
app.get("/ad-image/:id", (req, res) => {
  const ad = (appAds || []).find((a) => a && a.id === req.params.id);
  if (!ad || !ad.imageBase64) return res.status(404).end();
  const parsed = parseImageData(ad.imageBase64);
  if (!parsed || !parsed.buffer) return res.status(404).end();
  res.setHeader("Content-Type", parsed.mime || "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(parsed.buffer);
});

// GET /status
app.get("/status", (req, res) => {
  const includeInit = req.query.init === "1";
  const payload = {
    status: waStatus,
    user: waUser,
    name: waName,
    hasQr: !!waQrCode,
    qrCodeDataUrl: waQrCode,
    campaign: { ...campaignState, hasPending: !campaignState.isRunning && !!campaignQueue },
  };
  if (includeInit) {
    payload.config = {
      minDelaySec: appConfig.minDelaySec,
      maxDelaySec: appConfig.maxDelaySec,
      shuffleGroups: appConfig.shuffleGroups,
      simulateTyping: appConfig.simulateTyping,
      rotationMode: appConfig.rotationMode,
    };
    payload.ads = getClientAds();
  }
  res.json(payload);
});

// GET /test-fetch-meta
app.get("/test-fetch-meta", async (req, res) => {
  if (!waSocket || waStatus !== "CONNECTED") return res.status(503).json({ error: "WA offline" });
  try {
    const all = await waSocket.groupFetchAllParticipating();
    const withoutSubj = Object.values(all || {}).filter(g => !g.subject);
    const results = [];
    for (const g of withoutSubj.slice(0, 5)) {
      try {
        const meta = await waSocket.groupMetadata(g.id);
        results.push({ id: g.id, fetchedSubject: meta.subject, size: meta.size || meta.participants?.length });
      } catch (e) {
        results.push({ id: g.id, error: e.message });
      }
    }
    res.json({ totalWithoutSubj: withoutSubj.length, sampleResolved: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /groups
app.get("/groups", async (req, res) => {
  const force = req.query.refresh === "1";
  if (force || cachedGroups.length === 0) {
    await refreshGroups();
  }
  res.json({
    groups: cachedGroups,
    selectedGroups: appConfig.selectedGroups || [],
    hiddenGroups: appConfig.hiddenGroups || [],
  });
});

// POST /groups/leave
app.post("/groups/leave", async (req, res) => {
  const { groupIds } = req.body;
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ success: false, error: "groupIds deve ser uma lista" });
  }
  if (!waSocket || waStatus !== "CONNECTED") {
    return res.status(503).json({ success: false, error: "WhatsApp não conectado" });
  }

  const results = [];
  for (const jid of groupIds) {
    const groupObj = cachedGroups.find((g) => g.id === jid);
    const groupName = groupObj ? groupObj.subject : jid;
    let leftOk = false;
    let deletedOk = false;
    let errorMsg = null;

    try {
      await waSocket.groupLeave(jid);
      leftOk = true;
    } catch (err) {
      errorMsg = err.message;
    }

    await delay(800);

    try {
      await waSocket.chatModify(
        {
          delete: true,
          lastMessages: [{ key: { remoteJid: jid, fromMe: true, id: "1" }, messageTimestamp: Math.floor(Date.now() / 1000) }],
        },
        jid
      );
      deletedOk = true;
    } catch (delErr) {}

    cachedGroups = cachedGroups.filter((g) => g.id !== jid);
    appConfig.selectedGroups = (appConfig.selectedGroups || []).filter((id) => id !== jid);
    appConfig.hiddenGroups = (appConfig.hiddenGroups || []).filter((id) => id !== jid);

    results.push({ jid, name: groupName, leftOk, deletedOk, error: errorMsg });
    await delay(1000);
  }

  saveConfig();
  await refreshGroups().catch(() => {});
  res.json({ success: true, results, remainingGroups: cachedGroups.length });
});

// POST /config
app.post("/config", (req, res) => {
  const { selectedGroups, hiddenGroups, minDelaySec, maxDelaySec, shuffleGroups, simulateTyping, rotationMode } = req.body;
  if (Array.isArray(hiddenGroups)) {
    appConfig.hiddenGroups = hiddenGroups;
  }
  if (Array.isArray(selectedGroups)) {
    const hiddenSet = new Set(appConfig.hiddenGroups || []);
    appConfig.selectedGroups = selectedGroups.filter((id) => !hiddenSet.has(id));
  }
  if (typeof minDelaySec === "number" && minDelaySec >= 5) appConfig.minDelaySec = minDelaySec;
  if (typeof maxDelaySec === "number" && maxDelaySec >= appConfig.minDelaySec) appConfig.maxDelaySec = maxDelaySec;
  if (typeof shuffleGroups === "boolean") appConfig.shuffleGroups = shuffleGroups;
  if (typeof simulateTyping === "boolean") appConfig.simulateTyping = simulateTyping;
  if (rotationMode === "round_robin" || rotationMode === "random") appConfig.rotationMode = rotationMode;

  saveConfig();
  res.json({ success: true, config: appConfig });
});

// POST /ads — salva os anúncios (fotos e legendas)
app.post("/ads", (req, res) => {
  const { ads } = req.body;
  if (Array.isArray(ads)) {
    appAds = mergeIncomingAds(ads);
    saveAds();
    return res.json({ success: true, ads: getClientAds() });
  }
  res.status(400).json({ success: false, error: "ads deve ser um array" });
});

// POST /broadcast — dispara a rotação mesclada nos grupos
app.post("/broadcast", async (req, res) => {
  try {
    const { ads, selectedGroups, hiddenGroups, minDelaySec, maxDelaySec, shuffleGroups, simulateTyping, rotationMode } = req.body;

    if (Array.isArray(ads)) {
      appAds = mergeIncomingAds(ads);
      saveAds();
    }
    if (Array.isArray(hiddenGroups)) appConfig.hiddenGroups = hiddenGroups;
    if (Array.isArray(selectedGroups)) {
      const hiddenSet = new Set(appConfig.hiddenGroups || []);
      appConfig.selectedGroups = selectedGroups.filter((id) => !hiddenSet.has(id));
    }
    if (typeof minDelaySec === "number" && minDelaySec >= 5) appConfig.minDelaySec = minDelaySec;
    if (typeof maxDelaySec === "number" && maxDelaySec >= appConfig.minDelaySec) appConfig.maxDelaySec = maxDelaySec;
    if (typeof shuffleGroups === "boolean") appConfig.shuffleGroups = shuffleGroups;
    if (typeof simulateTyping === "boolean") appConfig.simulateTyping = simulateTyping;
    if (rotationMode === "round_robin" || rotationMode === "random") appConfig.rotationMode = rotationMode;
    saveConfig();

    const state = await startHumanBroadcast({
      targetGroupIds: appConfig.selectedGroups,
      source: "Painel Web",
    });

    res.json({ success: true, campaign: state });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /broadcast/pause — pausa ou retoma o disparo
app.post("/broadcast/pause", (req, res) => {
  if (!campaignState.isRunning) {
    return res.json({ success: false, message: "Nenhum disparo em andamento." });
  }
  campaignState.isPaused = !campaignState.isPaused;
  saveCampaignQueue();
  const statusMsg = campaignState.isPaused ? "Disparo pausado." : "Disparo retomado.";
  addCampaignLog("Sistema", "INFO", statusMsg);
  res.json({ success: true, isPaused: campaignState.isPaused, message: statusMsg });
});

// POST /broadcast/stop
app.post("/broadcast/stop", (req, res) => {
  if (campaignState.isRunning) {
    campaignState.shouldStop = true;
    return res.json({ success: true, message: "Parando disparo..." });
  }
  // Parar também cancela qualquer disparo salvo aguardando retomada
  if (loadPendingCampaignQueue()) {
    clearCampaignQueue();
    campaignState.statusText = "Disparo pendente cancelado.";
    return res.json({ success: true, message: "Disparo pendente cancelado." });
  }
  res.json({ success: true, message: "Nenhum disparo rodando." });
});

// POST /reset
app.post("/reset", async (req, res) => {
  await initWhatsApp(true).catch(() => {});
  res.json({ success: true, message: "Sessão reiniciada." });
});

// GET /qr.png
app.get("/qr.png", async (req, res) => {
  if (!waQrRaw) return res.status(404).send("QR não disponível");
  try {
    const buf = await QRCode.toBuffer(waQrRaw, { margin: 2, width: 400 });
    res.setHeader("Content-Type", "image/png");
    res.send(buf);
  } catch (err) {
    res.status(500).send("Erro ao gerar PNG");
  }
});

// GET / e /qr — Painel com Sistema Multi-Anúncios Mesclados Anti-Ban
app.get(["/", "/qr"], async (req, res) => {
  if (!waQrCode && waStatus !== "CONNECTED") initWhatsApp().catch(() => {});

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="format-detection" content="telephone=no" />
  <title>WhatsApp Cledson — Disparador Multi-Anúncios Anti-Ban</title>
  <style>
    :root {
      --bg: #0b141a;
      --card: #111b21;
      --card-2: #182229;
      --border: #222e35;
      --text: #e9edef;
      --muted: #8696a0;
      --green: #25d366;
      --green-dark: #1da851;
      --danger: #ef4444;
      --warn: #f59e0b;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }
    html {
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 20px;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 1200px; margin: 0 auto; width: 100%; }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      background: var(--card);
      border: 1px solid var(--border);
      padding: 16px 22px;
      border-radius: 16px;
      margin-bottom: 20px;
      width: 100%;
      min-width: 0;
    }
    .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-icon {
      width: 44px; height: 44px; border-radius: 12px;
      background: rgba(37, 211, 102, 0.15); color: var(--green);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: bold; flex-shrink: 0;
    }
    .brand h1 { font-size: 19px; font-weight: 700; color: #fff; }
    .brand p { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 16px; border-radius: 999px; font-size: 13px; font-weight: 600;
    }
    .status-pill.connected { background: rgba(37, 211, 102, 0.16); color: var(--green); border: 1px solid rgba(37, 211, 102, 0.3); }
    .status-pill.wait { background: rgba(245, 158, 11, 0.16); color: var(--warn); border: 1px solid rgba(245, 158, 11, 0.3); }

    .qr-screen {
      max-width: 460px; margin: 40px auto; background: var(--card);
      border: 1px solid var(--border); border-radius: 20px; padding: 32px 24px; text-align: center;
    }
    .qr-wrapper {
      background: #fff; padding: 16px; border-radius: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 270px; min-height: 270px; margin: 20px 0;
    }
    .qr-wrapper img { width: 250px; height: 250px; display: block; }
    .spinner {
      width: 42px; height: 42px; border: 4px solid #e5e7eb;
      border-top-color: var(--green); border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
      gap: 20px;
      width: 100%;
      max-width: 100%;
    }
    @media (max-width: 980px) {
      .grid {
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
      }
    }

    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px;
      min-width: 0;
      max-width: 100%;
      width: 100%;
    }
    .panel-title {
      font-size: 16px; font-weight: 700; margin-bottom: 6px;
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 8px; min-width: 0;
    }
    .panel-sub { font-size: 13px; color: var(--muted); margin-bottom: 18px; line-height: 1.45; }

    /* Badges e Tabs */
    .radar-badge, .nav-badge {
      background: var(--green); color: #0b141a; font-size: 11px; font-weight: 800;
      padding: 2px 7px; border-radius: 999px; margin-left: 4px;
    }
    .nav-tab {
      background: transparent; color: var(--muted); border: none; padding: 8px 14px;
      border-radius: 9px; font-size: 13.5px; font-weight: 700; cursor: pointer; transition: 0.15s;
    }
    .nav-tab:hover { color: #fff; }
    .nav-tab.active { background: #222e35; color: #fff; }
    .tabs-bar {
      display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;
      min-width: 0; max-width: 100%; width: 100%;
    }
    .tab-btn {
      background: var(--card-2); color: var(--text); border: 1px solid var(--border);
      padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 600;
      cursor: pointer; transition: 0.15s; display: inline-flex; align-items: center; gap: 6px;
      max-width: 100%; overflow: hidden; text-overflow: ellipsis;
    }
    .tab-btn:hover { background: #222e35; }
    .tab-btn.active {
      background: rgba(37, 211, 102, 0.15); color: var(--green); border-color: rgba(37, 211, 102, 0.4);
    }
    .tab-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #64748b; flex-shrink: 0;
    }
    .tab-btn.active .tab-dot { background: var(--green); }
    .tab-btn.has-content .tab-dot { background: #38bdf8; }
    .tab-btn.active.has-content .tab-dot { background: var(--green); }

    .ad-card {
      background: var(--card-2); border: 1px solid var(--border); border-radius: 14px; padding: 18px; margin-bottom: 16px;
      min-width: 0; max-width: 100%; width: 100%;
    }
    .ad-card-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 10px; flex-wrap: wrap;
    }
    .ad-name-input {
      background: var(--card); border: 1px solid #2a3942; color: #fff;
      padding: 6px 12px; border-radius: 8px; font-size: 14px; font-weight: 600; width: 60%; min-width: 0;
    }
    .ad-toggle-label {
      font-size: 13px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: #d1d7db;
    }
    .ad-toggle-label input { width: 16px; height: 16px; accent-color: var(--green); }

    .upload-zone {
      border: 2px dashed #2a3942; background: var(--card);
      border-radius: 12px; padding: 16px; text-align: center; cursor: pointer;
      transition: 0.2s; margin-bottom: 14px;
      min-width: 0; max-width: 100%; width: 100%; overflow: hidden;
    }
    .upload-zone:hover { border-color: var(--green); background: rgba(37, 211, 102, 0.04); }
    .upload-zone input[type="file"] { display: none; }
    .preview-container {
      width: 100%; max-width: 100%; overflow: hidden; text-align: center;
    }
    .preview-container img {
      max-height: 200px; max-width: 100%; width: auto; height: auto; object-fit: contain; border-radius: 8px; display: block; margin: 0 auto;
    }
    .remove-img-btn {
      margin-top: 8px; background: rgba(239, 68, 68, 0.15); color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3); padding: 5px 10px; border-radius: 6px;
      font-size: 12px; cursor: pointer;
    }

    textarea {
      width: 100%; max-width: 100%; min-height: 170px; background: var(--card); border: 1px solid #2a3942;
      border-radius: 10px; padding: 12px; color: #fff; font-family: inherit; font-size: 13.5px;
      line-height: 1.45; resize: vertical; margin-bottom: 12px;
    }
    textarea:focus, input:focus, select:focus { outline: none; border-color: var(--green); }

    .mode-select-box {
      background: var(--card-2); border: 1px solid var(--border); border-radius: 12px;
      padding: 14px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px;
      min-width: 0; max-width: 100%; width: 100%;
    }
    .mode-select-box select {
      background: var(--card); border: 1px solid #2a3942; color: #fff;
      padding: 9px 12px; border-radius: 8px; font-size: 13.5px;
      width: 100%; max-width: 100%; min-width: 0; text-overflow: ellipsis;
    }

    .settings-row {
      display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px;
      background: var(--card-2); padding: 14px; border-radius: 12px; margin-bottom: 16px; border: 1px solid var(--border);
      min-width: 0; max-width: 100%; width: 100%;
    }
    .settings-row > div { min-width: 0; }
    .settings-row input[type="number"] {
      width: 100%; background: var(--card); border: 1px solid #2a3942; color: #fff;
      padding: 8px 10px; border-radius: 8px; font-size: 14px; margin-top: 4px;
    }
    .checkbox-row {
      display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; font-size: 13px; color: #d1d7db;
      min-width: 0; max-width: 100%; width: 100%;
    }
    .checkbox-row label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }

    .btn {
      background: #202c33; color: var(--text); border: 1px solid #2a3942;
      padding: 9px 15px; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; transition: 0.15s;
    }
    .btn:hover { background: #2a3942; }
    .btn-primary {
      width: 100%; background: var(--green); color: #0b141a; border: none;
      padding: 14px 20px; font-size: 15px; font-weight: 700; border-radius: 12px; cursor: pointer; transition: 0.2s;
    }
    .btn-primary:hover { background: var(--green-dark); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-stop {
      width: 100%; background: var(--danger); color: #fff; border: none;
      padding: 13px 20px; font-size: 15px; font-weight: 700; border-radius: 12px; cursor: pointer; margin-top: 10px;
    }

    /* Coluna Direita (Grupos) */
    .group-subtabs-bar {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
      background: var(--card-2);
      padding: 4px;
      border-radius: 10px;
      border: 1px solid var(--border);
      width: 100%;
      max-width: 100%;
      min-width: 0;
    }
    .group-subtabs-bar .nav-tab {
      flex: 1;
      min-width: 0;
      text-align: center;
      justify-content: center;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .group-toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; width: 100%; min-width: 0; }
    .toolbar-btn-group { display: flex; gap: 8px; flex-wrap: wrap; min-width: 0; }
    .group-search {
      flex: 1; min-width: 0; background: var(--card-2); border: 1px solid #2a3942;
      color: #fff; padding: 9px 12px; border-radius: 10px; font-size: 13.5px;
    }
    .groups-list {
      max-height: 380px; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch;
      border: 1px solid var(--border); border-radius: 12px; background: var(--card-2);
      width: 100%; max-width: 100%; min-width: 0;
    }
    .group-item {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: 0.15s;
      width: 100%; max-width: 100%; min-width: 0;
    }
    .group-item:last-child { border-bottom: none; }
    .group-item:hover { background: rgba(255,255,255,0.03); }
    .group-item.selected { background: rgba(37, 211, 102, 0.08); }
    .group-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 0%; overflow: hidden; }
    .group-left input[type="checkbox"] { width: 17px; height: 17px; accent-color: var(--green); cursor: pointer; flex-shrink: 0; }
    .group-name {
      font-size: 13.5px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 0%;
    }
    .group-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .group-meta { font-size: 12px; color: var(--muted); white-space: nowrap; }
    .btn-hide-group {
      background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25);
      font-size: 11.5px; font-weight: 600; padding: 4px 8px; border-radius: 6px; cursor: pointer; transition: 0.15s;
      display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
    }
    .btn-hide-group:hover { background: #ef4444; color: #fff; border-color: #ef4444; }
    .btn-unhide-group {
      background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.25);
      font-size: 11.5px; font-weight: 600; padding: 4px 8px; border-radius: 6px; cursor: pointer; transition: 0.15s;
      display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
    }
    .btn-unhide-group:hover { background: #38bdf8; color: #0b141a; border-color: #38bdf8; }

    /* Modal de Edição de Anúncio */
    .modal-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75); z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      padding: 16px; backdrop-filter: blur(4px);
    }
    .modal-card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 18px; width: 100%; max-width: 580px;
      max-height: 90vh; overflow-y: auto; padding: 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }
    .modal-header {
      display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px;
    }
    .modal-title { font-size: 17px; font-weight: 700; color: #fff; }
    .close-modal-btn {
      background: transparent; border: none; color: var(--muted);
      font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 6px;
    }
    .close-modal-btn:hover { color: #fff; background: var(--card-2); }

    /* Estilos do Banco de Anúncios / Galeria */
    .gallery-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
      gap: 16px;
      margin-top: 16px;
      width: 100%;
      min-width: 0;
    }
    .gallery-card {
      background: var(--card-2);
      border: 2px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: 0.2s;
      position: relative;
      min-width: 0;
      max-width: 100%;
    }
    .gallery-card:hover { border-color: rgba(37, 211, 102, 0.4); }
    .gallery-card.selected-for-campaign {
      border-color: var(--green);
      background: rgba(37, 211, 102, 0.05);
    }
    .gallery-thumb {
      width: 100%;
      height: 160px;
      object-fit: cover;
      border-radius: 10px;
      background: var(--card);
      margin-bottom: 12px;
      display: block;
    }
    .gallery-thumb-placeholder {
      width: 100%;
      height: 140px;
      border-radius: 10px;
      background: var(--card);
      border: 1px dashed var(--border);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 12px;
    }
    .gallery-card-title {
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 6px;
      word-break: break-word;
    }
    .gallery-card-caption {
      font-size: 12.5px;
      color: var(--muted);
      line-height: 1.45;
      max-height: 80px;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .gallery-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: auto;
      flex-wrap: wrap;
    }
    .select-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      color: #d1d7db;
    }
    .select-tag input {
      width: 18px;
      height: 18px;
      accent-color: var(--green);
    }

    .progress-card {
      margin-top: 18px; background: var(--card-2); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px;
      min-width: 0; max-width: 100%; width: 100%;
    }
    .progress-bar-bg {
      width: 100%; height: 10px; background: #0b141a; border-radius: 999px; overflow: hidden; margin: 10px 0;
    }
    .progress-bar-fill { height: 100%; background: var(--green); width: 0%; transition: width 0.4s ease; }
    .logs-box {
      max-height: 200px; overflow-y: auto; overflow-x: hidden; background: #0b141a; border: 1px solid var(--border);
      border-radius: 10px; padding: 10px; font-family: monospace; font-size: 12px; margin-top: 12px;
      word-break: break-word; overflow-wrap: anywhere;
    }
    .log-entry { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .log-entry.SUCCESS { color: #4ade80; }
    .log-entry.ERROR { color: #f87171; }
    .log-entry.WARN { color: #fbbf24; }
    .log-entry.INFO, .log-entry.DONE { color: #93c5fd; }

    /* ─── Responsividade Mobile Limpa e Destravada (iPhone / Android) ─── */
    .header-right-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .header-status-box { display: flex; align-items: center; gap: 10px; }
    .main-nav { display: flex; background: var(--card-2); border: 1px solid var(--border); border-radius: 12px; padding: 4px; }

    @media (max-width: 768px) {
      /* Evita que o Safari no iPhone dê zoom automático ao tocar num campo de texto */
      input[type="text"],
      input[type="number"],
      input[type="search"],
      textarea,
      select {
        font-size: 16px !important;
      }

      body {
        padding: 10px;
        font-size: 13px;
      }

      header {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        padding: 12px 14px;
        margin-bottom: 14px;
        border-radius: 14px;
      }
      .brand {
        gap: 10px;
      }
      .brand-icon {
        width: 38px;
        height: 38px;
        font-size: 18px;
        border-radius: 10px;
      }
      .brand h1 {
        font-size: 14.5px;
        line-height: 1.25;
      }
      .brand p {
        font-size: 11.5px;
      }
      .header-right-actions {
        width: 100%;
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
      }
      .main-nav {
        width: 100%;
        gap: 4px;
      }
      .main-nav .nav-tab {
        flex: 1;
        min-width: 0;
        text-align: center;
        justify-content: center;
        padding: 9px 6px;
        font-size: 12px;
        display: flex;
        align-items: center;
        white-space: nowrap;
      }
      .header-status-box {
        width: 100%;
        justify-content: space-between;
        gap: 8px;
      }
      .status-pill {
        padding: 8px 10px;
        font-size: 11.5px;
        flex: 1;
        min-width: 0;
        justify-content: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .header-status-box .btn {
        padding: 8px 12px;
        font-size: 11.5px;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .panel {
        padding: 14px 12px;
        border-radius: 14px;
      }
      .panel-title {
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
        font-size: 14.5px;
      }
      .panel-title .btn, .panel-title a {
        text-align: center;
      }
      .panel-sub {
        font-size: 12px;
        margin-bottom: 12px;
      }

      .tabs-bar {
        gap: 6px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .tab-btn {
        padding: 8px 11px;
        font-size: 12px;
      }
      .tabs-bar > button.btn {
        font-size: 12px;
        padding: 8px 11px;
      }

      .ad-card {
        padding: 12px;
        border-radius: 12px;
        margin-bottom: 12px;
      }
      .ad-card-header {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        margin-bottom: 12px;
      }
      .ad-name-input {
        width: 100%;
        padding: 9px 12px;
      }
      textarea {
        min-height: 130px;
        padding: 10px 12px;
      }

      .mode-select-box {
        padding: 12px;
      }
      .mode-select-box select {
        padding: 9px 10px;
      }
      .settings-row {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px;
        padding: 12px;
      }
      .checkbox-row {
        flex-direction: column;
        gap: 8px;
        font-size: 12.5px;
      }

      .group-subtabs-bar .nav-tab {
        padding: 8px 4px;
        font-size: 11.5px;
      }
      .group-toolbar {
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
      }
      .group-search {
        width: 100%;
        padding: 9px 12px;
      }
      .toolbar-btn-group {
        width: 100%;
        gap: 8px;
      }
      .toolbar-btn-group .btn {
        flex: 1;
        min-width: 0;
        text-align: center;
        padding: 9px 6px;
        font-size: 12px;
      }
      .groups-list {
        max-height: 340px;
      }
      .group-item {
        padding: 9px 8px;
        gap: 8px;
      }
      .group-left {
        gap: 8px;
      }
      .group-left input[type="checkbox"] {
        width: 19px;
        height: 19px;
      }
      .group-name {
        font-size: 13px;
      }
      .group-right {
        gap: 6px;
      }
      .group-meta {
        font-size: 11px;
      }
      .btn-hide-group, .btn-unhide-group {
        font-size: 11px;
        padding: 5px 8px;
      }

      .gallery-grid {
        grid-template-columns: minmax(0, 1fr);
        gap: 12px;
      }
      .gallery-card {
        padding: 14px 12px;
      }

      .modal-card {
        padding: 18px 14px;
        border-radius: 16px;
      }
      .modal-footer {
        flex-direction: column !important;
        align-items: stretch !important;
        gap: 12px !important;
      }
      .modal-footer .modal-btn-row {
        display: flex !important;
        gap: 8px !important;
        width: 100% !important;
      }
      .modal-footer .modal-btn-row .btn {
        flex: 1 !important;
        text-align: center !important;
      }

      .qr-screen {
        margin: 20px auto;
        padding: 20px 14px;
      }
      .qr-wrapper {
        min-width: unset;
        min-height: unset;
        width: 100%;
        max-width: 260px;
        padding: 10px;
      }
      .qr-wrapper img {
        width: 100%;
        height: auto;
      }

      .progress-card {
        padding: 12px;
      }
      .logs-box {
        max-height: 140px;
        font-size: 11px;
      }
    }

    @media (max-width: 390px) {
      .group-meta {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">🔄</div>
        <div>
          <h1>WhatsApp Cledson — Disparador Multi-Anúncios Anti-Ban</h1>
          <p id="accountSubtitle">Sincronizando com a VPS...</p>
        </div>
      </div>
      <div class="header-right-actions">
        <div id="mainNav" class="main-nav">
          <button class="nav-tab active" id="tabNavDisparo" onclick="switchMainView('disparo')">📢 Disparador</button>
          <button class="nav-tab" id="tabNavGaleria" onclick="switchMainView('galeria')">
            🖼️ Banco de Anúncios <span id="galleryBadge" class="radar-badge" style="background:#38bdf8;color:#0b141a;">0</span>
          </button>
        </div>
        <div class="header-status-box">
          <div id="statusPill" class="status-pill wait">⏳ Conectando...</div>
          <button class="btn" onclick="resetSession()">Trocar Número</button>
        </div>
      </div>
    </header>

    <div id="qrSection" class="qr-screen" style="display:none;">
      <h2>Escaneie o QR Code</h2>
      <div class="qr-wrapper" id="qrBox"><div class="spinner"></div></div>
      <button class="btn" onclick="resetSession()">🔄 Gerar Novo QR Code</button>
    </div>

    <div id="appSection" class="grid" style="display:none;">
      <!-- Coluna Esquerda: Anúncios Mesclados -->
      <div class="panel">
        <div class="panel-title">
          <span>1. Anúncios Ativos para Disparo</span>
          <a href="javascript:void(0)" onclick="switchMainView('galeria')" style="font-size:12.5px;color:#38bdf8;text-decoration:none;font-weight:600;">🖼️ Abrir Banco de Anúncios</a>
        </div>
        <p class="panel-sub">Exibindo apenas os anúncios que você marcou como <strong>"Usar no Disparo"</strong> na sua Galeria. A cada grupo, o sistema alterna entre eles!</p>

        <!-- Abas dos Anúncios -->
        <div class="tabs-bar" id="tabsBar"></div>

        <!-- Conteúdo do Anúncio Ativo -->
        <div class="ad-card" id="adEditorCard">
          <div id="adEditorContent">
            <div class="ad-card-header">
              <input type="text" id="adNameInput" class="ad-name-input" placeholder="Nome do Anúncio" oninput="onAdFieldChange(false)" />
              <label class="ad-toggle-label">
                <input type="checkbox" id="adEnabledCheck" onchange="onAdFieldChange(true)" checked />
                Incluir no Disparo
              </label>
            </div>

            <label style="font-size:12px;font-weight:600;color:#d1d7db;display:block;margin-bottom:6px;">
              📸 Foto do Anúncio (Clique, Arraste ou Cole com Ctrl+V)
            </label>
            <div class="upload-zone" id="uploadZone" onclick="document.getElementById('fileInput').click()">
              <input type="file" id="fileInput" accept="image/*" onchange="handleFileSelect(event)" />
              <div id="uploadPlaceholder">
                <div style="font-size:26px;margin-bottom:4px;">🖼️</div>
                <div style="font-size:13px;font-weight:600;color:#fff;">Clique para adicionar foto ou cole (Ctrl+V)</div>
              </div>
              <div id="uploadPreview" class="preview-container" style="display:none;">
                <img id="previewImg" src="" alt="Foto" />
                <button type="button" class="remove-img-btn" onclick="removeImage(event)">🗑️ Remover Foto</button>
              </div>
            </div>

            <label style="font-size:12px;font-weight:600;color:#d1d7db;display:block;margin-bottom:6px;">
              📝 Descrição / Legenda
            </label>
            <textarea id="captionInput" placeholder="Digite o texto deste anúncio..." oninput="onAdFieldChange(false)"></textarea>
          </div>
          <div id="adEditorEmpty" style="display:none;padding:32px 16px;text-align:center;">
            <div style="font-size:32px;margin-bottom:8px;">🖼️</div>
            <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:6px;">Nenhum Anúncio Selecionado no Banco</div>
            <p style="font-size:13px;color:var(--muted);margin-bottom:16px;">Vá até a aba <strong>Banco de Anúncios</strong> e marque a caixinha "Usar no Disparo" nos produtos que deseja disparar hoje.</p>
            <button class="btn" style="background:var(--green);color:#0b141a;font-weight:700;" onclick="switchMainView('galeria')">Ir para o Banco de Anúncios</button>
          </div>
        </div>

        <!-- Modo de Rotação / Mesclagem -->
        <div class="mode-select-box">
          <label style="font-size:12.5px;font-weight:600;color:#fff;">🎯 Como mesclar os anúncios entre os grupos?</label>
          <select id="rotationModeSelect" onchange="saveAllSettings()">
            <option value="round_robin">Alternar em Ordem: Anúncio 1 ➔ 2 ➔ 3 (Recomendado)</option>
            <option value="random">Sorteio Aleatório a cada grupo</option>
          </select>
          <span style="font-size:11.5px;color:var(--muted);">
            Cada grupo recebe uma oferta diferente, quebrando o padrão de repetição do algoritmo do WhatsApp.
          </span>
        </div>

        <!-- Configurações de Intervalo Humano -->
        <div class="settings-row">
          <div>
            <span style="font-size:12px;color:var(--muted);">Espera Mínima (segundos)</span>
            <input type="number" id="minDelayInput" value="15" min="5" max="300" onchange="saveAllSettings()" />
          </div>
          <div>
            <span style="font-size:12px;color:var(--muted);">Espera Máxima (segundos)</span>
            <input type="number" id="maxDelayInput" value="30" min="10" max="600" onchange="saveAllSettings()" />
          </div>
        </div>

        <div class="checkbox-row">
          <label>
            <input type="checkbox" id="typingCheck" checked onchange="saveAllSettings()" />
            Simular "digitando..." antes de enviar
          </label>
          <label>
            <input type="checkbox" id="shuffleCheck" checked onchange="saveAllSettings()" />
            Embaralhar ordem dos grupos
          </label>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;">
          <button id="startBtn" class="btn-primary" onclick="startBroadcast()">
            🚀 Disparar Ofertas Mescladas (<span id="btnGroupCount">0</span> Grupos)
          </button>
          <div style="display:flex;gap:10px;">
            <button id="pauseBtn" class="btn" style="display:none;flex:1;background:var(--warn);color:#0b141a;font-weight:700;padding:12px;" onclick="togglePauseBroadcast()">
              ⏸️ Pausar Disparo
            </button>
            <button id="stopBtn" class="btn-stop" style="display:none;flex:1;margin-top:0;" onclick="stopBroadcast()">
              🛑 Parar Disparo
            </button>
          </div>
        </div>
      </div>

      <!-- Coluna Direita: Grupos Ativos + Progresso -->
      <div class="panel">
        <div class="panel-title">
          <span>2. Meus Grupos de Vendas (<span id="selectedCounter">0</span> de <span id="totalActiveCounter">0</span> ativos)</span>
          <button class="btn" onclick="loadGroups(true)" id="refreshGroupsBtn">🔄 Atualizar Grupos</button>
        </div>
        <p class="panel-sub">Marque os grupos que receberão as ofertas. Grupos pessoais ou sensíveis podem ser <strong>Ocultados</strong> para nunca receberem mensagens.</p>

        <!-- Sub-abas: Grupos Ativos vs Ocultos -->
        <div class="group-subtabs-bar">
          <button id="groupTabActive" class="nav-tab active" onclick="setGroupFilter('active')">
            📢 Grupos Ativos (<span id="activeGroupsCount">0</span>)
          </button>
          <button id="groupTabHidden" class="nav-tab" onclick="setGroupFilter('hidden')">
            🔒 Ocultos / Bloqueados (<span id="hiddenGroupsCount">0</span>)
          </button>
        </div>

        <!-- Toolbar para Grupos Ativos -->
        <div class="group-toolbar" id="activeGroupsToolbar">
          <input type="text" id="groupSearch" class="group-search" placeholder="🔍 Buscar grupo ativo pelo nome..." oninput="renderGroups()" />
          <div class="toolbar-btn-group">
            <button class="btn" style="background:var(--green);color:#0b141a;font-weight:700;" onclick="selectAllGroups(true)">✓ Selecionar Todos</button>
            <button class="btn" onclick="selectAllGroups(false)">Desmarcar Todos</button>
          </div>
        </div>

        <!-- Toolbar para Grupos Ocultos -->
        <div class="group-toolbar" id="hiddenGroupsToolbar" style="display:none;">
          <input type="text" id="hiddenGroupSearch" class="group-search" placeholder="🔍 Buscar nos grupos ocultos..." oninput="renderGroups()" />
          <div class="toolbar-btn-group">
            <button class="btn" style="background:#38bdf8;color:#0b141a;font-weight:700;" onclick="unhideAllGroups()">👁️ Reexibir Todos</button>
          </div>
        </div>

        <div class="groups-list" id="groupsList">
          <div style="padding:24px;text-align:center;color:var(--muted);">Carregando seus grupos...</div>
        </div>

        <!-- Progresso em Tempo Real -->
        <div class="progress-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-size:13.5px;">📊 Progresso do Disparo</strong>
            <span id="campaignCounters" style="font-size:13px;color:var(--green);font-weight:700;">0 / 0 enviados</span>
          </div>
          <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressBar"></div></div>
          <div id="campaignStatusText" style="font-size:12.5px;color:var(--muted);">Pronto para disparar.</div>
          <div class="logs-box" id="logsBox">
            <div style="color:var(--muted);">Os envios aparecerão aqui em tempo real...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ABA 2: BANCO DE ANÚNCIOS / GALERIA -->
    <div id="galeriaSection" class="panel" style="display:none;margin-top:20px;">
      <div class="panel-title">
        <span>🖼️ Banco de Anúncios Salvos (Sua Galeria Permanente)</span>
        <div style="display:flex;gap:8px;">
          <button class="btn" style="background:var(--green);color:#0b141a;font-weight:700;" onclick="createAdInGallery()">+ Criar Novo Anúncio</button>
        </div>
      </div>
      <p class="panel-sub">
        Todos os seus anúncios ficam salvos aqui para sempre. Você nunca mais precisa digitar do zero! 
        Basta <strong>marcar a caixinha "Usar no Disparo"</strong> nos anúncios que quiser enviar hoje.
      </p>

      <div style="display:flex;gap:10px;margin-bottom:16px;">
        <input type="text" id="gallerySearch" class="group-search" placeholder="🔍 Buscar no banco por título ou modelo (ex: 17E, 15 Pro, iPad)..." oninput="renderGalleryGrid()" />
      </div>

      <div class="gallery-grid" id="galleryGrid">
        <!-- Cards dos Anúncios -->
      </div>
    </div>
  </div>

  <!-- MODAL PARA EDITAR / CRIAR ANÚNCIO DIRETO NA GALERIA -->
  <div id="editAdModal" class="modal-overlay" style="display:none;">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title" id="modalTitle">✏️ Editar Anúncio</div>
        <button class="close-modal-btn" onclick="closeEditModal()">✕</button>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:12.5px;font-weight:600;color:#d1d7db;display:block;margin-bottom:6px;">
          🏷️ Nome / Identificador do Anúncio (ex: iPhone 13 PM, 17E Lacrado, iPad)
        </label>
        <input type="text" id="modalAdName" class="ad-name-input" style="width:100%;" placeholder="Nome do Anúncio" />
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:12.5px;font-weight:600;color:#d1d7db;display:block;margin-bottom:6px;">
          📸 Foto do Anúncio
        </label>
        <div class="upload-zone" id="modalUploadZone" onclick="document.getElementById('modalFileInput').click()">
          <input type="file" id="modalFileInput" accept="image/*" onchange="handleModalFileSelect(event)" />
          <div id="modalUploadPlaceholder">
            <div style="font-size:26px;margin-bottom:4px;">🖼️</div>
            <div style="font-size:13px;font-weight:600;color:#fff;">Clique para adicionar foto ou cole (Ctrl+V)</div>
          </div>
          <div id="modalUploadPreview" class="preview-container" style="display:none;">
            <img id="modalPreviewImg" src="" alt="Foto" />
            <button type="button" class="remove-img-btn" onclick="removeModalImage(event)">🗑️ Remover Foto</button>
          </div>
        </div>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:12.5px;font-weight:600;color:#d1d7db;display:block;margin-bottom:6px;">
          📝 Texto / Legenda Completa
        </label>
        <textarea id="modalCaptionInput" placeholder="Cole ou digite a descrição do anúncio..." style="min-height:160px;margin-bottom:4px;"></textarea>
      </div>

      <div class="modal-footer" style="display:flex;align-items:center;justify-content:space-between;margin-top:16px;">
        <label class="select-tag">
          <input type="checkbox" id="modalAdEnabledCheck" checked />
          <span>✅ Incluir este anúncio no Disparo</span>
        </label>
        <div class="modal-btn-row" style="display:flex;gap:8px;">
          <button class="btn" onclick="closeEditModal()">Cancelar</button>
          <button class="btn" style="background:var(--green);color:#0b141a;font-weight:700;" onclick="saveAdFromModal()">💾 Salvar Anúncio</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentMainView = 'disparo'; // 'disparo' | 'galeria'

    function switchMainView(view) {
      currentMainView = view;
      document.getElementById('tabNavDisparo').className = 'nav-tab' + (view === 'disparo' ? ' active' : '');
      document.getElementById('tabNavGaleria').className = 'nav-tab' + (view === 'galeria' ? ' active' : '');
      
      const appSec = document.getElementById('appSection');
      const galeriaSec = document.getElementById('galeriaSection');
      
      if (view === 'disparo') {
        appSec.style.display = 'grid';
        galeriaSec.style.display = 'none';
        renderTabs();
        loadCurrentAdIntoEditor();
      } else {
        appSec.style.display = 'none';
        galeriaSec.style.display = 'block';
        renderGalleryGrid();
      }
    }

    function updateGalleryBadge() {
      const badge = document.getElementById('galleryBadge');
      if (badge) {
        const activeCount = adsList.filter(a => a.enabled).length;
        badge.innerText = activeCount + ' / ' + adsList.length;
        badge.title = activeCount + ' anúncios marcados para disparo de um total de ' + adsList.length + ' salvos';
      }
    }

    function renderGalleryGrid() {
      const container = document.getElementById('galleryGrid');
      const q = (document.getElementById('gallerySearch').value || '').toLowerCase().trim();
      updateGalleryBadge();

      const filtered = adsList.filter(ad => {
        const n = (ad.name || '').toLowerCase();
        const c = (ad.caption || '').toLowerCase();
        return n.includes(q) || c.includes(q);
      });

      if (adsList.length === 0) {
        container.innerHTML = \`
          <div style="grid-column: 1 / -1; padding:48px 24px;text-align:center;background:var(--card);border-radius:14px;border:1px dashed var(--border);">
            <div style="font-size:36px;margin-bottom:10px;">📦</div>
            <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px;">Nenhum anúncio salvo ainda</div>
            <p style="font-size:13px;color:var(--muted);margin-bottom:16px;">Crie seu primeiro anúncio para guardar na galeria permanente!</p>
            <button class="btn" style="background:var(--green);color:#0b141a;font-weight:700;" onclick="createAdInGallery()">+ Criar Anúncio Agora</button>
          </div>
        \`;
        return;
      }

      if (filtered.length === 0) {
        container.innerHTML = '<div style="grid-column: 1 / -1; padding:30px;text-align:center;color:var(--muted);">Nenhum anúncio encontrado com essa busca.</div>';
        return;
      }

      container.innerHTML = filtered.map((ad, idx) => {
        const realIndex = adsList.findIndex(a => a.id === ad.id);
        const hasImg = !!ad.imageBase64;
        const isEnabled = !!ad.enabled;

        const imgHtml = hasImg 
          ? '<img src="' + ad.imageBase64 + '" class="gallery-thumb" alt="Foto" />'
          : '<div class="gallery-thumb-placeholder">📷 Sem foto anexada</div>';

        const titleText = ad.name || 'Anúncio sem nome';
        const captionText = ad.caption || '<em>(Sem texto/legenda cadastrada)</em>';
        const statusText = isEnabled ? '✅ Usar no Disparo' : '⏸️ Pausado';

        return \`
          <div class="gallery-card \${isEnabled ? 'selected-for-campaign' : ''}">
            <div>
              \${imgHtml}
              <div class="gallery-card-title">\${titleText}</div>
              <div class="gallery-card-caption">\${captionText}</div>
            </div>

            <div class="gallery-actions">
              <label class="select-tag" title="Marque para incluir este anúncio na rotação de envio nos grupos">
                <input type="checkbox" \${isEnabled ? 'checked' : ''} onchange="toggleGalleryAdSelect('\${ad.id}')" />
                <span>\${statusText}</span>
              </label>
              <div style="margin-left:auto;display:flex;gap:6px;">
                <button class="btn" style="padding:6px 10px;font-size:12px;" onclick="editAdFromGallery(\${realIndex})" title="Editar foto e texto">✏️ Editar</button>
                <button class="btn" style="padding:6px 10px;font-size:12px;background:rgba(239,68,68,0.15);color:#f87171;border-color:rgba(239,68,68,0.3);" onclick="deleteAdFromGallery('\${ad.id}')" title="Excluir este anúncio permanentemente">🗑️</button>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    function toggleGalleryAdSelect(id) {
      const ad = adsList.find(a => a.id === id);
      if (ad) {
        ad.enabled = !ad.enabled;
        renderTabs();
        renderGalleryGrid();
        debounceSaveAds();
      }
    }

    function deleteAdFromGallery(id) {
      const ad = adsList.find(a => a.id === id);
      if (!ad) return;
      if (!confirm('Deseja realmente excluir o anúncio "' + (ad.name || 'Sem nome') + '" permanentemente do banco?')) {
        return;
      }
      adsList = adsList.filter(a => a.id !== id);
      if (adsList.length === 0) {
        adsList.push({
          id: 'ad_' + Date.now(),
          name: 'Anúncio 1',
          caption: '',
          enabled: true,
          imageBase64: null
        });
      }
      if (currentAdIndex >= adsList.length) {
        currentAdIndex = Math.max(0, adsList.length - 1);
      }
      renderTabs();
      renderGalleryGrid();
      debounceSaveAds();
    }

    let editingAdId = null;
    let modalImageData = null;

    function openEditModal(adId) {
      editingAdId = adId;
      const modal = document.getElementById('editAdModal');
      const title = document.getElementById('modalTitle');
      const nameInput = document.getElementById('modalAdName');
      const captionInput = document.getElementById('modalCaptionInput');
      const enabledCheck = document.getElementById('modalAdEnabledCheck');
      const previewImg = document.getElementById('modalPreviewImg');
      const preview = document.getElementById('modalUploadPreview');
      const placeholder = document.getElementById('modalUploadPlaceholder');

      if (adId) {
        const ad = adsList.find(a => a.id === adId);
        if (!ad) return;
        title.innerText = '✏️ Editar Anúncio (' + (ad.name || 'Sem nome') + ')';
        nameInput.value = ad.name || '';
        captionInput.value = ad.caption || '';
        enabledCheck.checked = !!ad.enabled;
        modalImageData = ad.imageBase64 || null;
      } else {
        title.innerText = '➕ Criar Novo Anúncio';
        nameInput.value = 'Anúncio ' + (adsList.length + 1);
        captionInput.value = '';
        enabledCheck.checked = true;
        modalImageData = null;
      }

      if (modalImageData) {
        previewImg.src = modalImageData;
        placeholder.style.display = 'none';
        preview.style.display = 'block';
      } else {
        previewImg.src = '';
        placeholder.style.display = 'block';
        preview.style.display = 'none';
      }

      modal.style.display = 'flex';
    }

    function closeEditModal() {
      document.getElementById('editAdModal').style.display = 'none';
      editingAdId = null;
      modalImageData = null;
    }

    function handleModalFileSelect(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        modalImageData = ev.target.result;
        document.getElementById('modalPreviewImg').src = modalImageData;
        document.getElementById('modalUploadPlaceholder').style.display = 'none';
        document.getElementById('modalUploadPreview').style.display = 'block';
      };
      reader.readAsDataURL(file);
    }

    function removeModalImage(e) {
      e.stopPropagation();
      document.getElementById('modalFileInput').value = '';
      modalImageData = null;
      document.getElementById('modalPreviewImg').src = '';
      document.getElementById('modalUploadPlaceholder').style.display = 'block';
      document.getElementById('modalUploadPreview').style.display = 'none';
    }

    function saveAdFromModal() {
      const name = document.getElementById('modalAdName').value.trim() || 'Anúncio';
      const caption = document.getElementById('modalCaptionInput').value;
      const enabled = document.getElementById('modalAdEnabledCheck').checked;

      if (editingAdId) {
        const ad = adsList.find(a => a.id === editingAdId);
        if (ad) {
          ad.name = name;
          ad.caption = caption;
          ad.enabled = enabled;
          ad.imageBase64 = modalImageData;
        }
      } else {
        adsList.push({
          id: 'ad_' + Date.now(),
          name,
          caption,
          enabled,
          imageBase64: modalImageData
        });
      }

      closeEditModal();
      renderTabs();
      renderGalleryGrid();
      debounceSaveAds();
    }

    function editAdFromGallery(index) {
      const ad = adsList[index];
      if (ad) openEditModal(ad.id);
    }

    function createAdInGallery() {
      openEditModal(null);
    }

    let adsList = [];
    let currentAdIndex = 0;
    let allGroups = [];
    let selectedSet = new Set();
    let hiddenSet = new Set();
    let currentGroupFilter = 'active';
    let groupsLoadedOnce = false;

    // Gerenciamento de Anúncios e Abas (Mostra apenas os selecionados para disparo)
    function renderTabs(reloadEditor = true) {
      const bar = document.getElementById('tabsBar');
      const contentDiv = document.getElementById('adEditorContent');
      const emptyDiv = document.getElementById('adEditorEmpty');
      const activeAds = adsList.filter(a => a.enabled);

      if (activeAds.length === 0) {
        bar.innerHTML = '<span style="font-size:13px;color:var(--warn);font-weight:600;">⚠️ Nenhum anúncio selecionado para disparo.</span>';
        if (contentDiv) contentDiv.style.display = 'none';
        if (emptyDiv) emptyDiv.style.display = 'block';
        return;
      }

      if (contentDiv) contentDiv.style.display = 'block';
      if (emptyDiv) emptyDiv.style.display = 'none';

      // Se o anúncio atual não estiver mais entre os ativos, aponta para o primeiro ativo
      const curAd = adsList[currentAdIndex];
      let needsIndexReset = false;
      if (!curAd || !curAd.enabled) {
        const firstActiveIdx = adsList.findIndex(a => a.enabled);
        if (firstActiveIdx !== -1) {
          currentAdIndex = firstActiveIdx;
          needsIndexReset = true;
        }
      }

      bar.innerHTML = activeAds.map(ad => {
        const realIdx = adsList.findIndex(a => a.id === ad.id);
        const isActive = realIdx === currentAdIndex;
        const hasContent = !!(ad.caption?.trim() || ad.imageBase64);
        return \`
          <button class="tab-btn \${isActive ? 'active' : ''} \${hasContent ? 'has-content' : ''}" onclick="switchTab(\${realIdx})">
            <span class="tab-dot"></span>
            \${ad.name || 'Anúncio'}
          </button>
        \`;
      }).join('') + \`
        <button class="btn" onclick="switchMainView('galeria')" title="Gerenciar todos os anúncios no banco">🖼️ Gerenciar no Banco</button>
      \`;

      if (reloadEditor || needsIndexReset) {
        loadCurrentAdIntoEditor();
      }
    }

    function switchTab(index) {
      currentAdIndex = index;
      renderTabs(true);
    }

    function loadCurrentAdIntoEditor() {
      const ad = adsList[currentAdIndex];
      if (!ad) return;
      const nameEl = document.getElementById('adNameInput');
      const checkEl = document.getElementById('adEnabledCheck');
      const capEl = document.getElementById('captionInput');
      if (nameEl) nameEl.value = ad.name || '';
      if (checkEl) checkEl.checked = !!ad.enabled;
      if (capEl) capEl.value = ad.caption || '';

      const placeholder = document.getElementById('uploadPlaceholder');
      const preview = document.getElementById('uploadPreview');
      const previewImg = document.getElementById('previewImg');

      if (ad.imageBase64) {
        if (previewImg) previewImg.src = ad.imageBase64;
        if (placeholder) placeholder.style.display = 'none';
        if (preview) preview.style.display = 'block';
      } else {
        if (previewImg) previewImg.src = '';
        if (placeholder) placeholder.style.display = 'block';
        if (preview) preview.style.display = 'none';
      }
    }

    function onAdFieldChange(reloadEditor = false) {
      const ad = adsList[currentAdIndex];
      if (!ad) return;
      const nameEl = document.getElementById('adNameInput');
      const checkEl = document.getElementById('adEnabledCheck');
      const capEl = document.getElementById('captionInput');
      if (nameEl) ad.name = nameEl.value;
      if (checkEl) ad.enabled = checkEl.checked;
      if (capEl) ad.caption = capEl.value;
      renderTabs(reloadEditor);
      debounceSaveAds();
    }

    function addNewAd() {
      const num = adsList.length + 1;
      adsList.push({
        id: 'ad_' + Date.now(),
        name: 'Anúncio ' + num,
        enabled: true,
        caption: '',
        imageBase64: null
      });
      switchTab(adsList.length - 1);
      debounceSaveAds();
    }

    function handleFileSelect(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const ad = adsList[currentAdIndex];
        if (ad) {
          ad.imageBase64 = ev.target.result;
          loadCurrentAdIntoEditor();
          renderTabs();
          debounceSaveAds();
        }
      };
      reader.readAsDataURL(file);
    }

    function removeImage(e) {
      e.stopPropagation();
      document.getElementById('fileInput').value = '';
      const ad = adsList[currentAdIndex];
      if (ad) {
        ad.imageBase64 = null;
        loadCurrentAdIntoEditor();
        renderTabs();
        debounceSaveAds();
      }
    }

    // Suporte a colar foto (Ctrl+V)
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items || [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
              const ad = adsList[currentAdIndex];
              if (ad) {
                ad.imageBase64 = ev.target.result;
                loadCurrentAdIntoEditor();
                renderTabs();
                debounceSaveAds();
              }
            };
            reader.readAsDataURL(file);
          }
          break;
        }
      }
    });

    let saveAdsTimeout = null;
    function debounceSaveAds() {
      clearTimeout(saveAdsTimeout);
      saveAdsTimeout = setTimeout(() => {
        fetch('/ads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ads: adsList })
        }).catch(() => {});
      }, 500);
    }

    // Gerenciamento de Grupos
    function setGroupFilter(filter) {
      currentGroupFilter = filter;
      const tabActive = document.getElementById('groupTabActive');
      const tabHidden = document.getElementById('groupTabHidden');
      if (tabActive && tabHidden) {
        if (filter === 'active') {
          tabActive.classList.add('active');
          tabHidden.classList.remove('active');
        } else {
          tabActive.classList.remove('active');
          tabHidden.classList.add('active');
        }
      }
      const activeToolbar = document.getElementById('activeGroupsToolbar');
      const hiddenToolbar = document.getElementById('hiddenGroupsToolbar');
      if (activeToolbar && hiddenToolbar) {
        activeToolbar.style.display = filter === 'active' ? 'flex' : 'none';
        hiddenToolbar.style.display = filter === 'hidden' ? 'flex' : 'none';
      }
      renderGroups();
    }

    async function loadGroups(forceRefresh = false) {
      const btn = document.getElementById('refreshGroupsBtn');
      if (btn) btn.innerText = '⏳ Buscando...';
      try {
        const res = await fetch('/groups' + (forceRefresh ? '?refresh=1' : ''));
        const data = await res.json();
        allGroups = data.groups || [];
        hiddenSet = new Set(Array.isArray(data.hiddenGroups) ? data.hiddenGroups : []);
        if (Array.isArray(data.selectedGroups) && !groupsLoadedOnce) {
          selectedSet = new Set(data.selectedGroups.filter(id => !hiddenSet.has(id)));
        }
        // Limpa seleções de grupos que já não existem ou estão ocultos
        const validGroupIds = new Set(allGroups.map(g => g.id));
        for (const sid of Array.from(selectedSet)) {
          if (!validGroupIds.has(sid) || hiddenSet.has(sid)) {
            selectedSet.delete(sid);
          }
        }
        groupsLoadedOnce = true;
        renderGroups();
      } catch (e) {
        console.error('Erro ao carregar grupos:', e);
      } finally {
        if (btn) btn.innerText = '🔄 Atualizar Grupos';
      }
    }

    function renderGroups() {
      const container = document.getElementById('groupsList');
      const searchInput = currentGroupFilter === 'active' 
        ? document.getElementById('groupSearch') 
        : document.getElementById('hiddenGroupSearch');
      const query = (searchInput?.value || '').toLowerCase().trim();

      const activeGroups = allGroups.filter(g => !hiddenSet.has(g.id));
      const hiddenGroups = allGroups.filter(g => hiddenSet.has(g.id));
      const activeSelectedCount = activeGroups.filter(g => selectedSet.has(g.id)).length;

      const activeCountEl = document.getElementById('activeGroupsCount');
      const hiddenCountEl = document.getElementById('hiddenGroupsCount');
      const selectedCounterEl = document.getElementById('selectedCounter');
      const totalActiveCounterEl = document.getElementById('totalActiveCounter');
      const btnGroupCountEl = document.getElementById('btnGroupCount');

      if (activeCountEl) activeCountEl.innerText = activeGroups.length;
      if (hiddenCountEl) hiddenCountEl.innerText = hiddenGroups.length;
      if (selectedCounterEl) selectedCounterEl.innerText = activeSelectedCount;
      if (totalActiveCounterEl) totalActiveCounterEl.innerText = activeGroups.length;
      if (btnGroupCountEl) btnGroupCountEl.innerText = activeSelectedCount;

      if (currentGroupFilter === 'active') {
        const filtered = activeGroups.filter(g => (g.subject || '').toLowerCase().includes(query));

        if (allGroups.length === 0) {
          container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum grupo encontrado na conta.</div>';
          return;
        }
        if (activeGroups.length === 0) {
          container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">Todos os seus grupos estão ocultos! Abra a aba "Ocultos" acima para reexibir.</div>';
          return;
        }
        if (filtered.length === 0) {
          container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum grupo ativo corresponde à busca.</div>';
          return;
        }

        container.innerHTML = filtered.map(g => {
          const isSel = selectedSet.has(g.id);
          const safeName = (g.subject || 'Grupo sem nome').replace(/"/g, '&quot;');
          return \`
            <div class="group-item \${isSel ? 'selected' : ''}" onclick="toggleGroup('\${g.id}')">
              <div class="group-left">
                <input type="checkbox" \${isSel ? 'checked' : ''} onclick="event.stopPropagation(); toggleGroup('\${g.id}')" />
                <div class="group-name" title="\${safeName}">\${safeName}</div>
              </div>
              <div class="group-right">
                <span class="group-meta">👥 \${g.size || 0}</span>
                <button type="button" class="btn-hide-group" title="Ocultar para nunca enviar anúncios a este grupo" onclick="event.stopPropagation(); toggleHideGroup('\${g.id}', true)">
                  🚫 Ocultar
                </button>
              </div>
            </div>
          \`;
        }).join('');
      } else {
        // Aba de Grupos Ocultos (Blindados)
        const filtered = hiddenGroups.filter(g => (g.subject || '').toLowerCase().includes(query));
        const banner = \`
          <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:8px;padding:10px 14px;margin:8px;font-size:12.5px;color:#fca5a5;display:flex;align-items:center;gap:8px;">
            <span style="font-size:16px;">🔒</span>
            <div><strong>100% Blindados:</strong> Estes grupos nunca receberão anúncios nos disparos automáticos.</div>
          </div>
        \`;

        if (hiddenGroups.length === 0) {
          container.innerHTML = banner + '<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum grupo oculto no momento. Para proteger um grupo de receber anúncios, clique em "🚫 Ocultar" na lista ativa.</div>';
          return;
        }
        if (filtered.length === 0) {
          container.innerHTML = banner + '<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum grupo oculto corresponde à busca.</div>';
          return;
        }

        container.innerHTML = banner + filtered.map(g => {
          const safeName = (g.subject || 'Grupo sem nome').replace(/"/g, '&quot;');
          return \`
            <div class="group-item" style="opacity:0.95;">
              <div class="group-left">
                <span style="font-size:15px;color:#ef4444;" title="Grupo Blindado / Oculto">🔒</span>
                <div class="group-name" style="color:#d1d7db;" title="\${safeName}">\${safeName}</div>
              </div>
              <div class="group-right">
                <span class="group-meta">👥 \${g.size || 0}</span>
                <button type="button" class="btn-unhide-group" title="Reexibir grupo na lista ativa" onclick="event.stopPropagation(); toggleHideGroup('\${g.id}', false)">
                  👁️ Reexibir
                </button>
              </div>
            </div>
          \`;
        }).join('');
      }
    }

    function toggleGroup(id) {
      if (hiddenSet.has(id)) return;
      if (selectedSet.has(id)) selectedSet.delete(id);
      else selectedSet.add(id);
      renderGroups();
      saveAllSettings();
    }

    function toggleHideGroup(id, hide) {
      if (hide) {
        hiddenSet.add(id);
        selectedSet.delete(id);
      } else {
        hiddenSet.delete(id);
      }
      renderGroups();
      saveAllSettings();
    }

    function unhideAllGroups() {
      if (hiddenSet.size === 0) return;
      if (!confirm('Deseja realmente reexibir todos os grupos ocultos na lista ativa?')) return;
      hiddenSet.clear();
      renderGroups();
      saveAllSettings();
    }

    function selectAllGroups(select) {
      if (select) {
        for (const g of allGroups) {
          if (!hiddenSet.has(g.id)) {
            selectedSet.add(g.id);
          }
        }
      } else {
        selectedSet.clear();
      }
      renderGroups();
      saveAllSettings();
    }

    async function saveAllSettings() {
      const minDelaySec = parseInt(document.getElementById('minDelayInput').value, 10) || 15;
      const maxDelaySec = parseInt(document.getElementById('maxDelayInput').value, 10) || 30;
      const simulateTyping = document.getElementById('typingCheck').checked;
      const shuffleGroups = document.getElementById('shuffleCheck').checked;
      const rotationMode = document.getElementById('rotationModeSelect').value;

      await fetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedGroups: Array.from(selectedSet),
          hiddenGroups: Array.from(hiddenSet),
          minDelaySec,
          maxDelaySec,
          simulateTyping,
          shuffleGroups,
          rotationMode
        })
      }).catch(() => {});
    }

    async function startBroadcast() {
      for (const hid of hiddenSet) {
        selectedSet.delete(hid);
      }
      if (selectedSet.size === 0) {
        alert('Selecione pelo menos 1 grupo ativo na lista!');
        return;
      }
      const activeAds = adsList.filter(a => a.enabled && (a.caption?.trim() || a.imageBase64));
      if (activeAds.length === 0) {
        alert('Preencha e ative pelo menos 1 anúncio com foto ou texto para disparar!');
        return;
      }

      const minDelaySec = parseInt(document.getElementById('minDelayInput').value, 10) || 15;
      const maxDelaySec = parseInt(document.getElementById('maxDelayInput').value, 10) || 30;
      const simulateTyping = document.getElementById('typingCheck').checked;
      const shuffleGroups = document.getElementById('shuffleCheck').checked;
      const rotationMode = document.getElementById('rotationModeSelect').value;

      const btn = document.getElementById('startBtn');
      btn.disabled = true;

      try {
        const res = await fetch('/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ads: adsList,
            selectedGroups: Array.from(selectedSet),
            hiddenGroups: Array.from(hiddenSet),
            minDelaySec,
            maxDelaySec,
            simulateTyping,
            shuffleGroups,
            rotationMode
          })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Erro: ' + (data.error || 'Falha ao iniciar'));
          btn.disabled = false;
        } else {
          pollStatus();
        }
      } catch (err) {
        alert('Erro de conexão com o servidor.');
        btn.disabled = false;
      }
    }

    async function togglePauseBroadcast() {
      try {
        const res = await fetch('/broadcast/pause', { method: 'POST' });
        const data = await res.json();
        pollStatus();
      } catch (e) {
        alert('Erro ao pausar/retomar disparo.');
      }
    }

    async function stopBroadcast() {
      await fetch('/broadcast/stop', { method: 'POST' });
      pollStatus();
    }

    async function resetSession() {
      if (!confirm('Desconectar o WhatsApp atual e gerar novo QR Code?')) return;
      await fetch('/reset', { method: 'POST' });
      setTimeout(pollStatus, 1200);
    }

    let initialDataLoaded = false;
    let isPollingStatus = false;

    async function pollStatus() {
      if (isPollingStatus) return;
      isPollingStatus = true;
      try {
        const url = '/status?t=' + Date.now() + (!initialDataLoaded ? '&init=1' : '');
        const res = await fetch(url);
        const data = await res.json();

        const pill = document.getElementById('statusPill');
        const sub = document.getElementById('accountSubtitle');
        const qrSec = document.getElementById('qrSection');
        const appSec = document.getElementById('appSection');
        const qrBox = document.getElementById('qrBox');

        if (data.status === 'CONNECTED') {
          pill.className = 'status-pill connected';
          pill.innerHTML = '🟢 Conectado: +' + (data.user || '');
          sub.innerText = (data.name || 'Cledson') + ' • Sessão Ativa na VPS';
          qrSec.style.display = 'none';
          
          // Respeita a aba atual que o usuário está navegando (Disparador ou Banco de Anúncios)
          const galeriaSec = document.getElementById('galeriaSection');
          if (currentMainView === 'disparo') {
            appSec.style.display = 'grid';
            if (galeriaSec) galeriaSec.style.display = 'none';
          } else {
            appSec.style.display = 'none';
            if (galeriaSec) galeriaSec.style.display = 'block';
          }

          if (!initialDataLoaded && Array.isArray(data.ads)) {
            adsList = data.ads;
            initialDataLoaded = true;
            renderTabs(true);
            updateGalleryBadge();
          }
          if (data.config) {
            if (data.config.rotationMode) {
              document.getElementById('rotationModeSelect').value = data.config.rotationMode;
            }
            if (typeof data.config.minDelaySec === 'number') {
              document.getElementById('minDelayInput').value = data.config.minDelaySec;
            }
            if (typeof data.config.maxDelaySec === 'number') {
              document.getElementById('maxDelayInput').value = data.config.maxDelaySec;
            }
            if (typeof data.config.simulateTyping === 'boolean') {
              document.getElementById('typingCheck').checked = data.config.simulateTyping;
            }
            if (typeof data.config.shuffleGroups === 'boolean') {
              document.getElementById('shuffleCheck').checked = data.config.shuffleGroups;
            }
          }
          if (!groupsLoadedOnce) loadGroups(false);
        } else {
          pill.className = 'status-pill wait';
          pill.innerHTML = '📲 Conectar via QR Code';
          qrSec.style.display = 'block';
          appSec.style.display = 'none';
          if (data.hasQr && data.qrCodeDataUrl) {
            qrBox.innerHTML = '<img src="' + data.qrCodeDataUrl + '" alt="QR Code" />';
          } else {
            qrBox.innerHTML = '<div class="spinner"></div>';
          }
        }

        if (data.campaign) {
          const c = data.campaign;
          const startBtn = document.getElementById('startBtn');
          const pauseBtn = document.getElementById('pauseBtn');
          const stopBtn = document.getElementById('stopBtn');
          const counters = document.getElementById('campaignCounters');
          const statusTxt = document.getElementById('campaignStatusText');
          const bar = document.getElementById('progressBar');
          const logsBox = document.getElementById('logsBox');

          startBtn.disabled = c.isRunning || c.hasPending;
          stopBtn.style.display = (c.isRunning || c.hasPending) ? 'block' : 'none';
          
          if (pauseBtn) {
            pauseBtn.style.display = c.isRunning ? 'block' : 'none';
            if (c.isPaused) {
              pauseBtn.innerHTML = '▶️ Retomar Disparo';
              pauseBtn.style.background = 'var(--green)';
              pauseBtn.style.color = '#0b141a';
            } else {
              pauseBtn.innerHTML = '⏸️ Pausar Disparo';
              pauseBtn.style.background = 'var(--warn)';
              pauseBtn.style.color = '#0b141a';
            }
          }

          const doneCount = (c.sentCount || 0) + (c.failedCount || 0);
          const pct = c.totalGroups > 0 ? Math.round((doneCount / c.totalGroups) * 100) : 0;
          bar.style.width = pct + '%';
          counters.innerText = \`\${c.sentCount || 0} / \${c.totalGroups || 0} enviados\`;
          statusTxt.innerText = c.statusText || 'Pronto.';

          if (Array.isArray(c.logs) && c.logs.length > 0) {
            logsBox.innerHTML = c.logs.map(l => \`
              <div class="log-entry \${l.status}">
                [\${l.time}] <strong>\${l.groupName}:</strong> \${l.detail}
              </div>
            \`).join('');
          }
        }
      } catch (e) {
        console.error('Erro no pollStatus:', e);
      } finally {
        isPollingStatus = false;
      }
    }

    pollStatus();
    setInterval(pollStatus, 2000);
  </script>
</body>
</html>`);
});

// POST /send
app.post("/send", async (req, res) => {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key && key !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

  const { phone, jid, message, text } = req.body;
  const msgContent = message || text;

  if ((!phone && !jid) || !msgContent) {
    return res.status(400).json({ success: false, error: "phone/jid e message/text são obrigatórios" });
  }

  try {
    if (waStatus !== "CONNECTED" || !waSocket) {
      return res.status(503).json({ success: false, error: "WhatsApp não conectado." });
    }

    let targetJid = jid;
    if (!targetJid) {
      let clean = phone.replace(/\D/g, "");
      if (clean.length === 10 || clean.length === 11) clean = "55" + clean;
      targetJid = `${clean}@s.whatsapp.net`;
      try {
        const check = await waSocket.onWhatsApp(clean);
        if (check && check.length > 0 && check[0].exists) {
          targetJid = check[0].jid;
        }
      } catch (e) {}
    }

    const sentMsg = await waSocket.sendMessage(targetJid, { text: msgContent });
    saveMessageToStore(sentMsg);

    return res.json({ success: true, jid: targetJid });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 [WHATSAPP CLEDSON] Servidor rodando na porta ${PORT}`);
});
