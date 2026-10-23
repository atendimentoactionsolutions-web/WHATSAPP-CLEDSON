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
      return { ...defaultConfig, ...parsed };
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

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
  } catch (e) {
    console.error("Erro ao salvar config.json:", e);
  }
}

function saveAds() {
  try {
    fs.writeFileSync(ADS_FILE, JSON.stringify(appAds, null, 2));
  } catch (e) {
    console.error("Erro ao salvar ads.json:", e);
  }
}

// ─── Cache em Memória para Mensagens e Links de Convite Detectados ───
const messageStore = new Map();
const detectedInvites = new Map(); // code -> { code, inviteUrl, foundInGroup, groupName, sender, text, timestamp, groupInfo }

function saveMessageToStore(msg) {
  if (!msg || !msg.key || !msg.key.id) return;
  const key = `${msg.key.remoteJid}:${msg.key.id}`;
  messageStore.set(key, msg.message);
  messageStore.set(msg.key.id, msg.message);
  if (messageStore.size > 2000) {
    const firstKey = messageStore.keys().next().value;
    if (firstKey) messageStore.delete(firstKey);
  }

  // Extrair texto da mensagem para caçar links de convite (chat.whatsapp.com)
  try {
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      "";

    if (text && text.includes("chat.whatsapp.com")) {
      const matches = text.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{20,26})/g);
      if (matches) {
        for (const m of matches) {
          const code = m.split("/").pop();
          if (code && !detectedInvites.has(code)) {
            const remoteJid = msg.key.remoteJid || "";
            const groupName = cachedGroups.find((g) => g.id === remoteJid)?.subject || remoteJid;
            detectedInvites.set(code, {
              code,
              url: `https://chat.whatsapp.com/${code}`,
              foundInGroup: remoteJid,
              groupName,
              sender: msg.key.participant || msg.key.remoteJid,
              snippet: text.slice(0, 200),
              timestamp: msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(),
            });
          }
        }
      }
    }
  } catch (e) {}
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
let cachedGroups = [];

// ─── Estado do Disparador Anti-Ban (Fila Humana com Rotação) ────────────────
let campaignState = {
  isRunning: false,
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

// Converte dataURL/base64 em Buffer
function parseImageData(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) {
    return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
  }
  try {
    return { mime: "image/jpeg", buffer: Buffer.from(dataUrl, "base64") };
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
  try {
    fs.writeFileSync(GROUP_META_CACHE_FILE, JSON.stringify(groupMetaCache, null, 2));
  } catch (e) {}
}

let isResolvingMeta = false;

// Resolver metadados dos grupos que o WhatsApp não entregou o nome de primeira
async function resolveMissingGroupMetadata(groupsList) {
  if (isResolvingMeta || !waSocket || waStatus !== "CONNECTED") return;
  isResolvingMeta = true;

  try {
    const missing = groupsList.filter((g) => !g.subject && g.id);
    if (missing.length === 0) return;

    console.log(`🔍 [METADATA] Resolvendo nomes de ${missing.length} grupos em segundo plano...`);
    let updatedCount = 0;

    for (const item of missing) {
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
        await delay(300);
      } catch (err) {}
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

// ─── Motor de Disparo Humano Anti-Ban com Mesclagem de Anúncios ─────────────
async function startHumanBroadcast({ targetGroupIds, source = "Painel Web" }) {
  if (campaignState.isRunning) {
    throw new Error("Já existe um disparo em andamento. Aguarde terminar ou pause o atual.");
  }
  if (!waSocket || waStatus !== "CONNECTED") {
    throw new Error("WhatsApp não está conectado no momento.");
  }
  if (!targetGroupIds || targetGroupIds.length === 0) {
    throw new Error("Selecione pelo menos 1 grupo de vendas para disparar.");
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

  const orderedIds = appConfig.shuffleGroups ? shuffleArray(targetGroupIds) : [...targetGroupIds];

  campaignState = {
    isRunning: true,
    shouldStop: false,
    id: "camp_" + Date.now(),
    startedAt: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    finishedAt: null,
    totalGroups: orderedIds.length,
    sentCount: 0,
    failedCount: 0,
    currentGroupName: null,
    currentAdName: null,
    nextActionInSec: 0,
    statusText: `Iniciando disparo mesclado entre ${activeAds.length} anúncios...`,
    logs: [],
  };

  addCampaignLog(
    "Sistema",
    "INFO",
    `Disparo iniciado (${orderedIds.length} grupos) • Mesclando ${activeAds.length} anúncio(s) [${activeAds.map((a) => a.name).join(", ")}]`
  );

  // Executa em segundo plano
  (async () => {
    let adIndex = 0;
    try {
      for (let i = 0; i < orderedIds.length; i++) {
        if (campaignState.shouldStop) {
          campaignState.statusText = "Disparo interrompido manualmente pelo usuário.";
          addCampaignLog("Sistema", "WARN", "Disparo cancelado manualmente.");
          break;
        }

        const jid = orderedIds[i];
        const groupName = groupMap.get(jid) || jid;
        campaignState.currentGroupName = groupName;

        // Escolhe o anúncio da rodada (Round-Robin ou Random)
        let chosenAd;
        if (appConfig.rotationMode === "random") {
          chosenAd = activeAds[Math.floor(Math.random() * activeAds.length)];
        } else {
          chosenAd = activeAds[adIndex % activeAds.length];
          adIndex++;
        }
        campaignState.currentAdName = chosenAd.name;

        try {
          // 1. Simular digitação humana
          if (appConfig.simulateTyping) {
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
              await waSocket.sendPresenceUpdate("paused", jid);
            } catch (e) {}
          }

          if (campaignState.shouldStop) break;

          // 2. Humanizar texto com assinatura invisível única
          const finalCaption = humanizeText(chosenAd.caption || "", i);
          const imgParsed = parseImageData(chosenAd.imageBase64);

          // 3. Enviar imagem ou texto
          campaignState.statusText = `Enviando para "${groupName}" (${i + 1}/${orderedIds.length}) • ${chosenAd.name}...`;
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

          campaignState.sentCount++;
          addCampaignLog(
            groupName,
            "SUCCESS",
            `Enviado [${chosenAd.name}] (${campaignState.sentCount}/${orderedIds.length})`
          );
          console.log(`✅ [DISPARO ${campaignState.sentCount}/${orderedIds.length}] Enviado para ${groupName} com ${chosenAd.name}`);
        } catch (sendErr) {
          campaignState.failedCount++;
          addCampaignLog(groupName, "ERROR", `Falha: ${sendErr.message}`);
          console.error(`❌ [ERRO DISPARO] ${groupName}:`, sendErr.message);
        }

        // 4. Intervalo aleatório anti-ban entre grupos
        if (i < orderedIds.length - 1 && !campaignState.shouldStop) {
          const waitSec = randomInt(appConfig.minDelaySec || 15, appConfig.maxDelaySec || 30);
          const nextName = groupMap.get(orderedIds[i + 1]) || orderedIds[i + 1];

          for (let remaining = waitSec; remaining > 0; remaining--) {
            if (campaignState.shouldStop) break;
            campaignState.nextActionInSec = remaining;
            campaignState.statusText = `Intervalo humano anti-ban (${remaining}s) antes do próximo envio ("${nextName}")...`;
            await delay(1000);
          }
        }
      }
    } finally {
      campaignState.isRunning = false;
      campaignState.nextActionInSec = 0;
      campaignState.currentGroupName = null;
      campaignState.currentAdName = null;
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
          const fullKey = `${key.remoteJid}:${key.id}`;
          return messageStore.get(fullKey) || messageStore.get(key.id) || { conversation: "" };
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

      // 2. Quando um novo chat de grupo aparece ou é criado
      sock.ev.on("chats.upsert", async (newChats) => {
        try {
          if (!Array.isArray(newChats)) return;
          for (const chat of newChats) {
            const jid = chat.id;
            if (jid && jid.endsWith("@g.us") && !cachedGroups.some((g) => g.id === jid)) {
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
            if (!appConfig.selectedGroups || appConfig.selectedGroups.length === 0) {
              await sock.sendMessage(remoteJid, {
                text: "⚠️ Nenhum grupo de vendas selecionado! Acesse o Painel Web da VPS para marcar os grupos.",
              });
              continue;
            }

            try {
              await startHumanBroadcast({
                targetGroupIds: appConfig.selectedGroups,
                source: "Comando WhatsApp (#disparar)",
              });
              await sock.sendMessage(remoteJid, {
                text: `🚀 *Disparo Humano Mesclado Iniciado!*\n\n📦 *Grupos selecionados:* ${appConfig.selectedGroups.length}\n🎯 *Modo de rotação:* ${appConfig.rotationMode}\n⏱️ *Intervalo Anti-Ban:* ${appConfig.minDelaySec}s a ${appConfig.maxDelaySec}s\n\n_(Envie *#parar* a qualquer momento para cancelar)_`,
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

          if (reconnect) {
            setTimeout(() => initWhatsApp(), 3000);
          } else {
            try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
            setTimeout(() => initWhatsApp(), 2000);
          }
        } else if (connection === "open") {
          waStatus = "CONNECTED";
          waQrCode = null;
          waQrRaw = null;
          waUser = (sock.user?.id || "").split(":")[0];
          waName = sock.user?.name || "Cledson";
          console.log("✅ [WHATSAPP CLEDSON] Conectado:", waUser, waName);
          setTimeout(() => refreshGroups().catch(() => {}), 2000);
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

// GET /status
app.get("/status", (req, res) => {
  res.json({
    status: waStatus,
    user: waUser,
    name: waName,
    hasQr: !!waQrCode,
    qrCodeDataUrl: waQrCode,
    campaign: campaignState,
    config: appConfig,
    ads: appAds,
  });
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
    selectedGroups: appConfig.selectedGroups,
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

    results.push({ jid, name: groupName, leftOk, deletedOk, error: errorMsg });
    await delay(1000);
  }

  saveConfig();
  await refreshGroups().catch(() => {});
  res.json({ success: true, results, remainingGroups: cachedGroups.length });
});

// POST /config
app.post("/config", (req, res) => {
  const { selectedGroups, minDelaySec, maxDelaySec, shuffleGroups, simulateTyping, rotationMode } = req.body;
  if (Array.isArray(selectedGroups)) appConfig.selectedGroups = selectedGroups;
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
    appAds = ads;
    saveAds();
    return res.json({ success: true, ads: appAds });
  }
  res.status(400).json({ success: false, error: "ads deve ser um array" });
});

// POST /broadcast — dispara a rotação mesclada nos grupos
app.post("/broadcast", async (req, res) => {
  try {
    const { ads, selectedGroups, minDelaySec, maxDelaySec, shuffleGroups, simulateTyping, rotationMode } = req.body;

    if (Array.isArray(ads)) {
      appAds = ads;
      saveAds();
    }
    if (Array.isArray(selectedGroups)) appConfig.selectedGroups = selectedGroups;
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

// POST /broadcast/stop
app.post("/broadcast/stop", (req, res) => {
  if (campaignState.isRunning) {
    campaignState.shouldStop = true;
    return res.json({ success: true, message: "Parando disparo..." });
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1280px; margin: 0 auto; }
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
    }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-icon {
      width: 44px; height: 44px; border-radius: 12px;
      background: rgba(37, 211, 102, 0.15); color: var(--green);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: bold;
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
      grid-template-columns: 1.15fr 0.85fr;
      gap: 20px;
    }
    @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }

    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px;
    }
    .panel-title {
      font-size: 16px; font-weight: 700; margin-bottom: 6px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .panel-sub { font-size: 13px; color: var(--muted); margin-bottom: 18px; }

    /* Tabs de Anúncios */
    .tabs-bar {
      display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;
    }
    .tab-btn {
      background: var(--card-2); color: var(--text); border: 1px solid var(--border);
      padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 600;
      cursor: pointer; transition: 0.15s; display: inline-flex; align-items: center; gap: 6px;
    }
    .tab-btn:hover { background: #222e35; }
    .tab-btn.active {
      background: rgba(37, 211, 102, 0.15); color: var(--green); border-color: rgba(37, 211, 102, 0.4);
    }
    .tab-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #64748b;
    }
    .tab-btn.active .tab-dot { background: var(--green); }
    .tab-btn.has-content .tab-dot { background: #38bdf8; }
    .tab-btn.active.has-content .tab-dot { background: var(--green); }

    .ad-card {
      background: var(--card-2); border: 1px solid var(--border); border-radius: 14px; padding: 18px; margin-bottom: 16px;
    }
    .ad-card-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;
    }
    .ad-name-input {
      background: var(--card); border: 1px solid #2a3942; color: #fff;
      padding: 6px 12px; border-radius: 8px; font-size: 14px; font-weight: 600; width: 60%;
    }
    .ad-toggle-label {
      font-size: 13px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: #d1d7db;
    }
    .ad-toggle-label input { width: 16px; height: 16px; accent-color: var(--green); }

    .upload-zone {
      border: 2px dashed #2a3942; background: var(--card);
      border-radius: 12px; padding: 16px; text-align: center; cursor: pointer;
      transition: 0.2s; margin-bottom: 14px;
    }
    .upload-zone:hover { border-color: var(--green); background: rgba(37, 211, 102, 0.04); }
    .upload-zone input[type="file"] { display: none; }
    .preview-container img {
      max-height: 200px; max-width: 100%; border-radius: 8px; display: block; margin: 0 auto;
    }
    .remove-img-btn {
      margin-top: 8px; background: rgba(239, 68, 68, 0.15); color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3); padding: 5px 10px; border-radius: 6px;
      font-size: 12px; cursor: pointer;
    }

    textarea {
      width: 100%; min-height: 170px; background: var(--card); border: 1px solid #2a3942;
      border-radius: 10px; padding: 12px; color: #fff; font-family: inherit; font-size: 13.5px;
      line-height: 1.45; resize: vertical; margin-bottom: 12px;
    }
    textarea:focus, input:focus, select:focus { outline: none; border-color: var(--green); }

    .mode-select-box {
      background: var(--card-2); border: 1px solid var(--border); border-radius: 12px;
      padding: 14px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px;
    }
    .mode-select-box select {
      background: var(--card); border: 1px solid #2a3942; color: #fff;
      padding: 9px 12px; border-radius: 8px; font-size: 13.5px;
    }

    .settings-row {
      display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
      background: var(--card-2); padding: 14px; border-radius: 12px; margin-bottom: 16px; border: 1px solid var(--border);
    }
    .settings-row input[type="number"] {
      width: 100%; background: var(--card); border: 1px solid #2a3942; color: #fff;
      padding: 8px 10px; border-radius: 8px; font-size: 14px; margin-top: 4px;
    }
    .checkbox-row {
      display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; font-size: 13px; color: #d1d7db;
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
    .group-toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .group-search {
      flex: 1; min-width: 180px; background: var(--card-2); border: 1px solid #2a3942;
      color: #fff; padding: 9px 12px; border-radius: 10px; font-size: 13.5px;
    }
    .groups-list {
      max-height: 380px; overflow-y: auto; border: 1px solid var(--border);
      border-radius: 12px; background: var(--card-2);
    }
    .group-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: 0.15s;
    }
    .group-item:last-child { border-bottom: none; }
    .group-item:hover { background: rgba(255,255,255,0.03); }
    .group-item.selected { background: rgba(37, 211, 102, 0.08); }
    .group-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .group-left input[type="checkbox"] { width: 17px; height: 17px; accent-color: var(--green); cursor: pointer; }
    .group-name {
      font-size: 13.5px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px;
    }
    .group-meta { font-size: 12px; color: var(--muted); white-space: nowrap; }

    .progress-card {
      margin-top: 18px; background: var(--card-2); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px;
    }
    .progress-bar-bg {
      width: 100%; height: 10px; background: #0b141a; border-radius: 999px; overflow: hidden; margin: 10px 0;
    }
    .progress-bar-fill { height: 100%; background: var(--green); width: 0%; transition: width 0.4s ease; }
    .logs-box {
      max-height: 200px; overflow-y: auto; background: #0b141a; border: 1px solid var(--border);
      border-radius: 10px; padding: 10px; font-family: monospace; font-size: 12px; margin-top: 12px;
    }
    .log-entry { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .log-entry.SUCCESS { color: #4ade80; }
    .log-entry.ERROR { color: #f87171; }
    .log-entry.WARN { color: #fbbf24; }
    .log-entry.INFO, .log-entry.DONE { color: #93c5fd; }
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
      <div style="display:flex;align-items:center;gap:10px;">
        <div id="statusPill" class="status-pill wait">⏳ Conectando...</div>
        <button class="btn" onclick="resetSession()">Trocar Número</button>
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
          <span>1. Seus Anúncios Mesclados (Anti-Ban)</span>
          <span style="font-size:12px;color:var(--green);">🛡️ Rotação Ativa</span>
        </div>
        <p class="panel-sub">Cadastre seus 3 anúncios abaixo. A cada grupo, o sistema alterna o anúncio enviado para o WhatsApp nunca ver conteúdo repetido!</p>

        <!-- Abas dos Anúncios -->
        <div class="tabs-bar" id="tabsBar"></div>

        <!-- Conteúdo do Anúncio Ativo -->
        <div class="ad-card" id="adEditorCard">
          <div class="ad-card-header">
            <input type="text" id="adNameInput" class="ad-name-input" placeholder="Nome do Anúncio" oninput="onAdFieldChange()" />
            <label class="ad-toggle-label">
              <input type="checkbox" id="adEnabledCheck" onchange="onAdFieldChange()" checked />
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
          <textarea id="captionInput" placeholder="Digite o texto deste anúncio..." oninput="onAdFieldChange()"></textarea>
        </div>

        <!-- Modo de Rotação / Mesclagem -->
        <div class="mode-select-box">
          <label style="font-size:12.5px;font-weight:600;color:#fff;">🎯 Como mesclar os anúncios entre os grupos?</label>
          <select id="rotationModeSelect" onchange="saveAllSettings()">
            <option value="round_robin">Alternar em Ordem: Anúncio 1 ➔ Anúncio 2 ➔ Anúncio 3 ➔ Repete (Recomendado)</option>
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

        <button id="startBtn" class="btn-primary" onclick="startBroadcast()">
          🚀 Disparar Ofertas Mescladas (<span id="btnGroupCount">0</span> Grupos)
        </button>
        <button id="stopBtn" class="btn-stop" style="display:none;" onclick="stopBroadcast()">
          🛑 Parar Disparo Imediatamente
        </button>
      </div>

      <!-- Coluna Direita: Grupos Ativos + Progresso -->
      <div class="panel">
        <div class="panel-title">
          <span>2. Meus Grupos de Vendas (<span id="selectedCounter">0</span> de <span id="totalActiveCounter">0</span> ativos)</span>
          <button class="btn" onclick="loadGroups(true)" id="refreshGroupsBtn">🔄 Atualizar Grupos</button>
        </div>
        <p class="panel-sub">Marque os grupos que receberão as ofertas. Sua seleção fica salva na VPS.</p>

        <div class="group-toolbar">
          <input type="text" id="groupSearch" class="group-search" placeholder="🔍 Buscar grupo pelo nome..." oninput="renderGroups()" />
          <button class="btn" style="background:var(--green);color:#0b141a;font-weight:700;" onclick="selectAllGroups(true)">✓ Selecionar Todos</button>
          <button class="btn" onclick="selectAllGroups(false)">Desmarcar Todos</button>
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
  </div>

  <script>
    let adsList = [];
    let currentAdIndex = 0;
    let allGroups = [];
    let selectedSet = new Set();
    let groupsLoadedOnce = false;

    // Gerenciamento de Anúncios e Abas
    function renderTabs() {
      const bar = document.getElementById('tabsBar');
      bar.innerHTML = adsList.map((ad, idx) => {
        const isActive = idx === currentAdIndex;
        const hasContent = !!(ad.caption?.trim() || ad.imageBase64);
        return \`
          <button class="tab-btn \${isActive ? 'active' : ''} \${hasContent ? 'has-content' : ''}" onclick="switchTab(\${idx})">
            <span class="tab-dot"></span>
            \${ad.name || ('Anúncio ' + (idx + 1))} \${!ad.enabled ? '(Pausado)' : ''}
          </button>
        \`;
      }).join('') + \`
        <button class="btn" onclick="addNewAd()" title="Adicionar mais um anúncio">+ Novo Anúncio</button>
      \`;
    }

    function switchTab(index) {
      currentAdIndex = index;
      renderTabs();
      loadCurrentAdIntoEditor();
    }

    function loadCurrentAdIntoEditor() {
      const ad = adsList[currentAdIndex];
      if (!ad) return;
      document.getElementById('adNameInput').value = ad.name || '';
      document.getElementById('adEnabledCheck').checked = !!ad.enabled;
      document.getElementById('captionInput').value = ad.caption || '';

      const placeholder = document.getElementById('uploadPlaceholder');
      const preview = document.getElementById('uploadPreview');
      const previewImg = document.getElementById('previewImg');

      if (ad.imageBase64) {
        previewImg.src = ad.imageBase64;
        placeholder.style.display = 'none';
        preview.style.display = 'inline-block';
      } else {
        previewImg.src = '';
        placeholder.style.display = 'block';
        preview.style.display = 'none';
      }
    }

    function onAdFieldChange() {
      const ad = adsList[currentAdIndex];
      if (!ad) return;
      ad.name = document.getElementById('adNameInput').value;
      ad.enabled = document.getElementById('adEnabledCheck').checked;
      ad.caption = document.getElementById('captionInput').value;
      renderTabs();
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
    async function loadGroups(forceRefresh = false) {
      const btn = document.getElementById('refreshGroupsBtn');
      if (btn) btn.innerText = '⏳ Buscando...';
      try {
        const res = await fetch('/groups' + (forceRefresh ? '?refresh=1' : ''));
        const data = await res.json();
        allGroups = data.groups || [];
        if (Array.isArray(data.selectedGroups) && !groupsLoadedOnce) {
          selectedSet = new Set(data.selectedGroups);
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
      const query = (document.getElementById('groupSearch').value || '').toLowerCase().trim();
      const filtered = allGroups.filter(g => g.subject.toLowerCase().includes(query));

      document.getElementById('selectedCounter').innerText = selectedSet.size;
      document.getElementById('totalActiveCounter').innerText = allGroups.length;
      document.getElementById('btnGroupCount').innerText = selectedSet.size;

      if (allGroups.length === 0) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum grupo encontrado.</div>';
        return;
      }
      if (filtered.length === 0) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum grupo corresponde à busca.</div>';
        return;
      }

      container.innerHTML = filtered.map(g => {
        const isSel = selectedSet.has(g.id);
        return \`
          <div class="group-item \${isSel ? 'selected' : ''}" onclick="toggleGroup('\${g.id}')">
            <div class="group-left">
              <input type="checkbox" \${isSel ? 'checked' : ''} onclick="event.stopPropagation(); toggleGroup('\${g.id}')" />
              <div class="group-name" title="\${g.subject.replace(/"/g, '&quot;')}">\${g.subject}</div>
            </div>
            <div class="group-meta">👥 \${g.size || 0}</div>
          </div>
        \`;
      }).join('');
    }

    function toggleGroup(id) {
      if (selectedSet.has(id)) selectedSet.delete(id);
      else selectedSet.add(id);
      renderGroups();
      saveAllSettings();
    }

    function selectAllGroups(select) {
      if (select) {
        for (const g of allGroups) selectedSet.add(g.id);
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
          minDelaySec,
          maxDelaySec,
          simulateTyping,
          shuffleGroups,
          rotationMode
        })
      }).catch(() => {});
    }

    async function startBroadcast() {
      if (selectedSet.size === 0) {
        alert('Selecione pelo menos 1 grupo na lista ao lado!');
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

    async function stopBroadcast() {
      await fetch('/broadcast/stop', { method: 'POST' });
      pollStatus();
    }

    async function resetSession() {
      if (!confirm('Desconectar o WhatsApp atual e gerar novo QR Code?')) return;
      await fetch('/reset', { method: 'POST' });
      setTimeout(pollStatus, 1200);
    }

    async function pollStatus() {
      try {
        const res = await fetch('/status?t=' + Date.now());
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
          appSec.style.display = 'grid';

          if (adsList.length === 0 && Array.isArray(data.ads)) {
            adsList = data.ads;
            renderTabs();
            loadCurrentAdIntoEditor();
          }
          if (data.config?.rotationMode) {
            document.getElementById('rotationModeSelect').value = data.config.rotationMode;
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
          const stopBtn = document.getElementById('stopBtn');
          const counters = document.getElementById('campaignCounters');
          const statusTxt = document.getElementById('campaignStatusText');
          const bar = document.getElementById('progressBar');
          const logsBox = document.getElementById('logsBox');

          startBtn.disabled = c.isRunning;
          stopBtn.style.display = c.isRunning ? 'block' : 'none';

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
