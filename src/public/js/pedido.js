const state = {
	produtos: [],
	filtrados: [],
	carrinho: [],
	cliente: { id: null, nome: "", from: "" },
	qtyMap: new Map(),
	page: 1,
	perPage: 10,
	totalPages: 1,
	pageItems: [],
};

const qs = (id) => document.getElementById(id);

function parseValue(v) {
	if (v == null || v === "") return 0;
	if (typeof v === "number") return Number.isFinite(v) ? v : 0;
	let s = String(v)
		.trim()
		.replace(/\s+/g, "")
		.replace(/^R\$/i, "")
		.replace(/[^0-9,.-]/g, "");

	const hasComma = s.includes(",");
	const hasDot = s.includes(".");

	if (hasComma && hasDot) {
		s =
			s.lastIndexOf(",") > s.lastIndexOf(".")
				? s.replace(/\./g, "").replace(",", ".")
				: s.replace(/,/g, "");
	} else if (hasComma) {
		s = s.replace(",", ".");
	}

	const n = Number(s);
	return Number.isFinite(n) ? n : 0;
}

const formatCurrencyBR = (v) =>
	parseValue(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const escapeHtml = (str = "") =>
	String(str).replace(
		/[&<>\"']/g,
		(m) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#039;",
			})[m],
	);

function debounce(fn, delay = 220) {
	let timer = null;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), delay);
	};
}

function applySavedTheme() {
	const saved = localStorage.getItem("soline-theme") || "dark";
	document.documentElement.setAttribute("data-theme", saved);
	syncThemeIcon(saved);
}

function syncThemeIcon(theme) {
	const icon = qs("themeToggleIcon");
	if (icon) icon.className = `fas ${theme === "light" ? "fa-sun" : "fa-moon"}`;
}

function toggleTheme() {
	const current = document.documentElement.getAttribute("data-theme") || "dark";
	const next = current === "light" ? "dark" : "light";
	document.documentElement.setAttribute("data-theme", next);
	localStorage.setItem("soline-theme", next);
	syncThemeIcon(next);
}

function readQuery() {
	const p = new URLSearchParams(location.search);
	state.cliente.id = p.get("cliente_id");
	state.cliente.nome = p.get("cliente_nome") || "";
	state.cliente.from = p.get("from") || "";
}

function renderCliente() {
	const nome = qs("clienteNome");
	const meta = qs("clienteMeta");
	if (nome) nome.textContent = state.cliente.nome || "Cliente não informado";
	if (meta)
		meta.textContent = state.cliente.id
			? `Cliente ID ${state.cliente.id}`
			: "Selecione o cliente pelo CRM.";
}

async function fetchClienteInfo() {
	if (!state.cliente.id) return;
	try {
		const clientes = await fetch("/api/clientes").then((r) => r.json());
		const cliente = clientes.find(
			(c) => String(c.id) === String(state.cliente.id),
		);
		if (cliente) {
			state.cliente.nome = cliente.nome || state.cliente.nome;
			renderCliente();
		}
	} catch (_) {}
}

function getImageSrc(url) {
	if (!url) return "https://via.placeholder.com/96x96?text=Foto";
	return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

function renderProdutosSkeleton() {
	const wrap = qs("catalogoLista");
	if (!wrap) return;
	wrap.innerHTML = Array.from({ length: 6 })
		.map(
			() => `
    <article class="prod-card loading-shimmer">
      <div class="prod-thumb"></div>
      <div>
        <div class="prod-title-row">
          <div style="width:100%">
            <div style="height:20px;border-radius:10px;background:var(--surface-soft);width:65%;margin-bottom:10px"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <div style="height:26px;width:80px;border-radius:999px;background:var(--surface-soft)"></div>
              <div style="height:26px;width:90px;border-radius:999px;background:var(--surface-soft)"></div>
              <div style="height:26px;width:100px;border-radius:999px;background:var(--surface-soft)"></div>
            </div>
          </div>
          <div style="height:24px;width:90px;border-radius:10px;background:var(--surface-soft)"></div>
        </div>
        <div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;margin-top:14px">
          <div style="height:40px;width:120px;border-radius:999px;background:var(--surface-soft)"></div>
          <div style="height:42px;width:130px;border-radius:14px;background:var(--surface-soft)"></div>
        </div>
      </div>
    </article>
  `,
		)
		.join("");
}

async function loadProdutos() {
	renderProdutosSkeleton();
	const res = await fetch("/api/produtos");
	const data = await res.json();
	state.produtos = Array.isArray(data) ? data : [];
	hydrateFilters();
	aplicarFiltros({ resetPage: true });
}

function hydrateFilters() {
	const categoria = qs("filtroCategoria");
	const colecao = qs("filtroColecao");

	if (!categoria || !colecao) return;

	const categorias = [
		...new Set(
			state.produtos.map((p) => (p.categoria || "").trim()).filter(Boolean),
		),
	].sort((a, b) => a.localeCompare(b));
	const colecoes = [
		...new Set(
			state.produtos.map((p) => (p.colecao || "").trim()).filter(Boolean),
		),
	].sort((a, b) => a.localeCompare(b));

	categoria.innerHTML =
		'<option value="">Todas</option>' +
		categorias
			.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
			.join("");
	colecao.innerHTML =
		'<option value="">Todas</option>' +
		colecoes
			.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
			.join("");
}

function aplicarFiltros({ resetPage = false } = {}) {
	const termo = (qs("produtoBusca")?.value || "").trim().toLowerCase();
	const categoria = qs("filtroCategoria")?.value || "";
	const colecao = qs("filtroColecao")?.value || "";
	const ordenar = qs("filtroOrdenacao")?.value || "relevancia";
	const onlyAvail = qs("filtroDisponiveis")?.checked ?? true;
	const precoMin = parseValue(qs("filtroPrecoMin")?.value || 0);
	const precoMaxRaw = qs("filtroPrecoMax")?.value;
	const precoMax = precoMaxRaw === "" ? Infinity : parseValue(precoMaxRaw);

	let lista = state.produtos.filter((p) => {
		const hay = [p.nome, p.sku, p.categoria, p.colecao].join(" ").toLowerCase();
		const valor = parseValue(p.valor);
		if (termo && !hay.includes(termo)) return false;
		if (categoria && (p.categoria || "") !== categoria) return false;
		if (colecao && (p.colecao || "") !== colecao) return false;
		if (onlyAvail && Number(p.estoque) <= 0) return false;
		if (valor < precoMin) return false;
		if (valor > precoMax) return false;
		return true;
	});

	switch (ordenar) {
		case "nome":
			lista.sort((a, b) =>
				String(a.nome || "").localeCompare(String(b.nome || "")),
			);
			break;
		case "preco-asc":
			lista.sort((a, b) => parseValue(a.valor) - parseValue(b.valor));
			break;
		case "preco-desc":
			lista.sort((a, b) => parseValue(b.valor) - parseValue(a.valor));
			break;
		case "estoque-desc":
			lista.sort((a, b) => (Number(b.estoque) || 0) - (Number(a.estoque) || 0));
			break;
		default:
			lista.sort((a, b) => {
				const av = Number(a.estoque) > 0 ? 1 : 0;
				const bv = Number(b.estoque) > 0 ? 1 : 0;
				if (av !== bv) return bv - av;
				return String(a.nome || "").localeCompare(String(b.nome || ""));
			});
			break;
	}

	state.filtrados = lista;
	state.totalPages = Math.max(1, Math.ceil(lista.length / state.perPage));

	if (resetPage) {
		state.page = 1;
	} else if (state.page > state.totalPages) {
		state.page = state.totalPages;
	}

	updatePagedItems();
	renderProdutos();
	renderPagination();
	updateSummary();
}

function updatePagedItems() {
	const start = (state.page - 1) * state.perPage;
	const end = start + state.perPage;
	state.pageItems = state.filtrados.slice(start, end);
}

function getQty(sku) {
	return state.qtyMap.get(sku) || 1;
}

function setQty(sku, value) {
	state.qtyMap.set(sku, Math.max(1, value));
	renderProdutos();
}

function addQty(sku, delta, max) {
	const next = Math.min(Math.max(1, getQty(sku) + delta), Math.max(1, max));
	setQty(sku, next);
}

function renderProdutos() {
	const wrap = qs("catalogoLista");
	if (!wrap) return;

	wrap.classList.remove("fade-in-page");
	void wrap.offsetWidth;
	wrap.classList.add("fade-in-page");

	if (!state.pageItems.length) {
		wrap.innerHTML =
			'<div class="empty-state">Nenhum produto encontrado. Ajuste os filtros e tente novamente.</div>';
		return;
	}

	wrap.innerHTML = state.pageItems
		.map((p) => {
			const estoque = Number(p.estoque) || 0;
			const qty = Math.min(getQty(p.sku), Math.max(1, estoque || 1));
			const stockClass =
				estoque <= 0 ? "stock-out" : estoque <= 3 ? "stock-low" : "stock-ok";
			const stockText = estoque <= 0 ? "Sem estoque" : `Estoque: ${estoque}`;

			return `
      <article class="prod-card">
        <img
          class="prod-thumb"
          src="${escapeHtml(getImageSrc(p.image_url))}"
          alt="${escapeHtml(p.nome)}"
          onerror="this.src='https://via.placeholder.com/96x96?text=Foto'"
        />

        <div>
          <div class="prod-title-row">
            <div>
              <h3 class="prod-title">${escapeHtml(p.nome)}</h3>
              <div class="prod-meta">
                <span class="pill">SKU ${escapeHtml(p.sku)}</span>
                ${p.categoria ? `<span class="pill">${escapeHtml(p.categoria)}</span>` : ""}
                ${p.colecao ? `<span class="pill">${escapeHtml(p.colecao)}</span>` : ""}
                <span class="pill ${stockClass}">${stockText}</span>
              </div>
            </div>

            <div class="prod-price">${escapeHtml(formatCurrencyBR(p.valor))}</div>
          </div>

          <div class="prod-actions">
            <div class="qty-stepper">
              <button type="button" onclick="addQty('${escapeHtml(p.sku)}', -1, ${estoque})">−</button>
              <span>${qty}</span>
              <button type="button" onclick="addQty('${escapeHtml(p.sku)}', 1, ${estoque})">+</button>
            </div>

            <button
              type="button"
              class="add-btn"
              ${estoque <= 0 ? "disabled" : ""}
              onclick="adicionarAoCarrinho('${escapeHtml(p.sku)}')"
            >
              <i class="fas fa-plus"></i>
              Adicionar
            </button>
          </div>
        </div>
      </article>
    `;
		})
		.join("");
}

function renderPagination() {
	const numbersWrap = qs("paginationNumbers");
	const firstBtn = qs("btnPrimeiraPagina");
	const prevBtn = qs("btnPaginaAnterior");
	const nextBtn = qs("btnProximaPagina");
	const lastBtn = qs("btnUltimaPagina");
	const pageBadge = qs("pageBadge");
	const paginationWrap = qs("paginationWrap");

	if (
		!numbersWrap ||
		!firstBtn ||
		!prevBtn ||
		!nextBtn ||
		!lastBtn ||
		!pageBadge ||
		!paginationWrap
	)
		return;

	pageBadge.textContent = `Página ${state.page} de ${state.totalPages}`;
	paginationWrap.style.display = state.filtrados.length ? "flex" : "none";

	firstBtn.disabled = state.page === 1;
	prevBtn.disabled = state.page === 1;
	nextBtn.disabled = state.page === state.totalPages;
	lastBtn.disabled = state.page === state.totalPages;

	const pages = getVisiblePages(state.page, state.totalPages);
	numbersWrap.innerHTML = pages
		.map((p) => {
			if (p === "...") return '<span class="pagination-ellipsis">...</span>';
			return `<button class="pagination-btn ${p === state.page ? "active" : ""}" type="button" onclick="goToPage(${p})">${p}</button>`;
		})
		.join("");
}

function getVisiblePages(current, total) {
	if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
	if (current <= 4) return [1, 2, 3, 4, 5, "...", total];
	if (current >= total - 3)
		return [1, "...", total - 4, total - 3, total - 2, total - 1, total];
	return [1, "...", current - 1, current, current + 1, "...", total];
}

function goToPage(page) {
	const nextPage = Math.max(1, Math.min(state.totalPages, Number(page) || 1));
	if (nextPage === state.page) return;
	state.page = nextPage;
	updatePagedItems();
	renderProdutos();
	renderPagination();
	scrollCatalogTop();
}

function scrollCatalogTop() {
	const target = qs("catalogoLista");
	if (!target) return;
	const top = target.getBoundingClientRect().top + window.scrollY - 90;
	window.scrollTo({ top, behavior: "smooth" });
}

function updateSummary() {
	const count = qs("resultadoCount");
	const hint = qs("resultadoHint");
	if (count)
		count.textContent = `${state.filtrados.length} produto${state.filtrados.length !== 1 ? "s" : ""}`;

	if (hint) {
		if (!state.filtrados.length) {
			hint.textContent = "Nenhum item encontrado com esses filtros.";
		} else {
			const start = (state.page - 1) * state.perPage + 1;
			const end = Math.min(start + state.perPage - 1, state.filtrados.length);
			hint.textContent = `Exibindo ${start}-${end} de ${state.filtrados.length} itens.`;
		}
	}
}

function adicionarAoCarrinho(sku) {
	const produto = state.produtos.find((p) => String(p.sku) === String(sku));
	if (!produto) return;

	const estoque = Number(produto.estoque) || 0;
	if (estoque <= 0) return;

	const qty = Math.min(getQty(sku), estoque);
	const existing = state.carrinho.find(
		(item) => String(item.produto_sku) === String(sku),
	);
	const totalDesejado = (existing?.quantidade || 0) + qty;

	if (totalDesejado > estoque) {
		alert(`Estoque insuficiente para ${produto.nome}. Disponível: ${estoque}`);
		return;
	}

	if (existing) {
		existing.quantidade += qty;
	} else {
		state.carrinho.push({
			produto_sku: produto.sku,
			produto_nome: produto.nome,
			valor: parseValue(produto.valor),
			quantidade: qty,
		});
	}

	setQty(sku, 1);
	renderCarrinho();
}

function alterCartQty(sku, delta) {
	const item = state.carrinho.find(
		(x) => String(x.produto_sku) === String(sku),
	);
	const produto = state.produtos.find((x) => String(x.sku) === String(sku));
	if (!item || !produto) return;

	const estoque = Number(produto.estoque) || 0;
	item.quantidade = Math.max(1, Math.min(estoque, item.quantidade + delta));
	renderCarrinho();
}

function removerDoCarrinho(sku) {
	state.carrinho = state.carrinho.filter(
		(item) => String(item.produto_sku) !== String(sku),
	);
	renderCarrinho();
}

function limparCarrinho() {
	state.carrinho = [];
	renderCarrinho();
}

function renderCarrinho() {
	const wrap = qs("carrinhoLista");
	const totalEl = qs("pedidoTotal");
	const btn = qs("btnConfirmarPedido");

	if (!wrap || !totalEl || !btn) return;

	if (!state.carrinho.length) {
		wrap.innerHTML =
			'<div class="empty-state">Nenhum item adicionado ainda.</div>';
		totalEl.textContent = "R$ 0,00";
		btn.disabled = true;
		return;
	}

	let total = 0;
	wrap.innerHTML = state.carrinho
		.map((item) => {
			const subtotal = item.valor * item.quantidade;
			total += subtotal;

			return `
      <div class="carrinho-item">
        <div class="carrinho-top">
          <div>
            <strong>${escapeHtml(item.produto_nome)}</strong>
            <small>SKU ${escapeHtml(item.produto_sku)}</small>
          </div>
          <strong>${escapeHtml(formatCurrencyBR(subtotal))}</strong>
        </div>

        <div class="carrinho-controls">
          <div class="qty-stepper">
            <button type="button" onclick="alterCartQty('${escapeHtml(item.produto_sku)}', -1)">−</button>
            <span>${item.quantidade}</span>
            <button type="button" onclick="alterCartQty('${escapeHtml(item.produto_sku)}', 1)">+</button>
          </div>

          <button type="button" class="link-btn" onclick="removerDoCarrinho('${escapeHtml(item.produto_sku)}')">Remover</button>
        </div>
      </div>
    `;
		})
		.join("");

	totalEl.textContent = formatCurrencyBR(total);
	btn.disabled = false;
}

async function confirmarPedido() {
	if (!state.cliente.id)
		return alert("Cliente não informado. Volte ao CRM e selecione um cliente.");
	if (!state.carrinho.length)
		return alert("Adicione pelo menos um item ao pedido.");

	const btn = qs("btnConfirmarPedido");
	if (!btn) return;

	btn.disabled = true;
	btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';

	try {
		const body = {
			cliente_id: state.cliente.id,
			pago: qs("pedidoPago")?.value === "true",
			data_pagamento: qs("pedidoDataPagamento")?.value || null,
			observacoes: (qs("pedidoObs")?.value || "").trim(),
			items: state.carrinho.map((item) => ({
				produto_sku: item.produto_sku,
				quantidade: item.quantidade,
				valor_unitario: item.valor,
			})),
		};

		const res = await fetch("/api/vendas", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		const result = await res.json();
		if (!res.ok) throw new Error(result.error || "Erro ao registrar pedido");

		alert("Pedido registrado com sucesso.");
		voltarOrigem();
	} catch (err) {
		alert(err.message || "Não foi possível salvar o pedido.");
		btn.disabled = false;
		btn.innerHTML = '<i class="fas fa-check-circle"></i> Finalizar pedido';
	}
}

function voltarOrigem() {
	if (state.cliente.from === "crm-cliente" && state.cliente.id) {
		window.location.href = `/crm/cliente?id=${encodeURIComponent(state.cliente.id)}`;
		return;
	}
	window.location.href = "/crm";
}

function limparFiltros() {
	if (qs("produtoBusca")) qs("produtoBusca").value = "";
	if (qs("filtroCategoria")) qs("filtroCategoria").value = "";
	if (qs("filtroColecao")) qs("filtroColecao").value = "";
	if (qs("filtroOrdenacao")) qs("filtroOrdenacao").value = "relevancia";
	if (qs("filtroDisponiveis")) qs("filtroDisponiveis").checked = true;
	if (qs("filtroPrecoMin")) qs("filtroPrecoMin").value = "";
	if (qs("filtroPrecoMax")) qs("filtroPrecoMax").value = "";
	aplicarFiltros({ resetPage: true });
}

function bindEvents() {
	const debouncedFilter = debounce(
		() => aplicarFiltros({ resetPage: true }),
		220,
	);

	qs("produtoBusca")?.addEventListener("input", debouncedFilter);
	qs("filtroPrecoMin")?.addEventListener("input", debouncedFilter);
	qs("filtroPrecoMax")?.addEventListener("input", debouncedFilter);

	[
		"filtroCategoria",
		"filtroColecao",
		"filtroOrdenacao",
		"filtroDisponiveis",
	].forEach((id) => {
		qs(id)?.addEventListener("change", () =>
			aplicarFiltros({ resetPage: true }),
		);
	});

	qs("btnLimparFiltros")?.addEventListener("click", limparFiltros);
	qs("btnLimparCarrinho")?.addEventListener("click", limparCarrinho);
	qs("btnConfirmarPedido")?.addEventListener("click", confirmarPedido);
	qs("themeToggleBtn")?.addEventListener("click", toggleTheme);

	qs("btnPrimeiraPagina")?.addEventListener("click", () => goToPage(1));
	qs("btnPaginaAnterior")?.addEventListener("click", () =>
		goToPage(state.page - 1),
	);
	qs("btnProximaPagina")?.addEventListener("click", () =>
		goToPage(state.page + 1),
	);
	qs("btnUltimaPagina")?.addEventListener("click", () =>
		goToPage(state.totalPages),
	);
}

window.addQty = addQty;
window.adicionarAoCarrinho = adicionarAoCarrinho;
window.alterCartQty = alterCartQty;
window.removerDoCarrinho = removerDoCarrinho;
window.voltarOrigem = voltarOrigem;
window.goToPage = goToPage;

window.addEventListener("DOMContentLoaded", async () => {
	applySavedTheme();
	readQuery();
	renderCliente();
	bindEvents();
	renderCarrinho();
	await fetchClienteInfo();
	await loadProdutos();
});
