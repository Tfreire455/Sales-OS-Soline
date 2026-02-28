/* src/public/js/login.js — Versão Otimizada */

document.addEventListener('DOMContentLoaded', () => {

    // ─────────────────────────────────────────
    // 1. Lógica de Erro
    // ✅ Sem mudanças necessárias — já é eficiente
    // ─────────────────────────────────────────
    if (window.location.search.includes('error=1')) {
        const errorMsg = document.getElementById('error-msg');
        if (errorMsg) errorMsg.style.display = 'block';
    }


    // ─────────────────────────────────────────
    // 2. Gerador de Partículas
    // 🔧 PROBLEMA: 50x DOM insertions individuais (lento)
    // ✅ FIX: DocumentFragment agrupa tudo em 1 único reflow
    // ─────────────────────────────────────────
    function createParticles() {
        const container = document.getElementById('particles');
        if (!container) return;

        const fragment = document.createDocumentFragment(); // ← KEY FIX

        for (let i = 0; i < 50; i++) {
            const sparkle = document.createElement('div');
            sparkle.classList.add('sparkle');

            // Desestruturação de Math.random() para legibilidade
            const x        = Math.random() * 100;
            const y        = Math.random() * 100;
            const size     = Math.random() * 4 + 1;
            const duration = Math.random() * 3 + 2;
            const delay    = Math.random() * 5;

            // ✅ Usar cssText é mais rápido que 5 atribuições .style separadas
            sparkle.style.cssText = `
                left: ${x}%;
                top: ${y}%;
                width: ${size}px;
                height: ${size}px;
                animation-duration: ${duration}s;
                animation-delay: ${delay}s;
            `;

            fragment.appendChild(sparkle);
        }

        container.appendChild(fragment); // ← 1 único reflow no DOM
    }
    createParticles();


    // ─────────────────────────────────────────
    // 3. Efeito Tilt 3D
    // 🔧 PROBLEMA 1: mousemove dispara centenas de vezes/seg sem throttle
    // 🔧 PROBLEMA 2: style.transform sem will-change força repaint contínuo
    // ✅ FIX 1: requestAnimationFrame como throttle nativo (60fps cap)
    // ✅ FIX 2: will-change promove o card para camada GPU
    // ─────────────────────────────────────────
    if (window.matchMedia("(min-width: 768px)").matches) {
        const card = document.getElementById('card3d');

        if (card) {
            // Promove para GPU uma única vez
            card.style.willChange = 'transform';

            let ticking = false; // flag de throttle via rAF

            document.addEventListener('mousemove', (e) => {
                if (ticking) return; // ignora eventos extras no mesmo frame

                requestAnimationFrame(() => {
                    const xAxis = (window.innerWidth  / 2 - e.pageX) / 25;
                    const yAxis = (window.innerHeight / 2 - e.pageY) / 25;
                    card.style.transform = `rotateY(${xAxis}deg) rotateX(${yAxis}deg)`;
                    ticking = false;
                });

                ticking = true;
            });

            document.addEventListener('mouseleave', () => {
                // Transição suave ao resetar
                card.style.transition = 'transform 0.5s ease';
                card.style.transform  = 'rotateY(0deg) rotateX(0deg)';

                // Remove transition após reset para não atrasar o tilt
                card.addEventListener('transitionend', () => {
                    card.style.transition = '';
                }, { once: true }); // ← { once: true } remove o listener automaticamente
            });
        }
    }
});