import express from 'express';
import session from 'express-session';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import cron from 'node-cron';

// Serviços
import { iniciarWhatsApp } from './services/whatsapp.service.js';
import { DatabaseService } from './services/postgres.service.js';
import { gerarCopyComIA } from './services/openai.service.js';
import { config } from './config/settings.js';

// Google Sheets (para migração via dashboard)
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

// Utils
import { delay, getRandomDelay, getDirectDriveLink, getDriveFallbackUrls, getDriveImageLink, extrairDriveId } from './utils/formatters.js';
import { validarLinkImagem } from './utils/validators.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────
let CAMPAIGN_STATE = { active: false, mode: 'NORMAL', filter: null, startTime: null };
let DYNAMIC_CONFIG = {};
let CAMPAIGN_TIMER = null;
let ACTIVE_SOCK = null;
let SLEEP_TOKEN = 0;
let BOT_PAUSED = false;

// [FIX] Centraliza toda mutação de CAMPAIGN_STATE em uma única função.
// Isso evita race conditions causadas por múltiplos escritores espalhados
// pelo código e garante que o evento de Socket seja sempre emitido junto.
function setCampaignState(updates) {
    CAMPAIGN_STATE = { ...CAMPAIGN_STATE, ...updates };
    io.emit('campaign_update', CAMPAIGN_STATE);
}

const wakeBot = () => {
    SLEEP_TOKEN++;
    console.log("⚡ [SISTEMA] Acordando bot para reavaliar agenda...");
};

// ─────────────────────────────────────────────────────────────
// INSTÂNCIA SINGLETON DO BANCO
// [FIX] Uma única conexão compartilhada por todo o processo,
// em vez de new DatabaseService() a cada requisição HTTP.
// Evita esgotar o pool de conexões do PostgreSQL.
// ─────────────────────────────────────────────────────────────
const db = new DatabaseService();

// ─────────────────────────────────────────────────────────────
// DELAY CANCELÁVEL
// ─────────────────────────────────────────────────────────────
async function delayInterruptible(ms, tokenAtStart, stepMs = 1000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (SLEEP_TOKEN !== tokenAtStart) return false;
        const remaining = end - Date.now();
        await delay(Math.min(stepMs, remaining));
    }
    return true;
}

// ─────────────────────────────────────────────────────────────
// DESPERTADOR
// ─────────────────────────────────────────────────────────────
async function agendarDespertador() {
    if (CAMPAIGN_TIMER) clearTimeout(CAMPAIGN_TIMER);

    try {
        const prox = await db.getNextSchedule();
        if (prox) {
            const agora = new Date();
            const inicio = new Date(prox.data_inicio);
            const msAteInicio = inicio.getTime() - agora.getTime();

            const inicioUTC = inicio.toISOString().replace('T', ' ').substring(0, 19);
            const inicioBR  = inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

            if (msAteInicio > 0 && msAteInicio < 86400000) {
                console.log(`\n⏰ DESPERTADOR ARMADO: '${prox.nome_evento}'`);
                console.log(`   🌍 UTC (Banco):  ${inicioUTC} Z`);
                console.log(`   🇧🇷 BRT (Real):   ${inicioBR}`);
                console.log(`   ⏳ Dispara em:   ${(msAteInicio / 60000).toFixed(1)} minutos`);

                CAMPAIGN_TIMER = setTimeout(() => {
                    console.log(`🔔 DRIIIIING! Hora da campanha: ${prox.nome_evento}`);
                    wakeBot();
                }, msAteInicio + 1000);
            }
        }
    } catch (e) {
        console.error("Erro Despertador:", e.message);
    }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Headers que simulam um navegador real — sem eles, Google retorna 403
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://drive.google.com/',
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
};

/**
 * Faz download de uma imagem e retorna um Buffer limpo.
 * 
 * Para links do Google Drive, tenta até 3 endpoints diferentes
 * em cascata (uc?export → usercontent → lh3 thumbnail).
 * 
 * Cada tentativa inclui:
 *   - Headers de navegador real (User-Agent, Accept, Referer)
 *   - Follow de redirects (padrão do fetch)
 *   - Timeout de 20s por tentativa
 *   - Validação do Content-Type (rejeita HTML = página de erro)
 */
async function getMediaBuffer(originalUrl) {
    const urls = getDriveFallbackUrls(originalUrl);

    for (const url of urls) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);

            const res = await fetch(url, {
                signal: controller.signal,
                headers: BROWSER_HEADERS,
                redirect: 'follow',
            });

            clearTimeout(timeoutId);

            if (!res.ok) {
                console.warn(`⚠️ [getMediaBuffer] ${res.status} em ${url.substring(0, 80)}...`);
                continue; // tenta próximo fallback
            }

            // VALIDAÇÃO CRÍTICA: Google retorna 200 + text/html quando bloqueia.
            // Se o Content-Type não for imagem, descartamos e tentamos o próximo.
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
                console.warn(`⚠️ [getMediaBuffer] Resposta HTML (bloqueio Google) em ${url.substring(0, 80)}...`);
                continue;
            }

            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Verifica se o buffer tem tamanho mínimo razoável (> 1KB)
            if (buffer.length < 1024) {
                console.warn(`⚠️ [getMediaBuffer] Buffer muito pequeno (${buffer.length} bytes), provavelmente inválido.`);
                continue;
            }

            return buffer;

        } catch (e) {
            console.warn(`⚠️ [getMediaBuffer] Erro: ${e.message} em ${url.substring(0, 80)}...`);
            continue;
        }
    }

    // Se todos os fallbacks falharam
    console.error(`❌ [getMediaBuffer] Todas as tentativas falharam para: ${originalUrl}`);
    return null;
}

function getMensagemFimCampanha(nomeEvento) {
    const nome = nomeEvento || "Evento";
    const msgs = [
        `✨ *${nome} Finalizado!* ✨\n\nTodas as peças foram apresentadas. Obrigada a todas! 🥰\n\nFiquem ligadas, logo mais teremos novidades!`,
        `💎 *Encerrado por hoje!* 💎\n\nO ${nome} foi um sucesso absoluto. Quem garantiu, garantiu! 😉\n\nAtivem as notificações.`,
        `🚀 *Fim da Edição!*\n\nAgradecemos a preferência no *${nome}*. Foi incrível!\n\nEm breve voltamos com mais peças exclusivas. ✨`
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
}

// [FIX] Cálculo de hora BR via Intl — robusto a horário de verão.
// A subtração manual getUTCHours() - 3 quebraria se o Brasil voltasse
// a adotar DST (UTC-2 no verão).
function getHoraBR() {
    return parseInt(
        new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            hour: 'numeric',
            hour12: false
        }).format(new Date())
    );
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARES
// ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: config.DASHBOARD.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, httpOnly: true, maxAge: 86400000 }
}));

const requireAuth = (req, res, next) => {
    req.session.authenticated ? next() : res.redirect('/login');
};

// ─────────────────────────────────────────────────────────────
// ROTAS WEB
// ─────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/html', 'login.html')));

app.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }), (req, res) => {
    const { username, password } = req.body;
    if (username === config.DASHBOARD.USER && password === config.DASHBOARD.PASS) {
        req.session.authenticated = true;
        res.redirect('/');
    } else {
        res.redirect('/login?error=1');
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/html', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─────────────────────────────────────────────────────────────
// APIs — Produtos
// ─────────────────────────────────────────────────────────────

// PROXY DE IMAGENS — resolve CORS e bloqueio do Google Drive no front-end
// O navegador pede ao SEU servidor, que busca a imagem com headers de bot.
// Isso elimina 100% dos problemas de CORS no <img>.
// PROXY DE IMAGENS — resolve CORS/bloqueio do Google Drive no front-end
app.get('/api/image-proxy', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL obrigatória');

  // Segurança básica: evita SSRF óbvio
  const raw = String(url);
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    return res.status(400).send('URL inválida');
  }

  try {
    const urls = getDriveFallbackUrls(raw);

    for (const targetUrl of urls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(targetUrl, {
          headers: BROWSER_HEADERS,
          redirect: 'follow',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) continue;

        const contentType = (response.headers.get('content-type') || '').toLowerCase();

        // Bloqueio clássico do Google: 200 + HTML
        if (contentType.includes('text/html') || contentType.includes('text/plain')) continue;

        // Aceita só imagem
        if (!contentType.startsWith('image/')) continue;

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (buffer.length < 1024) continue;

        res.set({
          'Content-Type': contentType,
          'Content-Length': buffer.length,
          'Cache-Control': 'private, max-age=3600', // 1h no browser (private por ter auth)
          'X-Image-Source': 'drive-proxy',
          'Vary': 'Cookie',
        });

        return res.send(buffer);
      } catch {
        continue;
      }
    }

    return res.status(502).send('Imagem indisponível');
  } catch (e) {
    console.error('[image-proxy]', e.message);
    return res.status(500).send('Erro interno');
  }
});

app.get('/api/produtos', requireAuth, async (req, res) => {
    try {
        res.json(await db.getAllProducts());
    } catch (e) {
        console.error('[GET /api/produtos]', e.message);
        res.status(500).json([]);
    }
});

app.post('/api/produtos/reset/:sku', requireAuth, async (req, res) => {
    try {
        await db.resetarItem(req.params.sku);
        res.json({ success: true });
    } catch (e) {
        console.error('[POST /api/produtos/reset]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/produtos/prioridade/:sku', requireAuth, async (req, res) => {
    try {
        await db.togglePrioridade(req.params.sku);
        res.json({ success: true });
    } catch (e) {
        console.error('[POST /api/produtos/prioridade]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/collections', requireAuth, async (req, res) => {
    try {
        res.json(await db.getCollectionsList());
    } catch (e) {
        console.error('[GET /api/collections]', e.message);
        res.status(500).json([]);
    }
});

app.post('/api/produtos/reset-all', requireAuth, async (req, res) => {
    try {
        await db.resetarCatalogo();
        io.emit('log', '♻️ Catálogo resetado.');
        wakeBot();
        res.json({ success: true });
    } catch (e) {
        console.error('[POST /api/produtos/reset-all]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────
// APIs — Campanha
// ─────────────────────────────────────────────────────────────
app.get('/api/campaign/status', requireAuth, (req, res) => res.json(CAMPAIGN_STATE));

app.post('/api/campaign/start', requireAuth, (req, res) => {
    const { mode, filter } = req.body;
    setCampaignState({ active: true, mode: mode.toUpperCase(), filter: filter || null, startTime: Date.now() });
    io.emit('log', `🚀 Manual Iniciado: ${mode}`);
    wakeBot();
    res.json({ success: true });
});

app.post('/api/campaign/stop', requireAuth, (req, res) => {
    setCampaignState({ active: false, mode: 'NORMAL', filter: null, startTime: null });
    io.emit('log', `🛑 Parado.`);
    wakeBot();
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// APIs — Pausar / Retomar Bot
// ─────────────────────────────────────────────────────────────
app.get('/api/bot/status', requireAuth, (req, res) => {
    res.json({ paused: BOT_PAUSED });
});

app.post('/api/bot/pause', requireAuth, (req, res) => {
    BOT_PAUSED = true;
    io.emit('bot_paused', true);
    io.emit('log', '⏸️ Bot PAUSADO pelo operador.');
    res.json({ success: true, paused: true });
});

app.post('/api/bot/resume', requireAuth, (req, res) => {
    BOT_PAUSED = false;
    io.emit('bot_paused', false);
    io.emit('log', '▶️ Bot RETOMADO pelo operador.');
    wakeBot();
    res.json({ success: true, paused: false });
});

// ─────────────────────────────────────────────────────────────
// APIs — Migração (Planilha → Banco) com Senha
// ─────────────────────────────────────────────────────────────
app.post('/api/migrate', requireAuth, async (req, res) => {
    const { password } = req.body;
    if (!password || password !== config.DASHBOARD.PASS) {
        return res.status(403).json({ error: 'Senha incorreta.' });
    }

    io.emit('log', '🚀 Iniciando Migração (Planilha → Banco)...');

    try {
        const normalize = (str) => {
            if (!str) return '';
            return str.toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        };

        // Garante estrutura
        await db.executeQuery(`
            CREATE TABLE IF NOT EXISTS produtos (
                id SERIAL PRIMARY KEY, nome TEXT NOT NULL, sku TEXT UNIQUE NOT NULL,
                valor TEXT, categoria TEXT, estoque INTEGER DEFAULT 0,
                image_url TEXT, reposicao BOOLEAN DEFAULT FALSE,
                colecao TEXT, status TEXT DEFAULT '', prioridade BOOLEAN DEFAULT FALSE
            );
        `);
        await db.executeQuery(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS prioridade BOOLEAN DEFAULT FALSE;`);
        await db.executeQuery(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS colecao TEXT;`);

        io.emit('log', '📊 Lendo Google Sheets...');

        const auth = new JWT({
            email: config.GOOGLE_CREDS.client_email,
            key: config.GOOGLE_CREDS.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(config.SHEET_ID, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        await sheet.loadHeaderRow();
        const headerValues = sheet.headerValues;
        const rows = await sheet.getRows();

        io.emit('log', `📋 Cabeçalhos: [${headerValues.join(', ')}]`);

        const findKey = (possiveisNomes) => headerValues.find(h => possiveisNomes.includes(normalize(h)));

        const keySKU  = findKey(['sku', 'codigo', 'ref', 'cod']);
        const keyNome = findKey(['nome', 'name', 'produto', 'titulo', 'descricao']);
        const keyValor= findKey(['valor', 'preco', 'price']);
        const keyEstoque = findKey(['estoque', 'qtd', 'quantidade']);
        const keyImg  = findKey(['imagem', 'foto', 'image', 'url', 'link', 'imageurl']);
        const keyCat  = findKey(['categoria', 'category', 'tipo']);
        const keyRepo = findKey(['reposicao', 'reposição', 'repo']);
        const keyCol  = findKey(['colecao', 'coleção', 'collection', 'campanha', 'tema']);

        if (!keySKU) {
            io.emit('log', '❌ Coluna SKU não encontrada na planilha!');
            return res.status(400).json({ error: 'Coluna SKU não encontrada na planilha!' });
        }

        const skusNaPlanilha = [];
        let inseridos = 0, colecoesEncontradas = 0;

        await db.executeQuery('BEGIN');

        for (const row of rows) {
            const sku = row.get(keySKU);
            if (!sku) continue;
            skusNaPlanilha.push(sku);

            const nome    = row.get(keyNome) || 'Produto Sem Nome';
            const valor   = row.get(keyValor);
            const estoque = parseInt(row.get(keyEstoque)) || 0;
            const img     = row.get(keyImg);
            const cat     = row.get(keyCat) || 'Geral';
            const repoRaw = row.get(keyRepo);
            const repo    = repoRaw ? (String(repoRaw).trim().toLowerCase() === 'sim' || String(repoRaw).trim().toLowerCase() === 'true') : false;

            let col = null;
            if (keyCol) {
                const rawCol = row.get(keyCol);
                if (rawCol && typeof rawCol === 'string' && rawCol.trim() !== '') {
                    col = rawCol.trim();
                    colecoesEncontradas++;
                }
            }

            await db.executeQuery(`
                INSERT INTO produtos (nome, sku, valor, categoria, estoque, image_url, reposicao, colecao)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (sku) DO UPDATE SET
                nome = EXCLUDED.nome, estoque = EXCLUDED.estoque, valor = EXCLUDED.valor,
                categoria = EXCLUDED.categoria, reposicao = EXCLUDED.reposicao,
                colecao = EXCLUDED.colecao, image_url = EXCLUDED.image_url;
            `, [nome, sku, valor, cat, estoque, img, repo, col]);
            inseridos++;
        }

        if (skusNaPlanilha.length > 0) {
            const resDelete = await db.executeQuery(`DELETE FROM produtos WHERE sku != ALL($1::text[])`, [skusNaPlanilha]);
            if (resDelete.rowCount > 0) io.emit('log', `🗑️ ${resDelete.rowCount} itens antigos removidos.`);
        }

        await db.executeQuery('COMMIT');

        const msg = `✅ Migração concluída! ${inseridos} produtos | ${colecoesEncontradas} com coleção`;
        io.emit('log', msg);
        res.json({ success: true, total: inseridos, colecoes: colecoesEncontradas });

    } catch (error) {
        try { await db.executeQuery('ROLLBACK'); } catch {}
        const errMsg = `❌ Erro na migração: ${error.message}`;
        io.emit('log', errMsg);
        console.error(errMsg, error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
// APIs — Settings
// ─────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
    try {
        if (Object.keys(DYNAMIC_CONFIG).length === 0) DYNAMIC_CONFIG = await db.getSettings();
        res.json(DYNAMIC_CONFIG);
    } catch (e) {
        console.error('[GET /api/settings]', e.message);
        res.status(500).json({});
    }
});

app.post('/api/settings', requireAuth, async (req, res) => {
    try {
        for (const [key, value] of Object.entries(req.body)) await db.updateSetting(key, value);
        DYNAMIC_CONFIG = await db.getSettings();
        io.emit('log', '⚙️ Configs atualizadas.');
        wakeBot();
        res.json({ success: true });
    } catch (e) {
        console.error('[POST /api/settings]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────
// APIs — Schedule
// ─────────────────────────────────────────────────────────────
app.get('/api/schedule', requireAuth, async (req, res) => {
    try {
        res.json(await db.getSchedules());
    } catch (e) {
        console.error('[GET /api/schedule]', e.message);
        res.status(500).json([]);
    }
});

app.post('/api/schedule', requireAuth, async (req, res) => {
    try {
        await db.createSchedule(req.body);
        io.emit('log', '📅 Agendado!');
        wakeBot();
        res.json({ success: true });
    } catch (e) {
        console.error('[POST /api/schedule]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/schedule/:id', requireAuth, async (req, res) => {
    try {
        await db.updateSchedule(req.params.id, req.body);
        io.emit('log', '✏️ Atualizado.');
        wakeBot();
        res.json({ success: true });
    } catch (e) {
        console.error('[PUT /api/schedule]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/schedule/:id', requireAuth, async (req, res) => {
    try {
        await db.deleteSchedule(req.params.id);
        io.emit('log', '🗑️ Removido.');
        wakeBot();
        res.json({ success: true });
    } catch (e) {
        console.error('[DELETE /api/schedule]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────
// APIs — VIP
// ─────────────────────────────────────────────────────────────

// ROTA 1: CADASTRO (pública — chamada pelo site Vercel)
app.post('/api/vip/cadastro', async (req, res) => {
    const { nome, whatsapp, nascimento } = req.body;

    // [FIX] Validação de entrada antes de tocar no banco.
    // Rota pública: qualquer pessoa pode chamá-la, então precisamos
    // garantir tipos, tamanhos e formatos corretos.
    if (!nome || !whatsapp || !nascimento) {
        return res.status(400).json({ error: 'Campos obrigatórios: nome, whatsapp, nascimento' });
    }

    const numbersOnly = String(whatsapp).replace(/\D/g, '');
    if (numbersOnly.length < 10 || numbersOnly.length > 15) {
        return res.status(400).json({ error: 'Número de WhatsApp inválido' });
    }

    const nomeClean = String(nome).trim().substring(0, 100);
    const nascDate = new Date(nascimento);
    if (isNaN(nascDate.getTime())) {
        return res.status(400).json({ error: 'Data de nascimento inválida' });
    }

    const numeroFinal = numbersOnly.length <= 11 ? '55' + numbersOnly : numbersOnly;

    try {
        await db.executeQuery(
            `INSERT INTO leads_vip (nome, whatsapp, data_nascimento)
             VALUES ($1, $2, $3)
             ON CONFLICT (whatsapp) DO UPDATE SET data_nascimento = $3, nome = $1`,
            [nomeClean, numeroFinal, nascimento]
        );
        console.log(`🎂 Novo VIP cadastrado: ${nomeClean}`);
        res.json({ success: true });
    } catch (e) {
        console.error("Erro VIP cadastro:", e);
        res.status(500).json({ error: "Erro interno" });
    }
});

// ROTA 2: ANIVERSARIANTES PARA O CALENDÁRIO
app.get('/api/vip/aniversariantes', requireAuth, async (req, res) => {
    try {
        const result = await db.executeQuery("SELECT id, nome, data_nascimento FROM leads_vip");
        const hoje = new Date();

        const events = result.rows.map(vip => {
            // [FIX] Extrair mês e dia direto da string ISO do banco,
            // sem construir um objeto Date que sofre offset de fuso horário.
            // O +1 dia manual era um workaround que quebrava em datas como dia 31.
            const isoStr = vip.data_nascimento instanceof Date
                ? vip.data_nascimento.toISOString()
                : String(vip.data_nascimento);
            const [, mm, dd] = isoStr.split('T')[0].split('-');

            return {
                id: `vip_${vip.id}`,
                title: `🎂 ${vip.nome.split(' ')[0]}`,
                start: `${hoje.getFullYear()}-${mm}-${dd}`,
                allDay: true,
                type: 'BIRTHDAY'
            };
        });

        res.json(events);
    } catch (e) {
        console.error('[GET /api/vip/aniversariantes]', e.message);
        res.status(500).json([]);
    }
});

// ROTA 3: LISTA COMPLETA DE VIPS
app.get('/api/vip/list', requireAuth, async (req, res) => {
    try {
        const result = await db.executeQuery("SELECT * FROM leads_vip ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (e) {
        console.error('[GET /api/vip/list]', e.message);
        res.status(500).json({ error: "Erro ao buscar lista" });
    }
});

// ROTA 4: DELETAR VIP
app.delete('/api/vip/:id', requireAuth, async (req, res) => {
    try {
        await db.executeQuery("DELETE FROM leads_vip WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('[DELETE /api/vip]', e.message);
        res.status(500).json({ error: "Erro ao deletar" });
    }
});

// ─────────────────────────────────────────────────────────────
// CRON JOB — PARABÉNS VIP 🎂
// [FIX] timezone explícito para garantir disparo às 09:00 BRT
// independente do fuso do servidor (VPS geralmente rodam em UTC).
// ─────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
    console.log("🎂 [CRON] Checando aniversariantes...");

    if (!ACTIVE_SOCK) {
        console.log("⚠️ [CRON] WhatsApp desconectado. Abortando disparos de aniversário.");
        return;
    }

    try {
        const res = await db.executeQuery(`
            SELECT nome, whatsapp FROM leads_vip
            WHERE EXTRACT(MONTH FROM data_nascimento) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(DAY FROM data_nascimento) = EXTRACT(DAY FROM CURRENT_DATE)
        `);

        if (res.rows.length === 0) {
            console.log("🎂 Nenhum aniversariante hoje.");
            return;
        }

        console.log(`🎂 Encontrados ${res.rows.length} aniversariantes! Disparando...`);

        for (const vip of res.rows) {
            const nome = vip.nome.split(' ')[0];
            const msg = `🥳 Parabéns, *${nome}*! 🎉\n\n` +
                        `Vi aqui que hoje é seu dia especial! A Equipe Soline te deseja muitas felicidades! ✨\n\n` +
                        `🎁 *PRESENTE:* Use o cupom *NIVERVIP* para ter 15% OFF em todo o site hoje!\n\n` +
                        `Aproveite seu dia! 💎`;

            const jid = `${vip.whatsapp}@s.whatsapp.net`;

            try {
                await ACTIVE_SOCK.sendMessage(jid, { text: msg });
                console.log(`✅ Parabéns enviado para ${nome}`);
                await delay(5000 + Math.random() * 5000);
            } catch (err) {
                console.error(`❌ Erro ao enviar para ${nome}:`, err.message);
            }
        }
    } catch (e) {
        console.error("❌ Erro no Cron de Aniversário:", e);
    }
}, {
    timezone: 'America/Sao_Paulo'   // [FIX] Fuso explícito
});

// =============================================================================
// MOTOR DE VENDAS (ENGINE)
// [FIX] Substituída recursão infinita por loop while(true).
//
// O código original chamava cicloDeVendas() a si mesmo em ~8 pontos como
// forma de "reiniciar" o ciclo. Em Node.js cada chamada recursiva empilha um
// novo frame na call stack. Rodando 24/7, isso inevitavelmente causa
// Stack Overflow e derruba o processo silenciosamente.
//
// Com while(true) + continue, zero frames extras são empilhados e o loop
// roda indefinidamente sem vazamento de memória.
// =============================================================================
async function cicloDeVendas(log) {
    if (!log) log = (msg) => { console.log(msg); if (!msg.includes("Dormindo")) io.emit('log', msg); };

    while (true) {

        // [SEGURANÇA] WhatsApp desconectado — aguarda reconexão
        if (!ACTIVE_SOCK) {
            log("⚠️ WhatsApp desconectado. Aguardando reconexão...");
            await delay(5000);
            continue;
        }

        // [PAUSA] Bot pausado pelo dashboard — aguarda resume
        if (BOT_PAUSED) {
            log("⏸️ Bot pausado. Aguardando retomada...");
            const token = SLEEP_TOKEN;
            await delayInterruptible(10000, token);
            continue;
        }

        try {
            if (Object.keys(DYNAMIC_CONFIG).length === 0) {
                await db.init();
                DYNAMIC_CONFIG = await db.getSettings();
            }
        } catch (e) {
            console.error('[ciclo] Erro ao carregar settings:', e.message);
        }

        // 1. ARMA O DESPERTADOR
        await agendarDespertador();

        const agora = new Date();
        let ativa = null;
        let proxima = null;

        try {
            ativa = await db.checkActiveSchedule();
            proxima = await db.getNextSchedule();

            const agoraBR = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            console.log(`🔍 [DEBUG] Hora BR: ${agoraBR} | Ativa: ${ativa?.nome_evento || 'NÃO'}`);

            // --- TRAVA DE PRIORIDADE ABSOLUTA ---
            if (!ativa && proxima) {
                const msFaltam = new Date(proxima.data_inicio) - agora;
                if (msFaltam > 0 && msFaltam < (20 * 60 * 1000)) {
                    log(`⏳ Campanha '${proxima.nome_evento}' em ${(msFaltam / 60000).toFixed(1)} min. Aguardando...`);
                    await delayInterruptible(msFaltam + 2000, SLEEP_TOKEN);
                    continue;
                }
            }

            if (ativa) {
                // [CHECA SE JÁ ACABOU POR FALTA DE ESTOQUE]
                if (ativa.msg_fim_enviada) {
                    const msRestante = new Date(ativa.data_fim) - agora;
                    if (msRestante > 0) {
                        console.log(`💤 Campanha esgotada. Aguardando fim do horário...`);
                        await delayInterruptible(msRestante, SLEEP_TOKEN);
                    } else {
                        await delay(5000);
                    }
                    continue;
                }

                // [INICIA CAMPANHA]
                if (!CAMPAIGN_STATE.active || CAMPAIGN_STATE.mode !== ativa.modo) {
                    log(`🚨 CAMPANHA INICIADA: ${ativa.nome_evento}`);

                    if (!ativa.msg_inicio_enviada) {
                        try {
                            const dataFim = new Date(ativa.data_fim).toLocaleString('pt-BR', {
                                timeZone: 'America/Sao_Paulo',
                                day:'2-digit',
                                month:'short', 
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                            const msgAbertura = `🚀 *A CAMPANHA COMEÇOU!*\n\n💎 *Evento:* ${ativa.nome_evento}\n⏳ *Válido até:* ${dataFim}\n\nPreparamos ofertas imperdíveis. Confira! 👇`;
                            await ACTIVE_SOCK.sendMessage(config.GROUP_ID, { text: msgAbertura });
                            await db.markStartMsgAsSent(ativa.id);
                            await delay(3000);
                        } catch (e) {
                            log(`❌ Erro msg abertura: ${e.message}`);
                        }
                    }

                    setCampaignState({
                        active: true,
                        mode: ativa.modo,
                        filter: ativa.filtro || null,
                        startTime: Date.now()
                    });
                }
            } else {
                // [ENCERRAMENTO POR TEMPO]
                if (CAMPAIGN_STATE.active && CAMPAIGN_STATE.startTime) {
                    log(`🏁 Horário da campanha encerrado.`);
                    try {
                        const msgFim = getMensagemFimCampanha("Edição Especial");
                        await ACTIVE_SOCK.sendMessage(config.GROUP_ID, { text: msgFim });
                        log(`✅ Mensagem de encerramento enviada.`);
                    } catch (e) {
                        log(`❌ Erro msg fim: ${e.message}`);
                    }
                    setCampaignState({ active: false, mode: 'NORMAL', filter: null, startTime: null });
                }
            }
        } catch (e) {
            console.error("Erro Schedule Check:", e.message);
        }

        // 2. AVISOS PRÉVIOS
        try {
            const avisos = await db.checkPreLaunchMessages();
            for (const av of avisos) {
                log(`🔔 Aviso: ${av.nome_evento}`);
                try {
                    await ACTIVE_SOCK.sendMessage(config.GROUP_ID, { text: `📢 *AVISO IMPORTANTE*\n\n${av.msg_pre_lancamento}` });
                    await db.markPreLaunchAsSent(av.id);
                    await delay(3000);
                } catch (err) {
                    console.error('[avisos prévios] Erro ao enviar:', err.message);
                }
            }
        } catch (e) {
            console.error('[avisos prévios] Erro ao checar:', e.message);
        }

        // 3. MODO & HORÁRIO COMERCIAL
        const modoId = CAMPAIGN_STATE.active ? CAMPAIGN_STATE.mode : 'NORMAL';
        const modoAtual = { ...config.MODES[modoId] };
        if (DYNAMIC_CONFIG['INTERVALO_' + modoId]) modoAtual.INTERVALO_LOTE = DYNAMIC_CONFIG['INTERVALO_' + modoId];
        if (DYNAMIC_CONFIG['PROMPT_' + modoId]) modoAtual.PROMPT_STYLE = DYNAMIC_CONFIG['PROMPT_' + modoId];

        const hInicio = DYNAMIC_CONFIG['HORARIO_INICIO'] || config.HORARIO.INICIO;
        const hFim    = DYNAMIC_CONFIG['HORARIO_FIM']    || config.HORARIO.FIM;

        // [FIX] Usa Intl para calcular hora BRT — robusto a horário de verão
        const horaBR = getHoraBR();
        const comercial = (horaBR >= hInicio && horaBR < hFim);

        // Dormir se fora do horário comercial
        if (!CAMPAIGN_STATE.active && !comercial) {
            log(`🌙 Loja fechada (${hInicio}h às ${hFim}h).`);
            const token = SLEEP_TOKEN;
            let msSono = 30 * 60 * 1000;

            if (proxima) {
                const msAteProx = new Date(proxima.data_inicio).getTime() - Date.now();
                if (msAteProx > 0 && msAteProx < msSono) {
                    msSono = msAteProx + 1000;
                    log(`⚡ Campanha breve! Ajustando sono.`);
                }
            }

            await delayInterruptible(msSono, token);
            continue;
        }

        if (CAMPAIGN_STATE.active) log(`\n🔥 [CAMPANHA ATIVA] ${ativa ? ativa.nome_evento : modoId}`);
        else log(`\n🔄 [MODO NORMAL] Intervalo: ${modoAtual.INTERVALO_LOTE} min`);

        // TRAVA DE SEGURANÇA IMINENTE
        if (!CAMPAIGN_STATE.active && proxima) {
            const msAteInicio = new Date(proxima.data_inicio).getTime() - Date.now();
            const margemSeguranca = 30 * 60 * 1000;
            if (msAteInicio > 0 && msAteInicio < margemSeguranca) {
                log(`✋ MODO NORMAL PAUSADO! Campanha em ${(msAteInicio / 60000).toFixed(1)} min.`);
                await delayInterruptible(msAteInicio + 1000, SLEEP_TOKEN);
                continue;
            }
        }

        // 4. PROCESSAMENTO DO LOTE
        try {
            let lote = [];

            if (CAMPAIGN_STATE.active) {
                lote = await db.getCampaignProducts(CAMPAIGN_STATE.mode, CAMPAIGN_STATE.filter, modoAtual.ITENS_LOTE);

                if (lote.length === 0) {
                    log(`🏁 Campanha finalizada (estoque zero).`);
                    if (ativa && !ativa.msg_fim_enviada) {
                        try {
                            const msgFim = getMensagemFimCampanha(ativa.nome_evento);
                            await ACTIVE_SOCK.sendMessage(config.GROUP_ID, { text: msgFim });
                            await db.markEndMsgAsSent(ativa.id);
                            log(`✅ Mensagem de encerramento enviada.`);
                        } catch (e) {
                            log(`❌ Erro encerramento: ${e.message}`);
                        }
                    }
                    setCampaignState({ active: false, mode: 'NORMAL' });
                    wakeBot();
                    continue;
                }
            } else {
                const pendentes = await db.getPendentesCount();
                if (pendentes === 0) {
                    await db.resetarCatalogo();
                    log('♻️ Catálogo resetado.');
                    await delay(5000);
                }
                lote = await db.getMelhorMix(modoAtual.ITENS_LOTE);
            }

            log(`📦 Lote: ${lote.length} itens.`);

            for (const p of lote) {
                const checkAtiva = await db.checkActiveSchedule();
                if (checkAtiva && !CAMPAIGN_STATE.active) {
                    log("⚡ Campanha detectada! Interrompendo envio normal...");
                    break; // Sai do for, o while continuará na próxima iteração
                }

                const buffer = await getMediaBuffer(p.image_url);
                if (!buffer) {
                    log(`🚫 Erro Imagem: ${p.nome}`);
                    await db.marcarErroImagem(p.sku);
                    continue;
                }

                let copy;
                try {
                    copy = await gerarCopyComIA(p.nome, p.valor, p.sku, p.estoque, p.reposicao, p.colecao, CAMPAIGN_STATE.active ? modoAtual : null);
                } catch (e) {
                    copy = `✨ *${p.nome}*\n💎 R$ ${p.valor}`;
                }

                const caption = `${copy}\n\n👇 *COMPRE AQUI:* https://wa.me/${config.SEU_NUMERO_ATENDIMENTO}?text=${encodeURIComponent('Quero o ' + p.nome)}`;

                try {
                    await ACTIVE_SOCK.sendMessage(config.GROUP_ID, { image: buffer, caption });
                    await db.marcarComoEnviado(p.sku);
                    log(`✅ Enviado: ${p.nome}`);
                    await delay(getRandomDelay(modoAtual.DELAY_ENTRE_MSGS.MIN, modoAtual.DELAY_ENTRE_MSGS.MAX));
                } catch (e) {
                    log(`❌ Erro Zap: ${e.message}`);
                    if (e.message && (e.message.includes('Connection Closed') || e.message.includes('socket'))) {
                        log("🔄 Conexão instável. Pausando 10s...");
                        await delay(10000);
                    }
                    await delay(5000);
                }
            }

            // 5. ESPERA INTELIGENTE PÓS-LOTE
            let msEspera = modoAtual.INTERVALO_LOTE * 60000;
            const recheckProx = await db.getNextSchedule();

            if (recheckProx) {
                const msAteCampanha = new Date(recheckProx.data_inicio).getTime() - Date.now();
                if (msAteCampanha <= 0) msEspera = 1000;
                else if (msAteCampanha < msEspera) {
                    msEspera = msAteCampanha + 1000;
                    log(`⏱️ Ajustando espera: Campanha inicia em ${(msEspera / 60000).toFixed(1)} min.`);
                }
            }

            const horaAcordar = new Date(Date.now() + msEspera).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            log(`⏳ Aguardando ${(msEspera / 60000).toFixed(1)} min (Até ${horaAcordar})...`);

            const token = SLEEP_TOKEN;
            const completouSono = await delayInterruptible(msEspera, token, 5000);
            if (!completouSono) log(`⚡ Bot acordado manualmente!`);

        } catch (erro) {
            log(`❌ Erro Geral Ciclo: ${erro.message}`);
            await delay(30000);
        }

    } // fim while(true)
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
let loopIniciado = false;

iniciarWhatsApp(io, (sock, logFunction) => {
    ACTIVE_SOCK = sock;

    if (!loopIniciado) {
        loopIniciado = true;
        console.log("🔄 Loop de Vendas Iniciado.");
        cicloDeVendas(logFunction);
    } else {
        console.log("♻️ Conexão atualizada (Loop já rodando).");
    }
});

httpServer.listen(PORT, () => {
    console.log(`\n🚀 SALES OS ONLINE: http://localhost:${PORT}`);
});