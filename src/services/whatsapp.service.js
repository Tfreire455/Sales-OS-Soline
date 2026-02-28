import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode'; 
import pino from 'pino';
import { limparCacheAuth } from './auth.service.js';
import { config } from '../config/settings.js';
import { delay } from '../utils/formatters.js';

// --- ESTADO GLOBAL DO SERVIÇO ---
let isConnected = false;
let lastQrCode = null;
const logHistory = []; // Guarda os últimos 50 logs

// Função auxiliar para guardar log e enviar pro site
const pushLog = (io, msg) => {
    console.log(msg); // Terminal
    
    if (logHistory.length > 50) logHistory.shift();
    logHistory.push(msg);

    if (io) io.emit('log', msg);
};

let socketListenerConfigurado = false;

export const iniciarWhatsApp = async (arg1, arg2) => {
    
    let io = null;
    let onReady = null;

    if (arg1 && typeof arg1.emit === 'function') {
        io = arg1;      
        onReady = arg2;
    } else {
        onReady = arg1; 
    }

    const log = (msg) => pushLog(io, msg);

    // --- SOCKET.IO: Sincronização Inicial ---
    if (io && !socketListenerConfigurado) {
        io.on('connection', (socket) => {
            if (isConnected) socket.emit('connected');
            if (lastQrCode && !isConnected) socket.emit('qr', lastQrCode);
            logHistory.forEach(l => socket.emit('log', l));
        });
        socketListenerConfigurado = true;
    }

    log('🏁 Iniciando Robô Soline...');

    // 🔥 CORREÇÃO 1: Busca a versão mais recente do WhatsApp Web para evitar o erro 405
    const { version, isLatest } = await fetchLatestBaileysVersion();
    log(`📡 Usando WhatsApp Web v${version.join('.')} (Mais recente: ${isLatest})`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        version, // 🔥 CORREÇÃO 2: Injeta a versão dinâmica aqui
        auth: state,
        // printQRInTerminal foi removido para evitar o warning amarelo
        logger: pino({ level: 'silent' }),
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        browser: ['Ubuntu', 'Chrome', '110.0.0.0'], // Navegador estável para o seu ambiente
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            isConnected = false;
            if (io) {
                log('👉 Gerando QR Code para o Painel Web...');
                try {
                    const qrImageUrl = await QRCode.toDataURL(qr);
                    lastQrCode = qrImageUrl;
                    io.emit('qr', qrImageUrl);
                } catch (e) {
                    console.error('Erro QR:', e);
                }
            } else {
                // Como não estamos mais usando o printQRInTerminal, você pode logar a string pura do QR aqui se quiser ler pelo terminal, ou apenas aguardar o Web.
                log('👉 QR Code gerado. Escaneie pelo Dashboard da Sales OS.');
            }
        }

        if (connection === 'close') {
            isConnected = false;
            lastQrCode = null;
            
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            
            if (!isLoggedOut) {
                log(`⚠️ Conexão caiu (Status: ${statusCode}). Reconectando em 5s...`);
                setTimeout(() => iniciarWhatsApp(arg1, arg2), 5000);
            } else {
                log('🔴 Aparelho desconectado pelo celular. Limpando dados e preparando novo QR Code...');
                limparCacheAuth(); 
                setTimeout(() => iniciarWhatsApp(arg1, arg2), 3000);
            }
        } 
        
        else if (connection === 'open') {
            isConnected = true;
            lastQrCode = null;
            log('✅ WhatsApp Conectado!');
            
            if (io) io.emit('connected'); 
            
            try {
                const modo = io ? 'Dashboard Web' : 'Modo Terminal';
                await sock.sendMessage(`${config.NUMERO_ADMIN}@s.whatsapp.net`, { 
                    text: `✅ *Bot Iniciado!*\nModo: ${modo}\nStatus: Online e Monitorando.` 
                });
            } catch (e) {
                // Ignora erro silenciosamente
            }

            if (onReady) onReady(sock, log); 
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const remoteJid = m.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const isStatus = remoteJid === 'status@broadcast';

        if (isGroup) {
            const dadosGrupo = {
                id: remoteJid,
                pushName: m.pushName || 'Desconhecido',
                subject: 'Grupo Detectado' 
            };
            if (io) io.emit('group_detected', dadosGrupo);
        }

        if (!isGroup && !isStatus) {
            if (remoteJid.includes(config.NUMERO_ADMIN)) return;

            const nome = m.pushName || 'Cliente';
            log(`📩 Auto-resposta disparada para: ${nome}`);
            
            await sock.sendPresenceUpdate('composing', remoteJid);
            await delay(2500);

            const texto = `Esse é o bot da Soline ✨💛\nPor aqui as mensagens não são respondidas, mas você pode falar conosco pelo link abaixo:\nhttps://wa.me/${config.SEU_NUMERO_ATENDIMENTO}`.trim();

            await sock.sendMessage(remoteJid, { text: texto });
            await sock.sendPresenceUpdate('paused', remoteJid);
        }
    });

    return sock;
};