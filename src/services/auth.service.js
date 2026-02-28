import fs from 'fs';
import path from 'path';

export const limparCacheAuth = () => {
    const pastaAuth = path.resolve('./auth_info_baileys');
    
    // Se a pasta não existe, não há o que limpar
    if (!fs.existsSync(pastaAuth)) return;

    try {
        // Remove a pasta inteira e todo o seu conteúdo (incluindo o creds.json)
        fs.rmSync(pastaAuth, { recursive: true, force: true });
        console.log('🧹 Cache de autenticação limpo com sucesso. Pronto para novo QR Code.');
    } catch (erro) {
        console.error('⚠️ Erro ao limpar cache de autenticação:', erro.message);
    }
};