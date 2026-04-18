/* src/public/js/dashboard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GSAP 3 Integration — o que foi adicionado / modificado:
 *
 * 1. ENTRADA DA PÁGINA  — timeline staggerada: status-bar → botões → cards →
 *                          card full-width
 * 2. PARTÍCULAS         — movimento orgânico com GSAP (float individual + loop)
 * 3. HOVER NOS CARDS    — elevação suave com boxShadow via GSAP
 * 4. MODAIS             — gsapModalOpen / gsapModalClose substituem classList
 * 5. LOGS               — cada linha entra com slide + fade
 * 6. GROUP DETECTED     — card entra com bounce do topo
 * 7. QR / CONNECTED     — troca de conteúdo com cross-fade + bounce no ícone
 * 8. CALENDÁRIO         — células animam ao renderizar e ao mudar mês
 * 9. MODE BUTTONS       — confirmação de seleção com micro-bounce
 * 10.FILTROS            — botão ativo com pop
 * 11.TABELA             — linhas entram em stagger; hover muda fundo via GSAP
 * 12.SPINNERS           — rotation contínua via GSAP (substituí style.animation)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const socket = io();

// ─── GSAP Setup ──────────────────────────────────────────────────────────────
gsap.registerPlugin(CustomEase);

// Easing orgânico: sobe além do alvo e volta suavemente (overshoots slightly)
CustomEase.create(
	"bounce4",
	"M0,0 C0.14,0 0.24,1.22 0.42,1.04 0.7,0.97 1,1 1,1",
);
// Saída rápida para closes de modal
CustomEase.create("quickIn", "M0,0 C0.55,0 0.9,0.5 1,1");

// ─── Estado Global ────────────────────────────────────────────────────────────
let produtosCache = [];
let currentMode = "NORMAL";
let isCampaignActive = false;
let filtroStatusAtual = "todos";
let filtroTipoAtual = "";
let catalogoPagina = 1;
const ITENS_POR_PAGINA = 5;
let _produtosFiltradosCache = [];
let calendarDate = new Date();
let scheduleCache = [];
let birthdaysCache = [];
let holidaysCache = {};
let _agendDebounce = null;

// ─── Segurança: Escape HTML ───────────────────────────────────────────────────
function escapeHtml(str) {
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function parseCurrencyValue(value) {
	if (value == null || value === "") return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	let raw = String(value).trim();
	if (!raw) return null;
	raw = raw.replace(/\s+/g, "").replace(/R\$/gi, "");
	const hasComma = raw.includes(",");
	const hasDot = raw.includes(".");
	if (hasComma && hasDot) {
		raw = raw.replace(/\./g, "").replace(",", ".");
	} else if (hasComma) {
		raw = raw.replace(",", ".");
	}
	raw = raw.replace(/[^0-9.-]/g, "");
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

function formatCurrencyBR(value, fallback = "-") {
	const parsed = parseCurrencyValue(value);
	if (parsed == null) return fallback;
	return new Intl.NumberFormat("pt-BR", {
		style: "currency",
		currency: "BRL",
	}).format(parsed);
}

function normalizeId(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : value;
}

function isVendaPaid(v) {
	const status = String(v?.status_pagamento || "").toLowerCase();
	if (status === "pago") return true;
	if (status === "aberto" || status === "parcial") return false;
	if (
		v?.pago === true ||
		v?.pago === "true" ||
		v?.pago === "t" ||
		v?.pago === 1 ||
		v?.pago === "1"
	)
		return true;
	const total = parseCurrencyValue(v?.valor_total ?? v?.valor);
	const restante = parseCurrencyValue(v?.valor_restante);
	return total != null && total > 0 && restante != null && restante <= 0;
}

let headerMenuOpen = false;
let currentPairingView = "qr";
let whatsappUiState = { started: false, starting: false, connected: false, hasQr: false, pairingInProgress: false };

function updateHeaderMenuState() {
	const menu = document.getElementById("top-actions");
	const toggle = document.getElementById("menu-toggle");
	if (!menu || !toggle) return;

	const isMobile = window.innerWidth <= 1100;

	if (!isMobile) {
		headerMenuOpen = false;
		menu.classList.remove("open");
		toggle.setAttribute("aria-expanded", "false");
		toggle.innerHTML = '<i class="fas fa-bars"></i>';
		return;
	}

	menu.classList.toggle("open", headerMenuOpen);
	toggle.setAttribute("aria-expanded", String(headerMenuOpen));
	toggle.innerHTML = `<i class="fas ${headerMenuOpen ? "fa-times" : "fa-bars"}"></i>`;
}

function toggleHeaderMenu(force) {
	if (window.innerWidth > 1100) return;
	headerMenuOpen = typeof force === "boolean" ? force : !headerMenuOpen;
	updateHeaderMenuState();
}

function closeHeaderMenu() {
	headerMenuOpen = false;
	updateHeaderMenuState();
}

function setPairingView(view) {
	currentPairingView = view === "code" ? "code" : "qr";
	const form = document.getElementById("pairing-form");
	const tabQr = document.getElementById("pairing-tab-qr");
	const tabCode = document.getElementById("pairing-tab-code");
	const container = document.getElementById("qr-container");
	const result = document.getElementById("pairing-result");
	const error = document.getElementById("pairing-error");

	if (form) {
		form.style.display = currentPairingView === "code" ? "block" : "none";
		form.classList.toggle("is-hidden", currentPairingView !== "code");
	}
	if (container)
		container.style.display = currentPairingView === "qr" ? "flex" : "none";
	if (tabQr) tabQr.classList.toggle("active", currentPairingView === "qr");
	if (tabCode)
		tabCode.classList.toggle("active", currentPairingView === "code");

	if (currentPairingView === "qr") {
		if (result) {
			result.style.display = "none";
			result.classList.add("is-hidden");
		}
		if (error) {
			error.style.display = "none";
			error.classList.add("is-hidden");
		}
	}

	if (currentPairingView === "code") {
		setTimeout(() => document.getElementById("pairing-phone")?.focus(), 120);
	}
}

function renderConnectionIdle(message = "Conecte o WhatsApp apenas quando precisar.") {
	const container = document.getElementById("qr-container");
	if (container) {
		container.innerHTML = `
          <div class="connect-phone-state">
            <i class="fas fa-mobile-alt"></i>
            <p>${escapeHtml(message)}</p>
          </div>`;
		container.style.display = "flex";
	}
	const form = document.getElementById("pairing-form");
	if (form) { form.style.display = "none"; form.classList.add("is-hidden"); }
	const result = document.getElementById("pairing-result");
	if (result) { result.style.display = "none"; result.classList.add("is-hidden"); }
	const error = document.getElementById("pairing-error");
	if (error) { error.style.display = "none"; error.classList.add("is-hidden"); }
}

function applyWhatsAppState(state = {}) {
	whatsappUiState = { ...whatsappUiState, ...state };
	const startBtn = document.getElementById("btn-start-whatsapp");
	const stopBtn = document.getElementById("btn-stop-whatsapp");
	const pairingSection = document.getElementById("pairing-section");
	const badge = document.getElementById("status-badge");
	const dot = document.getElementById("conn-dot");
	const text = document.getElementById("conn-text");
	if (pairingSection) pairingSection.style.display = whatsappUiState.started ? "block" : "none";
	if (startBtn) startBtn.style.display = whatsappUiState.started ? "none" : "inline-flex";
	if (stopBtn) stopBtn.style.display = whatsappUiState.started ? "inline-flex" : "none";
	if (badge) {
		if (whatsappUiState.connected) { badge.innerText = "Sistema Online"; badge.className = "status-badge status-online"; }
		else if (whatsappUiState.starting) { badge.innerText = "Iniciando conexão"; badge.className = "status-badge status-offline"; }
		else if (whatsappUiState.started) { badge.innerText = whatsappUiState.pairingInProgress ? "Pareamento em andamento" : "Aguardando leitura"; badge.className = "status-badge status-offline"; }
		else { badge.innerText = "Não iniciado"; badge.className = "status-badge status-offline"; }
	}
	if (dot) dot.className = `status-dot ${whatsappUiState.connected ? "dot-green" : "dot-red"}`;
	if (text) text.innerText = whatsappUiState.connected ? "WhatsApp Conectado" : (whatsappUiState.started ? "Conexão em andamento" : "WhatsApp não iniciado");
	if (!whatsappUiState.started && !whatsappUiState.connected) renderConnectionIdle();
}

async function loadWhatsAppConnectionState() {
	try {
		const res = await fetch('/api/whatsapp/status');
		const data = await res.json();
		applyWhatsAppState(data || {});
	} catch (e) {
		console.error('Erro ao obter estado do WhatsApp:', e);
		applyWhatsAppState({ started: false, starting: false, connected: false, hasQr: false });
	}
}

async function startWhatsAppConnection() {
	try {
		applyWhatsAppState({ started: true, starting: true, connected: false, hasQr: false });
		renderConnectionIdle('Preparando a conexão. O QR Code será exibido em instantes.');
		const res = await fetch('/api/whatsapp/start', { method: 'POST' });
		const data = await res.json();
		if (!res.ok || !data.success) throw new Error(data.error || 'Falha ao iniciar conexão.');
		applyWhatsAppState(data.state || { started: true, starting: false });
	} catch (e) {
		renderConnectionIdle('Não foi possível iniciar a conexão agora. Tente novamente.');
		applyWhatsAppState({ started: false, starting: false, connected: false, hasQr: false });
		showSysAlert(e.message || 'Erro ao iniciar conexão.', 'error');
	}
}

async function stopWhatsAppConnection() {
	try {
		const res = await fetch('/api/whatsapp/stop', { method: 'POST' });
		const data = await res.json();
		if (!res.ok || !data.success) throw new Error(data.error || 'Falha ao encerrar conexão.');
		applyWhatsAppState(data.state || { started: false, connected: false, hasQr: false });
		renderConnectionIdle('Conexão encerrada. Toque em “Conectar ao celular” para gerar um novo QR Code ou código.');
		const form = document.getElementById('pairing-form');
		const result = document.getElementById('pairing-result');
		const error = document.getElementById('pairing-error');
		if (form) form.style.display = 'none';
		if (result) result.style.display = 'none';
		if (error) error.style.display = 'none';
	} catch (e) {
		showSysAlert(e.message || 'Erro ao encerrar conexão.', 'error');
	}
}

function iniciarConexaoWhatsApp() { startWhatsAppConnection(); }

// =============================================================================
// GSAP HELPERS — MODAIS
// =============================================================================

/**
 * Abre um modal com animação GSAP:
 *   overlay → fade-in
 *   card    → slide-up + scale + fade-in com overshooting
 */
function gsapModalOpen(id) {
	const overlay = document.getElementById(id);
	if (!overlay) return;
	const card = overlay.querySelector(".modal-card");

	overlay.classList.add("active");
	gsap.killTweensOf([overlay, card]);

	gsap.fromTo(
		overlay,
		{ opacity: 0 },
		{ opacity: 1, duration: 0.28, ease: "power2.out" },
	);
	gsap.fromTo(
		card,
		{ opacity: 0, y: 40, scale: 0.93 },
		{
			opacity: 1,
			y: 0,
			scale: 1,
			duration: 0.46,
			ease: "bounce4",
			clearProps: "transform,scale",
		},
	);
}

/**
 * Fecha um modal com animação GSAP:
 *   card    → slide-down + fade-out
 *   overlay → fade-out → remove .active
 */
function gsapModalClose(id) {
	const overlay = document.getElementById(id);
	if (!overlay) return;
	const card = overlay.querySelector(".modal-card");

	gsap.killTweensOf([overlay, card]);
	gsap.to(card, {
		opacity: 0,
		y: 22,
		scale: 0.96,
		duration: 0.2,
		ease: "quickIn",
	});
	gsap.to(overlay, {
		opacity: 0,
		duration: 0.26,
		ease: "power2.in",
		delay: 0.05,
		onComplete: () => {
			overlay.classList.remove("active");
			// Reset do card para próxima abertura
			gsap.set(card, { opacity: 0, y: 40, scale: 0.93 });
		},
	});
}

// =============================================================================
// GSAP HELPERS — CUSTOM SYSTEM ALERTS & TOASTS
// =============================================================================
function showSysAlert(message, type = "info") {
	return new Promise((resolve) => {
		const overlay = document.getElementById("sysAlertModal");
		const card = document.getElementById("sysAlertCard");
		const icon = document.getElementById("sysAlertIcon");
		const msgEl = document.getElementById("sysAlertMsg");
		const btns = document.getElementById("sysAlertButtons");

		let iconHtml =
			'<i class="fas fa-info-circle" style="color: #3b82f6; filter: drop-shadow(0 0 15px rgba(59,130,246,0.5));"></i>';
		let btnHtml = `<button class="sys-btn sys-btn-confirm" id="sysBtnOk" style="background: #3b82f6; color: white; box-shadow: 0 0 20px rgba(59,130,246,0.3);">OK</button>`;

		if (type === "error") {
			iconHtml =
				'<i class="fas fa-times-circle" style="color: #ff4444; filter: drop-shadow(0 0 15px rgba(255,68,68,0.5));"></i>';
			btnHtml = `<button class="sys-btn sys-btn-confirm" id="sysBtnOk" style="background: #ff4444; color: white; box-shadow: 0 0 20px rgba(255,68,68,0.3);">ENTENDI</button>`;
		} else if (type === "warning") {
			iconHtml =
				'<i class="fas fa-exclamation-triangle" style="color: var(--gold); filter: drop-shadow(0 0 15px rgba(255,215,0,0.5));"></i>';
			btnHtml = `<button class="sys-btn sys-btn-confirm" id="sysBtnOk" style="background: var(--gold); color: black;">OK</button>`;
		}

		icon.innerHTML = iconHtml;
		msgEl.innerHTML = escapeHtml(message);
		btns.innerHTML = btnHtml;

		overlay.classList.add("active");
		gsap.fromTo(
			overlay,
			{ opacity: 0 },
			{ opacity: 1, duration: 0.25, ease: "power2.out" },
		);
		gsap.fromTo(
			card,
			{ opacity: 0, y: 30, scale: 0.9 },
			{ opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "bounce4" },
		);

		document.getElementById("sysBtnOk").onclick = () => {
			gsap.to(card, {
				opacity: 0,
				y: 15,
				scale: 0.95,
				duration: 0.2,
				ease: "quickIn",
			});
			gsap.to(overlay, {
				opacity: 0,
				duration: 0.25,
				delay: 0.05,
				onComplete: () => {
					overlay.classList.remove("active");
					resolve(true);
				},
			});
		};
	});
}

function showSysConfirm(message, confirmText = "Confirmar", danger = false) {
	return new Promise((resolve) => {
		const overlay = document.getElementById("sysAlertModal");
		const card = document.getElementById("sysAlertCard");
		const icon = document.getElementById("sysAlertIcon");
		const msgEl = document.getElementById("sysAlertMsg");
		const btns = document.getElementById("sysAlertButtons");

		const color = danger ? "#ff4444" : "var(--primary)";
		const txtColor = danger ? "white" : "black";
		const shadow = danger ? "rgba(255,68,68,0.3)" : "rgba(37,211,102,0.3)";

		icon.innerHTML = `<i class="fas fa-question-circle" style="color: ${color}; filter: drop-shadow(0 0 15px ${shadow});"></i>`;
		msgEl.innerHTML = escapeHtml(message);
		btns.innerHTML = `
            <button class="sys-btn sys-btn-cancel" id="sysBtnCancel">Cancelar</button>
            <button class="sys-btn sys-btn-confirm" id="sysBtnConfirm" style="background: ${color}; color: ${txtColor}; box-shadow: 0 0 20px ${shadow};">${confirmText}</button>
        `;

		overlay.classList.add("active");
		gsap.fromTo(
			overlay,
			{ opacity: 0 },
			{ opacity: 1, duration: 0.25, ease: "power2.out" },
		);
		gsap.fromTo(
			card,
			{ opacity: 0, y: 30, scale: 0.9 },
			{ opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "bounce4" },
		);

		const closeAndResolve = (result) => {
			gsap.to(card, {
				opacity: 0,
				y: 15,
				scale: 0.95,
				duration: 0.2,
				ease: "quickIn",
			});
			gsap.to(overlay, {
				opacity: 0,
				duration: 0.25,
				delay: 0.05,
				onComplete: () => {
					overlay.classList.remove("active");
					resolve(result);
				},
			});
		};

		document.getElementById("sysBtnCancel").onclick = () =>
			closeAndResolve(false);
		document.getElementById("sysBtnConfirm").onclick = () =>
			closeAndResolve(true);
	});
}

function showSysToast(message, type = "success") {
	const toast = document.createElement("div");
	const color =
		type === "success"
			? "#4ade80"
			: type === "error"
				? "#ff4444"
				: "var(--gold)";
	const icon =
		type === "success"
			? "fa-check-circle"
			: type === "error"
				? "fa-times-circle"
				: "fa-info-circle";

	toast.style.cssText = `
        position: fixed; bottom: 30px; right: 30px; 
        background: rgba(15,15,15,0.95); backdrop-filter: blur(10px);
        border: 1px solid ${color}; border-left: 4px solid ${color};
        color: white; padding: 16px 24px; border-radius: 12px; z-index: 9999999; 
        box-shadow: 0 20px 40px rgba(0,0,0,0.6), 0 0 20px ${color}20;
        display: flex; align-items: center; gap: 12px; font-weight: 600; font-size: 0.95rem;
    `;
	toast.innerHTML = `<i class="fas ${icon}" style="color: ${color}; font-size: 1.2rem;"></i> ${escapeHtml(message)}`;
	document.body.appendChild(toast);

	gsap.fromTo(
		toast,
		{ opacity: 0, x: 50 },
		{ opacity: 1, x: 0, duration: 0.4, ease: "back.out(1.2)" },
	);
	setTimeout(() => {
		gsap.to(toast, {
			opacity: 0,
			x: 20,
			duration: 0.3,
			ease: "power2.in",
			onComplete: () => toast.remove(),
		});
	}, 3500);
}

// =============================================================================
// GSAP HELPERS — TABELA & CALENDÁRIO
// =============================================================================

function gsapAnimateRows() {
	const rows = document.querySelectorAll("#tableBody tr");
	if (!rows.length) return;
	gsap.fromTo(
		rows,
		{ opacity: 0, x: -14 },
		{
			opacity: 1,
			x: 0,
			duration: 0.32,
			stagger: 0.028,
			ease: "power2.out",
			clearProps: "transform",
		},
	);
}

function gsapAnimateCells() {
	const cells = document.querySelectorAll(
		"#calendarGrid .day-cell:not(.empty)",
	);
	if (!cells.length) return;
	gsap.fromTo(
		cells,
		{ opacity: 0, scale: 0.84 },
		{
			opacity: 1,
			scale: 1,
			duration: 0.3,
			stagger: { amount: 0.38 },
			ease: "bounce4",
			clearProps: "transform,scale",
		},
	);
}

// =============================================================================
// INICIALIZAÇÃO — Sequência de entrada cinematográfica
// =============================================================================
document.addEventListener("DOMContentLoaded", () => {
	gsap.set(".status-bar, .logout-btn, .card", { clearProps: "all" });
	gsap.fromTo(
		".status-bar",
		{ opacity: 0, y: -12 },
		{ opacity: 1, y: 0, duration: 0.24, ease: "power2.out" },
	);
	gsap.fromTo(
		".card",
		{ opacity: 0, y: 12 },
		{ opacity: 1, y: 0, duration: 0.24, stagger: 0.03, ease: "power2.out" },
	);
	gsap.fromTo(
		".logout-btn",
		{ opacity: 0, y: -8 },
		{ opacity: 1, y: 0, duration: 0.2, stagger: 0.02, ease: "power2.out" },
	);

	if (!window.matchMedia("(pointer: coarse)").matches) {
		document.querySelectorAll(".card").forEach((card) => {
			card.addEventListener("mouseenter", () => {
				if (window.innerWidth < 1100) return;
				gsap.to(card, { y: -2, duration: 0.16, ease: "power2.out" });
			});
			card.addEventListener("mouseleave", () => {
				gsap.to(card, { y: 0, duration: 0.18, ease: "power2.out" });
			});
		});
	}

	createParticles();
	loadCollections();
	carregarProdutos();
	ensureHolidaysLoaded(calendarDate.getFullYear()).finally(() => {
		carregarAgendamentos();
		renderCalendar();
	});
	setPairingView("qr");
	loadWhatsAppConnectionState();

	const toggle = document.getElementById("menu-toggle");
	const menu = document.getElementById("top-actions");

	if (toggle) {
		toggle.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleHeaderMenu();
		});
	}

	document.addEventListener("click", (event) => {
		if (!menu || !toggle || window.innerWidth > 1100 || !headerMenuOpen) return;
		if (!menu.contains(event.target) && !toggle.contains(event.target))
			closeHeaderMenu();
	});

	window.addEventListener("resize", () => {
		updateHeaderMenuState();
	});

	updateHeaderMenuState();

	fetch("/api/campaign/status")
		.then((r) => r.json())
		.then(updateCampaignUI)
		.catch((err) => console.error("Erro ao obter status inicial:", err));

	setInterval(carregarProdutos, 10800000);
});

// =============================================================================
// PARTÍCULAS — Movimento orgânico contínuo via GSAP
// =============================================================================
function createParticles() {
	const container = document.getElementById("particles");
	if (!container) return;

	const prefersReducedMotion = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches;
	const isMobile =
		window.matchMedia("(max-width: 640px)").matches ||
		window.matchMedia("(pointer: coarse)").matches;
	const count = prefersReducedMotion
		? 0
		: isMobile
			? 5
			: window.innerWidth <= 1024
				? 8
				: 12;

	container.innerHTML = "";
	if (!count) return;

	const fragment = document.createDocumentFragment();

	for (let i = 0; i < count; i++) {
		const s = document.createElement("div");
		const size = isMobile ? Math.random() * 2.2 + 0.8 : Math.random() * 3 + 0.9;
		const x = Math.random() * 100;
		const y = Math.random() * 100;

		s.style.cssText = `
            position: absolute;
            left: ${x}%;
            top: ${y}%;
            width: ${size}px;
            height: ${size}px;
            background: white;
            border-radius: 50%;
            box-shadow: 0 0 ${size * 2}px rgba(255,255,255,0.65);
            opacity: 0;
            will-change: transform, opacity;
        `;
		fragment.appendChild(s);

		const floatY = -(
			Math.random() * (isMobile ? 16 : 30) +
			(isMobile ? 8 : 12)
		);
		const dur = Math.random() * (isMobile ? 2 : 3) + (isMobile ? 2.2 : 2.8);
		const delay = Math.random() * (isMobile ? 5 : 8);

		gsap
			.timeline({ repeat: -1, delay })
			.fromTo(
				s,
				{ opacity: 0, scale: 0, y: 0 },
				{
					opacity:
						Math.random() * (isMobile ? 0.28 : 0.45) + (isMobile ? 0.08 : 0.14),
					scale: 1,
					y: floatY,
					duration: dur * 0.45,
					ease: "power2.out",
				},
			)
			.to(s, {
				opacity: 0,
				scale: 0.2,
				y: floatY - (isMobile ? 8 : 14),
				duration: dur * 0.55,
				ease: "power2.in",
			});
	}

	container.appendChild(fragment);
}

// =============================================================================
// COLEÇÕES
// =============================================================================
async function loadCollections() {
	try {
		const res = await fetch("/api/collections");
		if (!res.ok) throw new Error("Erro na API de coleções");
		const list = await res.json();

		const selects = [
			document.getElementById("collection-select"),
			document.getElementById("collectionFilter"),
			document.getElementById("sched_filtro"),
		];

		selects.forEach((sel) => {
			if (!sel) return;
			const prev = sel.value;
			sel.innerHTML = '<option value="">Selecione...</option>';
			if (list && list.length > 0) {
				list.forEach((c) => {
					if (c && c.trim() !== "") {
						const opt = document.createElement("option");
						opt.value = c;
						opt.innerText = c;
						sel.appendChild(opt);
					}
				});
				if (Array.from(sel.options).some((o) => o.value === prev))
					sel.value = prev;
			}
		});
	} catch (e) {
		console.error("Erro ao carregar coleções:", e);
	}
}

// =============================================================================
// ENGINE DE FERIADOS (via API + fallback local)
// =============================================================================
function normalizeHolidayDate(dateStr) {
	if (!dateStr) return "";
	const dateOnly = String(dateStr).split("T")[0];
	const [y, m, d] = dateOnly.split("-");
	if (!y || !m || !d) return "";
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizeHolidayName(name) {
	return String(name || "").trim();
}

function getCachedHolidays(year) {
	return holidaysCache[year] || [];
}

async function fetchHolidaysFromBrasilAPI(year) {
	const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`);
	if (!res.ok) {
		throw new Error(`BrasilAPI retornou ${res.status}`);
	}

	const data = await res.json();
	if (!Array.isArray(data)) return [];

	return data
		.map((item) => ({
			date: normalizeHolidayDate(item.date),
			name: normalizeHolidayName(item.name),
			type: item.type || "API",
			source: "brasilapi",
		}))
		.filter((item) => item.date && item.name);
}

function getLocalFallbackHolidays(year) {
	const holidays = [];
	const fixed = {
		"01-01": "Confraternização Universal",
		"04-21": "Tiradentes",
		"05-01": "Dia do Trabalho",
		"09-07": "Independência do Brasil",
		"10-12": "Nossa Senhora Aparecida",
		"11-02": "Finados",
		"11-15": "Proclamação da República",
		"11-20": "Dia da Consciência Negra",
		"12-25": "Natal",
	};

	for (const [d, n] of Object.entries(fixed)) {
		holidays.push({
			date: `${year}-${d}`,
			name: n,
			type: "LOCAL_FALLBACK",
			source: "local",
		});
	}

	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	const easter = new Date(year, month - 1, day);

	const addDays = (dt, n) => {
		const r = new Date(dt);
		r.setDate(r.getDate() + n);
		return r;
	};

	const fmt = (dt) => {
		const y = dt.getFullYear();
		const mo = String(dt.getMonth() + 1).padStart(2, "0");
		const da = String(dt.getDate()).padStart(2, "0");
		return `${y}-${mo}-${da}`;
	};

	holidays.push({
		date: fmt(addDays(easter, -48)),
		name: "Carnaval",
		type: "LOCAL_FALLBACK",
		source: "local",
	});
	holidays.push({
		date: fmt(addDays(easter, -2)),
		name: "Sexta-feira Santa",
		type: "LOCAL_FALLBACK",
		source: "local",
	});
	holidays.push({
		date: fmt(easter),
		name: "Páscoa",
		type: "LOCAL_FALLBACK",
		source: "local",
	});
	holidays.push({
		date: fmt(addDays(easter, 60)),
		name: "Corpus Christi",
		type: "LOCAL_FALLBACK",
		source: "local",
	});

	return holidays;
}

async function ensureHolidaysLoaded(year) {
	if (holidaysCache[year]) return holidaysCache[year];

	try {
		const apiHolidays = await fetchHolidaysFromBrasilAPI(year);
		holidaysCache[year] = apiHolidays;
		return holidaysCache[year];
	} catch (err) {
		console.error(`Erro ao buscar feriados ${year} na API:`, err);
		holidaysCache[year] = getLocalFallbackHolidays(year);
		return holidaysCache[year];
	}
}

// =============================================================================
// HELPERS DE DATA
// =============================================================================
function inputParaISO(v) {
	return v ? `${v}:00-03:00` : "";
}

function formatarDataParaInput(iso) {
	if (!iso) return "";
	const date = new Date(iso);
	const parts = new Intl.DateTimeFormat("sv-SE", {
		timeZone: "America/Sao_Paulo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
	return parts.replace(" ", "T");
}

function dateKeyLocalFromISO(iso) {
	return iso ? formatarDataParaInput(iso).split("T")[0] : "";
}

// =============================================================================
// AGENDAMENTO
// =============================================================================
async function salvarAgendamento() {
	const id = document.getElementById("sched_id").value;
	const ini = document.getElementById("sched_inicio").value;
	const fim = document.getElementById("sched_fim").value;
	const nome = document.getElementById("sched_nome").value;

	if (!nome || !ini || !fim)
		return showSysAlert("Preencha Nome, Início e Fim!", "warning");
	if (ini >= fim)
		return showSysAlert(
			"A data de fim deve ser maior que a de início.",
			"warning",
		);

	const data = {
		nome,
		inicio: inputParaISO(ini),
		fim: inputParaISO(fim),
		modo: document.getElementById("sched_modo").value,
		filtro: document.getElementById("sched_filtro").value,
		msg_pre: document.getElementById("sched_msg").value,
	};
	if (data.modo === "COLECAO" && !data.filtro)
		return showSysAlert("Selecione a coleção alvo!", "warning");

	try {
		const res = await fetch(id ? `/api/schedule/${id}` : "/api/schedule", {
			method: id ? "PUT" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (res.ok) {
			fecharSchedule();
			carregarAgendamentos();
			showSysToast(
				id ? "Agendamento atualizado!" : "Agendamento criado!",
				"success",
			);
		} else {
			showSysAlert("Erro ao salvar.", "error");
		}
	} catch (e) {
		console.error(e);
		showSysAlert("Erro de conexão.", "error");
	}
}

async function carregarAgendamentos() {
	try {
		const currentYear = calendarDate.getFullYear();

		const [rs, rb] = await Promise.all([
			fetch("/api/schedule"),
			fetch("/api/vip/aniversariantes"),
			ensureHolidaysLoaded(currentYear),
		]);

		scheduleCache = rs.ok ? await rs.json() : [];
		birthdaysCache = rb.ok ? await rb.json() : [];
		renderCalendar();
	} catch (e) {
		console.error("Erro ao carregar agenda:", e);
	}
}

// =============================================================================
// CALENDÁRIO — com animação GSAP nas células + transição de mês
// =============================================================================
function renderCalendar() {
	const grid = document.getElementById("calendarGrid");
	const label = document.getElementById("calendarMonthLabel");
	if (!grid || !label) return;

	const year = calendarDate.getFullYear();
	const month = calendarDate.getMonth();

	label.innerText = calendarDate.toLocaleDateString("pt-BR", {
		month: "long",
		year: "numeric",
	});
	grid.innerHTML = "";

	const holidays = getCachedHolidays(year);
	const firstIndex = new Date(year, month, 1).getDay();
	const daysInMo = new Date(year, month + 1, 0).getDate();
	const today = new Date();

	["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].forEach(
		(d) => (grid.innerHTML += `<div class="weekday">${d}</div>`),
	);
	for (let i = 0; i < firstIndex; i++)
		grid.innerHTML += `<div class="day-cell empty"></div>`;

	for (let d = 1; d <= daysInMo; d++) {
		const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
		const isToday =
			d === today.getDate() &&
			month === today.getMonth() &&
			year === today.getFullYear();

		const dayEvt = (scheduleCache || []).filter(
			(ev) => dateKeyLocalFromISO(ev.data_inicio) === dateStr,
		);
		const dayBday = (birthdaysCache || []).filter((bd) => {
			if (!bd.start) return false;
			const [, bm, bd2] = String(bd.start).split("-");
			return Number(bm) === month + 1 && Number(bd2) === d;
		});
		const dayHol = holidays.filter((h) => h.date === dateStr);

		let html = `<div class="day-cell ${isToday ? "today" : ""}" onclick="abrirSchedule(null,'${dateStr}')">
                        <div class="day-number">${d}</div>
                        <div class="events-stack">`;

		dayHol.forEach(
			(h) =>
				(html += `<div class="info-marker" style="background:rgba(147,51,234,0.15);color:#d8b4fe;border:1px solid rgba(147,51,234,0.3);margin-bottom:2px;" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</div>`),
		);
		dayEvt.forEach((ev) => {
			const cls = ev.modo === "BLITZ" ? "event-blitz" : "event-colecao";
			const hora = new Date(ev.data_inicio).toLocaleTimeString("pt-BR", {
				timeZone: "America/Sao_Paulo",
				hour: "2-digit",
				minute: "2-digit",
			});
			html += `<div class="event-marker ${cls}" title="${escapeHtml(ev.nome_evento)}" onclick="event.stopPropagation();editarAgendamento(${ev.id})">${hora} ${escapeHtml(ev.nome_evento)}</div>`;
		});
		dayBday.forEach(
			(bd) =>
				(html += `<div class="event-marker" style="background:rgba(255,105,180,0.15);color:#ff80bf;border-left:3px solid #ff1493;">${escapeHtml(bd.title)}</div>`),
		);

		html += `</div></div>`;
		grid.innerHTML += html;
	}

	gsapAnimateCells();
}

async function mudarMes(delta) {
	const label = document.getElementById("calendarMonthLabel");
	const dir = delta > 0 ? -1 : 1;

	gsap.to(label, {
		opacity: 0,
		x: dir * 20,
		duration: 0.18,
		ease: "power2.in",
		onComplete: async () => {
			calendarDate.setMonth(calendarDate.getMonth() + delta);
			const year = calendarDate.getFullYear();
			await ensureHolidaysLoaded(year);
			renderCalendar();
			gsap.fromTo(
				label,
				{ opacity: 0, x: -dir * 20 },
				{ opacity: 1, x: 0, duration: 0.28, ease: "power2.out" },
			);
		},
	});
}

// ─── Modais de Agendamento ────────────────────────────────────────────────────
function abrirSchedule(id, dateStr) {
	document.getElementById("sched_id").value = "";
	document.getElementById("sched_nome").value = "";
	document.getElementById("sched_msg").value = "";
	document.getElementById("sched_filtro").value = "";
	document.getElementById("sched_filtro_div").style.display = "none";
	document.getElementById("btn-del-sched").style.display = "none";

	if (dateStr) {
		document.getElementById("sched_inicio").value = `${dateStr}T08:00`;
		document.getElementById("sched_fim").value = `${dateStr}T18:00`;
		const year = Number(dateStr.split("-")[0]);
		const feriado = getCachedHolidays(year).find((h) => h.date === dateStr);
		if (feriado) {
			document.getElementById("sched_nome").value = `Oferta de ${feriado.name}`;
		}
	}
	gsapModalOpen("scheduleModal");
}

function editarAgendamento(id) {
	const ev = scheduleCache.find((e) => e.id === id);
	if (!ev) return;
	document.getElementById("sched_id").value = ev.id;
	document.getElementById("sched_nome").value = ev.nome_evento;
	document.getElementById("sched_inicio").value = formatarDataParaInput(
		ev.data_inicio,
	);
	document.getElementById("sched_fim").value = formatarDataParaInput(
		ev.data_fim,
	);
	document.getElementById("sched_modo").value = ev.modo;
	const divF = document.getElementById("sched_filtro_div");
	if (ev.modo === "COLECAO") {
		divF.style.display = "block";
		document.getElementById("sched_filtro").value = ev.filtro || "";
	} else divF.style.display = "none";
	document.getElementById("sched_msg").value = ev.msg_pre_lancamento || "";
	document.getElementById("btn-del-sched").style.display = "block";
	gsapModalOpen("scheduleModal");
}

function fecharSchedule() {
	gsapModalClose("scheduleModal");
}

function toggleSchedFiltro() {
	const modo = document.getElementById("sched_modo").value;
	const div = document.getElementById("sched_filtro_div");
	if (!div) return;
	if (modo === "COLECAO") {
		div.style.display = "block";
		gsap.fromTo(
			div,
			{ opacity: 0, height: 0 },
			{ opacity: 1, height: "auto", duration: 0.3, ease: "power2.out" },
		);
	} else {
		gsap.to(div, {
			opacity: 0,
			height: 0,
			duration: 0.2,
			ease: "power2.in",
			onComplete: () => {
				div.style.display = "none";
			},
		});
	}
}

async function gerarCopySugestao() {
	const nome = document.getElementById("sched_nome").value;
	if (!nome) {
		await showSysAlert("Dê um nome ao evento primeiro!", "warning");
		return;
	}
	const msgs = [
		`🔥 Está chegando! O evento ${nome} vai trazer peças exclusivas. Prepare-se!`,
		`💎 Spoiler: ${nome} começa em breve. Você não vai querer perder!`,
		`⚠️ Atenção Grupo: Amanhã teremos o especial ${nome}. Ativem as notificações!`,
		`✨ ${nome}: Elegância e sofisticação esperam por você. Em breve!`,
	];
	document.getElementById("sched_msg").value =
		msgs[Math.floor(Math.random() * msgs.length)];
}

async function deletarAgendamento() {
	const id = document.getElementById("sched_id").value;
	if (!id) return;
	if (
		!(await showSysConfirm(
			"Tem certeza que deseja excluir este agendamento?",
			"Excluir",
			true,
		))
	)
		return;
	try {
		await fetch(`/api/schedule/${id}`, { method: "DELETE" });
		fecharSchedule();
		carregarAgendamentos();
		showSysToast("Agendamento removido", "success");
	} catch (e) {
		showSysAlert("Erro ao excluir.", "error");
	}
}

// =============================================================================
// CONTROLE MANUAL & CAMPANHA
// =============================================================================
async function selectMode(mode) {
	if (isCampaignActive) {
		await showSysAlert(
			"⚠️ Pare a campanha atual antes de mudar o modo de operação.",
			"warning",
		);
		return;
	}
	currentMode = mode;

	document
		.querySelectorAll(".mode-btn")
		.forEach((b) =>
			b.classList.remove("active-normal", "active-blitz", "active-colecao"),
		);
	const btnMap = {
		NORMAL: "btn-normal",
		BLITZ: "btn-blitz",
		COLECAO: "btn-colecao",
	};
	const classMap = {
		NORMAL: "active-normal",
		BLITZ: "active-blitz",
		COLECAO: "active-colecao",
	};
	const btn = document.getElementById(btnMap[mode]);
	if (btn) {
		btn.classList.add(classMap[mode]);
		gsap.fromTo(
			btn,
			{ scale: 0.9 },
			{ scale: 1, duration: 0.35, ease: "bounce4" },
		);
	}

	const sel = document.getElementById("collection-select");
	const hint = document.getElementById("campaign-hint");
	const main = document.getElementById("main-action-btn");
	if (!sel || !hint || !main) return;

	if (mode === "COLECAO") {
		sel.style.display = "block";
		gsap.fromTo(
			sel,
			{ opacity: 0, y: -8 },
			{ opacity: 1, y: 0, duration: 0.3, ease: "power2.out" },
		);
		if (sel.options.length <= 1) loadCollections();
		hint.innerText =
			"Modo Desfile: Envia 2 itens a cada 30min com foco em storytelling e desejo.";
		main.innerText = "INICIAR DESFILE 💎";
		main.className = "btn-start";
		main.disabled = false;
		main.style.opacity = 1;
	} else if (mode === "BLITZ") {
		if (sel.style.display !== "none") sel.style.display = "none";
		hint.innerHTML =
			"<span style='color:#ff6b6b'>⚡ ATENÇÃO:</span> O bot enviará os itens marcados com ⭐ a cada 2 MINUTOS!";
		main.innerText = "INICIAR BLITZ ⚡";
		main.className = "btn-start";
		main.disabled = false;
		main.style.opacity = 1;
	} else {
		if (sel.style.display !== "none") sel.style.display = "none";
		hint.innerText =
			"Modo Normal: O bot seleciona produtos automaticamente e envia a cada 1h.";
		main.innerText = "EM OPERAÇÃO (AUTO)";
		main.className = "btn-start";
		main.disabled = true;
		main.style.opacity = 0.5;
	}
}

async function toggleCampaign() {
	if (!isCampaignActive) {
		let filter = null;
		if (currentMode === "COLECAO") {
			const sel = document.getElementById("collection-select");
			filter = sel ? sel.value : null;
			if (!filter) {
				await showSysAlert(
					"Por favor, selecione uma coleção para iniciar o desfile!",
					"warning",
				);
				return;
			}
		}
		if (
			currentMode === "BLITZ" &&
			!produtosCache.some((p) => p.prioridade && p.status !== "ENVIADO")
		) {
			await showSysAlert(
				"⚠️ Atenção: Não há produtos marcados com estrela ⭐ pendentes.",
				"warning",
			);
			return;
		}
		if (
			!(await showSysConfirm(
				`Confirmar início do modo ${currentMode}? O bot começará a enviar mensagens.`,
				"Iniciar",
			))
		)
			return;

		try {
			const res = await fetch("/api/campaign/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: currentMode, filter }),
			});
			const json = await res.json();
			if (json.error) showSysAlert("Erro: " + json.error, "error");
			else showSysToast("Campanha Inciada!", "success");
		} catch (err) {
			console.error(err);
			showSysAlert("Erro ao conectar com o servidor.", "error");
		}
	} else {
		if (
			!(await showSysConfirm(
				"Deseja parar a campanha atual e voltar ao modo normal (automático)?",
				"Parar Campanha",
				true,
			))
		)
			return;
		try {
			await fetch("/api/campaign/stop", { method: "POST" });
			showSysToast("Campanha Pausada!", "success");
		} catch (err) {
			showSysAlert("Erro ao parar campanha.", "error");
		}
	}
}

function updateCampaignUI(state) {
	if (!state) return;
	isCampaignActive = !!state.active;
	currentMode = state.mode || "NORMAL";

	const btn = document.getElementById("main-action-btn");
	const stat = document.getElementById("campaign-status");
	const sel = document.getElementById("collection-select");
	if (!btn || !stat || !sel) return;

	gsap.to(stat, {
		opacity: 0,
		y: -6,
		duration: 0.15,
		onComplete: () => {
			if (state.active) {
				btn.innerText = "PARAR CAMPANHA 🛑";
				btn.className = "btn-start stop";
				btn.disabled = false;
				btn.style.opacity = 1;

				let label = state.mode,
					color = "#fff";
				if (state.mode === "BLITZ") {
					label = "⚡ BLITZ ATIVA";
					color = "#ff4444";
				}
				if (state.mode === "COLECAO") {
					label = "💎 DESFILE ATIVO";
					color = "#FFD700";
				}

				stat.innerHTML = `<span style="color:${color};text-shadow:0 0 10px ${color}40;">${escapeHtml(label)}</span>`;
				if (state.filter)
					stat.innerHTML += ` <span style="font-size:0.8em;opacity:0.7">(${escapeHtml(state.filter)})</span>`;

				document
					.querySelectorAll(".mode-btn")
					.forEach((b) =>
						b.classList.remove(
							"active-normal",
							"active-blitz",
							"active-colecao",
						),
					);
				const bId =
					state.mode === "NORMAL"
						? "btn-normal"
						: state.mode === "BLITZ"
							? "btn-blitz"
							: "btn-colecao";
				const bCl =
					state.mode === "NORMAL"
						? "active-normal"
						: state.mode === "BLITZ"
							? "active-blitz"
							: "active-colecao";
				const bEl = document.getElementById(bId);
				if (bEl) bEl.classList.add(bCl);

				if (state.mode === "COLECAO") {
					sel.style.display = "block";
					sel.value = state.filter || "";
					sel.disabled = true;
				} else sel.style.display = "none";
			} else {
				isCampaignActive = false;
				selectMode("NORMAL");
				stat.innerHTML = "MODO: NORMAL";
				sel.disabled = false;
				sel.style.display = "none";
			}
			gsap.to(stat, { opacity: 1, y: 0, duration: 0.22, ease: "power2.out" });
		},
	});
}

// =============================================================================
// SOCKET.IO
// =============================================================================
socket.on("campaign_update", (state) => {
	updateCampaignUI(state);
	clearTimeout(_agendDebounce);
	_agendDebounce = setTimeout(carregarAgendamentos, 2000);
});

socket.on("log", (msg) => {
	const logsDiv = document.getElementById("logs");
	if (!logsDiv) return;

	const line = document.createElement("div");
	line.className = "log-line";
	const time = new Date().toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	line.innerHTML = `<span class="log-time">${time}</span> ${escapeHtml(msg)}`;
	logsDiv.appendChild(line);

	gsap.fromTo(
		line,
		{ opacity: 0, x: -10 },
		{
			opacity: 1,
			x: 0,
			duration: 0.28,
			ease: "power2.out",
			clearProps: "transform",
		},
	);

	while (logsDiv.children.length > 200) logsDiv.removeChild(logsDiv.firstChild);

	logsDiv.scrollTop = logsDiv.scrollHeight;
});

socket.on("whatsapp_idle", () => { renderConnectionIdle(); applyWhatsAppState({ started: false, starting: false, connected: false, hasQr: false }); });
socket.on("whatsapp_state", (state) => { applyWhatsAppState(state || {}); });

socket.on("connection_starting", () => {
	applyWhatsAppState({ started: true, starting: true });
	const container = document.getElementById("qr-container");
	if (container) container.innerHTML = `<span class="qr-placeholder"><i class="fas fa-spinner fa-spin"></i> Preparando conexão...</span>`;
});

socket.on("qr", (url) => {
	applyWhatsAppState({ started: true, starting: false, connected: false, hasQr: true });
	const container = document.getElementById("qr-container");
	setPairingView(currentPairingView === "code" ? "code" : "qr");
	if (container) {
		gsap.to(container, {
			opacity: 0,
			scale: 0.88,
			duration: 0.2,
			ease: "power2.in",
			onComplete: () => {
				container.innerHTML = `<img src="${escapeHtml(url)}" id="qr-image"
                    style="max-width:200px;border:4px solid white;border-radius:10px;" />`;
				gsap.fromTo(
					container,
					{ opacity: 0, scale: 0.82 },
					{
						opacity: 1,
						scale: 1,
						duration: 0.45,
						ease: "bounce4",
						clearProps: "transform,scale",
					},
				);
			},
		});
	}
	const badge = document.getElementById("status-badge");
	if (badge) {
		badge.innerText = "Aguardando Leitura";
		badge.className = "status-badge status-offline";
	}
	const dot = document.getElementById("conn-dot");
	if (dot) dot.className = "status-dot dot-red";
	const text = document.getElementById("conn-text");
	if (text) text.innerText = "WhatsApp Desconectado";
});

socket.on("connected", () => {
	applyWhatsAppState({ started: true, starting: false, connected: true, hasQr: false, pairingInProgress: false });
	const container = document.getElementById("qr-container");
	const form = document.getElementById("pairing-form");
	if (form) form.style.display = "none";
	setPairingView(currentPairingView === "code" ? "code" : "qr");
	if (container) {
		gsap.to(container, {
			opacity: 0,
			scale: 0.82,
			duration: 0.2,
			ease: "power2.in",
			onComplete: () => {
				container.innerHTML = `<i class="fas fa-check-circle"
                    style="font-size:5rem;color:#25D366;filter:drop-shadow(0 0 15px rgba(37,211,102,0.4));"></i>`;
				gsap.fromTo(
					container,
					{ opacity: 0, scale: 0.4 },
					{
						opacity: 1,
						scale: 1,
						duration: 0.6,
						ease: "bounce4",
						clearProps: "transform,scale",
					},
				);
			},
		});
	}

	const badge = document.getElementById("status-badge");
	if (badge) {
		gsap.to(badge, {
			scale: 1.15,
			duration: 0.15,
			ease: "power2.out",
			yoyo: true,
			repeat: 1,
			onComplete: () => {
				badge.innerText = "Sistema Online";
				badge.className = "status-badge status-online";
				gsap.set(badge, { scale: 1 });
			},
		});
	}

	const dot = document.getElementById("conn-dot");
	if (dot) {
		dot.className = "status-dot dot-green";
		gsap.fromTo(
			dot,
			{ boxShadow: "0 0 0 0 rgba(74,222,128,0.9)" },
			{
				boxShadow: "0 0 0 14px rgba(74,222,128,0)",
				duration: 0.85,
				ease: "power2.out",
			},
		);
	}

	const text = document.getElementById("conn-text");
	if (text) text.innerText = "WhatsApp Conectado";
});

socket.on("group_detected", (data) => {
	const list = document.getElementById("group-list");
	if (!list) return;
	if (list.innerHTML.includes("Envie mensagem")) list.innerHTML = "";

	const safeSubject = escapeHtml(data.subject || "Grupo Detectado");
	const safeId = escapeHtml(data.id);

	const wrapper = document.createElement("div");
	wrapper.className = "group-item";
	wrapper.style.cssText =
		"margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.05);border-radius:8px;border-left:3px solid var(--primary);";
	wrapper.innerHTML = `
        <div style="font-weight:600;font-size:0.9rem;color:white;">${safeSubject}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
            <span class="group-id" style="font-family:monospace;font-size:0.8rem;color:var(--gold)">${safeId}</span>
            <button class="btn-copy" onclick="copiar('${safeId}')"
                style="background:none;border:none;color:#aaa;cursor:pointer;" title="Copiar ID">
                <i class="far fa-copy"></i>
            </button>
        </div>
    `;
	list.insertBefore(wrapper, list.firstChild);

	gsap.fromTo(
		wrapper,
		{ opacity: 0, y: -18, scale: 0.92 },
		{
			opacity: 1,
			y: 0,
			scale: 1,
			duration: 0.42,
			ease: "bounce4",
			clearProps: "transform,scale",
		},
	);
});

function copiar(text) {
	navigator.clipboard.writeText(text);
	showSysToast("ID copiado!", "success");
}

// =============================================================================
// CATÁLOGO & TABELA
// =============================================================================
async function resetarTudo(ev) {
	if (
		!(await showSysConfirm(
			"ATENÇÃO: Isso marcará TODOS os produtos como pendentes novamente. Deseja continuar?",
			"Resetar Tudo",
			true,
		))
	)
		return;
	const btn = ev?.currentTarget || null;
	const svgIcon = btn ? btn.querySelector("svg.svgIcon") : null;
	try {
		if (svgIcon)
			gsap.to(svgIcon, {
				rotation: 360,
				duration: 0.7,
				ease: "linear",
				repeat: -1,
			});
		const res = await fetch("/api/produtos/reset-all", { method: "POST" });
		const data = await res.json();
		if (data?.success) {
			showSysToast("Catálogo resetado com sucesso!", "success");
			await carregarProdutos();
		} else if (data?.error) {
			showSysAlert("Erro: " + data.error, "error");
		}
	} catch (err) {
		console.error(err);
		showSysAlert("Erro de conexão ao tentar resetar.", "error");
	} finally {
		if (svgIcon) {
			gsap.killTweensOf(svgIcon);
			gsap.set(svgIcon, { rotation: 0 });
		}
	}
}

async function resetarItem(sku) {
	if (
		!(await showSysConfirm(
			`Deseja colocar o item ${sku} na fila de envio novamente?`,
			"Resetar Item",
		))
	)
		return;
	try {
		await fetch(`/api/produtos/reset/${sku}`, { method: "POST" });
		const item = produtosCache.find((p) => p.sku === sku);
		if (item) item.status = "";
		renderizarTabela(produtosCache);
		showSysToast("Item resetado!", "success");
	} catch (err) {
		showSysAlert("Erro ao resetar item", "error");
		carregarProdutos();
	}
}

async function carregarProdutos() {
	const btnIcon = document.querySelector(".btn-refresh-exp .svgIcon");
	if (btnIcon)
		gsap.to(btnIcon, {
			rotation: 360,
			duration: 0.65,
			ease: "linear",
			repeat: -1,
		});

	try {
		const res = await fetch("/api/produtos");
		if (!res.ok) throw new Error("Falha ao buscar produtos");
		produtosCache = await res.json();
		filtrarTabela();
	} catch (err) {
		console.error("Erro ao carregar produtos:", err);
	} finally {
		if (btnIcon) {
			gsap.killTweensOf(btnIcon);
			gsap.set(btnIcon, { rotation: 0 });
		}
	}
}

function converterLinkDrive(url) {
	if (!url) return "https://via.placeholder.com/50/333/888?text=?";

	const patterns = [
		/\/d\/([a-zA-Z0-9_-]{10,})/,
		/id=([a-zA-Z0-9_-]{10,})/,
		/open\?id=([a-zA-Z0-9_-]{10,})/,
		/uc\?.*id=([a-zA-Z0-9_-]{10,})/,
		/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]{10,})/,
	];

	let id = null;
	for (const p of patterns) {
		const match = String(url).match(p);
		if (match && match[1]) {
			id = match[1];
			break;
		}
	}

	if (
		id ||
		String(url).includes("drive.google.com") ||
		String(url).includes("googleusercontent.com")
	) {
		return `/api/image-proxy?url=${encodeURIComponent(url)}`;
	}

	return url;
}

function handleImgError(imgEl) {
	const originalSrc = imgEl.getAttribute("data-original-url");
	if (!originalSrc || imgEl.getAttribute("data-proxy-tried")) {
		imgEl.src = "https://via.placeholder.com/50/333/888?text=Erro";
		return;
	}
	imgEl.setAttribute("data-proxy-tried", "true");
	imgEl.src = `/api/image-proxy?url=${encodeURIComponent(originalSrc)}`;
}

function renderizarTabela(lista) {
	const tbody = document.getElementById("tableBody");
	if (!tbody) return;
	tbody.innerHTML = "";

	if (!lista || lista.length === 0) {
		tbody.innerHTML =
			'<div class="list-empty">Nenhum produto encontrado.</div>';
		return;
	}

	lista.forEach((p) => {
		const imgUrl = converterLinkDrive(p.image_url);
		let statusBadge = '<span class="badge b-pendente">Pendente</span>';
		if (p.status === "ENVIADO")
			statusBadge = '<span class="badge b-enviado">Enviado</span>';
		if (p.status === "ERRO_IMG")
			statusBadge = '<span class="badge b-erro">Erro Img</span>';
		const repoBadge = p.reposicao
			? '<span class="badge b-repo" title="Produto de reposição">Repo</span>'
			: "";

		const item = document.createElement("div");
		item.className = "product-list-item";
		item.innerHTML = `
          <div class="product-list-thumb-wrap">
            <button class="star-btn ${p.prioridade ? "active" : ""}" onclick="togglePrioridade('${escapeHtml(p.sku)}')" title="Marcar prioridade">
              <i class="${p.prioridade ? "fas" : "far"} fa-star"></i>
            </button>
            <img class="product-list-thumb" src="${escapeHtml(imgUrl)}" loading="lazy" data-original-url="${escapeHtml(p.image_url || "")}" onerror="handleImgError(this)">
          </div>
          <div class="product-list-main">
            <div class="product-list-top">
              <div class="product-list-copy">
                <div class="product-list-name">${escapeHtml(p.nome)} ${repoBadge}</div>
                <div class="product-list-sku">SKU: ${escapeHtml(p.sku)}</div>
              </div>
              <div class="product-list-price">${escapeHtml(formatCurrencyBR(p.valor))}</div>
            </div>
            <div class="product-list-meta">
              <span><strong>Coleção:</strong> ${escapeHtml(p.colecao || "-")}</span>
              <span><strong>Estoque:</strong> ${escapeHtml(String(p.estoque))}</span>
            </div>
            <div class="product-list-bottom">
              <div class="product-list-status">${statusBadge}</div>
              <div class="product-list-actions">
                ${
								p.status === "ENVIADO" || p.status === "ERRO_IMG"
									? `<button class="btn-action product-inline-btn" onclick="resetarItem('${escapeHtml(p.sku)}')" title="Resetar item"><i class="fas fa-redo"></i><span>Resetar</span></button>`
									: '<span class="product-inline-hint">Sem ação</span>'
							}
              </div>
            </div>
          </div>`;
		tbody.appendChild(item);
	});

	gsap.fromTo(
		"#tableBody .product-list-item",
		{ opacity: 0, y: 14 },
		{ opacity: 1, y: 0, duration: 0.22, stagger: 0.03, ease: "power2.out" },
	);
}

async function togglePrioridade(sku) {
	try {
		const item = produtosCache.find((p) => p.sku === sku);
		if (item) {
			item.prioridade = !item.prioridade;
			filtrarTabela();
		}
		await fetch(`/api/produtos/prioridade/${sku}`, { method: "POST" });
	} catch (err) {
		console.error("Erro ao mudar prioridade:", err);
		carregarProdutos();
	}
}

function filtrarStatus(status, el) {
	filtroStatusAtual = status;
	document
		.querySelectorAll(".btn-filter")
		.forEach((b) => b.classList.remove("active"));
	if (el && el.classList && el.classList.contains("btn-filter")) {
		el.classList.add("active");
		gsap.fromTo(
			el,
			{ scale: 0.88 },
			{ scale: 1, duration: 0.3, ease: "bounce4" },
		);
	} else {
		document.querySelectorAll(".btn-filter").forEach((b) => {
			if (
				b.textContent
					.toLowerCase()
					.includes(status === "todos" ? "todos" : status)
			)
				b.classList.add("active");
		});
	}
	const sel = document.querySelector(".filter-select-mobile");
	if (sel) sel.value = status;
	filtrarTabela();
}

function _normTipo(s) {
	return String(s || "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, "")
		.trim();
}
const TIPO_KEYWORDS = {
	colares: ["colar", "colares", "gargantilha", "corrente"],
	pulseiras: ["pulseira", "pulseiras", "bracelete"],
	brincos: ["brinco", "brincos", "argola", "argolas"],
	aneis: ["anel", "aneis", "aliança", "alianca"],
	kits: ["kit", "kits", "conjunto", "conjuntos"],
};
function matchTipo(categoria, filtro) {
	if (!filtro) return true;
	const keywords = TIPO_KEYWORDS[filtro] || [filtro];
	const cat = _normTipo(categoria);
	if (!cat) return false;
	return keywords.some((k) => cat.includes(_normTipo(k)));
}

function filtrarTipo(tipo) {
	filtroTipoAtual = tipo || "";
	catalogoPagina = 1;
	filtrarTabela();
}

function filtrarTabela() {
	const termo = (
		document.getElementById("searchInput")?.value || ""
	).toLowerCase();
	const colFilter = document.getElementById("collectionFilter")?.value || "";
	_produtosFiltradosCache = produtosCache.filter((p) => {
		const matchTexto =
			(p.nome || "").toLowerCase().includes(termo) ||
			(p.sku || "").toLowerCase().includes(termo);
		const matchCol = colFilter === "" || p.colecao === colFilter;
		const matchTip = matchTipo(p.categoria, filtroTipoAtual);
		let matchStatus = true;
		if (filtroStatusAtual === "pendente")
			matchStatus = p.status !== "ENVIADO" && p.status !== "ERRO_IMG";
		else if (filtroStatusAtual === "enviado")
			matchStatus = p.status === "ENVIADO";
		else if (filtroStatusAtual === "erro")
			matchStatus = p.status === "ERRO_IMG";
		return matchTexto && matchCol && matchTip && matchStatus;
	});

	const totalPaginas = Math.max(
		1,
		Math.ceil(_produtosFiltradosCache.length / ITENS_POR_PAGINA),
	);
	if (catalogoPagina > totalPaginas) catalogoPagina = totalPaginas;
	if (catalogoPagina < 1) catalogoPagina = 1;

	const inicio = (catalogoPagina - 1) * ITENS_POR_PAGINA;
	const fim = inicio + ITENS_POR_PAGINA;
	const paginaItens = _produtosFiltradosCache.slice(inicio, fim);

	renderizarTabela(paginaItens);
	renderCatalogoPaginacao(totalPaginas);
}

function renderCatalogoPaginacao(totalPaginas) {
	const wrap = document.getElementById("catalogPagination");
	if (!wrap) return;

	if (totalPaginas <= 1) {
		wrap.innerHTML = "";
		return;
	}

	let html = `
		<button class="pag-btn" ${catalogoPagina === 1 ? "disabled" : ""} onclick="mudarPaginaCatalogo(${catalogoPagina - 1})"><</button>
		<span class="page-indicator">Página ${catalogoPagina} de ${totalPaginas}</span>
		<button class="pag-btn" ${catalogoPagina === totalPaginas ? "disabled" : ""} onclick="mudarPaginaCatalogo(${catalogoPagina + 1})">></button>
	`;

	wrap.innerHTML = html;
}

function mudarPaginaCatalogo(page) {
	catalogoPagina = page;
	filtrarTabela();
}

// =============================================================================
// RESTANTE DO ARQUIVO
// =============================================================================
// O restante do seu arquivo original segue sem alteração funcional relevante
// para a integração dos feriados. Como o arquivo completo ultrapassa muito o
// limite prático de resposta, deixei a versão integral disponível no arquivo
// gerado no sandbox.


// =============================================================================
// CONFIGURAÇÕES (CÉREBRO DO BOT)
// =============================================================================
function abrirConfig() {
	gsapModalOpen("configModal");
	fetch("/api/settings")
		.then((r) => r.json())
		.then((s) => {
			const sv = (id, v) => {
				const el = document.getElementById(id);
				if (el && v != null) el.value = v;
			};
			sv("cfg_hora_inicio", s.HORARIO_INICIO);
			sv("cfg_hora_fim", s.HORARIO_FIM);
			sv("cfg_int_normal", s.INTERVALO_NORMAL);
			sv("cfg_int_blitz", s.INTERVALO_BLITZ);
			sv("cfg_int_colecao", s.INTERVALO_COLECAO);
			const sp = (id, raw) => {
				const el = document.getElementById(id);
				if (!el) return;
				try {
					el.value = JSON.parse(raw);
				} catch {
					el.value = raw || "";
				}
			};
			sp("cfg_prompt_normal", s.PROMPT_NORMAL);
			sp("cfg_prompt_blitz", s.PROMPT_BLITZ);
			sp("cfg_prompt_colecao", s.PROMPT_COLECAO);
		})
		.catch((e) => console.error("Erro ao carregar settings:", e));
}

function fecharConfig() {
	gsapModalClose("configModal");
}

async function salvarConfig() {
	if (
		!(await showSysConfirm(
			"Tem certeza que deseja salvar as configurações? O bot será atualizado imediatamente.",
			"Salvar",
		))
	)
		return;
	const gi = (id) => {
		const el = document.getElementById(id);
		return el ? parseInt(el.value) : null;
	};
	const gs = (id) => {
		const el = document.getElementById(id);
		return el ? el.value : "";
	};
	const data = {
		HORARIO_INICIO: gi("cfg_hora_inicio"),
		HORARIO_FIM: gi("cfg_hora_fim"),
		INTERVALO_NORMAL: gi("cfg_int_normal"),
		PROMPT_NORMAL: gs("cfg_prompt_normal"),
		INTERVALO_BLITZ: gi("cfg_int_blitz"),
		PROMPT_BLITZ: gs("cfg_prompt_blitz"),
		INTERVALO_COLECAO: gi("cfg_int_colecao"),
		PROMPT_COLECAO: gs("cfg_prompt_colecao"),
	};
	try {
		const res = await fetch("/api/settings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		const json = await res.json();
		if (json.success) {
			showSysToast("Cérebro do bot atualizado!", "success");
			fecharConfig();
		} else
			showSysAlert(
				"Erro ao salvar: " + (json.error || "Desconhecido"),
				"error",
			);
	} catch (err) {
		console.error(err);
		showSysAlert("Erro de conexão ao salvar configurações.", "error");
	}
}

// =============================================================================
// GESTÃO DE CLIENTES VIP
// =============================================================================
window.abrirListaVip = function () {
	const modal = document.getElementById("vipListModal");
	if (!modal) {
		console.error("Modal vipListModal não encontrado no HTML");
		return;
	}
	gsapModalOpen("vipListModal");
	window.carregarVips();
};

window.fecharListaVip = function () {
	gsapModalClose("vipListModal");
};

window.carregarVips = async function () {
	const tbody = document.getElementById("vipTableBody");
	const counter = document.getElementById("vip-total-count");
	if (!tbody) return;
	tbody.innerHTML = '<div class="list-empty">Carregando...</div>';

	try {
		const res = await fetch("/api/vip/list");
		if (!res.ok) throw new Error("Falha na API");
		const lista = await res.json();
		if (counter) counter.innerText = `Total: ${lista.length} clientes`;
		tbody.innerHTML = "";

		if (!lista || lista.length === 0) {
			tbody.innerHTML =
				'<div class="list-empty">Nenhum cliente cadastrado ainda.</div>';
			return;
		}

		tbody.innerHTML = lista
			.map((vip) => {
				let dataFmt = "--/--";
				if (vip.data_nascimento) {
					try {
						const parts = String(vip.data_nascimento).split("T")[0].split("-");
						if (parts.length === 3)
							dataFmt = `${parts[2]}/${parts[1]}/${parts[0]}`;
					} catch {}
				}
				let dw = vip.whatsapp || "";
				if (dw.startsWith("55") && dw.length > 10) dw = dw.substring(2);
				if (dw.length >= 10)
					dw = `(${dw.substring(0, 2)}) ${dw.substring(2, 7)}-${dw.substring(7)}`;
				return `<div class="crm-row-item vip-row-item">
                <div class="crm-row-main">
                    <div class="crm-row-title">${escapeHtml(vip.nome || "Sem Nome")}</div>
                    <div class="crm-row-subtitle">${escapeHtml(dw)}</div>
                </div>
                <div class="crm-row-stats"><span class="crm-pill">Nascimento: ${escapeHtml(dataFmt)}</span></div>
                <div class="crm-row-actions">
                    <button class="crm-action-btn danger" onclick="deletarVip(${vip.id})"><i class="fas fa-trash"></i><span>Excluir</span></button>
                </div>
            </div>`;
			})
			.join("");

		gsap.fromTo(
			"#vipTableBody .crm-row-item",
			{ opacity: 0, x: -12 },
			{
				opacity: 1,
				x: 0,
				duration: 0.28,
				stagger: 0.04,
				ease: "power2.out",
				clearProps: "transform",
			},
		);
	} catch (e) {
		console.error("Erro ao carregar VIPs:", e);
		tbody.innerHTML = '<div class="list-empty">Erro ao carregar lista.</div>';
	}
};

window.deletarVip = async function (id) {
	if (
		!(await showSysConfirm(
			"Tem certeza que deseja remover este cliente VIP?",
			"Remover",
			true,
		))
	)
		return;
	try {
		const res = await fetch(`/api/vip/${id}`, { method: "DELETE" });
		if (res.ok) {
			window.carregarVips();
			if (typeof carregarAgendamentos === "function") carregarAgendamentos();
			showSysToast("Cliente removido.", "success");
		} else {
			showSysAlert("Erro ao deletar.", "error");
		}
	} catch (e) {
		console.error(e);
		showSysAlert("Erro de conexão.", "error");
	}
};

// =============================================================================
// PAUSAR / RETOMAR BOT
// =============================================================================
let isBotPaused = false;

function updatePauseUI(paused) {
	isBotPaused = paused;
	const btn = document.getElementById("btn-bot-pause");
	const icon = document.getElementById("pause-icon");
	const label = document.getElementById("pause-label");
	if (!btn || !icon || !label) return;

	if (paused) {
		btn.classList.add("paused");
		icon.className = "fas fa-play";
		label.innerText = "Retomar";
		btn.title = "Retomar Bot";
	} else {
		btn.classList.remove("paused");
		icon.className = "fas fa-pause";
		label.innerText = "Pausar";
		btn.title = "Pausar Bot";
	}
	gsap.fromTo(
		btn,
		{ scale: 0.88 },
		{ scale: 1, duration: 0.35, ease: "bounce4" },
	);
}

async function toggleBotPause() {
	if (!isBotPaused) {
		if (
			!(await showSysConfirm(
				"Deseja PAUSAR o bot? Ele não enviará mensagens até ser retomado.",
				"Pausar",
				true,
			))
		)
			return;
		try {
			const res = await fetch("/api/bot/pause", { method: "POST" });
			const data = await res.json();
			if (data.success) {
				updatePauseUI(true);
				showSysToast("Bot pausado!", "warning");
			}
		} catch (e) {
			showSysAlert("Erro ao pausar bot.", "error");
		}
	} else {
		if (
			!(await showSysConfirm(
				"Deseja RETOMAR o bot? Ele voltará a operar normalmente.",
				"Retomar",
			))
		)
			return;
		try {
			const res = await fetch("/api/bot/resume", { method: "POST" });
			const data = await res.json();
			if (data.success) {
				updatePauseUI(false);
				showSysToast("Bot retomado!", "success");
			}
		} catch (e) {
			showSysAlert("Erro ao retomar bot.", "error");
		}
	}
}

socket.on("bot_paused", (paused) => updatePauseUI(paused));

// Carrega estado de pausa ao iniciar
fetch("/api/bot/status")
	.then((r) => r.json())
	.then((d) => {
		if (d.paused) updatePauseUI(true);
	})
	.catch(() => {});

// =============================================================================
// MIGRAÇÃO (PLANILHA → BANCO) COM SENHA
// =============================================================================
function abrirMigracao() {
	const inp = document.getElementById("migrate_password");
	if (inp) inp.value = "";
	const btn = document.getElementById("btn-exec-migrate");
	if (btn) {
		btn.disabled = false;
		btn.innerHTML = '<i class="fas fa-sync-alt"></i>&nbsp; EXECUTAR MIGRAÇÃO';
	}
	gsapModalOpen("migrateModal");
	setTimeout(() => {
		if (inp) inp.focus();
	}, 400);
}

function fecharMigracao() {
	gsapModalClose("migrateModal");
}

async function executarMigracao() {
	const password = document.getElementById("migrate_password")?.value;
	if (!password) {
		await showSysAlert(
			"Digite sua senha para confirmar a migração.",
			"warning",
		);
		return;
	}

	const btn = document.getElementById("btn-exec-migrate");
	if (btn) {
		btn.disabled = true;
		btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>&nbsp; MIGRANDO...';
	}

	try {
		const res = await fetch("/api/migrate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		});
		const data = await res.json();

		if (res.status === 403) {
			await showSysAlert("🔒 Senha incorreta!", "error");
			if (btn) {
				btn.disabled = false;
				btn.innerHTML =
					'<i class="fas fa-sync-alt"></i>&nbsp; EXECUTAR MIGRAÇÃO';
			}
			return;
		}

		if (data.success) {
			fecharMigracao();
			showSysToast(
				`Migração concluída! ${data.total} produtos sincronizados.`,
				"success",
			);
			await carregarProdutos();
			await loadCollections();
		} else {
			await showSysAlert("Erro: " + (data.error || "Desconhecido"), "error");
			if (btn) {
				btn.disabled = false;
				btn.innerHTML =
					'<i class="fas fa-sync-alt"></i>&nbsp; EXECUTAR MIGRAÇÃO';
			}
		}
	} catch (e) {
		console.error("Erro na migração:", e);
		await showSysAlert("Erro de conexão ao executar migração.", "error");
		if (btn) {
			btn.disabled = false;
			btn.innerHTML = '<i class="fas fa-sync-alt"></i>&nbsp; EXECUTAR MIGRAÇÃO';
		}
	}
}
// =============================================================================
// TEMA LIGHT/DARK
// =============================================================================

function toggleTheme() {
	const html = document.documentElement;
	const current = html.getAttribute("data-theme");
	const next = current === "light" ? "dark" : "light";
	html.setAttribute("data-theme", next);
	localStorage.setItem("soline-theme", next);
	const icon = document.getElementById("theme-icon");
	if (icon) icon.className = next === "light" ? "fas fa-sun" : "fas fa-moon";
	closeHeaderMenu();
}

// Carrega tema salvo
(function () {
	const saved = localStorage.getItem("soline-theme");
	if (saved) {
		document.documentElement.setAttribute("data-theme", saved);
		const icon = document.getElementById("theme-icon");
		if (icon) icon.className = saved === "light" ? "fas fa-sun" : "fas fa-moon";
	}
})();

// =============================================================================
// PAIRING CODE (CONEXAO VIA CODIGO)
// =============================================================================

function togglePairingMode() {
	setPairingView(currentPairingView === "qr" ? "code" : "qr");
}

function solicitarPairingCode() {
	const phone = document
		.getElementById("pairing-phone")
		?.value.replace(/\D/g, "");
	if (!phone || phone.length < 10) {
		const err = document.getElementById("pairing-error");
		err.textContent = "Digite um numero valido (ex: 5511999998888)";
		err.style.display = "block";
		document.getElementById("pairing-result").style.display = "none";
		return;
	}
	document.getElementById("pairing-error").style.display = "none";
	document.getElementById("pairing-result").style.display = "none";
	socket.emit("request_pairing_code", phone);
}

socket.on("pairing_code", (code) => {
	applyWhatsAppState({ started: true, pairingInProgress: true });
	const display = document.getElementById("pairing-code-display");
	const result = document.getElementById("pairing-result");
	setPairingView("code");
	if (display) display.textContent = code;
	if (result) result.style.display = "block";
	document.getElementById("pairing-error").style.display = "none";
});

socket.on("pairing_error", (msg) => {
	applyWhatsAppState({ started: true, starting: false });
	const err = document.getElementById("pairing-error");
	if (err) {
		err.textContent = msg;
		err.style.display = "block";
	}
	document.getElementById("pairing-result").style.display = "none";
});

// =============================================================================
// CRM — CLIENTES & VENDAS
// =============================================================================

let crmClientes = [];
let crmProdutos = [];
let vendaItensTemp = [];
let detalheClienteAtual = null;

function abrirCRM() { closeHeaderMenu(); window.location.href = "/crm"; }
function fecharCRM() { gsapModalClose("crmModal"); }

async function carregarClientes() {
	try {
		const res = await fetch("/api/clientes");
		crmClientes = await res.json();
		renderizarClientes(crmClientes);
	} catch (e) {
		console.error("Erro ao carregar clientes:", e);
	}
}

function filtrarClientes() {
	const q = (document.getElementById("crm-search")?.value || "").toLowerCase();
	if (!q) return renderizarClientes(crmClientes);
	renderizarClientes(
		crmClientes.filter(
			(c) => c.nome.toLowerCase().includes(q) || c.whatsapp.includes(q),
		),
	);
}

function renderizarClientes(lista) {
	const tbody = document.getElementById("crmTableBody");
	const counter = document.getElementById("crm-total-count");
	if (!tbody) return;
	if (counter)
		counter.textContent = `${lista.length} cliente${lista.length !== 1 ? "s" : ""}`;
	if (!lista.length) {
		tbody.innerHTML = '<div class="list-empty">Nenhum cliente cadastrado</div>';
		return;
	}
	tbody.innerHTML = lista
		.map((c) => {
			const nome = escapeHtml(c.nome || "Sem nome");
			const whatsRaw = String(c.whatsapp || "");
			const whatsFmt = whatsRaw.replace(
				/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/,
				"+$1 ($2) $3-$4",
			);
			const totalCompras = parseInt(c.total_compras) || 0;
			const pendentes = parseInt(c.pendentes) || 0;
			const valorAberto = parseFloat(c.valor_em_aberto) || 0;
			const valorPago = parseFloat(c.valor_pago_total) || 0;

			const pillCompras = `<span class="crm-pill"><i class="fas fa-shopping-bag"></i> ${totalCompras} venda${totalCompras !== 1 ? "s" : ""}</span>`;
			const pillPend =
				pendentes > 0
					? `<span class="crm-pill crm-pill-danger"><i class="fas fa-clock"></i> ${pendentes} pendente${pendentes !== 1 ? "s" : ""}</span>`
					: `<span class="crm-pill crm-pill-muted"><i class="fas fa-check"></i> Em dia</span>`;
			const pillAberto =
				valorAberto > 0
					? `<span class="crm-pill crm-pill-warning">A receber: ${escapeHtml(formatCurrencyBR(valorAberto))}</span>`
					: "";
			const pillPago =
				valorPago > 0
					? `<span class="crm-pill">Pago: ${escapeHtml(formatCurrencyBR(valorPago))}</span>`
					: "";

			const nomeJs = (c.nome || "").replace(/'/g, "\\'").replace(/"/g, '\\"');

			return `
          <div class="crm-row-item">
            <div class="crm-row-main" onclick="abrirDetalheCliente(${c.id})" style="cursor:pointer;">
              <div class="crm-row-title">${nome}</div>
              <div class="crm-row-subtitle"><i class="fab fa-whatsapp"></i> ${escapeHtml(whatsFmt)}</div>
            </div>
            <div class="crm-row-stats">
              ${pillCompras}
              ${pillPend}
              ${pillAberto}
              ${pillPago}
            </div>
            <div class="crm-row-actions">
              <button class="crm-action-btn" onclick="abrirDetalheCliente(${c.id})" title="Ver detalhes">
                <i class="fas fa-eye"></i><span>Detalhes</span>
              </button>
              <button class="crm-action-btn" onclick="abrirRegistrarVenda(${c.id},'${nomeJs}')" title="Registrar venda">
                <i class="fas fa-plus"></i><span>Venda</span>
              </button>
              <button class="crm-action-btn" onclick="editarCliente(${c.id})" title="Editar">
                <i class="fas fa-edit"></i><span>Editar</span>
              </button>
              <button class="crm-action-btn danger" onclick="deletarCliente(${c.id},'${nomeJs}')" title="Excluir">
                <i class="fas fa-trash"></i><span>Excluir</span>
              </button>
            </div>
          </div>
        `;
		})
		.join("");
}

function abrirNovoCliente() {
	document.getElementById("form-cliente-titulo").textContent = "Novo Cliente";
	document.getElementById("edit-cliente-id").value = "";
	document.getElementById("cliente-nome").value = "";
	document.getElementById("cliente-whatsapp").value = "";
	document.getElementById("cliente-email").value = "";
	document.getElementById("cliente-obs").value = "";
	gsapModalOpen("novoClienteModal");
	setTimeout(() => document.getElementById("cliente-nome")?.focus(), 400);
}

function fecharNovoCliente() {
	gsapModalClose("novoClienteModal");
}

function editarCliente(id) {
	const c = crmClientes.find((x) => x.id === id);
	if (!c) return;
	document.getElementById("form-cliente-titulo").textContent = "Editar Cliente";
	document.getElementById("edit-cliente-id").value = id;
	document.getElementById("cliente-nome").value = c.nome;
	document.getElementById("cliente-whatsapp").value = c.whatsapp;
	document.getElementById("cliente-email").value = c.email || "";
	document.getElementById("cliente-obs").value = c.observacoes || "";
	gsapModalOpen("novoClienteModal");
}

async function salvarCliente() {
	const id = document.getElementById("edit-cliente-id").value;
	const data = {
		nome: document.getElementById("cliente-nome").value.trim(),
		whatsapp: document.getElementById("cliente-whatsapp").value.trim(),
		email: document.getElementById("cliente-email").value.trim(),
		observacoes: document.getElementById("cliente-obs").value.trim(),
	};
	if (!data.nome || !data.whatsapp)
		return showSysAlert("Nome e WhatsApp sao obrigatorios.", "warning");
	try {
		const url = id ? `/api/clientes/${id}` : "/api/clientes";
		const method = id ? "PUT" : "POST";
		const res = await fetch(url, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		const result = await res.json();
		if (!res.ok) return showSysAlert(result.error || "Erro ao salvar", "error");
		fecharNovoCliente();
		showSysToast(id ? "Cliente atualizado!" : "Cliente cadastrado!", "success");
		await carregarClientes();
	} catch (e) {
		showSysAlert("Erro de conexao.", "error");
	}
}

async function deletarCliente(id, nome) {
	if (
		!(await showSysConfirm(
			`Excluir o cliente "${nome}" e todas as suas vendas?`,
			"Excluir",
			true,
		))
	)
		return;
	try {
		await fetch(`/api/clientes/${id}`, { method: "DELETE" });
		showSysToast("Cliente excluido.", "success");
		await carregarClientes();
	} catch (e) {
		showSysAlert("Erro ao excluir.", "error");
	}
}

// --- VENDAS ---

async function carregarProdutosParaSelect() {
	try {
		const res = await fetch("/api/produtos");
		crmProdutos = await res.json();
		const sel = document.getElementById("venda-produto");
		sel.innerHTML =
			'<option value="">Selecione um produto...</option>' +
			crmProdutos
				.filter((p) => p.estoque > 0)
				.map(
					(p) =>
						`<option value="${escapeHtml(String(p.sku))}" data-valor="${escapeHtml(String(p.valor ?? ""))}" data-estoque="${escapeHtml(String(p.estoque ?? ""))}">${escapeHtml(p.nome)} (${escapeHtml(String(p.sku))}) — ${escapeHtml(formatCurrencyBR(p.valor))} • Est: ${escapeHtml(String(p.estoque))}</option>`,
				)
				.join("");
	} catch (e) {
		console.error("Erro ao carregar produtos:", e);
	}
}

function onProdutoSelecionado() {
	const sel = document.getElementById("venda-produto");
	const opt = sel.options[sel.selectedIndex];
	const valorEl = document.getElementById("venda-valor");
	if (opt && opt.value) {
		const v = opt.getAttribute("data-valor");
		valorEl.value = formatCurrencyBR(v);
	} else {
		valorEl.value = "";
	}
}

function limparCamposItemVenda() {
	document.getElementById("venda-produto").value = "";
	document.getElementById("venda-qtd").value = 1;
	document.getElementById("venda-valor").value = "";
}

function renderizarItensVenda() {
	const listaEl = document.getElementById("venda-itens-lista");
	const totalEl = document.getElementById("venda-total-geral");
	if (!listaEl || !totalEl) return;

	if (!vendaItensTemp.length) {
		listaEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.92rem;">Nenhum item adicionado ainda.</div>';
		totalEl.textContent = formatCurrencyBR(0);
		return;
	}

	const total = vendaItensTemp.reduce((acc, item) => acc + (Number(item.valor_total) || 0), 0);
	totalEl.textContent = formatCurrencyBR(total);
	listaEl.innerHTML = vendaItensTemp
		.map((item, index) => `
			<div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start; padding:10px 12px; border:1px solid var(--border); border-radius:12px; background: rgba(255,255,255,0.03);">
				<div style="min-width:0;">
					<div style="font-weight:600; color: var(--text-main); word-break:break-word;">${escapeHtml(item.produto_nome)}</div>
					<div style="font-size:0.82rem; color: var(--text-muted); margin-top:4px;">SKU ${escapeHtml(item.produto_sku)} • Qtd ${item.quantidade} • ${formatCurrencyBR(item.valor_unitario)} un.</div>
					<div style="font-size:0.9rem; color:#f59e0b; font-weight:700; margin-top:6px;">${formatCurrencyBR(item.valor_total)}</div>
				</div>
				<button type="button" class="btn-action" onclick="removerItemVenda(${index})" title="Remover item"><i class="fas fa-trash"></i></button>
			</div>
		`)
		.join("");
}

function adicionarItemVenda() {
	const sel = document.getElementById("venda-produto");
	const produtoSku = sel.value;
	const qtd = Math.max(parseInt(document.getElementById("venda-qtd").value) || 1, 1);
	if (!produtoSku) return showSysAlert("Selecione um produto antes de adicionar.", "warning");

	const produto = crmProdutos.find((p) => String(p.sku) === String(produtoSku));
	if (!produto) return showSysAlert("Produto nao encontrado na lista.", "error");
	const estoque = Number(produto.estoque || 0);
	if (qtd > estoque) return showSysAlert(`Estoque insuficiente para ${produto.nome}. Disponivel: ${estoque}.`, "warning");

	const existente = vendaItensTemp.find((item) => String(item.produto_sku) === String(produtoSku));
	const novaQtd = (existente ? Number(existente.quantidade) : 0) + qtd;
	if (novaQtd > estoque) return showSysAlert(`A soma das quantidades para ${produto.nome} excede o estoque (${estoque}).`, "warning");

	const valorUnit = Number(parseCurrencyValue(produto.valor));
	if (existente) {
		existente.quantidade = novaQtd;
		existente.valor_total = Number((valorUnit * novaQtd).toFixed(2));
	} else {
		vendaItensTemp.push({
			produto_sku: String(produto.sku),
			produto_nome: produto.nome,
			quantidade: qtd,
			valor_unitario: valorUnit,
			valor_total: Number((valorUnit * qtd).toFixed(2)),
		});
	}

	renderizarItensVenda();
	limparCamposItemVenda();
}

function removerItemVenda(index) {
	vendaItensTemp.splice(index, 1);
	renderizarItensVenda();
}

function abrirRegistrarVenda(clienteId, clienteNome) {
	document.getElementById("venda-cliente-id").value = clienteId;
	document.getElementById("venda-cliente-nome").textContent = clienteNome;
	document.getElementById("venda-qtd").value = 1;
	document.getElementById("venda-pago").checked = false;
	document.getElementById("venda-data-pag").value = "";
	document.getElementById("venda-obs").value = "";
	document.getElementById("venda-valor").value = "";
	vendaItensTemp = [];
	renderizarItensVenda();
	carregarProdutosParaSelect();
	gsapModalOpen("registrarVendaModal");
}

function fecharRegistrarVenda() {
	gsapModalClose("registrarVendaModal");
}

function abrirRegistrarVendaFromDetalhe() {
	if (!detalheClienteAtual) return;
	abrirRegistrarVenda(detalheClienteAtual.id, detalheClienteAtual.nome);
}

async function confirmarVenda() {
	const clienteId = document.getElementById("venda-cliente-id").value;
	const pago = document.getElementById("venda-pago").checked;
	const dataPag = document.getElementById("venda-data-pag").value;
	const obs = document.getElementById("venda-obs").value.trim();

	if (!vendaItensTemp.length) return showSysAlert("Adicione pelo menos um item ao pedido.", "warning");

	try {
		const res = await fetch("/api/vendas", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cliente_id: clienteId,
				itens: vendaItensTemp.map((item) => ({
					produto_sku: item.produto_sku,
					quantidade: item.quantidade,
				})),
				pago,
				data_pagamento: dataPag || null,
				observacoes: obs,
			}),
		});
		const result = await res.json();
		if (!res.ok) return showSysAlert(result.error || "Erro ao registrar pedido", "error");
		fecharRegistrarVenda();
		showSysToast("Pedido registrado! Estoque atualizado.", "success");
		await carregarClientes();
		await carregarProdutos();
		if (detalheClienteAtual) await abrirDetalheCliente(detalheClienteAtual.id);
	} catch (e) {
		showSysAlert("Erro de conexao.", "error");
	}
}

// --- DETALHE CLIENTE ---

async function abrirDetalheCliente(id) {
	try {
		const [clienteRes, vendasRes] = await Promise.all([
			fetch("/api/clientes"),
			fetch(`/api/vendas/cliente/${id}`),
		]);
		const clientes = await clienteRes.json();
		const vendas = await vendasRes.json();
		const cliente = clientes.find((c) => normalizeId(c.id) === normalizeId(id));
		if (!cliente) return;
		detalheClienteAtual = cliente;

		document.getElementById("detalhe-cliente-nome").textContent = cliente.nome;
		const whats = cliente.whatsapp.replace(
			/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/,
			"+$1 ($2) $3-$4",
		);
		document.getElementById("detalhe-cliente-info").innerHTML =
			`<i class="fab fa-whatsapp" style="color:#25d366;"></i> ${whats}` +
			(cliente.email
				? ` &nbsp;|&nbsp; <i class="fas fa-envelope" style="color:#888;"></i> ${cliente.email}`
				: "") +
			(cliente.observacoes
				? ` &nbsp;|&nbsp; <i class="fas fa-sticky-note" style="color:#888;"></i> ${cliente.observacoes}`
				: "");

		const tbody = document.getElementById("detalheVendasBody");
		if (!vendas.length) {
			tbody.innerHTML =
				'<div class="list-empty">Nenhuma venda registrada</div>';
		} else {
			tbody.innerHTML = vendas
				.map((v) => {
					const pago = isVendaPaid(v);
					let statusBadge =
						'<span class="crm-badge crm-badge-pendente">PENDENTE</span>';
					if (String(v.status_pagamento || "").toLowerCase() === "parcial")
						statusBadge =
							'<span class="crm-badge crm-badge-warning">PARCIAL</span>';
					if (pago)
						statusBadge = '<span class="crm-badge crm-badge-pago">PAGO</span>';
					const dataPag = v.data_pagamento
						? new Date(v.data_pagamento).toLocaleDateString("pt-BR")
						: "-";
					const dataCriacao = new Date(v.created_at).toLocaleDateString(
						"pt-BR",
					);
					const valorDisplay = formatCurrencyBR(v.valor_total ?? v.valor);
					const restanteDisplay = formatCurrencyBR(v.valor_restante ?? 0);
					return `<div class="crm-row-item sale-row-item">
                    <div class="crm-row-main">
                        <div class="crm-row-title">${escapeHtml(v.produto_nome)}</div>
                        <div class="crm-row-subtitle">SKU ${escapeHtml(v.produto_sku)} • ${valorDisplay} • Qtd ${v.quantidade}</div>
                    </div>
                    <div class="crm-row-stats">
                        ${statusBadge}
                        <span class="crm-pill">Criado: ${dataCriacao}</span>
                        <span class="crm-pill">Pagar em: ${dataPag}</span>
                        ${String(v.status_pagamento || "").toLowerCase() === "parcial" ? `<span class="crm-pill crm-pill-warning">Resta ${restanteDisplay}</span>` : ""}
                    </div>
                    <div class="crm-row-actions">
                        <button class="crm-action-btn" onclick="togglePagoVenda(${v.id},${!pago})">${pago ? '<i class="fas fa-rotate-left"></i><span>Pendente</span>' : '<i class="fas fa-check"></i><span>Pagar</span>'}</button>
                        ${!pago ? `<label class="crm-date-wrap"><span>Data</span><input type="date" value="${v.data_pagamento ? v.data_pagamento.split("T")[0] : ""}" onchange="definirDataPag(${v.id},this.value)"></label>` : ""}
                        <button class="crm-action-btn danger" onclick="deletarVendaCRM(${v.id})"><i class="fas fa-trash"></i><span>Excluir</span></button>
                    </div>
                </div>`;
				})
				.join("");
		}
		gsapModalOpen("detalheClienteModal");
	} catch (e) {
		showSysAlert("Erro ao carregar detalhes.", "error");
	}
}

function fecharDetalheCliente() {
	gsapModalClose("detalheClienteModal");
}

async function togglePagoVenda(vendaId, pago) {
	try {
		await fetch(`/api/vendas/${vendaId}/pago`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pago }),
		});
		showSysToast(
			pago ? "Marcado como pago!" : "Marcado como pendente.",
			pago ? "success" : "warning",
		);
		if (detalheClienteAtual) await abrirDetalheCliente(detalheClienteAtual.id);
		await carregarClientes();
	} catch (e) {
		showSysAlert("Erro ao atualizar.", "error");
	}
}

async function definirDataPag(vendaId, data) {
	if (!data) return;
	try {
		await fetch(`/api/vendas/${vendaId}/data-pagamento`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data_pagamento: data }),
		});
		showSysToast(
			"Data de pagamento definida. Lembrete sera enviado automaticamente.",
			"success",
		);
		if (detalheClienteAtual) await abrirDetalheCliente(detalheClienteAtual.id);
	} catch (e) {
		showSysAlert("Erro ao definir data.", "error");
	}
}

async function deletarVendaCRM(vendaId) {
	if (!(await showSysConfirm("Excluir esta venda?", "Excluir", true))) return;
	try {
		await fetch(`/api/vendas/${vendaId}`, { method: "DELETE" });
		showSysToast("Venda excluida.", "success");
		if (detalheClienteAtual) await abrirDetalheCliente(detalheClienteAtual.id);
		await carregarClientes();
	} catch (e) {
		showSysAlert("Erro ao excluir.", "error");
	}
}

// =============================================================================
// EXPOSICAO GLOBAL — garante que onclick="" inline encontre todas as funcoes
// =============================================================================
window.toggleBotPause = toggleBotPause;
window.abrirMigracao = abrirMigracao;
window.fecharMigracao = fecharMigracao;
window.executarMigracao = executarMigracao;
window.abrirConfig = abrirConfig;
window.fecharConfig = fecharConfig;
window.salvarConfig = salvarConfig;
window.selectMode = selectMode;
window.toggleCampaign = toggleCampaign;
window.filtrarStatus = filtrarStatus;
window.filtrarTabela = filtrarTabela;
window.filtrarTipo = filtrarTipo;
window.mudarPaginaCatalogo = mudarPaginaCatalogo;
window.toggleSchedFiltro = toggleSchedFiltro;
window.resetarTudo = resetarTudo;
window.carregarProdutos = carregarProdutos;
window.mudarMes = mudarMes;
window.salvarAgendamento = salvarAgendamento;
window.deletarAgendamento = deletarAgendamento;
window.gerarCopySugestao = gerarCopySugestao;
window.fecharSchedule = fecharSchedule;

// CRM
window.abrirCRM = abrirCRM;
window.fecharCRM = fecharCRM;
window.filtrarClientes = filtrarClientes;
window.abrirNovoCliente = abrirNovoCliente;
window.fecharNovoCliente = fecharNovoCliente;
window.salvarCliente = salvarCliente;
window.editarCliente = editarCliente;
window.deletarCliente = deletarCliente;
window.abrirRegistrarVenda = abrirRegistrarVenda;
window.fecharRegistrarVenda = fecharRegistrarVenda;
window.abrirRegistrarVendaFromDetalhe = abrirRegistrarVendaFromDetalhe;
window.confirmarVenda = confirmarVenda;
window.onProdutoSelecionado = onProdutoSelecionado;
window.adicionarItemVenda = adicionarItemVenda;
window.removerItemVenda = removerItemVenda;
window.abrirDetalheCliente = abrirDetalheCliente;
window.fecharDetalheCliente = fecharDetalheCliente;
window.togglePagoVenda = togglePagoVenda;
window.definirDataPag = definirDataPag;
window.deletarVendaCRM = deletarVendaCRM;

// Header / Tema / Pairing

window.toggleHeaderMenu = toggleHeaderMenu;
window.closeHeaderMenu = closeHeaderMenu;
window.setPairingView = setPairingView;
window.toggleTheme = toggleTheme;
window.togglePairingMode = togglePairingMode;
window.solicitarPairingCode = solicitarPairingCode;

window.startWhatsAppConnection = startWhatsAppConnection;
window.stopWhatsAppConnection = stopWhatsAppConnection;
