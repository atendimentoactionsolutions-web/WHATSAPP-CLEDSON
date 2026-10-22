import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, ".wa-session");
const PORT = process.env.PORT || 3010;
const API_SECRET = process.env.WA_API_SECRET || "cledson2026";

const logger = pino({ level: "silent" });

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

// ─── Estado Global ─────────────────────────────────────────────
let waSocket = null;
let waStatus = "DISCONNECTED";
let waQrCode = null;
let waQrRaw = null;
let waUser = null;
let waName = null;
let waInitPromise = null;

// ─── Init WhatsApp ─────────────────────────────────────────────
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

      sock.ev.on("messages.upsert", ({ messages }) => {
        if (Array.isArray(messages)) {
          for (const m of messages) {
            saveMessageToStore(m);
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

// ─── Express App ───────────────────────────────────────────────
const app = express();
app.use(express.json());

// GET /status — retorna status em JSON (para polling da página de QR Code)
app.get(["/status", "/cledson-qr/status"], (req, res) => {
  res.json({
    status: waStatus,
    user: waUser,
    name: waName,
    hasQr: !!waQrCode,
    qrCodeDataUrl: waQrCode,
  });
});

// POST /reset — força geração de novo QR Code / desconexão
app.post(["/reset", "/cledson-qr/reset"], async (req, res) => {
  await initWhatsApp(true).catch(() => {});
  res.json({ success: true, message: "Sessão reiniciada. Gerando novo QR Code..." });
});

// GET /qr.png — retorna a imagem PNG direta do QR Code
app.get(["/qr.png", "/cledson-qr/qr.png"], async (req, res) => {
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

// GET / e /qr — Página interativa em tempo real para conectar o WhatsApp via QR Code
app.get(["/", "/qr", "/cledson-qr"], async (req, res) => {
  if (!waQrCode && waStatus !== "CONNECTED") {
    initWhatsApp().catch(() => {});
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Conectar WhatsApp — Cledson (VPS)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0b141a;
      color: #e9edef;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: #111b21;
      border: 1px solid #222e35;
      border-radius: 20px;
      max-width: 460px;
      width: 100%;
      padding: 36px 28px;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 18px;
    }
    .badge.scan { background: rgba(37, 211, 102, 0.15); color: #25d366; }
    .badge.connected { background: rgba(37, 211, 102, 0.2); color: #25d366; }
    .badge.wait { background: rgba(255, 193, 7, 0.15); color: #ffc107; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #ffffff; }
    p.sub { font-size: 14px; color: #8696a0; margin-bottom: 24px; line-height: 1.5; }
    .qr-wrapper {
      background: #ffffff;
      padding: 16px;
      border-radius: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 280px;
      min-height: 280px;
      margin-bottom: 20px;
      box-shadow: 0 8px 25px rgba(0, 0, 0, 0.35);
    }
    .qr-wrapper img {
      width: 260px;
      height: 260px;
      display: block;
    }
    .steps {
      text-align: left;
      background: #182229;
      padding: 16px 20px;
      border-radius: 12px;
      font-size: 13.5px;
      color: #d1d7db;
      line-height: 1.7;
      margin-bottom: 20px;
    }
    .steps strong { color: #25d366; }
    .btn {
      background: #202c33;
      color: #e9edef;
      border: 1px solid #2a3942;
      padding: 10px 18px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: 0.2s;
    }
    .btn:hover { background: #2a3942; }
    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.3);
      margin-top: 16px;
    }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.25); }
    .spinner {
      width: 44px;
      height: 44px;
      border: 4px solid #e5e7eb;
      border-top-color: #25d366;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .connected-box {
      padding: 28px 16px;
    }
    .check-icon {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: rgba(37, 211, 102, 0.18);
      color: #25d366;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 38px;
      margin: 0 auto 18px;
    }
    .phone-number {
      font-size: 18px;
      font-weight: 700;
      color: #25d366;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="badge" class="badge wait">⏳ Verificando conexão...</div>
    <h1>WhatsApp Cledson — VPS</h1>
    <p class="sub" id="subtitle">Sincronizando com o servidor em tempo real...</p>

    <div id="qrArea">
      <div class="qr-wrapper" id="qrBox">
        <div class="spinner"></div>
      </div>
      <div class="steps">
        1. Abra o <strong>WhatsApp</strong> no seu celular<br/>
        2. Toque em <strong>Configurações</strong> ou <strong>Mais opções (⋮)</strong><br/>
        3. Toque em <strong>Dispositivos conectados</strong> → <strong>Conectar dispositivo</strong><br/>
        4. Aponte a câmera para o QR Code acima
      </div>
      <button class="btn" onclick="resetSession()">🔄 Gerar Novo QR Code</button>
    </div>

    <div id="connectedArea" style="display:none;" class="connected-box">
      <div class="check-icon">✓</div>
      <h2>Conectado com Sucesso!</h2>
      <div class="phone-number" id="connectedPhone"></div>
      <p style="color:#8696a0;font-size:14px;margin-top:10px;">
        Sua sessão está ativa e salva na VPS.
      </p>
      <button class="btn btn-danger" onclick="resetSession()">Desconectar / Trocar Número</button>
    </div>
  </div>

  <script>
    const basePath = window.location.pathname.includes('/cledson-qr') ? '/cledson-qr' : '';

    async function checkStatus() {
      try {
        const res = await fetch(basePath + '/status?t=' + Date.now());
        const data = await res.json();
        const badge = document.getElementById('badge');
        const subtitle = document.getElementById('subtitle');
        const qrArea = document.getElementById('qrArea');
        const connectedArea = document.getElementById('connectedArea');
        const qrBox = document.getElementById('qrBox');
        const connectedPhone = document.getElementById('connectedPhone');

        if (data.status === 'CONNECTED') {
          badge.className = 'badge connected';
          badge.innerHTML = '🟢 WHATSAPP CONECTADO';
          subtitle.innerText = 'Aparelho vinculado e pronto para operar na VPS.';
          qrArea.style.display = 'none';
          connectedArea.style.display = 'block';
          connectedPhone.innerText = '+' + (data.user || '') + (data.name ? ' (' + data.name + ')' : '');
        } else if (data.hasQr && data.qrCodeDataUrl) {
          badge.className = 'badge scan';
          badge.innerHTML = '📲 AGUARDANDO LEITURA DO QR CODE';
          subtitle.innerText = 'Escaneie o código abaixo. Ele atualiza sozinho se expirar.';
          qrArea.style.display = 'block';
          connectedArea.style.display = 'none';
          qrBox.innerHTML = '<img src="' + data.qrCodeDataUrl + '" alt="QR Code WhatsApp" />';
        } else {
          badge.className = 'badge wait';
          badge.innerHTML = '⏳ GERANDO QR CODE...';
          subtitle.innerText = 'Aguarde alguns segundos enquanto o código é preparado.';
          qrArea.style.display = 'block';
          connectedArea.style.display = 'none';
          qrBox.innerHTML = '<div class="spinner"></div>';
        }
      } catch (e) {
        console.error('Erro ao consultar status:', e);
      }
    }

    async function resetSession() {
      const qrBox = document.getElementById('qrBox');
      qrBox.innerHTML = '<div class="spinner"></div>';
      await fetch(basePath + '/reset', { method: 'POST' });
      setTimeout(checkStatus, 1500);
    }

    checkStatus();
    setInterval(checkStatus, 2500);
  </script>
</body>
</html>`);
});

// POST /send — envia mensagem via API
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
