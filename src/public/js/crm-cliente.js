const state = { cliente: null, vendas: [] };

const els = {
	themeBtn: document.getElementById("crm-theme-btn"),
	themeIcon: document.getElementById("crm-theme-icon"),
	pageTitle: document.getElementById("cliente-page-title"),
	pageSubtitle: document.getElementById("cliente-page-subtitle"),
	detailName: document.getElementById("detalhe-cliente-nome"),
	detailInfo: document.getElementById("detalhe-cliente-info"),
	detailSummary: document.getElementById("crm-detail-summary"),
	salesList: document.getElementById("crm-sales-list"),
	btnOpenSaleForm: document.getElementById("btn-open-sale-form"),
	backBtn: document.getElementById("crmBackBtn"),
};

const escapeHtml = (str = "") =>
	String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const showToast = (msg) => alert(msg);

function revealCards() {
	document.querySelectorAll(".card").forEach((card) => {
		card.style.opacity = "1";
		card.style.visibility = "visible";
		card.style.transform = "none";
	});
}

async function api(url, options = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);

	try {
		const res = await fetch(url, {
			...(options || {}),
			credentials: "same-origin",
			headers: {
				Accept: "application/json",
				...((options && options.headers) || {}),
			},
			redirect: "follow",
			signal: controller.signal,
		});

		const contentType = (res.headers.get("content-type") || "").toLowerCase();
		const isJson = contentType.includes("application/json");
		const data = isJson ? await res.json().catch(() => ({})) : {};

		if (res.status === 401 && data?.redirectTo) {
			window.location.href = data.redirectTo;
			throw new Error("Sessão expirada");
		}

		if (!res.ok) {
			throw new Error(data?.error || `Erro na requisição (${res.status})`);
		}

		if (!isJson) {
			throw new Error("Resposta inválida do servidor.");
		}

		return data;
	} catch (err) {
		if (err.name === "AbortError") {
			throw new Error(
				"A requisição demorou demais. Verifique o servidor na SquareCloud.",
			);
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}

function syncThemeIcon(theme) {
	if (els.themeIcon) {
		els.themeIcon.className = `fas ${theme === "light" ? "fa-sun" : "fa-moon"}`;
	}
}

function applySavedTheme() {
	const saved = localStorage.getItem("soline-theme") || "dark";
	document.documentElement.setAttribute("data-theme", saved);
	syncThemeIcon(saved);
}

function toggleTheme() {
	const current = document.documentElement.getAttribute("data-theme") || "dark";
	const next = current === "light" ? "dark" : "light";
	document.documentElement.setAttribute("data-theme", next);
	localStorage.setItem("soline-theme", next);
	syncThemeIcon(next);
}

function goBackFromCliente() {
	if (window.history.length > 1) {
		window.history.back();
		return;
	}
	window.location.href = "/crm";
}

function parseCurrencyValue(value) {
	if (value === null || value === undefined || value === "") return 0;
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;

	let raw = String(value).trim();
	raw = raw
		.replace(/\s+/g, "")
		.replace(/^R\$/i, "")
		.replace(/[^0-9,.-]/g, "");

	const hasComma = raw.includes(",");
	const hasDot = raw.includes(".");

	if (hasComma && hasDot) {
		raw =
			raw.lastIndexOf(",") > raw.lastIndexOf(".")
				? raw.replace(/\./g, "").replace(",", ".")
				: raw.replace(/,/g, "");
	} else if (hasComma) {
		raw = raw.replace(",", ".");
	}

	const n = Number(raw);
	return Number.isFinite(n) ? n : 0;
}

function formatCurrencyBR(value) {
	return parseCurrencyValue(value).toLocaleString("pt-BR", {
		style: "currency",
		currency: "BRL",
	});
}

function getPagamentoMeta(venda) {
	const pago = parseCurrencyValue(venda.valor_pago);
	const restante = parseCurrencyValue(venda.valor_restante);
	const status = String(venda.status_pagamento || "").toLowerCase();

	if (status === "pago" || venda.pago === true) {
		return { label: "Pago", cls: "success" };
	}

	if (status === "parcial" || (pago > 0 && restante > 0)) {
		return { label: "Parcial", cls: "warning" };
	}

	return { label: "Pendente", cls: "danger" };
}

function renderCliente() {
	const cliente = state.cliente;
	if (!cliente) return;

	els.pageTitle.textContent = cliente.nome || "Cliente";
	els.pageSubtitle.textContent = "Informações gerais, pagamentos e pedidos";
	els.detailName.textContent = cliente.nome || "Cliente";
	els.detailInfo.textContent = [
		cliente.whatsapp || "-",
		cliente.email || null,
		cliente.observacoes || null,
	]
		.filter(Boolean)
		.join(" • ");

	const pendentes = Number(cliente.pendentes || 0);

	els.detailSummary.innerHTML = `
		<article class="card crm-summary-card">
			<span class="crm-summary-label">Compras</span>
			<strong>${escapeHtml(String(cliente.total_compras || 0))}</strong>
		</article>

		<article class="card crm-summary-card">
			<span class="crm-summary-label">Pendências</span>
			<strong class="${pendentes > 0 ? "is-danger" : "is-success"}">
				${pendentes > 0 ? `${pendentes} pendente(s)` : "Em dia"}
			</strong>
		</article>

		<article class="card crm-summary-card">
			<span class="crm-summary-label">Contato</span>
			<strong>${escapeHtml(cliente.whatsapp || "-")}</strong>
		</article>
	`;
}

function renderVendas() {
	const vendas = state.vendas || [];

	if (!vendas.length) {
		els.salesList.innerHTML = `
			<div class="crm-empty-state compact">
				<i class="fas fa-box-open"></i>
				<span>Este cliente ainda não possui vendas registradas.</span>
			</div>
		`;
		return;
	}

	els.salesList.innerHTML = vendas
		.map((v) => {
			const pagamento = getPagamentoMeta(v);
			const total = formatCurrencyBR(v.valor_total ?? v.valor ?? v.preco_total);
			const restante = formatCurrencyBR(v.valor_restante ?? 0);
			const criado = v.created_at
				? new Date(v.created_at).toLocaleDateString("pt-BR")
				: "-";
			const pagoEm = v.data_pagamento
				? new Date(v.data_pagamento).toLocaleDateString("pt-BR")
				: "Sem data";

			return `
				<article class="crm-sale-item page-sale-item">
					<div class="crm-sale-top compact-top">
						<div class="crm-sale-main">
							<div class="crm-sale-title">${escapeHtml(v.produto_nome || "Produto")}</div>
							<div class="crm-sale-meta">
								SKU ${escapeHtml(v.produto_sku || "-")} • Qtd ${escapeHtml(String(v.quantidade || 1))}
							</div>
						</div>

						<span class="crm-pill ${pagamento.cls}">${pagamento.label}</span>
					</div>

					<div class="crm-sale-price-row">
						<strong>${total}</strong>
						<span>Criado em ${criado}</span>
					</div>

					<div class="crm-sale-extra-row">
						<span>Pagamento: ${pagoEm}</span>
						<span>Tamanho: ${escapeHtml(v.tamanho || "-")}</span>
						${
							String(v.status_pagamento || "").toLowerCase() === "parcial"
								? `<span>Resta ${restante}</span>`
								: ""
						}
					</div>

					<div class="crm-sale-actions compact-actions">
						<button
							class="crm-inline-btn ${pagamento.cls === "success" ? "warning" : "success"}"
							type="button"
							data-sale-action="toggle-paid"
							data-id="${escapeHtml(String(v.id))}"
							data-next="${pagamento.cls === "success" ? "false" : "true"}"
						>
							<i class="fas ${pagamento.cls === "success" ? "fa-rotate-left" : "fa-check"}"></i>
							<span>${pagamento.cls === "success" ? "Marcar pendente" : "Marcar pago"}</span>
						</button>

						<button
							class="crm-inline-btn danger"
							type="button"
							data-sale-action="delete"
							data-id="${escapeHtml(String(v.id))}"
						>
							<i class="fas fa-trash"></i>
							<span>Excluir</span>
						</button>
					</div>
				</article>
			`;
		})
		.join("");
}

async function carregarDetalheCliente() {
	const params = new URLSearchParams(window.location.search);
	const id = params.get("id");

	if (!id) {
		els.pageTitle.textContent = "Cliente não encontrado";
		els.pageSubtitle.textContent = "Volte ao CRM e escolha um cliente válido";
		els.salesList.innerHTML = `
			<div class="crm-empty-state compact">
				<i class="fas fa-circle-exclamation"></i>
				<span>Cliente não informado.</span>
			</div>
		`;
		if (els.btnOpenSaleForm) els.btnOpenSaleForm.disabled = true;
		return;
	}

	try {
		const clientes = await api("/api/clientes");
		const cliente = Array.isArray(clientes)
			? clientes.find((c) => Number(c.id) === Number(id))
			: null;

		if (!cliente) {
			els.pageTitle.textContent = "Cliente não encontrado";
			els.pageSubtitle.textContent = "Este registro não existe mais";
			els.salesList.innerHTML = `
				<div class="crm-empty-state compact">
					<i class="fas fa-circle-exclamation"></i>
					<span>Cliente não encontrado.</span>
				</div>
			`;
			if (els.btnOpenSaleForm) els.btnOpenSaleForm.disabled = true;
			return;
		}

		state.cliente = cliente;

		if (els.pageTitle) els.pageTitle.textContent = cliente.nome || "Cliente";
		if (els.pageSubtitle)
			els.pageSubtitle.textContent = "Carregando histórico...";

		const vendas = await api(`/api/vendas/cliente/${id}`);
		state.vendas = Array.isArray(vendas) ? vendas : [];

		renderCliente();
		renderVendas();
	} catch (err) {
		console.error("[CRM-CLIENTE] Erro ao carregar detalhe do cliente:", err);

		els.pageTitle.textContent = "Erro ao carregar cliente";
		els.pageSubtitle.textContent =
			err.message || "Não foi possível carregar os dados";
		els.salesList.innerHTML = `
			<div class="crm-empty-state compact">
				<i class="fas fa-circle-exclamation"></i>
				<span>${escapeHtml(err.message || "Não foi possível carregar os dados do cliente.")}</span>
			</div>
		`;
	}
}

async function togglePagoVenda(vendaId, pago) {
	try {
		await api(`/api/vendas/${vendaId}/pago`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pago }),
		});

		showToast(
			pago ? "Venda marcada como paga." : "Venda marcada como pendente.",
		);
		await carregarDetalheCliente();
	} catch (err) {
		showToast(err.message || "Erro ao atualizar pagamento.");
	}
}

async function deletarVenda(vendaId) {
	if (!window.confirm("Excluir esta venda?")) return;

	try {
		await api(`/api/vendas/${vendaId}`, { method: "DELETE" });
		showToast("Venda excluída.");
		await carregarDetalheCliente();
	} catch (err) {
		showToast(err.message || "Erro ao excluir venda.");
	}
}

function goToPedido() {
	if (!state.cliente) return;

	const url = new URL("/pedido", window.location.origin);
	url.searchParams.set("cliente_id", state.cliente.id);
	url.searchParams.set("cliente_nome", state.cliente.nome || "");
	url.searchParams.set("from", "crm-cliente");
	window.location.href = url.toString();
}

function bindEvents() {
	els.themeBtn?.addEventListener("click", toggleTheme);
	els.btnOpenSaleForm?.addEventListener("click", goToPedido);
	els.backBtn?.addEventListener("click", goBackFromCliente);

	els.salesList?.addEventListener("click", async (e) => {
		const toggleBtn = e.target.closest('[data-sale-action="toggle-paid"]');
		const deleteBtn = e.target.closest('[data-sale-action="delete"]');

		if (toggleBtn) {
			await togglePagoVenda(
				toggleBtn.getAttribute("data-id"),
				toggleBtn.getAttribute("data-next") === "true",
			);
			return;
		}

		if (deleteBtn) {
			await deletarVenda(deleteBtn.getAttribute("data-id"));
		}
	});
}

window.addEventListener("DOMContentLoaded", async () => {
	applySavedTheme();
	revealCards();
	bindEvents();
	await carregarDetalheCliente();

	if (window.gsap) {
		gsap.fromTo(
			".card",
			{ opacity: 0, y: 8 },
			{ opacity: 1, y: 0, duration: 0.22, stagger: 0.035, ease: "power2.out" },
		);
	}
});
