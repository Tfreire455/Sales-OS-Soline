/* src/utils/formatters.js */

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const getRandomDelay = (min, max) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

// ─────────────────────────────────────────────────────────────
// EXTRATOR DE FILE ID DO GOOGLE DRIVE
// Suporta todos os formatos conhecidos:
//   - drive.google.com/file/d/ID/view
//   - drive.google.com/open?id=ID
//   - drive.google.com/uc?id=ID&export=download
//   - docs.google.com/file/d/ID
//   - lh3.googleusercontent.com/d/ID
// ─────────────────────────────────────────────────────────────
export const extrairDriveId = (url) => {
    if (!url) return null;

    const patterns = [
        /\/d\/([a-zA-Z0-9_-]{10,})/,          // /file/d/ID  ou  /d/ID
        /id=([a-zA-Z0-9_-]{10,})/,             // ?id=ID  ou  &id=ID
        /open\?id=([a-zA-Z0-9_-]{10,})/,       // /open?id=ID
        /uc\?.*id=([a-zA-Z0-9_-]{10,})/,       // /uc?id=ID&export=...
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) return match[1];
    }
    return null;
};

// ─────────────────────────────────────────────────────────────
// CONVERSOR DE LINKS — BACK-END (Node.js / Baileys)
//
// POR QUE O GOOGLE DRIVE BLOQUEIA?
// 1. Google removeu suporte a hot-linking direto em 2024/2025.
//    Links /file/d/ID/view retornam uma página HTML, não bytes.
// 2. O endpoint lh3.googleusercontent.com agora exige cookies
//    de sessão Google ou um Referer válido — bots sem headers
//    recebem 403 Forbidden.
// 3. O único endpoint que ainda entrega bytes raw de forma
//    confiável para requisições server-side é:
//       https://drive.google.com/uc?export=download&id=FILE_ID
//    combinado com um User-Agent de navegador real.
//
// ESTRATÉGIA (cascata de fallbacks):
//   1º  drive.google.com/uc?export=download&id=ID  (mais confiável)
//   2º  lh3.googleusercontent.com/d/ID=s2000       (CDN de thumbnails)
//   3º  drive.usercontent.google.com/download       (novo endpoint 2024)
// ─────────────────────────────────────────────────────────────
export const getDirectDriveLink = (url) => {
    if (!url) return null;

    // Já é link direto de imagem (extensão real ou CDN externo)
    if (url.match(/\.(jpeg|jpg|gif|png|webp)($|\?)/i) && !url.includes('drive.google.com')) {
        return url;
    }

    const id = extrairDriveId(url);
    if (id) {
        // Endpoint primário: uc?export=download — funciona com User-Agent forjado
        return `https://drive.google.com/uc?export=download&id=${id}`;
    }

    return url;
};

// Lista ordenada de URLs de fallback para download no back-end
export const getDriveFallbackUrls = (url) => {
    const id = extrairDriveId(url);
    if (!id) return [url].filter(Boolean);

    return [
        `https://drive.google.com/uc?export=download&id=${id}`,
        `https://drive.usercontent.google.com/download?id=${id}&export=download`,
        `https://lh3.googleusercontent.com/d/${id}=s2000`,
    ];
};

// Link otimizado para <img> no front-end (thumbnail CDN + referrerpolicy)
export const getDriveImageLink = (url, size = 220) => {
    if (!url) return null;
    const id = extrairDriveId(url);
    if (id) return `https://lh3.googleusercontent.com/d/${id}=s${size}`;
    return url;
};