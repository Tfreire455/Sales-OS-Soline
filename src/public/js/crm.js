const state = { clientes: [], search: "" };

const els = {
	list: document.getElementById("crm-clients-list"),
	total: document.getElementById("crm-total-count"),
	search: document.getElementById("crm-search"),
	formSection: document.getElementById("crm-form-section"),
	formTitle: document.getElementById("crm-form-title"),
	editId: document.getElementById("edit-cliente-id"),
	nome: document.getElementById("cliente-nome"),
	whatsapp: document.getElementById("cliente-whatsapp"),
	email: document.getElementById("cliente-email"),
	obs: document.getElementById("cliente-obs"),
	btnOpenClientForm: document.getElementById("btn-open-client-form"),
	btnCloseClientForm: document.getElementById("btn-close-client-form"),
	btnSaveClient: document.getElementById("btn-save-client"),
	themeBtn: document.getElementById("crm-theme-btn"),
	themeIcon: document.getElementById("crm-theme-icon"),
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
			credentials: "same-origin",
			headers: {
				Accept: "application/json",
				...(options.headers || {}),
			},
			redirect: "follow",
			signal: controller.signal,
			...options,
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

function goBackFromCRM() {
	if (window.history.length > 1) {
		window.history.back();
		return;
	}
	window.location.href = "/";
}

function openClientForm(cliente = null) {
	if (!els.formSection) return;

	els.formSection.classList.remove("is-hidden");

	if (cliente) {
		els.formTitle.textContent = "Editar cliente";
		els.editId.value = cliente.id || "";
		els.nome.value = cliente.nome || "";
		els.whatsapp.value = cliente.whatsapp || "";
		els.email.value = cliente.email || "";
		els.obs.value = cliente.observacoes || "";
	} else {
		els.formTitle.textContent = "Novo cliente";
		els.editId.value = "";
		els.nome.value = "";
		els.whatsapp.value = "";
		els.email.value = "";
		els.obs.value = "";
	}

	setTimeout(() => els.nome?.focus(), 60);
}

function closeClientForm() {
	els.formSection?.classList.add("is-hidden");
}

function getFilteredClientes() {
	const q = String(state.search || "")
		.trim()
		.toLowerCase();
	if (!q) return state.clientes;

	return state.clientes.filter((c) =>
		[c?.nome, c?.whatsapp, c?.email].some((v) =>
			String(v || "")
				.toLowerCase()
				.includes(q),
		),
	);
}

function renderClientes() {
	if (!els.list || !els.total) return;

	const lista = getFilteredClientes();
	els.total.textContent = `${lista.length} cliente${lista.length === 1 ? "" : "s"}`;

	if (!lista.length) {
		els.list.innerHTML = `
			<div class="crm-empty-state">
				<i class="fas fa-users-slash"></i>
				<span>Nenhum cliente encontrado.</span>
			</div>
		`;
		return;
	}

	els.list.innerHTML = lista
		.map((c) => {
			const pendentes = Number(c?.pendentes || 0);
			const totalCompras = Number(c?.total_compras || 0);

			return `
				<article class="crm-client-item compact-card" data-id="${escapeHtml(String(c?.id || ""))}">
					<div class="crm-client-row">
						<div class="crm-client-main">
							<div class="crm-client-name">${escapeHtml(c?.nome || "Sem nome")}</div>
							<div class="crm-client-meta">${escapeHtml(c?.whatsapp || "-")}</div>
						</div>

						<div class="crm-client-stats compact">
							<span class="crm-pill">
								<i class="fas fa-bag-shopping"></i> ${totalCompras}
							</span>
							<span class="crm-pill ${pendentes > 0 ? "danger" : "success"}">
								${pendentes > 0 ? `${pendentes} pend.` : "em dia"}
							</span>
						</div>
					</div>

					<div class="crm-client-footer-row">
						<div class="crm-subtext">Toque para abrir os dados completos e os pedidos.</div>

						<div class="crm-client-actions">
							<button class="crm-inline-btn info" type="button" data-action="open" data-id="${escapeHtml(String(c?.id || ""))}">
								<i class="fas fa-eye"></i>
								<span>Abrir</span>
							</button>

							<button class="crm-inline-btn info" type="button" data-action="edit" data-id="${escapeHtml(String(c?.id || ""))}">
								<i class="fas fa-pen"></i>
								<span>Editar</span>
							</button>

							<button class="crm-inline-btn danger" type="button" data-action="delete" data-id="${escapeHtml(String(c?.id || ""))}" data-name="${escapeHtml(c?.nome || "")}">
								<i class="fas fa-trash"></i>
								<span>Excluir</span>
							</button>
						</div>
					</div>
				</article>
			`;
		})
		.join("");
}

async function carregarClientes() {
	if (els.list) {
		els.list.innerHTML = `
			<div class="crm-empty-state">
				<i class="fas fa-spinner fa-spin"></i>
				<span>Carregando clientes...</span>
			</div>
		`;
	}

	try {
		const data = await api("/api/clientes");
		state.clientes = Array.isArray(data) ? data : [];
		renderClientes();
	} catch (err) {
		console.error("[CRM] Erro ao carregar clientes:", err);
		state.clientes = [];

		if (els.total) {
			els.total.textContent = "0 clientes";
		}

		if (els.list) {
			els.list.innerHTML = `
				<div class="crm-empty-state">
					<i class="fas fa-circle-exclamation"></i>
					<span>${escapeHtml(err.message || "Não foi possível carregar os clientes.")}</span>
				</div>
			`;
		}
	}
}

async function salvarCliente() {
	const payload = {
		nome: (els.nome?.value || "").trim(),
		whatsapp: (els.whatsapp?.value || "").trim(),
		email: (els.email?.value || "").trim(),
		observacoes: (els.obs?.value || "").trim(),
	};

	if (!payload.nome || !payload.whatsapp) {
		showToast("Nome e WhatsApp são obrigatórios.");
		return;
	}

	const id = els.editId?.value || "";

	try {
		await api(id ? `/api/clientes/${id}` : "/api/clientes", {
			method: id ? "PUT" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		showToast(id ? "Cliente atualizado." : "Cliente cadastrado.");
		closeClientForm();
		await carregarClientes();
	} catch (err) {
		showToast(err.message || "Erro ao salvar cliente.");
	}
}

async function deletarCliente(id, nome) {
	if (!window.confirm(`Excluir o cliente "${nome}" e todas as vendas dele?`))
		return;

	try {
		await api(`/api/clientes/${id}`, { method: "DELETE" });
		showToast("Cliente excluído.");
		await carregarClientes();
	} catch (err) {
		showToast(err.message || "Erro ao excluir cliente.");
	}
}

function openClientePage(id) {
	const url = new URL("/crm/cliente", window.location.origin);
	url.searchParams.set("id", id);
	window.location.href = url.toString();
}

function bindEvents() {
	els.search?.addEventListener("input", (e) => {
		state.search = e.target.value || "";
		renderClientes();
	});

	els.btnOpenClientForm?.addEventListener("click", () => openClientForm());
	els.btnCloseClientForm?.addEventListener("click", closeClientForm);
	els.btnSaveClient?.addEventListener("click", salvarCliente);
	els.themeBtn?.addEventListener("click", toggleTheme);
	els.backBtn?.addEventListener("click", goBackFromCRM);

	els.list?.addEventListener("click", async (e) => {
		const item = e.target.closest(".crm-client-item");
		const actionBtn = e.target.closest("[data-action]");
		const action = actionBtn?.getAttribute("data-action");
		const id =
			actionBtn?.getAttribute("data-id") || item?.getAttribute("data-id");

		if (!id) return;

		if (action === "edit") {
			e.stopPropagation();
			const cliente = state.clientes.find((c) => Number(c.id) === Number(id));
			if (cliente) openClientForm(cliente);
			return;
		}

		if (action === "delete") {
			e.stopPropagation();
			await deletarCliente(
				id,
				actionBtn.getAttribute("data-name") || "Cliente",
			);
			return;
		}

		if (item || action === "open") {
			openClientePage(id);
		}
	});
}

window.addEventListener("DOMContentLoaded", async () => {
	applySavedTheme();
	revealCards();
	bindEvents();
	await carregarClientes();

	if (window.gsap) {
		gsap.fromTo(
			".crm-page-wrap .card",
			{ opacity: 0, y: 10 },
			{
				opacity: 1,
				y: 0,
				duration: 0.24,
				stagger: 0.04,
				ease: "power2.out",
				clearProps: "transform",
			},
		);
	}
});
