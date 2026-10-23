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
const PORT = process.env.PORT || 3010;
const API_SECRET = process.env.WA_API_SECRET || "cledson2026";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const logger = pino({ level: "silent" });

// ─── Persistência de Configuração (Grupos Selecionados, Intervalos, Histórico) ───
const defaultConfig = {
  selectedGroups: [], // array de JIDs dos grupos selecionados para vendas
  minDelaySec: 15,
  maxDelaySec: 30,
  shuffleGroups: true,
  simulateTyping: true,
  lastCaption: `📱 iPhone 17E 256GB

Valor: R$ 4.250,00

 • Novo, lacrado
 • Garantia de 1 ano Apple
 • À pronta entrega
 • Emitimos nota fiscal
 • Parcelamos em até 18x no cartão

📍 Loja física

Aceitamos seu iPhone usado como parte do pagamento mediante avaliação.`,
  history: [], // últimos disparos realizados
};

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

let appConfig = loadConfig();

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
  } catch (e) {
    console.error("Erro ao salvar config.json:", e);
  }
}

// ─── Cache em Memória para Retry Receipts ───
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
  get(k) {
    return this.map.get(k);
  }
  set(k, v) {
    this.map.set(k, v);
    if (this.map.size > 5000) {
      const firstKey = this.map.keys().next().value;
      if (firstKey) this.map.delete(firstKey);
    }
    return true;
  }
  del(k) {
    this.map.delete(k);
    return 1;
  }
  flushAll() {
    this.map.clear();
  }
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
let cachedGroups = []; // [{ id, subject, size, announce, restrict }]

// ─── Estado do Disparador Anti-Ban (Fila Humana) ────────────────────────────
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
  nextActionInSec: 0,
  statusText: "Pronto para disparar",
  logs: [], // [{ time, groupName, status, detail }]
};

function addCampaignLog(groupName, status, detail) {
  const time = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" });
  campaignState.logs.unshift({ time, groupName, status, detail });
  if (campaignState.logs.length > 100) campaignState.logs.pop();
}

// Micro-variação invisível anti-ban no texto (caracteres zero-width + espaços sutis no final)
function humanizeText(baseText, index) {
  if (!baseText) return "";
  const zwChars = ["\u200B", "\u200C", "\u200D", "\uFEFF"];
  // Gera uma combinação única de caracteres invisíveis baseada no índice e timestamp
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

// Embaralhar array (Fisher-Yates) para nunca repetir a mesma sequência de grupos
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

// Buscar todos os grupos em que o número conectado participa
async function refreshGroups() {
  if (!waSocket || waStatus !== "CONNECTED") return cachedGroups;
  try {
    const all = await waSocket.groupFetchAllParticipating();
    const list = Object.values(all || {})
      .map((g) => ({
        id: g.id,
        subject: (g.subject || "").trim(),
        size: Array.isArray(g.participants) ? g.participants.length : g.size || 0,
        announce: !!g.announce,
        restrict: !!g.restrict,
      }))
      // Ignora subgrupos fantasmas sem nome e com 0 membros
      .filter((g) => g.subject.length > 0 && g.size > 0);

    list.sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"));
    cachedGroups = list;
    return cachedGroups;
  } catch (err) {
    console.error("Erro ao buscar grupos:", err.message);
    return cachedGroups;
  }
}

// ─── Motor de Disparo Humano Anti-Ban ────────────────────────────────────────
async function startHumanBroadcast({ caption, imageBuffer, mimeType, targetGroupIds, source = "Painel Web" }) {
  if (campaignState.isRunning) {
    throw new Error("Já existe um disparo em andamento. Aguarde terminar ou pause o atual.");
  }
  if (!waSocket || waStatus !== "CONNECTED") {
    throw new Error("WhatsApp não está conectado no momento.");
  }
  if (!targetGroupIds || targetGroupIds.length === 0) {
    throw new Error("Selecione pelo menos 1 grupo de vendas para disparar.");
  }
  if (!caption?.trim() && !imageBuffer) {
    throw new Error("Informe uma foto ou uma descrição para enviar.");
  }

  // Atualiza cache de nomes dos grupos se estiver vazio
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
    nextActionInSec: 0,
    statusText: `Iniciando disparo via ${source}...`,
    logs: [],
  };

  if (caption?.trim()) {
    appConfig.lastCaption = caption;
    saveConfig();
  }

  addCampaignLog("Sistema", "INFO", `Disparo iniciado (${orderedIds.length} grupos) via ${source}`);

  // Executa de forma assíncrona em background
  (async () => {
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

        try {
          // 1. Simular abertura do chat e presença humana ("digitando...")
          if (appConfig.simulateTyping) {
            const typingSec = randomInt(3, 6);
            campaignState.statusText = `Digitando mensagem no grupo "${groupName}" (${i + 1}/${orderedIds.length})...`;
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

          // 2. Preparar texto humanizado com micro-variação invisível única
          const finalCaption = humanizeText(caption || "", i);

          // 3. Enviar imagem com legenda ou somente texto
          campaignState.statusText = `Enviando para "${groupName}" (${i + 1}/${orderedIds.length})...`;
          let sentMsg;
          if (imageBuffer) {
            sentMsg = await waSocket.sendMessage(jid, {
              image: imageBuffer,
              mimetype: mimeType || "image/jpeg",
              caption: finalCaption,
            });
          } else {
            sentMsg = await waSocket.sendMessage(jid, {
              text: finalCaption,
            });
          }
          saveMessageToStore(sentMsg);

          campaignState.sentCount++;
          addCampaignLog(groupName, "SUCCESS", `Enviado com sucesso (${campaignState.sentCount}/${orderedIds.length})`);
          console.log(`✅ [DISPARO ${campaignState.sentCount}/${orderedIds.length}] Enviado para: ${groupName}`);
        } catch (sendErr) {
          campaignState.failedCount++;
          addCampaignLog(groupName, "ERROR", `Falha: ${sendErr.message}`);
          console.error(`❌ [ERRO DISPARO] Grupo ${groupName}:`, sendErr.message);
        }

        // 4. Se ainda houver próximos grupos, aguardar intervalo aleatório humano (ex: 15s a 30s)
        if (i < orderedIds.length - 1 && !campaignState.shouldStop) {
          const waitSec = randomInt(appConfig.minDelaySec || 15, appConfig.maxDelaySec || 30);
          const nextName = groupMap.get(orderedIds[i + 1]) || orderedIds[i + 1];

          for (let remaining = waitSec; remaining > 0; remaining--) {
            if (campaignState.shouldStop) break;
            campaignState.nextActionInSec = remaining;
            campaignState.statusText = `Aguardando intervalo humano anti-ban (${remaining}s) antes de enviar para "${nextName}"...`;
            await delay(1000);
          }
        }
      }
    } finally {
      campaignState.isRunning = false;
      campaignState.nextActionInSec = 0;
      campaignState.currentGroupName = null;
      campaignState.finishedAt = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

      if (!campaignState.shouldStop) {
        campaignState.statusText = `Concluído! ${campaignState.sentCount} enviados com sucesso, ${campaignState.failedCount} falhas.`;
        addCampaignLog("Sistema", "DONE", `Finalizado: ${campaignState.sentCount} enviados, ${campaignState.failedCount} falhas.`);
      }

      // Salvar resumo no histórico
      appConfig.history.unshift({
        id: campaignState.id,
        startedAt: campaignState.startedAt,
        finishedAt: campaignState.finishedAt,
        totalGroups: campaignState.totalGroups,
        sentCount: campaignState.sentCount,
        failedCount: campaignState.failedCount,
        captionPreview: (caption || "").slice(0, 80),
        hadImage: !!imageBuffer,
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
      try {
        waSocket.end(undefined);
      } catch (e) {}
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
      console.log("🔄 [WHATSAPP CLEDSON] Iniciando conexão com WhatsApp...");

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

      // Escutar mensagens para gatilho rápido pelo próprio celular (#disparar ou #parar)
      sock.ev.on("messages.upsert", async ({ messages }) => {
        if (!Array.isArray(messages)) return;
        for (const m of messages) {
          saveMessageToStore(m);

          if (!m.key?.fromMe || !m.message) continue;
          const remoteJid = m.key.remoteJid || "";
          // Ignorar comandos enviados dentro de grupos para evitar disparo acidental
          if (remoteJid.endsWith("@g.us") || remoteJid.includes("broadcast")) continue;

          const text =
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            "";

          if (!text) continue;
          const trimmed = text.trim();

          // Comando para parar disparo pelo celular: #parar
          if (/^#parar$/i.test(trimmed)) {
            if (campaignState.isRunning) {
              campaignState.shouldStop = true;
              await sock.sendMessage(remoteJid, { text: "🛑 Parando disparo nos grupos imediatamente!" });
            } else {
              await sock.sendMessage(remoteJid, { text: "ℹ️ Nenhum disparo em andamento no momento." });
            }
            continue;
          }

          // Comando para disparar pelo celular: começa com #disparar
          if (/^#disparar\b/i.test(trimmed)) {
            const cleanCaption = trimmed.replace(/^#disparar\s*/i, "").trim();
            let imgBuf = null;
            let mime = "image/jpeg";

            const imgMsg =
              m.message.imageMessage ||
              m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

            if (m.message.imageMessage) {
              try {
                imgBuf = await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
                mime = m.message.imageMessage.mimetype || "image/jpeg";
              } catch (err) {
                console.error("Erro ao baixar imagem do comando #disparar:", err);
              }
            }

            if (!appConfig.selectedGroups || appConfig.selectedGroups.length === 0) {
              await sock.sendMessage(remoteJid, {
                text: "⚠️ Nenhum grupo de vendas está selecionado ainda! Acesse o Painel Web da VPS e marque os grupos que devem receber os anúncios.",
              });
              continue;
            }

            try {
              await startHumanBroadcast({
                caption: cleanCaption,
                imageBuffer: imgBuf,
                mimeType: mime,
                targetGroupIds: appConfig.selectedGroups,
                source: "Comando WhatsApp (#disparar)",
              });
              await sock.sendMessage(remoteJid, {
                text: `🚀 *Disparo Humano Iniciado!*\n\n📦 *Grupos selecionados:* ${appConfig.selectedGroups.length}\n⏱️ *Intervalo Anti-Ban:* ${appConfig.minDelaySec}s a ${appConfig.maxDelaySec}s\n\n_(Envie *#parar* aqui caso queira cancelar)_`,
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
            console.log("📱 [WHATSAPP CLEDSON] Novo QR Code gerado!");
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
            console.log("⚠️  Desconectado. Reconectando em 3s...");
            setTimeout(() => initWhatsApp(), 3000);
          } else {
            console.log("🚫 Logout detectado (401). Limpando sessão e gerando novo QR Code...");
            try {
              fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            } catch (e) {}
            setTimeout(() => initWhatsApp(), 2000);
          }
        } else if (connection === "open") {
          waStatus = "CONNECTED";
          waQrCode = null;
          waQrRaw = null;
          waUser = (sock.user?.id || "").split(":")[0];
          waName = sock.user?.name || "Cledson";
          console.log("✅ [WHATSAPP CLEDSON] Conectado com sucesso:", waUser, waName);
          // Carregar grupos automaticamente após conectar
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

// GET /status — status da conexão + estado da campanha ao vivo
app.get("/status", (req, res) => {
  res.json({
    status: waStatus,
    user: waUser,
    name: waName,
    hasQr: !!waQrCode,
    qrCodeDataUrl: waQrCode,
    campaign: campaignState,
    config: {
      selectedGroups: appConfig.selectedGroups,
      minDelaySec: appConfig.minDelaySec,
      maxDelaySec: appConfig.maxDelaySec,
      shuffleGroups: appConfig.shuffleGroups,
      simulateTyping: appConfig.simulateTyping,
      history: appConfig.history,
    },
  });
});

// GET /groups — lista todos os grupos do WhatsApp conectado
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

// POST /groups/leave — sai e apaga uma lista de grupos (groupIds)
app.post("/groups/leave", async (req, res) => {
  const { groupIds } = req.body;
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ success: false, error: "groupIds deve ser uma lista de JIDs" });
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
      console.log(`🚪 Saiu do grupo: ${groupName} (${jid})`);
    } catch (err) {
      errorMsg = err.message;
      console.warn(`⚠️ Aviso ao sair do grupo ${groupName} (${jid}):`, err.message);
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
    } catch (delErr) {
      // Mesmo se o chatModify falhar por falta de mensagem local no cache, o groupLeave já removeu do grupo
    }

    // Remove da memória e dos selecionados
    cachedGroups = cachedGroups.filter((g) => g.id !== jid);
    appConfig.selectedGroups = (appConfig.selectedGroups || []).filter((id) => id !== jid);

    results.push({ jid, name: groupName, leftOk, deletedOk, error: errorMsg });
    await delay(1000);
  }

  saveConfig();
  await refreshGroups().catch(() => {});
  res.json({ success: true, results, remainingGroups: cachedGroups.length });
});

// POST /config — salva grupos selecionados e parâmetros de delay anti-ban
app.post("/config", (req, res) => {
  const { selectedGroups, minDelaySec, maxDelaySec, shuffleGroups, simulateTyping, lastCaption } = req.body;
  if (Array.isArray(selectedGroups)) appConfig.selectedGroups = selectedGroups;
  if (typeof minDelaySec === "number" && minDelaySec >= 5) appConfig.minDelaySec = minDelaySec;
  if (typeof maxDelaySec === "number" && maxDelaySec >= appConfig.minDelaySec) appConfig.maxDelaySec = maxDelaySec;
  if (typeof shuffleGroups === "boolean") appConfig.shuffleGroups = shuffleGroups;
  if (typeof simulateTyping === "boolean") appConfig.simulateTyping = simulateTyping;
  if (typeof lastCaption === "string") appConfig.lastCaption = lastCaption;

  saveConfig();
  res.json({ success: true, config: appConfig });
});

// POST /broadcast — inicia o disparo humano anti-ban nos grupos selecionados
app.post("/broadcast", async (req, res) => {
  try {
    const { caption, imageBase64, selectedGroups, minDelaySec, maxDelaySec, shuffleGroups, simulateTyping } = req.body;

    if (Array.isArray(selectedGroups)) appConfig.selectedGroups = selectedGroups;
    if (typeof minDelaySec === "number" && minDelaySec >= 5) appConfig.minDelaySec = minDelaySec;
    if (typeof maxDelaySec === "number" && maxDelaySec >= appConfig.minDelaySec) appConfig.maxDelaySec = maxDelaySec;
    if (typeof shuffleGroups === "boolean") appConfig.shuffleGroups = shuffleGroups;
    if (typeof simulateTyping === "boolean") appConfig.simulateTyping = simulateTyping;
    saveConfig();

    let imageBuffer = null;
    let mimeType = "image/jpeg";

    if (imageBase64 && typeof imageBase64 === "string") {
      const match = imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        imageBuffer = Buffer.from(match[2], "base64");
      } else {
        imageBuffer = Buffer.from(imageBase64, "base64");
      }
    }

    const state = await startHumanBroadcast({
      caption,
      imageBuffer,
      mimeType,
      targetGroupIds: appConfig.selectedGroups,
      source: "Painel Web",
    });

    res.json({ success: true, campaign: state });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /broadcast/stop — interrompe o disparo imediatamente
app.post("/broadcast/stop", (req, res) => {
  if (campaignState.isRunning) {
    campaignState.shouldStop = true;
    return res.json({ success: true, message: "Solicitação de parada enviada." });
  }
  res.json({ success: true, message: "Nenhum disparo estava rodando." });
});

// POST /reset — desconecta ou gera novo QR Code
app.post("/reset", async (req, res) => {
  await initWhatsApp(true).catch(() => {});
  res.json({ success: true, message: "Sessão reiniciada. Gerando novo QR Code..." });
});

// GET /qr.png — imagem direta do QR Code
app.get("/qr.png", async (req, res) => {
  if (!waQrRaw) {
    return res.status(404).send("QR Code não disponível no momento.");
  }
  try {
    const buf = await QRCode.toBuffer(waQrRaw, { margin: 2, width: 400 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.send(buf);
  } catch (err) {
    res.status(500).send("Erro ao gerar PNG");
  }
});

// GET / e /qr — Painel Web Completo (Conexão QR Code + Disparador Anti-Ban de Grupos)
app.get(["/", "/qr"], async (req, res) => {
  if (!waQrCode && waStatus !== "CONNECTED") {
    initWhatsApp().catch(() => {});
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp Cledson — Disparador de Grupos Anti-Ban</title>
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
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      background: var(--card);
      border: 1px solid var(--border);
      padding: 18px 24px;
      border-radius: 16px;
      margin-bottom: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: rgba(37, 211, 102, 0.15);
      color: var(--green);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      font-weight: bold;
    }
    .brand h1 { font-size: 19px; font-weight: 700; color: #fff; }
    .brand p { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
    }
    .status-pill.connected { background: rgba(37, 211, 102, 0.16); color: var(--green); border: 1px solid rgba(37, 211, 102, 0.3); }
    .status-pill.wait { background: rgba(245, 158, 11, 0.16); color: var(--warn); border: 1px solid rgba(245, 158, 11, 0.3); }

    /* QR Screen */
    .qr-screen {
      max-width: 460px;
      margin: 40px auto;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 32px 24px;
      text-align: center;
    }
    .qr-wrapper {
      background: #fff;
      padding: 16px;
      border-radius: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 270px;
      min-height: 270px;
      margin: 20px 0;
    }
    .qr-wrapper img { width: 250px; height: 250px; display: block; }
    .spinner {
      width: 42px;
      height: 42px;
      border: 4px solid #e5e7eb;
      border-top-color: var(--green);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Main Grid */
    .grid {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 20px;
    }
    @media (max-width: 920px) {
      .grid { grid-template-columns: 1fr; }
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px;
    }
    .panel-title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .panel-sub {
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 18px;
    }

    /* Form Controls */
    label.field-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #d1d7db;
      margin-bottom: 8px;
    }
    .upload-zone {
      border: 2px dashed #2a3942;
      background: var(--card-2);
      border-radius: 14px;
      padding: 20px;
      text-align: center;
      cursor: pointer;
      transition: 0.2s;
      margin-bottom: 18px;
      position: relative;
    }
    .upload-zone:hover, .upload-zone.dragover {
      border-color: var(--green);
      background: rgba(37, 211, 102, 0.05);
    }
    .upload-zone input[type="file"] {
      display: none;
    }
    .preview-container {
      position: relative;
      display: inline-block;
      max-width: 100%;
    }
    .preview-container img {
      max-height: 240px;
      max-width: 100%;
      border-radius: 10px;
      border: 1px solid var(--border);
      display: block;
      margin: 0 auto;
    }
    .remove-img-btn {
      margin-top: 10px;
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
    }
    textarea {
      width: 100%;
      min-height: 210px;
      background: var(--card-2);
      border: 1px solid #2a3942;
      border-radius: 12px;
      padding: 14px;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.5;
      resize: vertical;
      margin-bottom: 16px;
    }
    textarea:focus, input[type="text"]:focus, input[type="number"]:focus {
      outline: none;
      border-color: var(--green);
    }

    /* WhatsApp Bubble Preview */
    .wa-preview-box {
      background: #0b141a;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 18px;
    }
    .wa-preview-title {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .wa-bubble {
      background: #005c4b;
      color: #e9edef;
      border-radius: 12px;
      padding: 8px;
      max-width: 340px;
      font-size: 13.5px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    .wa-bubble img {
      width: 100%;
      border-radius: 8px;
      margin-bottom: 6px;
      display: none;
    }
    .wa-bubble-text {
      padding: 2px 4px 4px;
    }

    /* Anti-ban settings row */
    .settings-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      background: var(--card-2);
      padding: 14px;
      border-radius: 12px;
      margin-bottom: 18px;
      border: 1px solid var(--border);
    }
    .settings-row input[type="number"] {
      width: 100%;
      background: var(--card);
      border: 1px solid #2a3942;
      color: #fff;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 14px;
      margin-top: 4px;
    }
    .checkbox-row {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 18px;
      font-size: 13px;
      color: #d1d7db;
    }
    .checkbox-row label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }

    /* Buttons */
    .btn {
      background: #202c33;
      color: var(--text);
      border: 1px solid #2a3942;
      padding: 9px 15px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: 0.2s;
    }
    .btn:hover { background: #2a3942; }
    .btn-primary {
      width: 100%;
      background: var(--green);
      color: #0b141a;
      border: none;
      padding: 14px 20px;
      font-size: 15px;
      font-weight: 700;
      border-radius: 12px;
      cursor: pointer;
      transition: 0.2s;
    }
    .btn-primary:hover { background: var(--green-dark); }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-stop {
      width: 100%;
      background: var(--danger);
      color: #fff;
      border: none;
      padding: 13px 20px;
      font-size: 15px;
      font-weight: 700;
      border-radius: 12px;
      cursor: pointer;
      margin-top: 10px;
    }

    /* Group Selector */
    .group-toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .group-search {
      flex: 1;
      min-width: 180px;
      background: var(--card-2);
      border: 1px solid #2a3942;
      color: #fff;
      padding: 9px 12px;
      border-radius: 10px;
      font-size: 13.5px;
    }
    .groups-list {
      max-height: 360px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card-2);
      divide-y: 1px solid var(--border);
    }
    .group-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 11px 14px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: 0.15s;
    }
    .group-item:last-child { border-bottom: none; }
    .group-item:hover { background: rgba(255,255,255,0.03); }
    .group-item.selected { background: rgba(37, 211, 102, 0.08); }
    .group-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .group-left input[type="checkbox"] {
      width: 17px;
      height: 17px;
      accent-color: var(--green);
      cursor: pointer;
    }
    .group-name {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 280px;
    }
    .group-meta {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
    }

    /* Progress & Live Logs */
    .progress-card {
      margin-top: 18px;
      background: var(--card-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
    }
    .progress-bar-bg {
      width: 100%;
      height: 10px;
      background: #0b141a;
      border-radius: 999px;
      overflow: hidden;
      margin: 10px 0;
    }
    .progress-bar-fill {
      height: 100%;
      background: var(--green);
      width: 0%;
      transition: width 0.4s ease;
    }
    .logs-box {
      max-height: 200px;
      overflow-y: auto;
      background: #0b141a;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      font-family: monospace;
      font-size: 12px;
      margin-top: 12px;
    }
    .log-entry {
      padding: 4px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .log-entry.SUCCESS { color: #4ade80; }
    .log-entry.ERROR { color: #f87171; }
    .log-entry.WARN { color: #fbbf24; }
    .log-entry.INFO, .log-entry.DONE { color: #93c5fd; }
    .tip-box {
      margin-top: 16px;
      background: rgba(37, 211, 102, 0.08);
      border: 1px solid rgba(37, 211, 102, 0.25);
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 12.5px;
      color: #d1d7db;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">📲</div>
        <div>
          <h1>WhatsApp Cledson — Disparador Humano Anti-Ban</h1>
          <p id="accountSubtitle">Verificando sessão na VPS...</p>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div id="statusPill" class="status-pill wait">⏳ Sincronizando...</div>
        <button class="btn" onclick="resetSession()" title="Desconectar ou Trocar WhatsApp">Trocar Número</button>
      </div>
    </header>

    <!-- Tela de QR Code (Exibida apenas quando desconectado) -->
    <div id="qrSection" class="qr-screen" style="display:none;">
      <h2>Escaneie o QR Code com seu WhatsApp</h2>
      <p style="color:var(--muted);font-size:14px;margin-top:6px;">
        Abra o WhatsApp → Configurações → Dispositivos conectados → Conectar dispositivo
      </p>
      <div class="qr-wrapper" id="qrBox">
        <div class="spinner"></div>
      </div>
      <div>
        <button class="btn" onclick="resetSession()">🔄 Gerar Novo QR Code</button>
      </div>
    </div>

    <!-- Painel Principal de Disparo (Exibido quando conectado) -->
    <div id="appSection" class="grid" style="display:none;">
      <!-- Coluna Esquerda: Criar Anúncio (Foto + Descrição) -->
      <div class="panel">
        <div class="panel-title">
          <span>1. Montar Oferta (Foto + Descrição)</span>
          <span style="font-size:12px;color:var(--green);">🛡️ Proteção Anti-Ban Ativa</span>
        </div>
        <p class="panel-sub">Envie ou cole (Ctrl+V) a foto do produto e digite a descrição exatamente como quer nos grupos.</p>

        <label class="field-label">📸 Foto do Produto (Clique, Arraste ou Cole com Ctrl+V)</label>
        <div class="upload-zone" id="uploadZone" onclick="document.getElementById('fileInput').click()">
          <input type="file" id="fileInput" accept="image/*" onchange="handleFileSelect(event)" />
          <div id="uploadPlaceholder">
            <div style="font-size:28px;margin-bottom:6px;">🖼️</div>
            <div style="font-weight:600;font-size:14px;color:#fff;">Clique para escolher a foto ou cole (Ctrl+V)</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;">Suporta JPG, PNG, WEBP</div>
          </div>
          <div id="uploadPreview" class="preview-container" style="display:none;">
            <img id="previewImg" src="" alt="Preview" />
            <button type="button" class="remove-img-btn" onclick="removeImage(event)">🗑️ Remover Foto</button>
          </div>
        </div>

        <label class="field-label">📝 Descrição / Legenda da Oferta</label>
        <textarea id="captionInput" placeholder="Digite a descrição do produto..." oninput="updatePreview()">${(appConfig.lastCaption || "").replace(/</g, "&lt;")}</textarea>

        <!-- Pré-visualização idêntica ao WhatsApp -->
        <div class="wa-preview-box">
          <div class="wa-preview-title">Pré-visualização no Grupo de WhatsApp:</div>
          <div class="wa-bubble">
            <img id="bubbleImg" src="" alt="Foto" />
            <div class="wa-bubble-text" id="bubbleText"></div>
          </div>
        </div>

        <!-- Configurações Anti-Ban -->
        <label class="field-label">⏱️ Velocidade e Comportamento Humano (Anti-Ban)</label>
        <div class="settings-row">
          <div>
            <span style="font-size:12px;color:var(--muted);">Espera Mínima (segundos)</span>
            <input type="number" id="minDelayInput" value="${appConfig.minDelaySec || 15}" min="5" max="300" onchange="saveSettings()" />
          </div>
          <div>
            <span style="font-size:12px;color:var(--muted);">Espera Máxima (segundos)</span>
            <input type="number" id="maxDelayInput" value="${appConfig.maxDelaySec || 30}" min="10" max="600" onchange="saveSettings()" />
          </div>
        </div>

        <div class="checkbox-row">
          <label>
            <input type="checkbox" id="typingCheck" ${appConfig.simulateTyping ? "checked" : ""} onchange="saveSettings()" />
            Simular "digitando..." antes de enviar
          </label>
          <label>
            <input type="checkbox" id="shuffleCheck" ${appConfig.shuffleGroups ? "checked" : ""} onchange="saveSettings()" />
            Embaralhar ordem dos grupos a cada envio
          </label>
        </div>

        <button id="startBtn" class="btn-primary" onclick="startBroadcast()">
          🚀 Disparar Oferta nos Grupos Selecionados (<span id="btnGroupCount">0</span>)
        </button>
        <button id="stopBtn" class="btn-stop" style="display:none;" onclick="stopBroadcast()">
          🛑 Parar Disparo Imediatamente
        </button>

        <div class="tip-box">
          💡 <strong>Atalho pelo próprio celular:</strong> Você também pode enviar uma foto com legenda para o seu próprio número começando com <code>#disparar</code> (ex: <code>#disparar 📱 iPhone 17E...</code>) que a VPS dispara automaticamente nos grupos marcados ao lado!
        </div>
      </div>

      <!-- Coluna Direita: Seleção de Grupos de Vendas + Progresso ao Vivo -->
      <div class="panel">
        <div class="panel-title">
          <span>2. Meus Grupos de Vendas (<span id="selectedCounter">0</span> selecionados)</span>
          <button class="btn" onclick="loadGroups(true)" id="refreshGroupsBtn">🔄 Atualizar Grupos</button>
        </div>
        <p class="panel-sub">Marque apenas os grupos de vendas/atacado. Sua seleção fica salva automaticamente na VPS.</p>

        <div class="group-toolbar">
          <input type="text" id="groupSearch" class="group-search" placeholder="🔍 Buscar grupo pelo nome..." oninput="renderGroups()" />
          <button class="btn" onclick="toggleAllFiltered(true)">Marcar Visíveis</button>
          <button class="btn" onclick="toggleAllFiltered(false)">Desmarcar</button>
        </div>

        <div class="groups-list" id="groupsList">
          <div style="padding:24px;text-align:center;color:var(--muted);">Carregando seus grupos do WhatsApp...</div>
        </div>

        <!-- Card de Status e Progresso em Tempo Real -->
        <div class="progress-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-size:14px;">📊 Status do Disparador</strong>
            <span id="campaignCounters" style="font-size:13px;color:var(--green);font-weight:700;">0 / 0 enviados</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="progressBar"></div>
          </div>
          <div id="campaignStatusText" style="font-size:13px;color:var(--muted);">
            Pronto para disparar.
          </div>

          <div class="logs-box" id="logsBox">
            <div style="color:var(--muted);">Os registros de envio aparecerão aqui em tempo real...</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentImageDataUrl = null;
    let allGroups = [];
    let selectedSet = new Set(${JSON.stringify(appConfig.selectedGroups || [])});
    let groupsLoadedOnce = false;

    function updatePreview() {
      const text = document.getElementById('captionInput').value;
      document.getElementById('bubbleText').innerText = text || '(Sem texto)';
      const bubbleImg = document.getElementById('bubbleImg');
      if (currentImageDataUrl) {
        bubbleImg.src = currentImageDataUrl;
        bubbleImg.style.display = 'block';
      } else {
        bubbleImg.style.display = 'none';
      }
    }

    function setPreviewImage(dataUrl) {
      currentImageDataUrl = dataUrl;
      const placeholder = document.getElementById('uploadPlaceholder');
      const preview = document.getElementById('uploadPreview');
      const previewImg = document.getElementById('previewImg');

      if (dataUrl) {
        previewImg.src = dataUrl;
        placeholder.style.display = 'none';
        preview.style.display = 'inline-block';
      } else {
        previewImg.src = '';
        placeholder.style.display = 'block';
        preview.style.display = 'none';
      }
      updatePreview();
    }

    function handleFileSelect(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      readFileAsDataUrl(file);
    }

    function readFileAsDataUrl(file) {
      const reader = new FileReader();
      reader.onload = (ev) => setPreviewImage(ev.target.result);
      reader.readAsDataURL(file);
    }

    function removeImage(e) {
      e.stopPropagation();
      document.getElementById('fileInput').value = '';
      setPreviewImage(null);
    }

    // Suporte para Colar imagem (Ctrl+V) e Arrastar e Soltar
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items || [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) readFileAsDataUrl(file);
          break;
        }
      }
    });

    const uploadZone = document.getElementById('uploadZone');
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) readFileAsDataUrl(file);
    });

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
      document.getElementById('btnGroupCount').innerText = selectedSet.size;

      if (allGroups.length === 0) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">Nenhum grupo encontrado ainda. Clique em "Atualizar Grupos".</div>';
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
      saveSettings();
    }

    function toggleAllFiltered(select) {
      const query = (document.getElementById('groupSearch').value || '').toLowerCase().trim();
      const filtered = allGroups.filter(g => g.subject.toLowerCase().includes(query));
      for (const g of filtered) {
        if (select) selectedSet.add(g.id);
        else selectedSet.delete(g.id);
      }
      renderGroups();
      saveSettings();
    }

    async function saveSettings() {
      const minDelaySec = parseInt(document.getElementById('minDelayInput').value, 10) || 15;
      const maxDelaySec = parseInt(document.getElementById('maxDelayInput').value, 10) || 30;
      const simulateTyping = document.getElementById('typingCheck').checked;
      const shuffleGroups = document.getElementById('shuffleCheck').checked;
      const lastCaption = document.getElementById('captionInput').value;

      await fetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedGroups: Array.from(selectedSet),
          minDelaySec,
          maxDelaySec,
          simulateTyping,
          shuffleGroups,
          lastCaption
        })
      }).catch(() => {});
    }

    async function startBroadcast() {
      if (selectedSet.size === 0) {
        alert('Selecione pelo menos 1 grupo de vendas na lista ao lado!');
        return;
      }
      const caption = document.getElementById('captionInput').value;
      if (!caption.trim() && !currentImageDataUrl) {
        alert('Adicione uma foto ou escreva a descrição da oferta!');
        return;
      }

      const minDelaySec = parseInt(document.getElementById('minDelayInput').value, 10) || 15;
      const maxDelaySec = parseInt(document.getElementById('maxDelayInput').value, 10) || 30;
      const simulateTyping = document.getElementById('typingCheck').checked;
      const shuffleGroups = document.getElementById('shuffleCheck').checked;

      const btn = document.getElementById('startBtn');
      btn.disabled = true;

      try {
        const res = await fetch('/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caption,
            imageBase64: currentImageDataUrl,
            selectedGroups: Array.from(selectedSet),
            minDelaySec,
            maxDelaySec,
            simulateTyping,
            shuffleGroups
          })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Erro: ' + (data.error || 'Falha ao iniciar disparo'));
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
      if (!confirm('Tem certeza que deseja desconectar o WhatsApp atual e gerar um novo QR Code?')) return;
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
          if (!groupsLoadedOnce) loadGroups(false);
        } else {
          pill.className = 'status-pill wait';
          pill.innerHTML = '📲 Aguardando Conexão QR Code';
          sub.innerText = 'Escaneie o QR Code para liberar o disparador';
          qrSec.style.display = 'block';
          appSec.style.display = 'none';
          if (data.hasQr && data.qrCodeDataUrl) {
            qrBox.innerHTML = '<img src="' + data.qrCodeDataUrl + '" alt="QR Code" />';
          } else {
            qrBox.innerHTML = '<div class="spinner"></div>';
          }
        }

        // Atualizar progresso do disparador
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

    updatePreview();
    pollStatus();
    setInterval(pollStatus, 2000);
  </script>
</body>
</html>`);
});

// POST /send — envia mensagem individual via API
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
