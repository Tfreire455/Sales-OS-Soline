import express from "express";
import session from "express-session";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import cron from "node-cron";

import {
	configurarWhatsAppSobDemanda,
	iniciarWhatsApp,
	getWhatsAppState,
	stopWhatsApp,
} from "./services/whatsapp.service.js";
import { DatabaseService } from "./services/postgres.service.js";
import { gerarCopyComIA } from "./services/openai.service.js";
import { CRMSheetsService } from "./services/crmSheets.service.js";
import { config } from "./config/settings.js";

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

import {
	delay,
	getRandomDelay,
	getDriveFallbackUrls,
} from "./utils/formatters.js";
import { parseMoneyBR, toFixedMoney } from "./utils/currency.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Correção SquareCloud / proxies reversos
app.set("trust proxy", 1);

const httpServer = createServer(app);

const io = new Server(httpServer, {
	cors: {
		origin: true,
		credentials: true,
	},
});

const PORT = process.env.PORT || 80;

let CAMPAIGN_STATE = {
	active: false,
	mode: "NORMAL",
	filter: null,
	startTime: null,
};
let DYNAMIC_CONFIG = {};
let CAMPAIGN_TIMER = null;
let ACTIVE_SOCK = null;
let SLEEP_TOKEN = 0;
let BOT_PAUSED = false;
let loopIniciado = false;

function setCampaignState(updates) {
	CAMPAIGN_STATE = { ...CAMPAIGN_STATE, ...updates };
	io.emit("campaign_update", CAMPAIGN_STATE);
}

const wakeBot = () => {
	SLEEP_TOKEN++;
	console.log("⚡ [SISTEMA] Acordando bot para reavaliar agenda...");
};

const db = new DatabaseService();
const crmSheets = new CRMSheetsService();

function parseMoneyLike(value) {
	return toFixedMoney(parseMoneyBR(value));
}

async function syncClienteToCRMSheet(clienteId) {
	try {
		const resumo = await db.buildClienteResumo(clienteId);
		if (!resumo) return;
		await crmSheets.upsertCliente(resumo);
		const pref = await db.buildPreferenciaCliente(clienteId);
		await crmSheets.upsertPreferencia(pref);
	} catch (e) {
		console.error("[CRM Sheets] Falha ao sincronizar cliente:", e.message);
	}
}

async function syncVendaToCRMSheet(vendaId) {
	try {
		const vendaRes = await db.executeQuery(
			`
            SELECT v.*, c.nome AS cliente_nome, c.whatsapp AS cliente_whatsapp, p.categoria, p.colecao, p.estoque
            FROM vendas v
            JOIN clientes c ON c.id = v.cliente_id
            LEFT JOIN produtos p ON p.sku = v.produto_sku
            WHERE v.id = $1
        `,
			[vendaId],
		);

		const venda = vendaRes.rows[0];
		if (!venda) return;

		await db.rehydrateVendaValores(venda.id);
		await db.refreshVendaFinanceiro(venda.id);

		const quantidade = Math.max(Number(venda.quantidade || 1), 1);
		const valorUnitario = parseMoneyLike(
			venda.valor_unitario || venda.valor_total || venda.valor,
		);
		const valorTotal =
			parseMoneyLike(venda.valor_total) ||
			Number((valorUnitario * quantidade).toFixed(2));
		const valorPago = parseMoneyLike(venda.valor_pago);
		const valorRestante = Math.max(
			Number((valorTotal - valorPago).toFixed(2)),
			0,
		);
		const statusPagamento =
			(venda.status_pagamento || "").toLowerCase() ||
			(valorRestante <= 0 && valorTotal > 0
				? "pago"
				: valorPago > 0
					? "parcial"
					: "aberto");

		await crmSheets.upsertPedido({
			pedido_id: venda.id,
			cliente_id: venda.cliente_id,
			cliente_nome: venda.cliente_nome,
			cliente_whatsapp: venda.cliente_whatsapp,
			produto_sku: venda.produto_sku,
			produto_nome: venda.produto_nome,
			categoria: venda.categoria || "",
			colecao: venda.colecao || "",
			tamanho: venda.tamanho || "",
			quantidade,
			valor_unitario: valorUnitario,
			valor_total: valorTotal,
			valor_pago: valorPago,
			valor_restante: valorRestante,
			status_pagamento: statusPagamento,
			forma_pagamento: venda.forma_pagamento || "",
			data_pagamento: venda.data_pagamento || "",
			observacoes: venda.observacoes || "",
			created_at: venda.created_at,
			updated_at: new Date().toISOString(),
		});

		await crmSheets.upsertItem({
			item_id: venda.id,
			pedido_id: venda.id,
			cliente_id: venda.cliente_id,
			produto_sku: venda.produto_sku,
			produto_nome: venda.produto_nome,
			categoria: venda.categoria || "",
			colecao: venda.colecao || "",
			tamanho: venda.tamanho || "",
			quantidade,
			valor_unitario: valorUnitario,
			subtotal: valorTotal,
			estoque_apos_venda: venda.estoque || "",
			created_at: venda.created_at,
		});

		const pagamentos = await db.getPagamentosByVenda(venda.id);
		for (const pg of pagamentos) {
			await crmSheets.upsertPagamento({
				pagamento_id: pg.id,
				pedido_id: venda.id,
				cliente_id: venda.cliente_id,
				valor_pago: pg.valor,
				forma_pagamento: pg.forma_pagamento || "",
				descricao: pg.observacoes || "",
				created_at: pg.created_at,
			});
		}

		await syncClienteToCRMSheet(venda.cliente_id);
	} catch (e) {
		console.error("[CRM Sheets] Falha ao sincronizar venda:", e.message);
	}
}

async function deleteVendaFromCRMSheet(vendaId) {
	try {
		const pagamentos = await db.getPagamentosByVenda(vendaId);
		for (const pg of pagamentos) {
			await crmSheets.deletePagamento(pg.id);
		}
		await crmSheets.deleteItem(vendaId);
		await crmSheets.deletePedido(vendaId);
	} catch (e) {
		console.error("[CRM Sheets] Falha ao remover venda:", e.message);
	}
}

async function delayInterruptible(ms, tokenAtStart, stepMs = 1000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (SLEEP_TOKEN !== tokenAtStart) return false;
		const remaining = end - Date.now();
		await delay(Math.min(stepMs, remaining));
	}
	return true;
}

async function agendarDespertador() {
	if (CAMPAIGN_TIMER) clearTimeout(CAMPAIGN_TIMER);

	try {
		const prox = await db.getNextSchedule();
		if (prox) {
			const agora = new Date();
			const inicio = new Date(prox.data_inicio);
			const msAteInicio = inicio.getTime() - agora.getTime();

			const inicioUTC = inicio.toISOString().replace("T", " ").substring(0, 19);
			const inicioBR = inicio.toLocaleString("pt-BR", {
				timeZone: "America/Sao_Paulo",
			});

			if (msAteInicio > 0 && msAteInicio < 86400000) {
				console.log(`\n⏰ DESPERTADOR ARMADO: '${prox.nome_evento}'`);
				console.log(`   🌍 UTC (Banco):  ${inicioUTC} Z`);
				console.log(`   🇧🇷 BRT (Real):   ${inicioBR}`);
				console.log(
					`   ⏳ Dispara em:   ${(msAteInicio / 60000).toFixed(1)} minutos`,
				);

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

const BROWSER_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
	Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
	"Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
	Referer: "https://drive.google.com/",
	"Sec-Fetch-Dest": "image",
	"Sec-Fetch-Mode": "no-cors",
	"Sec-Fetch-Site": "cross-site",
};

async function getMediaBuffer(originalUrl) {
	const urls = getDriveFallbackUrls(originalUrl);

	for (const url of urls) {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 20000);

			const res = await fetch(url, {
				signal: controller.signal,
				headers: BROWSER_HEADERS,
				redirect: "follow",
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				console.warn(
					`⚠️ [getMediaBuffer] ${res.status} em ${url.substring(0, 80)}...`,
				);
				continue;
			}

			const contentType = res.headers.get("content-type") || "";
			if (contentType.includes("text/html")) {
				console.warn(
					`⚠️ [getMediaBuffer] Resposta HTML em ${url.substring(0, 80)}...`,
				);
				continue;
			}

			const arrayBuffer = await res.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);

			if (buffer.length < 1024) {
				console.warn(
					`⚠️ [getMediaBuffer] Buffer muito pequeno (${buffer.length} bytes).`,
				);
				continue;
			}

			return buffer;
		} catch (e) {
			console.warn(
				`⚠️ [getMediaBuffer] Erro: ${e.message} em ${url.substring(0, 80)}...`,
			);
			continue;
		}
	}

	console.error(
		`❌ [getMediaBuffer] Todas as tentativas falharam para: ${originalUrl}`,
	);
	return null;
}

function getMensagemFimCampanha(nomeEvento) {
	const nome = nomeEvento || "Evento";
	const msgs = [
		`✨ *${nome} Finalizado!* ✨\n\nTodas as peças foram apresentadas. Obrigada a todas! 🥰\n\nFiquem ligadas, logo mais teremos novidades!`,
		`💎 *Encerrado por hoje!* 💎\n\nO ${nome} foi um sucesso absoluto. Quem garantiu, garantiu! 😉\n\nAtivem as notificações.`,
		`🚀 *Fim da Edição!*\n\nAgradecemos a preferência no *${nome}*. Foi incrível!\n\nEm breve voltamos com mais peças exclusivas. ✨`,
	];
	return msgs[Math.floor(Math.random() * msgs.length)];
}

function getHoraBR() {
	return parseInt(
		new Intl.DateTimeFormat("pt-BR", {
			timeZone: "America/Sao_Paulo",
			hour: "numeric",
			hour12: false,
		}).format(new Date()),
	);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
	session({
		secret: config.DASHBOARD.SESSION_SECRET,
		resave: false,
		saveUninitialized: false,
		proxy: true,
		cookie: {
			secure: "auto",
			httpOnly: true,
			sameSite: "lax",
			maxAge: 86400000,
		},
	}),
);

// Evita que HTMLs autenticados sejam servidos do cache do navegador/proxy
// (problema frequente em SquareCloud/Cloudflare — o JS/CSS novo carrega mas o HTML fica velho)
const noCacheHtml = (_req, res, next) => {
	res.set({
		"Cache-Control": "no-store, no-cache, must-revalidate, private",
		Pragma: "no-cache",
		Expires: "0",
	});
	next();
};

const loginLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 5,
	standardHeaders: true,
	legacyHeaders: false,
});

const requireAuth = (req, res, next) => {
	if (req.session.authenticated) return next();
	// Para chamadas de API/XHR, responde 401 JSON em vez de redirect HTML
	// (assim o fetch no frontend detecta sessão perdida e não faz parse de HTML como JSON)
	const wantsJson =
		req.path.startsWith("/api/") ||
		req.xhr ||
		(req.get("accept") || "").includes("application/json");
	if (wantsJson) return res.status(401).json({ error: "nao-autenticado" });
	return res.redirect("/login");
};

app.get("/login", (req, res) =>
	res.sendFile(path.join(__dirname, "public/html", "login.html")),
);

app.post("/login", loginLimiter, (req, res) => {
	const { username, password } = req.body;
	if (
		username === config.DASHBOARD.USER &&
		password === config.DASHBOARD.PASS
	) {
		req.session.authenticated = true;
		res.redirect("/");
	} else {
		res.redirect("/login?error=1");
	}
});

app.get("/logout", (req, res) => {
	req.session.destroy(() => {
		res.redirect("/login");
	});
});

app.get("/", requireAuth, noCacheHtml, (req, res) =>
	res.sendFile(path.join(__dirname, "public/html", "index.html")),
);
app.get("/crm", requireAuth, noCacheHtml, (req, res) =>
	res.sendFile(path.join(__dirname, "public/html", "crm.html")),
);
app.get("/crm/cliente", requireAuth, noCacheHtml, (req, res) =>
	res.sendFile(path.join(__dirname, "public/html", "crm-cliente.html")),
);
app.get("/pedido", requireAuth, noCacheHtml, (req, res) =>
	res.sendFile(path.join(__dirname, "public/html", "pedido.html")),
);
app.use(express.static(path.join(__dirname, "public"), {
	index: false,
	etag: true,
	lastModified: true,
	setHeaders: (res, filePath) => {
		if (/\.(js|css|html)$/i.test(filePath)) {
			res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
			res.setHeader("Pragma", "no-cache");
			res.setHeader("Expires", "0");
		}
	},
}));

app.get("/api/image-proxy", requireAuth, async (req, res) => {
	const { url } = req.query;
	if (!url) return res.status(400).send("URL obrigatória");

	const raw = String(url);
	if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
		return res.status(400).send("URL inválida");
	}

	try {
		const urls = getDriveFallbackUrls(raw);

		for (const targetUrl of urls) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 15000);

				const response = await fetch(targetUrl, {
					headers: BROWSER_HEADERS,
					redirect: "follow",
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) continue;

				const contentType = (
					response.headers.get("content-type") || ""
				).toLowerCase();
				if (
					contentType.includes("text/html") ||
					contentType.includes("text/plain")
				)
					continue;
				if (!contentType.startsWith("image/")) continue;

				const arrayBuffer = await response.arrayBuffer();
				const buffer = Buffer.from(arrayBuffer);

				if (buffer.length < 1024) continue;

				res.set({
					"Content-Type": contentType,
					"Content-Length": buffer.length,
					"Cache-Control": "private, max-age=3600",
					"X-Image-Source": "drive-proxy",
					Vary: "Cookie",
				});

				return res.send(buffer);
			} catch {
				continue;
			}
		}

		return res.status(502).send("Imagem indisponível");
	} catch (e) {
		console.error("[image-proxy]", e.message);
		return res.status(500).send("Erro interno");
	}
});

app.get("/api/produtos", requireAuth, async (req, res) => {
	try {
		res.json(await db.getAllProducts());
	} catch (e) {
		console.error("[GET /api/produtos]", e.message);
		res.status(500).json([]);
	}
});

app.post("/api/produtos/reset/:sku", requireAuth, async (req, res) => {
	try {
		await db.resetarItem(req.params.sku);
		res.json({ success: true });
	} catch (e) {
		console.error("[POST /api/produtos/reset]", e.message);
		res.status(500).json({ error: e.message });
	}
});

app.post("/api/produtos/prioridade/:sku", requireAuth, async (req, res) => {
	try {
		await db.togglePrioridade(req.params.sku);
		res.json({ success: true });
	} catch (e) {
		console.error("[POST /api/produtos/prioridade]", e.message);
		res.status(500).json({ error: e.message });
	}
});

app.get("/api/collections", requireAuth, async (req, res) => {
	try {
		res.json(await db.getCollectionsList());
	} catch (e) {
		console.error("[GET /api/collections]", e.message);
		res.status(500).json([]);
	}
});

app.post("/api/produtos/reset-all", requireAuth, async (req, res) => {
	try {
		await db.resetarCatalogo();
		io.emit("log", "♻️ Catálogo resetado.");
		wakeBot();
		res.json({ success: true });
	} catch (e) {
		console.error("[POST /api/produtos/reset-all]", e.message);
		res.status(500).json({ error: e.message });
	}
});

app.get("/api/whatsapp/status", requireAuth, (req, res) => {
	res.json(getWhatsAppState());
});

app.post("/api/whatsapp/start", requireAuth, async (req, res) => {
	try {
		await iniciarWhatsApp(io, (sock, logFunction) => {
			ACTIVE_SOCK = sock;
			sock.ev.on("connection.update", ({ connection }) => {
				if (connection === "close" && ACTIVE_SOCK === sock) ACTIVE_SOCK = null;
			});

			if (!loopIniciado) {
				loopIniciado = true;
				console.log("🔄 Loop de Vendas Iniciado.");
				cicloDeVendas(logFunction);
			}
		});

		res.json({ success: true, state: getWhatsAppState() });
	} catch (e) {
		console.error("[POST /api/whatsapp/start]", e.message);
		res.status(500).json({ success: false, error: e.message });
	}
});

app.post("/api/whatsapp/stop", requireAuth, async (req, res) => {
	try {
		ACTIVE_SOCK = null;
		const state = await stopWhatsApp({
			clearAuth: true,
			reason: "Conexão encerrada pelo operador.",
		});
		res.json({ success: true, state });
	} catch (e) {
		console.error("[POST /api/whatsapp/stop]", e.message);
		res.status(500).json({ success: false, error: e.message });
	}
});

app.get("/api/campaign/status", requireAuth, (req, res) =>
	res.json(CAMPAIGN_STATE),
);

app.post("/api/campaign/start", requireAuth, (req, res) => {
	const { mode, filter } = req.body;
	setCampaignState({
		active: true,
		mode: String(mode || "NORMAL").toUpperCase(),
		filter: filter || null,
		startTime: Date.now(),
	});
	io.emit("log", `🚀 Manual Iniciado: ${mode}`);
	wakeBot();
	res.json({ success: true });
});

app.post("/api/campaign/stop", requireAuth, (req, res) => {
	setCampaignState({
		active: false,
		mode: "NORMAL",
		filter: null,
		startTime: null,
	});
	io.emit("log", `🛑 Parado.`);
	wakeBot();
	res.json({ success: true });
});

app.get("/api/bot/status", requireAuth, (req, res) => {
	res.json({ paused: BOT_PAUSED });
});

app.post("/api/bot/pause", requireAuth, (req, res) => {
	BOT_PAUSED = true;
	io.emit("bot_paused", true);
	io.emit("log", "⏸️ Bot PAUSADO pelo operador.");
	res.json({ success: true, paused: true });
});

app.post("/api/bot/resume", requireAuth, (req, res) => {
	BOT_PAUSED = false;
	io.emit("bot_paused", false);
	io.emit("log", "▶️ Bot RETOMADO pelo operador.");
	wakeBot();
	res.json({ success: true, paused: false });
});

app.post("/api/vip/cadastro", async (req, res) => {
	const { nome, whatsapp, nascimento } = req.body;

	if (!nome || !whatsapp || !nascimento) {
		return res
			.status(400)
			.json({ error: "Campos obrigatórios: nome, whatsapp, nascimento" });
	}

	const numbersOnly = String(whatsapp).replace(/\D/g, "");
	if (numbersOnly.length < 10 || numbersOnly.length > 15) {
		return res.status(400).json({ error: "Número de WhatsApp inválido" });
	}

	const nomeClean = String(nome).trim().substring(0, 100);
	const nascDate = new Date(nascimento);
	if (Number.isNaN(nascDate.getTime())) {
		return res.status(400).json({ error: "Data de nascimento inválida" });
	}

	const numeroFinal =
		numbersOnly.length <= 11 ? "55" + numbersOnly : numbersOnly;

	try {
		await db.executeQuery(
			`INSERT INTO leads_vip (nome, whatsapp, data_nascimento)
             VALUES ($1, $2, $3)
             ON CONFLICT (whatsapp) DO UPDATE SET data_nascimento = $3, nome = $1`,
			[nomeClean, numeroFinal, nascimento],
		);
		console.log(`🎂 Novo VIP cadastrado: ${nomeClean}`);
		res.json({ success: true });
	} catch (e) {
		console.error("Erro VIP cadastro:", e);
		res.status(500).json({ error: "Erro interno" });
	}
});

app.get("/api/vip/aniversariantes", requireAuth, async (req, res) => {
	try {
		const result = await db.executeQuery(
			"SELECT id, nome, data_nascimento FROM leads_vip",
		);
		const hoje = new Date();

		const events = result.rows.map((vip) => {
			const isoStr =
				vip.data_nascimento instanceof Date
					? vip.data_nascimento.toISOString()
					: String(vip.data_nascimento);

			const [, mm, dd] = isoStr.split("T")[0].split("-");

			return {
				id: `vip_${vip.id}`,
				title: `🎂 ${vip.nome.split(" ")[0]}`,
				start: `${hoje.getFullYear()}-${mm}-${dd}`,
				allDay: true,
				type: "BIRTHDAY",
			};
		});

		res.json(events);
	} catch (e) {
		console.error("[GET /api/vip/aniversariantes]", e.message);
		res.status(500).json([]);
	}
});

app.get("/api/vip/list", requireAuth, async (req, res) => {
	try {
		const result = await db.executeQuery(
			"SELECT * FROM leads_vip ORDER BY created_at DESC",
		);
		res.json(result.rows);
	} catch (e) {
		console.error("[GET /api/vip/list]", e.message);
		res.status(500).json({ error: "Erro ao buscar lista" });
	}
});

app.delete("/api/vip/:id", requireAuth, async (req, res) => {
	try {
		await db.executeQuery("DELETE FROM leads_vip WHERE id = $1", [
			req.params.id,
		]);
		res.json({ success: true });
	} catch (e) {
		console.error("[DELETE /api/vip]", e.message);
		res.status(500).json({ error: "Erro ao deletar" });
	}
});

app.get("/api/clientes", requireAuth, async (req, res) => {
	try {
		res.json(await db.getAllClientes());
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.post("/api/clientes", requireAuth, async (req, res) => {
	try {
		const { nome, whatsapp, email, observacoes } = req.body;
		if (!nome || !whatsapp)
			return res.status(400).json({ error: "Nome e WhatsApp obrigatorios" });

		const numbersOnly = String(whatsapp).replace(/\D/g, "");
		if (numbersOnly.length < 10 || numbersOnly.length > 13) {
			return res.status(400).json({ error: "WhatsApp invalido" });
		}

		const cliente = await db.createCliente({
			nome,
			whatsapp: numbersOnly,
			email,
			observacoes,
		});
		await syncClienteToCRMSheet(cliente.id);
		res.json({ success: true, cliente });
	} catch (e) {
		if (e.message.includes("unique") || e.message.includes("duplicate")) {
			return res.status(409).json({ error: "WhatsApp ja cadastrado" });
		}
		res.status(500).json({ error: e.message });
	}
});

app.put("/api/clientes/:id", requireAuth, async (req, res) => {
	try {
		const { nome, whatsapp, email, observacoes } = req.body;
		const numbersOnly = String(whatsapp).replace(/\D/g, "");
		await db.updateCliente(req.params.id, {
			nome,
			whatsapp: numbersOnly,
			email,
			observacoes,
		});
		await syncClienteToCRMSheet(req.params.id);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.delete("/api/clientes/:id", requireAuth, async (req, res) => {
	try {
		await db.deleteCliente(req.params.id);
		await crmSheets.deleteCliente(req.params.id);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.get("/api/vendas", requireAuth, async (req, res) => {
	try {
		res.json(await db.getAllVendas());
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.get("/api/vendas/cliente/:id", requireAuth, async (req, res) => {
	try {
		res.json(await db.getVendasByCliente(req.params.id));
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.post("/api/vendas", requireAuth, async (req, res) => {
	try {
		const {
			cliente_id,
			produto_sku,
			quantidade,
			pago,
			valor_pago,
			data_pagamento,
			observacoes,
			tamanho,
			forma_pagamento,
			itens,
		} = req.body;
		if (!cliente_id)
			return res.status(400).json({ error: "Cliente obrigatorio" });

		const itensNormalizados =
			Array.isArray(itens) && itens.length
				? itens
						.map((item) => ({
							produto_sku: String(item.produto_sku || "").trim(),
							quantidade: Math.max(parseInt(item.quantidade) || 1, 1),
							tamanho: item.tamanho || null,
							valor_unitario: toFixedMoney(
								item.valor_unitario ?? item.valor ?? item.preco ?? 0,
							),
						}))
						.filter((item) => item.produto_sku)
				: [
						{
							produto_sku,
							quantidade: Math.max(parseInt(quantidade) || 1, 1),
							tamanho: tamanho || null,
							valor_unitario: 0,
						},
					].filter((item) => item.produto_sku);

		if (!itensNormalizados.length) {
			return res
				.status(400)
				.json({ error: "Adicione ao menos um item ao pedido" });
		}

		const produtosValidados = [];
		for (const item of itensNormalizados) {
			const prodRes = await db.executeQuery(
				"SELECT nome, valor, categoria, colecao, estoque FROM produtos WHERE sku = $1",
				[item.produto_sku],
			);

			if (prodRes.rows.length === 0) {
				return res
					.status(404)
					.json({ error: `Produto nao encontrado: ${item.produto_sku}` });
			}

			const prod = prodRes.rows[0];
			if (item.quantidade > Number(prod.estoque || 0)) {
				return res
					.status(400)
					.json({
						error: `Estoque insuficiente para ${prod.nome}. Disponivel: ${prod.estoque}`,
					});
			}

			produtosValidados.push({ item, prod });
		}

		let sheetRows = null;
		let sheet = null;

		try {
			const auth = new JWT({
				email: config.GOOGLE_CREDS.client_email,
				key: config.GOOGLE_CREDS.private_key,
				scopes: ["https://www.googleapis.com/auth/spreadsheets"],
			});

			const doc = new GoogleSpreadsheet(config.SHEET_ID, auth);
			await doc.loadInfo();
			sheet = doc.sheetsByTitle[config.PRODUCTS_TAB] || doc.sheetsByIndex[0];
			sheetRows = await sheet.getRows();
		} catch (sheetErr) {
			console.error("[CRM] Erro preparando planilha:", sheetErr.message);
		}

		const vendasCriadas = [];

		for (const { item, prod } of produtosValidados) {
			const valorUnit =
				item.valor_unitario > 0
					? toFixedMoney(item.valor_unitario)
					: parseMoneyLike(prod.valor);
			const valorTotal = toFixedMoney(valorUnit * item.quantidade);
			const valorPagoInicial = pago ? valorTotal : toFixedMoney(valor_pago);

			const venda = await db.createVenda({
				cliente_id,
				produto_sku: item.produto_sku,
				produto_nome: prod.nome,
				quantidade: item.quantidade,
				valor_total: valorTotal,
				valor_pago: valorPagoInicial,
				data_pagamento: data_pagamento || null,
				observacoes,
				tamanho: item.tamanho,
				forma_pagamento,
				categoria: prod.categoria || null,
				colecao: prod.colecao || null,
				pagamento_observacao: valorPagoInicial > 0 ? "Pagamento inicial" : null,
			});

			await db.decrementarEstoque(item.produto_sku, item.quantidade);

			if (sheet && sheetRows) {
				try {
					const row = sheetRows.find((r) => r.get("SKU") === item.produto_sku);
					if (row) {
						const estoqueAtual = parseInt(row.get("ESTOQUE")) || 0;
						const novoEstoque = Math.max(estoqueAtual - item.quantidade, 0);
						row.set("ESTOQUE", novoEstoque);
						await row.save();
						io.emit(
							"log",
							`📦 Estoque de ${item.produto_sku} atualizado na planilha (${estoqueAtual} → ${novoEstoque})`,
						);
					}
				} catch (sheetErr) {
					console.error("[CRM] Erro ao sync planilha:", sheetErr.message);
					io.emit(
						"log",
						`⚠️ Pedido registrado mas estoque na planilha nao foi atualizado para ${item.produto_sku}: ${sheetErr.message}`,
					);
				}
			}

			await syncVendaToCRMSheet(venda.id);
			vendasCriadas.push(venda);
			io.emit(
				"log",
				`💰 Item do pedido: ${prod.nome} (${item.produto_sku}) x${item.quantidade} registrado`,
			);
		}

		res.json({
			success: true,
			venda: vendasCriadas[0] || null,
			vendas: vendasCriadas,
		});
	} catch (e) {
		console.error("[POST /api/vendas]", e.message);
		res.status(500).json({ error: e.message });
	}
});

app.put("/api/vendas/:id/pago", requireAuth, async (req, res) => {
	try {
		await db.updateVendaPago(req.params.id, req.body.pago);
		await syncVendaToCRMSheet(req.params.id);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.put("/api/vendas/:id/data-pagamento", requireAuth, async (req, res) => {
	try {
		await db.updateVendaDataPagamento(req.params.id, req.body.data_pagamento);
		await syncVendaToCRMSheet(req.params.id);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.delete("/api/vendas/:id", requireAuth, async (req, res) => {
	try {
		await deleteVendaFromCRMSheet(req.params.id);
		await db.deleteVenda(req.params.id);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.put("/api/vendas/:id/financeiro", requireAuth, async (req, res) => {
	try {
		const venda = await db.updateVendaFinanceiro(req.params.id, req.body || {});
		await syncVendaToCRMSheet(req.params.id);
		res.json({ success: true, venda });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.post("/api/crm/sync-all", requireAuth, async (req, res) => {
	try {
		const clientes = await db.getAllClientes();
		for (const cliente of clientes) {
			await syncClienteToCRMSheet(cliente.id);
			const vendas = await db.getVendasByCliente(cliente.id);
			for (const venda of vendas) {
				await db.rehydrateVendaValores(venda.id);
				await db.refreshVendaFinanceiro(venda.id);
				await syncVendaToCRMSheet(venda.id);
			}
		}
		res.json({
			success: true,
			clientes: clientes.length,
			sheetId: config.SHEET_ID,
		});
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

cron.schedule(
	"0 9 * * *",
	async () => {
		console.log("🎂 [CRON] Checando aniversariantes...");

		if (!ACTIVE_SOCK) {
			console.log(
				"⚠️ [CRON] WhatsApp desconectado. Abortando disparos de aniversário.",
			);
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

			console.log(
				`🎂 Encontrados ${res.rows.length} aniversariantes! Disparando...`,
			);

			for (const vip of res.rows) {
				const nome = vip.nome.split(" ")[0];
				const msg =
					`🥳 Parabéns, *${nome}*! 🎉\n\n` +
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
	},
	{
		timezone: "America/Sao_Paulo",
	},
);

cron.schedule(
	"0 10 * * *",
	async () => {
		console.log("[CRM] Checando lembretes de pagamento...");

		if (!ACTIVE_SOCK) {
			console.log("[CRM] WhatsApp desconectado. Abortando lembretes.");
			return;
		}

		try {
			const pendentes = await db.getCobrancasPendentes();

			if (pendentes.length === 0) {
				console.log("[CRM] Nenhum lembrete de pagamento pendente hoje.");
				return;
			}

			console.log(`[CRM] ${pendentes.length} lembretes para enviar.`);

			for (const item of pendentes) {
				const primeiroNome = item.cliente_nome.split(" ")[0];
				const msg =
					`Oi, *${primeiroNome}*! Tudo bem?\n\n` +
					`Passando para lembrar que hoje e a data combinada para o pagamento referente a *${item.produto_nome}*` +
					(item.valor ? ` no valor de *R$ ${item.valor}*` : "") +
					`.\n\n` +
					`Se ja realizou o pagamento, pode desconsiderar esta mensagem.\n\n` +
					`Qualquer duvida, estou a disposicao. Obrigada! 💎`;

				const jid = `${item.whatsapp}@s.whatsapp.net`;

				try {
					await ACTIVE_SOCK.sendMessage(jid, { text: msg });
					await db.marcarLembreteEnviado(item.id);
					console.log(
						`[CRM] Lembrete enviado para ${primeiroNome} (venda #${item.id})`,
					);
					io.emit(
						"log",
						`💬 Lembrete de pagamento enviado para ${primeiroNome}`,
					);
					await delay(5000 + Math.random() * 5000);
				} catch (err) {
					console.error(
						`[CRM] Erro ao enviar lembrete para ${primeiroNome}:`,
						err.message,
					);
				}
			}
		} catch (e) {
			console.error("[CRM] Erro no cron de lembretes:", e);
		}
	},
	{
		timezone: "America/Sao_Paulo",
	},
);

async function cicloDeVendas(log) {
	if (!log) {
		log = (msg) => {
			console.log(msg);
			if (!msg.includes("Dormindo")) io.emit("log", msg);
		};
	}

	while (true) {
		if (!ACTIVE_SOCK) {
			log("⚠️ WhatsApp desconectado. Aguardando reconexão...");
			await delay(5000);
			continue;
		}

		if (BOT_PAUSED) {
			log("⏸️ Bot pausado. Aguardando retomada...");
			const token = SLEEP_TOKEN;
			await delayInterruptible(10000, token);
			continue;
		}

		try {
			if (Object.keys(DYNAMIC_CONFIG).length === 0) {
				await db.init();
				await db.initCRM();
				DYNAMIC_CONFIG = await db.getSettings();
			}
		} catch (e) {
			console.error("[ciclo] Erro ao carregar settings:", e.message);
		}

		await agendarDespertador();

		const agora = new Date();
		let ativa = null;
		let proxima = null;

		try {
			ativa = await db.checkActiveSchedule();
			proxima = await db.getNextSchedule();

			const agoraBR = new Date().toLocaleString("pt-BR", {
				timeZone: "America/Sao_Paulo",
			});
			console.log(
				`🔍 [DEBUG] Hora BR: ${agoraBR} | Ativa: ${ativa?.nome_evento || "NÃO"}`,
			);

			if (!ativa && proxima) {
				const msFaltam = new Date(proxima.data_inicio) - agora;
				if (msFaltam > 0 && msFaltam < 20 * 60 * 1000) {
					log(
						`⏳ Campanha '${proxima.nome_evento}' em ${(msFaltam / 60000).toFixed(1)} min. Aguardando...`,
					);
					await delayInterruptible(msFaltam + 2000, SLEEP_TOKEN);
					continue;
				}
			}

			if (ativa) {
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

				if (!CAMPAIGN_STATE.active || CAMPAIGN_STATE.mode !== ativa.modo) {
					log(`🚨 CAMPANHA INICIADA: ${ativa.nome_evento}`);

					if (!ativa.msg_inicio_enviada) {
						try {
							const dataFim = new Date(ativa.data_fim).toLocaleString("pt-BR", {
								timeZone: "America/Sao_Paulo",
								day: "2-digit",
								month: "short",
								hour: "2-digit",
								minute: "2-digit",
							});

							const msgAbertura =
								`🚀 *A CAMPANHA COMEÇOU!*\n\n` +
								`💎 *Evento:* ${ativa.nome_evento}\n` +
								`⏳ *Válido até:* ${dataFim}\n\n` +
								`Preparamos ofertas imperdíveis. Confira! 👇`;

							await ACTIVE_SOCK.sendMessage(config.GROUP_ID, {
								text: msgAbertura,
							});
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
						startTime: Date.now(),
					});
				}
			} else {
				if (CAMPAIGN_STATE.active && CAMPAIGN_STATE.startTime) {
					log(`🏁 Horário da campanha encerrado.`);
					try {
						const msgFim = getMensagemFimCampanha("Edição Especial");
						await ACTIVE_SOCK.sendMessage(config.GROUP_ID, { text: msgFim });
						log(`✅ Mensagem de encerramento enviada.`);
					} catch (e) {
						log(`❌ Erro msg fim: ${e.message}`);
					}
					setCampaignState({
						active: false,
						mode: "NORMAL",
						filter: null,
						startTime: null,
					});
				}
			}
		} catch (e) {
			console.error("Erro Schedule Check:", e.message);
		}

		try {
			const avisos = await db.checkPreLaunchMessages();
			for (const av of avisos) {
				log(`🔔 Aviso: ${av.nome_evento}`);
				try {
					await ACTIVE_SOCK.sendMessage(config.GROUP_ID, {
						text: `📢 *AVISO IMPORTANTE*\n\n${av.msg_pre_lancamento}`,
					});
					await db.markPreLaunchAsSent(av.id);
					await delay(3000);
				} catch (err) {
					console.error("[avisos prévios] Erro ao enviar:", err.message);
				}
			}
		} catch (e) {
			console.error("[avisos prévios] Erro ao checar:", e.message);
		}

		const modoId = CAMPAIGN_STATE.active ? CAMPAIGN_STATE.mode : "NORMAL";
		const modoAtual = { ...config.MODES[modoId] };

		if (DYNAMIC_CONFIG["INTERVALO_" + modoId])
			modoAtual.INTERVALO_LOTE = DYNAMIC_CONFIG["INTERVALO_" + modoId];
		if (DYNAMIC_CONFIG["PROMPT_" + modoId])
			modoAtual.PROMPT_STYLE = DYNAMIC_CONFIG["PROMPT_" + modoId];

		const hInicio = DYNAMIC_CONFIG["HORARIO_INICIO"] || config.HORARIO.INICIO;
		const hFim = DYNAMIC_CONFIG["HORARIO_FIM"] || config.HORARIO.FIM;

		const horaBR = getHoraBR();
		const comercial = horaBR >= hInicio && horaBR < hFim;

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

		if (CAMPAIGN_STATE.active)
			log(`\n🔥 [CAMPANHA ATIVA] ${ativa ? ativa.nome_evento : modoId}`);
		else log(`\n🔄 [MODO NORMAL] Intervalo: ${modoAtual.INTERVALO_LOTE} min`);

		if (!CAMPAIGN_STATE.active && proxima) {
			const msAteInicio = new Date(proxima.data_inicio).getTime() - Date.now();
			const margemSeguranca = 30 * 60 * 1000;

			if (msAteInicio > 0 && msAteInicio < margemSeguranca) {
				log(
					`✋ MODO NORMAL PAUSADO! Campanha em ${(msAteInicio / 60000).toFixed(1)} min.`,
				);
				await delayInterruptible(msAteInicio + 1000, SLEEP_TOKEN);
				continue;
			}
		}

		try {
			let lote = [];

			if (CAMPAIGN_STATE.active) {
				lote = await db.getCampaignProducts(
					CAMPAIGN_STATE.mode,
					CAMPAIGN_STATE.filter,
					modoAtual.ITENS_LOTE,
				);

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
					setCampaignState({ active: false, mode: "NORMAL" });
					wakeBot();
					continue;
				}
			} else {
				const pendentes = await db.getPendentesCount();
				if (pendentes === 0) {
					await db.resetarCatalogo();
					log("♻️ Catálogo resetado.");
					await delay(5000);
				}
				lote = await db.getMelhorMix(modoAtual.ITENS_LOTE);
			}

			log(`📦 Lote: ${lote.length} itens.`);

			for (const p of lote) {
				const checkAtiva = await db.checkActiveSchedule();
				if (checkAtiva && !CAMPAIGN_STATE.active) {
					log("⚡ Campanha detectada! Interrompendo envio normal...");
					break;
				}

				const buffer = await getMediaBuffer(p.image_url);
				if (!buffer) {
					log(`🚫 Erro Imagem: ${p.nome}`);
					await db.marcarErroImagem(p.sku);
					continue;
				}

				let copy;
				try {
					copy = await gerarCopyComIA(
						p.nome,
						p.valor,
						p.sku,
						p.estoque,
						p.reposicao,
						p.colecao,
						CAMPAIGN_STATE.active ? modoAtual : null,
					);
				} catch (e) {
					copy = `✨ *${p.nome}*\n💎 R$ ${p.valor}`;
				}

				const caption =
					`${copy}\n\n👇 *COMPRE AQUI:* https://wa.me/${config.SEU_NUMERO_ATENDIMENTO}?text=` +
					encodeURIComponent("Quero o " + p.nome);

				try {
					await ACTIVE_SOCK.sendMessage(config.GROUP_ID, {
						image: buffer,
						caption,
					});
					await db.marcarComoEnviado(p.sku);
					log(`✅ Enviado: ${p.nome}`);
					await delay(
						getRandomDelay(
							modoAtual.DELAY_ENTRE_MSGS.MIN,
							modoAtual.DELAY_ENTRE_MSGS.MAX,
						),
					);
				} catch (e) {
					log(`❌ Erro Zap: ${e.message}`);
					if (
						e.message &&
						(e.message.includes("Connection Closed") ||
							e.message.includes("socket"))
					) {
						log("🔄 Conexão instável. Pausando 10s...");
						await delay(10000);
					}
					await delay(5000);
				}
			}

			let msEspera = modoAtual.INTERVALO_LOTE * 60000;
			const recheckProx = await db.getNextSchedule();

			if (recheckProx) {
				const msAteCampanha =
					new Date(recheckProx.data_inicio).getTime() - Date.now();
				if (msAteCampanha <= 0) msEspera = 1000;
				else if (msAteCampanha < msEspera) {
					msEspera = msAteCampanha + 1000;
					log(
						`⏱️ Ajustando espera: Campanha inicia em ${(msEspera / 60000).toFixed(1)} min.`,
					);
				}
			}

			const horaAcordar = new Date(Date.now() + msEspera).toLocaleTimeString(
				"pt-BR",
				{ timeZone: "America/Sao_Paulo" },
			);
			log(
				`⏳ Aguardando ${(msEspera / 60000).toFixed(1)} min (Até ${horaAcordar})...`,
			);

			const token = SLEEP_TOKEN;
			const completouSono = await delayInterruptible(msEspera, token, 5000);
			if (!completouSono) log(`⚡ Bot acordado manualmente!`);
		} catch (erro) {
			log(`❌ Erro Geral Ciclo: ${erro.message}`);
			await delay(30000);
		}
	}
}

configurarWhatsAppSobDemanda(io, (sock, logFunction) => {
	ACTIVE_SOCK = sock;

	sock.ev.on("connection.update", ({ connection }) => {
		if (connection === "close" && ACTIVE_SOCK === sock) {
			ACTIVE_SOCK = null;
		}
	});

	if (!loopIniciado) {
		loopIniciado = true;
		console.log("🔄 Loop de Vendas Iniciado.");
		cicloDeVendas(logFunction);
	} else {
		console.log("♻️ Conexão atualizada (Loop já rodando).");
	}
});

httpServer.listen(PORT, async () => {
	console.log(`\n🚀 SALES OS ONLINE: http://localhost:${PORT}`);
	try {
		await db.init();
		await db.initCRM();
		console.log("✅ Banco pronto (startup).");
	} catch (e) {
		console.error("⚠️ Erro no init do banco (startup):", e.message);
	}
});