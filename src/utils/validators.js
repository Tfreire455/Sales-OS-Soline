/* src/utils/validators.js */

import { extrairDriveId } from './formatters.js';

/**
 * Valida se uma URL de imagem é acessível.
 * 
 * Para links do Google Drive: valida apenas se o ID foi extraído com sucesso,
 * sem fazer requisição HTTP (Google bloqueia HEAD requests de bots).
 * 
 * Para outros links: faz um HEAD request com timeout de 8s.
 */
export const validarLinkImagem = async (url) => {
    if (!url) return false;

    // Links do Google Drive: valida apenas estrutura (ID presente)
    // O download real com headers será feito pelo getMediaBuffer
    const driveId = extrairDriveId(url);
    if (driveId) return true;

    // Links externos: tenta HEAD
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(url, {
            method: 'HEAD',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            }
        });

        clearTimeout(timeoutId);

        if (!res.ok) return false;

        const type = res.headers.get('content-type');
        return type && type.startsWith('image');

    } catch {
        // Timeout ou erro de rede — assume válido para não travar o loop
        return true;
    }
};