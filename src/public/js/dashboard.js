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
CustomEase.create('bounce4', 'M0,0 C0.14,0 0.24,1.22 0.42,1.04 0.7,0.97 1,1 1,1');
// Saída rápida para closes de modal
CustomEase.create('quickIn', 'M0,0 C0.55,0 0.9,0.5 1,1');

// ─── Estado Global ────────────────────────────────────────────────────────────
let produtosCache     = [];
let currentMode       = 'NORMAL';
let isCampaignActive  = false;
let filtroStatusAtual = 'todos';
let calendarDate      = new Date();
let scheduleCache     = [];
let birthdaysCache    = [];
let _agendDebounce    = null;

// ─── Segurança: Escape HTML ───────────────────────────────────────────────────
function escapeHtml(str) {
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#039;');
}

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
    const card = overlay.querySelector('.modal-card');

    overlay.classList.add('active');
    gsap.killTweensOf([overlay, card]);

    gsap.fromTo(overlay,
        { opacity: 0 },
        { opacity: 1, duration: 0.28, ease: 'power2.out' }
    );
    gsap.fromTo(card,
        { opacity: 0, y: 40, scale: 0.93 },
        { opacity: 1, y: 0,  scale: 1, duration: 0.46, ease: 'bounce4',
          clearProps: 'transform,scale' }
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
    const card = overlay.querySelector('.modal-card');

    gsap.killTweensOf([overlay, card]);
    gsap.to(card,    { opacity: 0, y: 22, scale: 0.96, duration: 0.2, ease: 'quickIn' });
    gsap.to(overlay, {
        opacity: 0, duration: 0.26, ease: 'power2.in', delay: 0.05,
        onComplete: () => {
            overlay.classList.remove('active');
            // Reset do card para próxima abertura
            gsap.set(card, { opacity: 0, y: 40, scale: 0.93 });
        }
    });
}

// =============================================================================
// GSAP HELPERS — CUSTOM SYSTEM ALERTS & TOASTS
// =============================================================================
function showSysAlert(message, type = 'info') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('sysAlertModal');
        const card = document.getElementById('sysAlertCard');
        const icon = document.getElementById('sysAlertIcon');
        const msgEl = document.getElementById('sysAlertMsg');
        const btns = document.getElementById('sysAlertButtons');

        let iconHtml = '<i class="fas fa-info-circle" style="color: #3b82f6; filter: drop-shadow(0 0 15px rgba(59,130,246,0.5));"></i>';
        let btnHtml = `<button class="sys-btn sys-btn-confirm" id="sysBtnOk" style="background: #3b82f6; color: white; box-shadow: 0 0 20px rgba(59,130,246,0.3);">OK</button>`;

        if (type === 'error') {
            iconHtml = '<i class="fas fa-times-circle" style="color: #ff4444; filter: drop-shadow(0 0 15px rgba(255,68,68,0.5));"></i>';
            btnHtml = `<button class="sys-btn sys-btn-confirm" id="sysBtnOk" style="background: #ff4444; color: white; box-shadow: 0 0 20px rgba(255,68,68,0.3);">ENTENDI</button>`;
        } else if (type === 'warning') {
            iconHtml = '<i class="fas fa-exclamation-triangle" style="color: var(--gold); filter: drop-shadow(0 0 15px rgba(255,215,0,0.5));"></i>';
            btnHtml = `<button class="sys-btn sys-btn-confirm" id="sysBtnOk" style="background: var(--gold); color: black;">OK</button>`;
        }

        icon.innerHTML = iconHtml;
        msgEl.innerHTML = escapeHtml(message);
        btns.innerHTML = btnHtml;

        overlay.classList.add('active');
        gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'power2.out' });
        gsap.fromTo(card, 
            { opacity: 0, y: 30, scale: 0.9 }, 
            { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'bounce4' }
        );

        document.getElementById('sysBtnOk').onclick = () => {
            gsap.to(card, { opacity: 0, y: 15, scale: 0.95, duration: 0.2, ease: 'quickIn' });
            gsap.to(overlay, { opacity: 0, duration: 0.25, delay: 0.05, onComplete: () => {
                overlay.classList.remove('active');
                resolve(true);
            }});
        };
    });
}

function showSysConfirm(message, confirmText = 'Confirmar', danger = false) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('sysAlertModal');
        const card = document.getElementById('sysAlertCard');
        const icon = document.getElementById('sysAlertIcon');
        const msgEl = document.getElementById('sysAlertMsg');
        const btns = document.getElementById('sysAlertButtons');

        const color = danger ? '#ff4444' : 'var(--primary)';
        const txtColor = danger ? 'white' : 'black';
        const shadow = danger ? 'rgba(255,68,68,0.3)' : 'rgba(37,211,102,0.3)';

        icon.innerHTML = `<i class="fas fa-question-circle" style="color: ${color}; filter: drop-shadow(0 0 15px ${shadow});"></i>`;
        msgEl.innerHTML = escapeHtml(message);
        btns.innerHTML = `
            <button class="sys-btn sys-btn-cancel" id="sysBtnCancel">Cancelar</button>
            <button class="sys-btn sys-btn-confirm" id="sysBtnConfirm" style="background: ${color}; color: ${txtColor}; box-shadow: 0 0 20px ${shadow};">${confirmText}</button>
        `;

        overlay.classList.add('active');
        gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'power2.out' });
        gsap.fromTo(card, 
            { opacity: 0, y: 30, scale: 0.9 }, 
            { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'bounce4' }
        );

        const closeAndResolve = (result) => {
            gsap.to(card, { opacity: 0, y: 15, scale: 0.95, duration: 0.2, ease: 'quickIn' });
            gsap.to(overlay, { opacity: 0, duration: 0.25, delay: 0.05, onComplete: () => {
                overlay.classList.remove('active');
                resolve(result);
            }});
        };

        document.getElementById('sysBtnCancel').onclick = () => closeAndResolve(false);
        document.getElementById('sysBtnConfirm').onclick = () => closeAndResolve(true);
    });
}

function showSysToast(message, type = 'success') {
    const toast = document.createElement('div');
    const color = type === 'success' ? '#4ade80' : (type === 'error' ? '#ff4444' : 'var(--gold)');
    const icon = type === 'success' ? 'fa-check-circle' : (type === 'error' ? 'fa-times-circle' : 'fa-info-circle');
    
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
    
    gsap.fromTo(toast, { opacity: 0, x: 50 }, { opacity: 1, x: 0, duration: 0.4, ease: 'back.out(1.2)' });
    setTimeout(() => {
        gsap.to(toast, { opacity: 0, x: 20, duration: 0.3, ease: 'power2.in', onComplete: () => toast.remove() });
    }, 3500);
}

// =============================================================================
// GSAP HELPERS — TABELA & CALENDÁRIO
// =============================================================================

function gsapAnimateRows() {
    const rows = document.querySelectorAll('#tableBody tr');
    if (!rows.length) return;
    gsap.fromTo(rows,
        { opacity: 0, x: -14 },
        { opacity: 1, x: 0, duration: 0.32, stagger: 0.028, ease: 'power2.out',
          clearProps: 'transform' }
    );
}

function gsapAnimateCells() {
    const cells = document.querySelectorAll('#calendarGrid .day-cell:not(.empty)');
    if (!cells.length) return;
    gsap.fromTo(cells,
        { opacity: 0, scale: 0.84 },
        { opacity: 1, scale: 1, duration: 0.3, stagger: { amount: 0.38 },
          ease: 'bounce4', clearProps: 'transform,scale' }
    );
}

// =============================================================================
// INICIALIZAÇÃO — Sequência de entrada cinematográfica
// =============================================================================
document.addEventListener('DOMContentLoaded', () => {

    // ── Timeline principal de entrada da página
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });

    // 1. Status bar desce do topo
    tl.fromTo('.status-bar',
        { opacity: 0, y: -30 },
        { opacity: 1, y: 0, duration: 0.55 }
    );

    // 2. Botões de logout entram da direita, em stagger
    tl.fromTo('.logout-btn',
        { opacity: 0, x: 28 },
        { opacity: 1, x: 0, duration: 0.4, stagger: 0.09 },
        '-=0.3'
    );

    // 3. Cards pequenos sobem com stagger (exceto full-width)
    tl.fromTo('.card:not(.full-width)',
        { opacity: 0, y: 40 },
        { opacity: 1, y: 0, duration: 0.55, stagger: 0.1,
          clearProps: 'transform' },
        '-=0.2'
    );

    // 4. Card full-width entra com leve delay extra
    tl.fromTo('.card.full-width',
        { opacity: 0, y: 52 },
        { opacity: 1, y: 0, duration: 0.65, clearProps: 'transform' },
        '-=0.25'
    );

    // ── Hover nos cards: GSAP cuida de elevação e sombra ──────────────────────
    document.querySelectorAll('.card').forEach(card => {
        card.addEventListener('mouseenter', () => {
            gsap.to(card, {
                y: -5,
                boxShadow: '0 22px 50px -10px rgba(0,0,0,0.75)',
                duration: 0.25, ease: 'power2.out'
            });
        });
        card.addEventListener('mouseleave', () => {
            gsap.to(card, {
                y: 0,
                boxShadow: '0 10px 30px -10px rgba(0,0,0,0.5)',
                duration: 0.35, ease: 'power2.out'
            });
        });
    });

    // ── Hover nos mode-buttons ─────────────────────────────────────────────────
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => gsap.to(btn, { scale: 1.05, duration: 0.2, ease: 'power2.out' }));
        btn.addEventListener('mouseleave', () => gsap.to(btn, { scale: 1,    duration: 0.22, ease: 'power2.out' }));
    });

    // ── Hover no botão principal de campanha ──────────────────────────────────
    const mainBtn = document.getElementById('main-action-btn');
    if (mainBtn) {
        mainBtn.addEventListener('mouseenter', () => gsap.to(mainBtn, { scale: 1.03, duration: 0.18, ease: 'power2.out' }));
        mainBtn.addEventListener('mouseleave', () => gsap.to(mainBtn, { scale: 1,    duration: 0.2,  ease: 'power2.out' }));
    }

    // ── Inicia lógica de dados ─────────────────────────────────────────────────
    createParticles();
    loadCollections();
    carregarProdutos();
    carregarAgendamentos();
    renderCalendar();

    fetch('/api/campaign/status')
        .then(r => r.json())
        .then(updateCampaignUI)
        .catch(err => console.error('Erro ao obter status inicial:', err));

    setInterval(carregarProdutos, 10800000);
});

// =============================================================================
// PARTÍCULAS — Movimento orgânico contínuo via GSAP
// =============================================================================
function createParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    container.innerHTML = '';

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < 50; i++) {
        const s    = document.createElement('div');
        const size = Math.random() * 3.5 + 0.8;
        const x    = Math.random() * 100;
        const y    = Math.random() * 100;

        // Inline style via cssText — 1 única recalculação por partícula
        s.style.cssText = `
            position: absolute;
            left: ${x}%;
            top:  ${y}%;
            width:  ${size}px;
            height: ${size}px;
            background: white;
            border-radius: 50%;
            box-shadow: 0 0 ${size * 2.5}px rgba(255,255,255,0.8);
            opacity: 0;
            will-change: transform, opacity;
        `;
        fragment.appendChild(s);

        // Timeline individual: surge → flutua → desvanece → repete
        const floatY  = -(Math.random() * 35 + 12);   // px para cima
        const dur     = Math.random() * 3 + 2.5;       // segundos totais
        const delay   = Math.random() * 8;              // stagger natural

        gsap.timeline({ repeat: -1, delay, defaults: {} })
            .fromTo(s,
                { opacity: 0, scale: 0, y: 0 },
                { opacity: Math.random() * 0.55 + 0.15,
                  scale: 1, y: floatY,
                  duration: dur * 0.45, ease: 'power2.out' }
            )
            .to(s,
                { opacity: 0, scale: 0.2, y: floatY - 15,
                  duration: dur * 0.55, ease: 'power2.in' }
            );
    }

    container.appendChild(fragment);
}

// =============================================================================
// COLEÇÕES
// =============================================================================
async function loadCollections() {
    try {
        const res = await fetch('/api/collections');
        if (!res.ok) throw new Error('Erro na API de coleções');
        const list = await res.json();

        const selects = [
            document.getElementById('collection-select'),
            document.getElementById('collectionFilter'),
            document.getElementById('sched_filtro')
        ];

        selects.forEach(sel => {
            if (!sel) return;
            const prev = sel.value;
            sel.innerHTML = '<option value="">Selecione...</option>';
            if (list && list.length > 0) {
                list.forEach(c => {
                    if (c && c.trim() !== '') {
                        const opt = document.createElement('option');
                        opt.value = c; opt.innerText = c;
                        sel.appendChild(opt);
                    }
                });
                if (Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
            }
        });
    } catch (e) {
        console.error('Erro ao carregar coleções:', e);
    }
}

// =============================================================================
// ENGINE DE FERIADOS (local, sem rede)
// =============================================================================
function getHolidays(year) {
    const holidays = [];
    const fixed = {
        '01-01':'Confraternização Universal','03-08':'Dia da Mulher 🌹',
        '04-21':'Tiradentes','05-01':'Dia do Trabalho',
        '06-12':'Dia dos Namorados 💘','09-07':'Independência do Brasil',
        '10-12':'N. Sra. Aparecida / Crianças','11-02':'Finados',
        '11-15':'Proclamação da República','11-20':'Dia da Consciência Negra',
        '12-25':'Natal 🎄','12-31':'Véspera de Ano Novo ✨'
    };
    for (const [d,n] of Object.entries(fixed))
        holidays.push({ date:`${year}-${d}`, name:n, type:'FIXED' });

    // Páscoa — Meeus/Jones/Butcher
    const a=year%19,b=Math.floor(year/100),c=year%100,
          d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),
          g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,
          ii=Math.floor(c/4),k=c%4,l=(32+2*e+2*ii-h-k)%7,
          m=Math.floor((a+11*h+22*l)/451),
          mo=Math.floor((h+l-7*m+114)/31),
          dy=((h+l-7*m+114)%31)+1;
    const easter = new Date(year, mo-1, dy);

    const add = (dt,n) => { const r=new Date(dt); r.setDate(r.getDate()+n); return r; };
    const fmt = dt => {
        const y=dt.getFullYear(),m=String(dt.getMonth()+1).padStart(2,'0'),d=String(dt.getDate()).padStart(2,'0');
        return `${y}-${m}-${d}`;
    };
    holidays.push({date:fmt(easter),          name:'Páscoa 🐰',        type:'MOBILE'});
    holidays.push({date:fmt(add(easter,-47)), name:'Carnaval 🎭',       type:'MOBILE'});
    holidays.push({date:fmt(add(easter,-2)),  name:'Sexta-feira Santa', type:'MOBILE'});
    holidays.push({date:fmt(add(easter,60)),  name:'Corpus Christi',    type:'MOBILE'});

    const getNth = (y,mo,dow,n) => {
        const dt=new Date(y,mo-1,1); let cnt=0;
        while(dt.getMonth()===mo-1){ if(dt.getDay()===dow&&++cnt===n) return fmt(dt); dt.setDate(dt.getDate()+1); }
        return null;
    };
    holidays.push({date:getNth(year,5,0,2),  name:'Dia das Mães 🌹', type:'RETAIL'});
    holidays.push({date:getNth(year,8,0,2),  name:'Dia dos Pais 👔',  type:'RETAIL'});
    holidays.push({date:getNth(year,11,5,4), name:'Black Friday 🖤',  type:'RETAIL'});
    return holidays;
}

// =============================================================================
// HELPERS DE DATA
// =============================================================================
function inputParaISO(v) { return v ? `${v}:00-03:00` : ''; }

function formatarDataParaInput(iso) {
    if (!iso) return '';
    const date  = new Date(iso);
    const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Sao_Paulo',
        year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', hour12:false
    }).format(date);
    return parts.replace(' ','T');
}

function dateKeyLocalFromISO(iso) { return iso ? formatarDataParaInput(iso).split('T')[0] : ''; }

// =============================================================================
// AGENDAMENTO
// =============================================================================
async function salvarAgendamento() {
    const id   = document.getElementById('sched_id').value;
    const ini  = document.getElementById('sched_inicio').value;
    const fim  = document.getElementById('sched_fim').value;
    const nome = document.getElementById('sched_nome').value;

    if (!nome || !ini || !fim) return showSysAlert('Preencha Nome, Início e Fim!', 'warning');
    if (ini >= fim)            return showSysAlert('A data de fim deve ser maior que a de início.', 'warning');

    const data = {
        nome, inicio: inputParaISO(ini), fim: inputParaISO(fim),
        modo:    document.getElementById('sched_modo').value,
        filtro:  document.getElementById('sched_filtro').value,
        msg_pre: document.getElementById('sched_msg').value
    };
    if (data.modo === 'COLECAO' && !data.filtro) return showSysAlert('Selecione a coleção alvo!', 'warning');

    try {
        const res = await fetch(id ? `/api/schedule/${id}` : '/api/schedule', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (res.ok) {
            fecharSchedule();
            carregarAgendamentos();
            showSysToast(id ? 'Agendamento atualizado!' : 'Agendamento criado!', 'success');
        } else {
            showSysAlert('Erro ao salvar.', 'error');
        }
    } catch (e) { console.error(e); showSysAlert('Erro de conexão.', 'error'); }
}

async function carregarAgendamentos() {
    try {
        const [rs, rb] = await Promise.all([
            fetch('/api/schedule'),
            fetch('/api/vip/aniversariantes')
        ]);
        scheduleCache  = rs.ok ? await rs.json() : [];
        birthdaysCache = rb.ok ? await rb.json() : [];
        renderCalendar();
    } catch (e) { console.error('Erro ao carregar agenda:', e); }
}

// =============================================================================
// CALENDÁRIO — com animação GSAP nas células + transição de mês
// =============================================================================
function renderCalendar() {
    const grid  = document.getElementById('calendarGrid');
    const label = document.getElementById('calendarMonthLabel');
    if (!grid || !label) return;

    const year  = calendarDate.getFullYear();
    const month = calendarDate.getMonth();

    label.innerText = calendarDate.toLocaleDateString('pt-BR', { month:'long', year:'numeric' });
    grid.innerHTML  = '';

    const holidays   = getHolidays(year);
    const firstIndex = new Date(year, month, 1).getDay();
    const daysInMo   = new Date(year, month+1, 0).getDate();
    const today      = new Date();

    ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].forEach(d =>
        grid.innerHTML += `<div class="weekday">${d}</div>`
    );
    for (let i = 0; i < firstIndex; i++)
        grid.innerHTML += `<div class="day-cell empty"></div>`;

    for (let d = 1; d <= daysInMo; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isToday = d===today.getDate() && month===today.getMonth() && year===today.getFullYear();

        const dayEvt  = (scheduleCache ||[]).filter(ev => dateKeyLocalFromISO(ev.data_inicio)===dateStr);
        const dayBday = (birthdaysCache||[]).filter(bd => {
            if (!bd.start) return false;
            const [,bm,bd2] = bd.start.split('-');
            return parseInt(bm)===(month+1) && parseInt(bd2)===d;
        });
        const dayHol = holidays.filter(h => h.date===dateStr);

        let html = `<div class="day-cell ${isToday?'today':''}" onclick="abrirSchedule(null,'${dateStr}')">
                        <div class="day-number">${d}</div>
                        <div class="events-stack">`;

        dayHol.forEach(h =>
            html += `<div class="info-marker" style="background:rgba(147,51,234,0.15);color:#d8b4fe;border:1px solid rgba(147,51,234,0.3);margin-bottom:2px;" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</div>`
        );
        dayEvt.forEach(ev => {
            const cls  = ev.modo==='BLITZ'?'event-blitz':'event-colecao';
            const hora = new Date(ev.data_inicio).toLocaleTimeString('pt-BR',
                {timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
            html += `<div class="event-marker ${cls}" title="${escapeHtml(ev.nome_evento)}" onclick="event.stopPropagation();editarAgendamento(${ev.id})">${hora} ${escapeHtml(ev.nome_evento)}</div>`;
        });
        dayBday.forEach(bd =>
            html += `<div class="event-marker" style="background:rgba(255,105,180,0.15);color:#ff80bf;border-left:3px solid #ff1493;">${escapeHtml(bd.title)}</div>`
        );

        html += `</div></div>`;
        grid.innerHTML += html;
    }

    gsapAnimateCells();
}

function mudarMes(delta) {
    const label = document.getElementById('calendarMonthLabel');
    const dir   = delta > 0 ? -1 : 1; // desloca o label para fora antes de trocar

    gsap.to(label, {
        opacity: 0, x: dir * 20, duration: 0.18, ease: 'power2.in',
        onComplete: () => {
            calendarDate.setMonth(calendarDate.getMonth() + delta);
            renderCalendar();
            gsap.fromTo(label,
                { opacity: 0, x: -dir * 20 },
                { opacity: 1, x: 0, duration: 0.28, ease: 'power2.out' }
            );
        }
    });
}

// ─── Modais de Agendamento ────────────────────────────────────────────────────
function abrirSchedule(id, dateStr) {
    document.getElementById('sched_id').value    = '';
    document.getElementById('sched_nome').value  = '';
    document.getElementById('sched_msg').value   = '';
    document.getElementById('sched_filtro').value = '';
    document.getElementById('sched_filtro_div').style.display = 'none';
    document.getElementById('btn-del-sched').style.display    = 'none';

    if (dateStr) {
        document.getElementById('sched_inicio').value = `${dateStr}T08:00`;
        document.getElementById('sched_fim').value    = `${dateStr}T18:00`;
        const feriado = getHolidays(parseInt(dateStr.split('-')[0])).find(h => h.date===dateStr);
        if (feriado)
            document.getElementById('sched_nome').value =
                `Oferta de ${feriado.name.replace('💘','').replace('🎄','').trim()}`;
    }
    gsapModalOpen('scheduleModal');
}

function editarAgendamento(id) {
    const ev = scheduleCache.find(e => e.id===id);
    if (!ev) return;
    document.getElementById('sched_id').value     = ev.id;
    document.getElementById('sched_nome').value   = ev.nome_evento;
    document.getElementById('sched_inicio').value = formatarDataParaInput(ev.data_inicio);
    document.getElementById('sched_fim').value    = formatarDataParaInput(ev.data_fim);
    document.getElementById('sched_modo').value   = ev.modo;
    const divF = document.getElementById('sched_filtro_div');
    if (ev.modo==='COLECAO') { divF.style.display='block'; document.getElementById('sched_filtro').value=ev.filtro||''; }
    else divF.style.display='none';
    document.getElementById('sched_msg').value           = ev.msg_pre_lancamento||'';
    document.getElementById('btn-del-sched').style.display = 'block';
    gsapModalOpen('scheduleModal');
}

function fecharSchedule() { gsapModalClose('scheduleModal'); }

function toggleSchedFiltro() {
    const modo = document.getElementById('sched_modo').value;
    const div  = document.getElementById('sched_filtro_div');
    if (!div) return;
    if (modo === 'COLECAO') {
        div.style.display = 'block';
        gsap.fromTo(div,
            { opacity: 0, height: 0 },
            { opacity: 1, height: 'auto', duration: 0.3, ease: 'power2.out' }
        );
    } else {
        gsap.to(div, {
            opacity: 0, height: 0, duration: 0.2, ease: 'power2.in',
            onComplete: () => { div.style.display='none'; }
        });
    }
}

async function gerarCopySugestao() {
    const nome = document.getElementById('sched_nome').value;
    if (!nome) {
        await showSysAlert('Dê um nome ao evento primeiro!', 'warning');
        return;
    }
    const msgs = [
        `🔥 Está chegando! O evento ${nome} vai trazer peças exclusivas. Prepare-se!`,
        `💎 Spoiler: ${nome} começa em breve. Você não vai querer perder!`,
        `⚠️ Atenção Grupo: Amanhã teremos o especial ${nome}. Ativem as notificações!`,
        `✨ ${nome}: Elegância e sofisticação esperam por você. Em breve!`
    ];
    document.getElementById('sched_msg').value = msgs[Math.floor(Math.random()*msgs.length)];
}

async function deletarAgendamento() {
    const id = document.getElementById('sched_id').value;
    if (!id) return;
    if (!(await showSysConfirm('Tem certeza que deseja excluir este agendamento?', 'Excluir', true))) return;
    try {
        await fetch(`/api/schedule/${id}`, { method:'DELETE' });
        fecharSchedule(); carregarAgendamentos();
        showSysToast('Agendamento removido', 'success');
    } catch (e) { showSysAlert('Erro ao excluir.', 'error'); }
}

// =============================================================================
// CONTROLE MANUAL & CAMPANHA
// =============================================================================
async function selectMode(mode) {
    if (isCampaignActive) {
        await showSysAlert('⚠️ Pare a campanha atual antes de mudar o modo de operação.', 'warning');
        return;
    }
    currentMode = mode;

document.querySelectorAll('.mode-btn').forEach(b =>
        b.classList.remove('active-normal','active-blitz','active-colecao')
    );
    const btnMap   = {NORMAL:'btn-normal', BLITZ:'btn-blitz', COLECAO:'btn-colecao'};
    const classMap = {NORMAL:'active-normal', BLITZ:'active-blitz', COLECAO:'active-colecao'};
    const btn = document.getElementById(btnMap[mode]);
    if (btn) {
        btn.classList.add(classMap[mode]);
        gsap.fromTo(btn, { scale: 0.9 }, { scale: 1, duration: 0.35, ease: 'bounce4' });
    }

    const sel  = document.getElementById('collection-select');
    const hint = document.getElementById('campaign-hint');
    const main = document.getElementById('main-action-btn');
    if (!sel || !hint || !main) return;

    if (mode === 'COLECAO') {
        sel.style.display = 'block';
        gsap.fromTo(sel, { opacity:0, y:-8 }, { opacity:1, y:0, duration:0.3, ease:'power2.out' });
        if (sel.options.length <= 1) loadCollections();
        hint.innerText    = 'Modo Desfile: Envia 2 itens a cada 30min com foco em storytelling e desejo.';
        main.innerText    = 'INICIAR DESFILE 💎';
        main.className    = 'btn-start';
        main.disabled     = false;
        main.style.opacity = 1;
    } else if (mode === 'BLITZ') {
        if (sel.style.display !== 'none') sel.style.display = 'none';
        hint.innerHTML    = "<span style='color:#ff6b6b'>⚡ ATENÇÃO:</span> O bot enviará os itens marcados com ⭐ a cada 2 MINUTOS!";
        main.innerText    = 'INICIAR BLITZ ⚡';
        main.className    = 'btn-start';
        main.disabled     = false;
        main.style.opacity = 1;
    } else {
        if (sel.style.display !== 'none') sel.style.display = 'none';
        hint.innerText    = 'Modo Normal: O bot seleciona produtos automaticamente e envia a cada 1h.';
        main.innerText    = 'EM OPERAÇÃO (AUTO)';
        main.className    = 'btn-start';
        main.disabled     = true;
        main.style.opacity = 0.5;
    }
}

async function toggleCampaign() {
    if (!isCampaignActive) {
        let filter = null;
        if (currentMode==='COLECAO') {
            const sel = document.getElementById('collection-select');
            filter = sel ? sel.value : null;
            if (!filter) {
                await showSysAlert('Por favor, selecione uma coleção para iniciar o desfile!', 'warning');
                return;
            }
        }
        if (currentMode==='BLITZ' && !produtosCache.some(p => p.prioridade && p.status!=='ENVIADO')) {
            await showSysAlert('⚠️ Atenção: Não há produtos marcados com estrela ⭐ pendentes.', 'warning');
            return;
        }
        if (!(await showSysConfirm(`Confirmar início do modo ${currentMode}? O bot começará a enviar mensagens.`, 'Iniciar'))) return;
        
        try {
            const res  = await fetch('/api/campaign/start', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({mode:currentMode, filter})
            });
            const json = await res.json();
            if (json.error) showSysAlert('Erro: ' + json.error, 'error');
            else showSysToast('Campanha Inciada!', 'success');
        } catch (err) { console.error(err); showSysAlert('Erro ao conectar com o servidor.', 'error'); }
    } else {
        if (!(await showSysConfirm('Deseja parar a campanha atual e voltar ao modo normal (automático)?', 'Parar Campanha', true))) return;
        try {
            await fetch('/api/campaign/stop', { method:'POST' });
            showSysToast('Campanha Pausada!', 'success');
        } catch (err) { showSysAlert('Erro ao parar campanha.', 'error'); }
    }
}


function updateCampaignUI(state) {
    if (!state) return;
    isCampaignActive = !!state.active;
    currentMode      = state.mode || 'NORMAL';

    const btn  = document.getElementById('main-action-btn');
    const stat = document.getElementById('campaign-status');
    const sel  = document.getElementById('collection-select');
    if (!btn || !stat || !sel) return;

    // Flip animado do texto de status
    gsap.to(stat, {
        opacity: 0, y: -6, duration: 0.15,
        onComplete: () => {
            if (state.active) {
                btn.innerText = 'PARAR CAMPANHA 🛑';
                btn.className = 'btn-start stop';
                btn.disabled  = false; btn.style.opacity = 1;

                let label=state.mode, color='#fff';
                if (state.mode==='BLITZ')   { label='⚡ BLITZ ATIVA';   color='#ff4444'; }
                if (state.mode==='COLECAO') { label='💎 DESFILE ATIVO'; color='#FFD700'; }

                stat.innerHTML = `<span style="color:${color};text-shadow:0 0 10px ${color}40;">${escapeHtml(label)}</span>`;
                if (state.filter) stat.innerHTML += ` <span style="font-size:0.8em;opacity:0.7">(${escapeHtml(state.filter)})</span>`;

                document.querySelectorAll('.mode-btn').forEach(b =>
                    b.classList.remove('active-normal','active-blitz','active-colecao')
                );
                const bId = state.mode==='NORMAL'?'btn-normal':(state.mode==='BLITZ'?'btn-blitz':'btn-colecao');
                const bCl = state.mode==='NORMAL'?'active-normal':(state.mode==='BLITZ'?'active-blitz':'active-colecao');
                const bEl = document.getElementById(bId);
                if (bEl) bEl.classList.add(bCl);

                if (state.mode==='COLECAO') { sel.style.display='block'; sel.value=state.filter||''; sel.disabled=true; }
                else sel.style.display='none';
            } else {
                isCampaignActive=false; selectMode('NORMAL');
                stat.innerHTML='MODO: NORMAL'; sel.disabled=false; sel.style.display='none';
            }
            gsap.to(stat, { opacity:1, y:0, duration:0.22, ease:'power2.out' });
        }
    });
}

// =============================================================================
// SOCKET.IO
// =============================================================================
socket.on('campaign_update', (state) => {
    updateCampaignUI(state);
    clearTimeout(_agendDebounce);
    _agendDebounce = setTimeout(carregarAgendamentos, 2000);
});

// [FIX + GSAP] Logs: escapeHtml + limite 200 linhas + entrada animada
socket.on('log', (msg) => {
    const logsDiv = document.getElementById('logs');
    if (!logsDiv) return;

    const line = document.createElement('div');
    line.className = 'log-line';
    const time = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    line.innerHTML = `<span class="log-time">${time}</span> ${escapeHtml(msg)}`;
    logsDiv.appendChild(line);

    // Entrada suave: desloca da esquerda e sobe opacity
    gsap.fromTo(line,
        { opacity: 0, x: -10 },
        { opacity: 1, x: 0, duration: 0.28, ease: 'power2.out', clearProps: 'transform' }
    );

    // Limite de 200 nós para evitar memory leak
    while (logsDiv.children.length > 200)
        logsDiv.removeChild(logsDiv.firstChild);

    logsDiv.scrollTop = logsDiv.scrollHeight;
});

socket.on('qr', (url) => {
    const container = document.getElementById('qr-container');
    if (container) {
        // Cross-fade: some → injeta → aparece
        gsap.to(container, {
            opacity: 0, scale: 0.88, duration: 0.2, ease: 'power2.in',
            onComplete: () => {
                container.innerHTML = `<img src="${escapeHtml(url)}" id="qr-image"
                    style="max-width:200px;border:4px solid white;border-radius:10px;" />`;
                gsap.fromTo(container,
                    { opacity: 0, scale: 0.82 },
                    { opacity: 1, scale: 1, duration: 0.45, ease: 'bounce4', clearProps: 'transform,scale' }
                );
            }
        });
    }
    const badge = document.getElementById('status-badge');
    if (badge) { badge.innerText='Aguardando Leitura'; badge.className='status-badge status-offline'; }
    const dot = document.getElementById('conn-dot');
    if (dot)  dot.className='status-dot dot-red';
    const text = document.getElementById('conn-text');
    if (text) text.innerText='WhatsApp Desconectado';
});

socket.on('connected', () => {
    const container = document.getElementById('qr-container');
    if (container) {
        gsap.to(container, {
            opacity: 0, scale: 0.82, duration: 0.2, ease: 'power2.in',
            onComplete: () => {
                container.innerHTML = `<i class="fas fa-check-circle"
                    style="font-size:5rem;color:#25D366;filter:drop-shadow(0 0 15px rgba(37,211,102,0.4));"></i>`;
                // Bounce exagerado no ícone de sucesso
                gsap.fromTo(container,
                    { opacity: 0, scale: 0.4 },
                    { opacity: 1, scale: 1, duration: 0.6, ease: 'bounce4', clearProps: 'transform,scale' }
                );
            }
        });
    }

    const badge = document.getElementById('status-badge');
    if (badge) {
        // Pop no badge antes de trocar o texto
        gsap.to(badge, {
            scale: 1.15, duration: 0.15, ease: 'power2.out', yoyo: true, repeat: 1,
            onComplete: () => {
                badge.innerText  = 'Sistema Online';
                badge.className  = 'status-badge status-online';
                gsap.set(badge, { scale: 1 });
            }
        });
    }

    const dot = document.getElementById('conn-dot');
    if (dot) {
        dot.className = 'status-dot dot-green';
        // Glow ring animado via boxShadow GSAP
        gsap.fromTo(dot,
            { boxShadow: '0 0 0 0 rgba(74,222,128,0.9)' },
            { boxShadow: '0 0 0 14px rgba(74,222,128,0)', duration: 0.85, ease: 'power2.out' }
        );
    }

    const text = document.getElementById('conn-text');
    if (text) text.innerText = 'WhatsApp Conectado';
});

// [FIX + GSAP] group_detected: escapeHtml + bounce entry
socket.on('group_detected', (data) => {
    const list = document.getElementById('group-list');
    if (!list) return;
    if (list.innerHTML.includes('Envie mensagem')) list.innerHTML = '';

    const safeSubject = escapeHtml(data.subject || 'Grupo Detectado');
    const safeId      = escapeHtml(data.id);

    const wrapper = document.createElement('div');
    wrapper.className = 'group-item';
    wrapper.style.cssText = 'margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.05);border-radius:8px;border-left:3px solid var(--primary);';
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

    // Bounce do topo — sinaliza novo grupo detectado
    gsap.fromTo(wrapper,
        { opacity: 0, y: -18, scale: 0.92 },
        { opacity: 1, y: 0, scale: 1, duration: 0.42, ease: 'bounce4', clearProps: 'transform,scale' }
    );
});

function copiar(text) { navigator.clipboard.writeText(text); showSysToast('ID copiado!', 'success'); }

// =============================================================================
// CATÁLOGO & TABELA
// =============================================================================
async function resetarTudo(ev) {
    if (!(await showSysConfirm('ATENÇÃO: Isso marcará TODOS os produtos como pendentes novamente. Deseja continuar?', 'Resetar Tudo', true))) return;
    const btn     = ev?.currentTarget || null;
    const svgIcon = btn ? btn.querySelector('svg.svgIcon') : null;
    try {
        if (svgIcon) gsap.to(svgIcon, { rotation: 360, duration: 0.7, ease: 'linear', repeat: -1 });
        const res  = await fetch('/api/produtos/reset-all', { method:'POST' });
        const data = await res.json();
        if (data?.success) {
            showSysToast('Catálogo resetado com sucesso!', 'success');
            await carregarProdutos();
        } else if (data?.error) {
            showSysAlert('Erro: ' + data.error, 'error');
        }
    } catch (err) {
        console.error(err); showSysAlert('Erro de conexão ao tentar resetar.', 'error');
    } finally {
        if (svgIcon) { gsap.killTweensOf(svgIcon); gsap.set(svgIcon, { rotation: 0 }); }
    }
}

async function resetarItem(sku) {
    if (!(await showSysConfirm(`Deseja colocar o item ${sku} na fila de envio novamente?`, 'Resetar Item'))) return;
    try {
        await fetch(`/api/produtos/reset/${sku}`, { method:'POST' });
        const item = produtosCache.find(p => p.sku===sku);
        if (item) item.status='';
        renderizarTabela(produtosCache);
        showSysToast('Item resetado!', 'success');
    } catch (err) { showSysAlert('Erro ao resetar item', 'error'); carregarProdutos(); }
}

async function carregarProdutos() {
    const btnIcon = document.querySelector('.btn-refresh-exp .svgIcon');
    if (btnIcon) gsap.to(btnIcon, { rotation: 360, duration: 0.65, ease: 'linear', repeat: -1 });

    try {
        const res = await fetch('/api/produtos');
        if (!res.ok) throw new Error('Falha ao buscar produtos');
        produtosCache = await res.json();
        renderizarTabela(produtosCache);
    } catch (err) {
        console.error('Erro ao carregar produtos:', err);
    } finally {
        if (btnIcon) { gsap.killTweensOf(btnIcon); gsap.set(btnIcon, { rotation: 0 }); }
    }
}

function converterLinkDrive(url) {
  if (!url) return 'https://via.placeholder.com/50/333/888?text=?';

  // Extrai File ID
  const patterns = [
    /\/d\/([a-zA-Z0-9_-]{10,})/,
    /id=([a-zA-Z0-9_-]{10,})/,
    /open\?id=([a-zA-Z0-9_-]{10,})/,
    /uc\?.*id=([a-zA-Z0-9_-]{10,})/,
    /lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]{10,})/, // extra (caso venha lh3)
  ];

  let id = null;
  for (const p of patterns) {
    const match = String(url).match(p);
    if (match && match[1]) { id = match[1]; break; }
  }

  // ✅ Se for Drive (ou tiver id), SEMPRE usa proxy do teu servidor
  // Isso elimina bloqueio e inconsistência do Google no browser.
  if (id || String(url).includes('drive.google.com') || String(url).includes('googleusercontent.com')) {
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
  }

  // Links externos normais
  return url;
}

// Fallback: se a imagem do lh3 falhar, usa o proxy do servidor
function handleImgError(imgEl) {
    const originalSrc = imgEl.getAttribute('data-original-url');
    if (!originalSrc || imgEl.getAttribute('data-proxy-tried')) {
        imgEl.src = 'https://via.placeholder.com/50/333/888?text=Erro';
        return;
    }
    imgEl.setAttribute('data-proxy-tried', 'true');
    imgEl.src = `/api/image-proxy?url=${encodeURIComponent(originalSrc)}`;
}

// [FIX + GSAP] Tabela com escapeHtml + hover por linha + stagger entry
function renderizarTabela(lista) {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!lista || lista.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" align="center" style="padding:30px;color:rgba(255,255,255,0.3)">Nenhum produto encontrado.</td></tr>';
        return;
    }

    lista.forEach(p => {
        const imgUrl = converterLinkDrive(p.image_url);
        let statusBadge = '<span class="badge b-pendente">Pendente</span>';
        if (p.status==='ENVIADO')  statusBadge='<span class="badge b-enviado">Enviado</span>';
        if (p.status==='ERRO_IMG') statusBadge='<span class="badge b-erro">Erro Img</span>';
        const repoBadge = p.reposicao
            ? '<span class="badge b-repo" title="Produto de Reposição">Repo</span>' : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td align="center" data-label="⭐">
                <button class="star-btn ${p.prioridade?'active':''}"
                    onclick="togglePrioridade('${escapeHtml(p.sku)}')" title="Marcar Prioridade (Blitz)">
                    <i class="${p.prioridade?'fas':'far'} fa-star"></i>
                </button>
            </td>
            <td class="col-img" data-label="Foto">
                <img src="${escapeHtml(imgUrl)}" loading="lazy"
  data-original-url="${escapeHtml(p.image_url || '')}"
  onerror="handleImgError(this)">
            </td>
            <td data-label="Produto">
                <div class="col-prod" style="font-weight:600">${escapeHtml(p.nome)} ${repoBadge}</div>
                <div class="col-sku" style="font-size:0.7rem;color:#777">${escapeHtml(p.sku)}</div>
            </td>
            <td class="col-price" style="color:var(--gold)" data-label="Preço">${escapeHtml(String(p.valor))}</td>
            <td data-label="Coleção"><small style="color:rgba(255,255,255,0.5)">${escapeHtml(p.colecao||'-')}</small></td>
            <td align="center" data-label="Estoque">${escapeHtml(String(p.estoque))}</td>
            <td data-label="Status">${statusBadge}</td>
            <td align="center" data-label="Ação">
                ${p.status==='ENVIADO'||p.status==='ERRO_IMG'
                    ? `<button class="btn-action" onclick="resetarItem('${escapeHtml(p.sku)}')"
                        title="Resetar item para Pendente"><i class="fas fa-redo"></i></button>`
                    : '-'}
            </td>
        `;

        // Hover por linha via GSAP (backgroundColor animado)
        tr.addEventListener('mouseenter', () =>
            gsap.to(tr, { backgroundColor:'rgba(255,255,255,0.035)', duration:0.15 })
        );
        tr.addEventListener('mouseleave', () =>
            gsap.to(tr, { backgroundColor:'rgba(0,0,0,0)', duration:0.22 })
        );

        tbody.appendChild(tr);
    });

    gsapAnimateRows();
}

async function togglePrioridade(sku) {
    try {
        const item = produtosCache.find(p => p.sku===sku);
        if (item) { item.prioridade=!item.prioridade; renderizarTabela(produtosCache); }
        await fetch(`/api/produtos/prioridade/${sku}`, { method:'POST' });
    } catch (err) { console.error('Erro ao mudar prioridade:', err); carregarProdutos(); }
}

function filtrarStatus(status, btn) {
    filtroStatusAtual = status;
    document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
    if (btn) {
        btn.classList.add('active');
        // Pop de confirmação no botão de filtro
        gsap.fromTo(btn, { scale: 0.88 }, { scale: 1, duration: 0.3, ease: 'bounce4' });
    }
    filtrarTabela();
}

function filtrarTabela() {
    const termo     = (document.getElementById('searchInput')?.value || '').toLowerCase();
    const colFilter = document.getElementById('collectionFilter')?.value || '';
    const filtrados = produtosCache.filter(p => {
        const matchTexto  = (p.nome||'').toLowerCase().includes(termo) || (p.sku||'').toLowerCase().includes(termo);
        const matchCol    = colFilter==='' || p.colecao===colFilter;
        let   matchStatus = true;
        if      (filtroStatusAtual==='pendente') matchStatus=p.status!=='ENVIADO'&&p.status!=='ERRO_IMG';
        else if (filtroStatusAtual==='enviado')  matchStatus=p.status==='ENVIADO';
        else if (filtroStatusAtual==='erro')     matchStatus=p.status==='ERRO_IMG';
        return matchTexto && matchCol && matchStatus;
    });
    renderizarTabela(filtrados);
}

// =============================================================================
// CONFIGURAÇÕES (CÉREBRO DO BOT)
// =============================================================================
function abrirConfig() {
    gsapModalOpen('configModal');
    fetch('/api/settings')
        .then(r => r.json())
        .then(s => {
            const sv = (id,v) => { const el=document.getElementById(id); if(el&&v!=null) el.value=v; };
            sv('cfg_hora_inicio',s.HORARIO_INICIO); sv('cfg_hora_fim',s.HORARIO_FIM);
            sv('cfg_int_normal',s.INTERVALO_NORMAL); sv('cfg_int_blitz',s.INTERVALO_BLITZ);
            sv('cfg_int_colecao',s.INTERVALO_COLECAO);
            const sp = (id,raw) => {
                const el=document.getElementById(id); if(!el) return;
                try{el.value=JSON.parse(raw);}catch{el.value=raw||'';}
            };
            sp('cfg_prompt_normal',s.PROMPT_NORMAL);
            sp('cfg_prompt_blitz',s.PROMPT_BLITZ);
            sp('cfg_prompt_colecao',s.PROMPT_COLECAO);
        })
        .catch(e => console.error('Erro ao carregar settings:', e));
}

function fecharConfig() { gsapModalClose('configModal'); }

async function salvarConfig() {
    if (!(await showSysConfirm('Tem certeza que deseja salvar as configurações? O bot será atualizado imediatamente.', 'Salvar'))) return;
    const gi = id => { const el=document.getElementById(id); return el?parseInt(el.value):null; };
    const gs = id => { const el=document.getElementById(id); return el?el.value:''; };
    const data = {
        HORARIO_INICIO:gi('cfg_hora_inicio'), HORARIO_FIM:gi('cfg_hora_fim'),
        INTERVALO_NORMAL:gi('cfg_int_normal'), PROMPT_NORMAL:gs('cfg_prompt_normal'),
        INTERVALO_BLITZ:gi('cfg_int_blitz'),   PROMPT_BLITZ:gs('cfg_prompt_blitz'),
        INTERVALO_COLECAO:gi('cfg_int_colecao'),PROMPT_COLECAO:gs('cfg_prompt_colecao')
    };
    try {
        const res  = await fetch('/api/settings',{
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
        });
        const json = await res.json();
        if (json.success) { 
            showSysToast('Cérebro do bot atualizado!', 'success'); 
            fecharConfig(); 
        }
        else showSysAlert('Erro ao salvar: ' + (json.error||'Desconhecido'), 'error');
    } catch (err) { console.error(err); showSysAlert('Erro de conexão ao salvar configurações.', 'error'); }
}

// =============================================================================
// GESTÃO DE CLIENTES VIP
// =============================================================================
window.abrirListaVip = function() {
    const modal = document.getElementById('vipListModal');
    if (!modal) { console.error('Modal vipListModal não encontrado no HTML'); return; }
    gsapModalOpen('vipListModal');
    window.carregarVips();
};

window.fecharListaVip = function() { gsapModalClose('vipListModal'); };

window.carregarVips = async function() {
    const tbody   = document.getElementById('vipTableBody');
    const counter = document.getElementById('vip-total-count');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" align="center" style="padding:20px;color:#666;">Carregando...</td></tr>';

    try {
        const res  = await fetch('/api/vip/list');
        if (!res.ok) throw new Error('Falha na API');
        const lista = await res.json();
        if (counter) counter.innerText = `Total: ${lista.length} clientes`;
        tbody.innerHTML = '';

        if (!lista || lista.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" align="center" style="padding:20px;color:#666;">Nenhum cliente cadastrado ainda.</td></tr>';
            return;
        }

        lista.forEach(vip => {
            let dataFmt = '--/--';
            if (vip.data_nascimento) {
                try {
                    const parts = String(vip.data_nascimento).split('T')[0].split('-');
                    if (parts.length===3) dataFmt=`${parts[2]}/${parts[1]}/${parts[0]}`;
                } catch {}
            }
            let dw = vip.whatsapp||'';
            if (dw.startsWith('55')&&dw.length>10) dw=dw.substring(2);
            if (dw.length>=10) dw=`(${dw.substring(0,2)}) ${dw.substring(2,7)}-${dw.substring(7)}`;

            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
            tr.innerHTML = `
                <td style="padding:12px 15px;color:white;">${escapeHtml(vip.nome||'Sem Nome')}</td>
                <td style="padding:12px 15px;color:#aaa;">${escapeHtml(dw)}</td>
                <td style="padding:12px 15px;color:#ff69b4;font-weight:bold;">${escapeHtml(dataFmt)}</td>
                <td style="padding:12px 15px;text-align:center;">
                    <button onclick="deletarVip(${vip.id})"
                        style="background:none;border:none;color:#ff4444;cursor:pointer;padding:5px;" title="Remover">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Stagger nas linhas da lista VIP
        const rows = tbody.querySelectorAll('tr');
        gsap.fromTo(rows,
            { opacity: 0, x: -12 },
            { opacity: 1, x: 0, duration: 0.28, stagger: 0.04, ease: 'power2.out',
              clearProps: 'transform' }
        );

    } catch (e) {
        console.error('Erro ao carregar VIPs:', e);
        tbody.innerHTML = '<tr><td colspan="4" align="center" style="color:#ff6b6b;padding:20px;">Erro ao carregar lista.<br><small>Verifique o console (F12)</small></td></tr>';
    }
};

window.deletarVip = async function(id) {
    if (!(await showSysConfirm('Tem certeza que deseja remover este cliente VIP?', 'Remover', true))) return;
    try {
        const res = await fetch(`/api/vip/${id}`, { method:'DELETE' });
        if (res.ok) {
            window.carregarVips();
            if (typeof carregarAgendamentos === 'function') carregarAgendamentos();
            showSysToast('Cliente removido.', 'success');
        } else { showSysAlert('Erro ao deletar.', 'error'); }
    } catch (e) { console.error(e); showSysAlert('Erro de conexão.', 'error'); }
};

// =============================================================================
// PAUSAR / RETOMAR BOT
// =============================================================================
let isBotPaused = false;

function updatePauseUI(paused) {
    isBotPaused = paused;
    const btn   = document.getElementById('btn-bot-pause');
    const icon  = document.getElementById('pause-icon');
    const label = document.getElementById('pause-label');
    if (!btn || !icon || !label) return;

    if (paused) {
        btn.classList.add('paused');
        icon.className = 'fas fa-play';
        label.innerText = 'Retomar';
        btn.title = 'Retomar Bot';
    } else {
        btn.classList.remove('paused');
        icon.className = 'fas fa-pause';
        label.innerText = 'Pausar';
        btn.title = 'Pausar Bot';
    }
    gsap.fromTo(btn, { scale: 0.88 }, { scale: 1, duration: 0.35, ease: 'bounce4' });
}

async function toggleBotPause() {
    if (!isBotPaused) {
        if (!(await showSysConfirm('Deseja PAUSAR o bot? Ele não enviará mensagens até ser retomado.', 'Pausar', true))) return;
        try {
            const res = await fetch('/api/bot/pause', { method: 'POST' });
            const data = await res.json();
            if (data.success) { updatePauseUI(true); showSysToast('Bot pausado!', 'warning'); }
        } catch (e) { showSysAlert('Erro ao pausar bot.', 'error'); }
    } else {
        if (!(await showSysConfirm('Deseja RETOMAR o bot? Ele voltará a operar normalmente.', 'Retomar'))) return;
        try {
            const res = await fetch('/api/bot/resume', { method: 'POST' });
            const data = await res.json();
            if (data.success) { updatePauseUI(false); showSysToast('Bot retomado!', 'success'); }
        } catch (e) { showSysAlert('Erro ao retomar bot.', 'error'); }
    }
}

socket.on('bot_paused', (paused) => updatePauseUI(paused));

// Carrega estado de pausa ao iniciar
fetch('/api/bot/status').then(r => r.json()).then(d => { if (d.paused) updatePauseUI(true); }).catch(() => {});

// =============================================================================
// MIGRAÇÃO (PLANILHA → BANCO) COM SENHA
// =============================================================================
function abrirMigracao() {
    const inp = document.getElementById('migrate_password');
    if (inp) inp.value = '';
    const btn = document.getElementById('btn-exec-migrate');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i>&nbsp; EXECUTAR MIGRAÇÃO'; }
    gsapModalOpen('migrateModal');
    setTimeout(() => { if (inp) inp.focus(); }, 400);
}

function fecharMigracao() { gsapModalClose('migrateModal'); }

async function executarMigracao() {
    const password = document.getElementById('migrate_password')?.value;
    if (!password) { await showSysAlert('Digite sua senha para confirmar a migração.', 'warning'); return; }

    const btn = document.getElementById('btn-exec-migrate');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>&nbsp; MIGRANDO...'; }

    try {
        const res = await fetch('/api/migrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();

        if (res.status === 403) {
            await showSysAlert('🔒 Senha incorreta!', 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i>&nbsp; EXECUTAR MIGRAÇÃO'; }
            return;
        }

        if (data.success) {
            fecharMigracao();
            showSysToast(`Migração concluída! ${data.total} produtos sincronizados.`, 'success');
            await carregarProdutos();
            await loadCollections();
        } else {
            await showSysAlert('Erro: ' + (data.error || 'Desconhecido'), 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i>&nbsp; EXECUTAR MIGRAÇÃO'; }
        }
    } catch (e) {
        console.error('Erro na migração:', e);
        await showSysAlert('Erro de conexão ao executar migração.', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i>&nbsp; EXECUTAR MIGRAÇÃO'; }
    }
}