import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { config } from '../config/settings.js';

export class SheetsService {
    constructor() {
        const auth = new JWT({
            email: config.GOOGLE_CREDS.client_email,
            key: config.GOOGLE_CREDS.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        this.doc = new GoogleSpreadsheet(config.SHEET_ID, auth);
    }

    async init() {
        await this.doc.loadInfo();
        this.sheet = this.doc.sheetsByIndex[0];
    }

    async getPendentes() {
        const rows = await this.sheet.getRows();
        
        // FILTRO:
        // 1. Status NÃO é 'ENVIADO'
        // 2. Status NÃO é 'ERRO_IMG'
        // 3. Estoque > 0
        const pendentes = rows.filter(r => {
            const status = r.get(config.COLUNA_STATUS);
            const estoque = parseInt(r.get('ESTOQUE')) || 0;
            return status !== 'ENVIADO' && status !== 'ERRO_IMG' && estoque > 0;
        });

        return { rows, pendentes };
    }

    async resetarStatus(rows) {
        console.log('♻️ Resetando catálogo (Ciclo Infinito)...');
        let count = 0;
        for (const row of rows) {
            const status = row.get(config.COLUNA_STATUS);
            if (status === 'ENVIADO' || status === 'ERRO_IMG') {
                row.set(config.COLUNA_STATUS, '');
                try {
                    await row.save();
                    count++;
                } catch (e) {}
            }
        }
        console.log(`✅ Reset concluído. ${count} itens reiniciados.`);
    }

    async marcarComoEnviado(row) {
        try {
            row.set(config.COLUNA_STATUS, 'ENVIADO');
            await row.save();
            return true;
        } catch (error) {
            console.error('🔴 Erro ao salvar na planilha (Permissão?):', error.message);
            return false;
        }
    }

    async marcarErroImagem(row) {
        try {
            row.set(config.COLUNA_STATUS, 'ERRO_IMG');
            await row.save();
            return true;
        } catch (error) {
            console.error('🔴 Erro ao salvar erro de imagem:', error.message);
            return false;
        }
    }
}