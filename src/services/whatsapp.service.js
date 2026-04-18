import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { limparCacheAuth } from './auth.service.js';
import { config } from '../config/settings.js';
import { delay } from '../utils/formatters.js';

let isConnected = false;
let lastQrCode = null;
let activeSock = null;
let pairingInProgress = false;
let pairingCooldown = false;
let socketListenerConfigurado = false;
let manualStartRequested = false;
let isStarting = false;
let currentIo = null;
let currentOnReady = null;
const logHistory = [];

const pushLog = (io, msg) => {
  console.log(msg);
  if (logHistory.length > 80) logHistory.shift();
  logHistory.push(msg);
  if (io) io.emit('log', msg);
};

const emitConnectionState = (io) => {
  if (!io) return;
  io.emit('whatsapp_state', getWhatsAppState());
};

const setupSocketIoListeners = (io) => {
  if (!io || socketListenerConfigurado) return;

  io.on('connection', (socket) => {
    socket.emit('whatsapp_state', getWhatsAppState());
    if (isConnected) socket.emit('connected');
    if (lastQrCode && !isConnected) socket.emit('qr', lastQrCode);
    logHistory.forEach((l) => socket.emit('log', l));

    socket.on('request_pairing_code', async (phoneNumber) => {
      if (!manualStartRequested) {
        socket.emit('pairing_error', 'Inicie a conexão primeiro.');
        return;
      }
      if (isConnected) {
        socket.emit('pairing_error', 'Já conectado.');
        return;
      }
      if (pairingCooldown) {
        socket.emit('pairing_error', 'Aguarde 10s entre tentativas.');
        return;
      }
      if (!activeSock) {
        socket.emit('pairing_error', 'Socket não inicializado. Aguarde.');
        return;
      }

      const cleaned = String(phoneNumber).replace(/\D/g, '');
      if (cleaned.length < 10 || cleaned.length > 15) {
        socket.emit('pairing_error', 'Número inválido. Use formato: 5511999998888');
        return;
      }

      try {
        pairingInProgress = true;
        pairingCooldown = true;
        emitConnectionState(io);
        setTimeout(() => { pairingCooldown = false; }, 10000);

        pushLog(io, `🔗 Solicitando código de pareamento para ${cleaned}...`);
        const code = await activeSock.requestPairingCode(cleaned);
        pushLog(io, `🔗 Código gerado: ${code}`);
        socket.emit('pairing_code', code);
        emitConnectionState(io);

        setTimeout(() => {
          pairingInProgress = false;
          emitConnectionState(io);
        }, 30000);
      } catch (e) {
        pairingInProgress = false;
        pushLog(io, `❌ Erro ao gerar código: ${e.message}`);
        socket.emit('pairing_error', e.message);
        emitConnectionState(io);
      }
    });
  });

  socketListenerConfigurado = true;
};

export const configurarWhatsAppSobDemanda = (io, onReady) => {
  currentIo = io || currentIo;
  currentOnReady = onReady || currentOnReady;
  setupSocketIoListeners(currentIo);
  emitConnectionState(currentIo);
};

export const getWhatsAppState = () => ({
  started: manualStartRequested,
  starting: isStarting,
  connected: isConnected,
  hasQr: !!lastQrCode,
  pairingInProgress,
});

export const stopWhatsApp = async ({ clearAuth = true, reason = 'Encerrado pelo operador.' } = {}) => {
  manualStartRequested = false;
  isStarting = false;
  pairingInProgress = false;
  pairingCooldown = false;
  lastQrCode = null;

  if (activeSock) {
    try { await activeSock.logout(); } catch (_) {}
    try { activeSock.end?.(undefined); } catch (_) {}
    try { activeSock.ws?.close?.(); } catch (_) {}
    activeSock = null;
  }

  isConnected = false;

  if (clearAuth) limparCacheAuth();

  pushLog(currentIo, `🛑 ${reason}`);
  emitConnectionState(currentIo);
  return getWhatsAppState();
};

export const iniciarWhatsApp = async (arg1, arg2) => {
  let io = null;
  let onReady = null;

  if (arg1 && typeof arg1.emit === 'function') {
    io = arg1;
    onReady = arg2;
  } else {
    onReady = arg1;
  }

  currentIo = io || currentIo;
  currentOnReady = onReady || currentOnReady;
  setupSocketIoListeners(currentIo);

  manualStartRequested = true;

  if (isStarting) return activeSock;

  isStarting = true;
  emitConnectionState(currentIo);
  pushLog(currentIo, '🏁 Iniciando Robô Soline...');

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    pushLog(currentIo, `📡 Usando WhatsApp Web v${version.join('.')} (Mais recente: ${isLatest})`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      browser: ['Ubuntu', 'Chrome', '110.0.0.0'],
      syncFullHistory: false,
    });

    activeSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        isConnected = false;
        isStarting = false;
        if (pairingInProgress) {
          pushLog(currentIo, '🔗 QR ignorado — aguardando pareamento via código...');
          emitConnectionState(currentIo);
          return;
        }
        if (currentIo) {
          pushLog(currentIo, '👉 Gerando QR Code para o painel web...');
          try {
            const qrImageUrl = await QRCode.toDataURL(qr);
            lastQrCode = qrImageUrl;
            currentIo.emit('qr', qrImageUrl);
          } catch (e) {
            console.error('Erro QR:', e);
          }
        }
        emitConnectionState(currentIo);
      }

      if (connection === 'close') {
        isConnected = false;
        isStarting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        activeSock = null;
        lastQrCode = null;

        if (!manualStartRequested) {
          pushLog(currentIo, '⏹️ Conexão WhatsApp encerrada.');
          emitConnectionState(currentIo);
          return;
        }

        if (pairingInProgress) {
          pushLog(currentIo, '🔗 Reconectando para completar pareamento...');
          emitConnectionState(currentIo);
          setTimeout(() => {
            if (manualStartRequested) iniciarWhatsApp(currentIo, currentOnReady);
          }, 3000);
          return;
        }

        if (!isLoggedOut) {
          pushLog(currentIo, `⚠️ Conexão caiu (Status: ${statusCode}). Reconectando em 5s...`);
          emitConnectionState(currentIo);
          setTimeout(() => {
            if (manualStartRequested) iniciarWhatsApp(currentIo, currentOnReady);
          }, 5000);
        } else {
          pushLog(currentIo, '🔴 Aparelho desconectado pelo celular. Limpando dados e preparando novo QR Code...');
          limparCacheAuth();
          emitConnectionState(currentIo);
          setTimeout(() => {
            if (manualStartRequested) iniciarWhatsApp(currentIo, currentOnReady);
          }, 3000);
        }
      } else if (connection === 'open') {
        isConnected = true;
        isStarting = false;
        lastQrCode = null;
        pairingInProgress = false;
        pushLog(currentIo, '✅ WhatsApp Conectado!');
        if (currentIo) currentIo.emit('connected');
        emitConnectionState(currentIo);

        try {
          const modo = currentIo ? 'Dashboard Web' : 'Modo Terminal';
          await sock.sendMessage(`${config.NUMERO_ADMIN}@s.whatsapp.net`, {
            text: `✅ *Bot Iniciado!*\nModo: ${modo}\nStatus: Online e Monitorando.`
          });
        } catch (_) {}

        if (currentOnReady) currentOnReady(sock, (msg) => pushLog(currentIo, msg));
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const m = messages[0];
      if (!m?.message) return;
      if (m.key.fromMe) return;

      const remoteJid = m.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const isStatus = remoteJid === 'status@broadcast';
      if (isStatus) return;
      if (isGroup && remoteJid === config.GROUP_ID) return;

      if (isGroup) {
        const dadosGrupo = {
          id: remoteJid,
          pushName: m.pushName || 'Desconhecido',
          subject: 'Grupo Detectado'
        };
        if (currentIo) currentIo.emit('group_detected', dadosGrupo);
        return;
      }

      const senderNumber = remoteJid.replace('@s.whatsapp.net', '');
      const isAdmin = senderNumber === config.NUMERO_ADMIN;
      if (isAdmin) return;

      const nome = m.pushName || 'Cliente';
      pushLog(currentIo, `📩 Auto-resposta disparada para: ${nome}`);
      await sock.sendPresenceUpdate('composing', remoteJid);
      await delay(2500);

      const texto = `Esse é o bot da Soline ✨💛\nPor aqui as mensagens não são respondidas, mas você pode falar conosco pelo link abaixo:\nhttps://wa.me/${config.SEU_NUMERO_ATENDIMENTO}`.trim();
      await sock.sendMessage(remoteJid, { text: texto });
      await sock.sendPresenceUpdate('paused', remoteJid);
    });

    return sock;
  } catch (error) {
    isStarting = false;
    pushLog(currentIo, `❌ Falha ao iniciar WhatsApp: ${error.message}`);
    emitConnectionState(currentIo);
    throw error;
  }
};
