import pg from 'pg';
import { config } from '../config/settings.js';

// Configuração Otimizada para Neon (Keep-Alive + Timeouts de 30s)
const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, 
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000 
});

pool.on('connect', (client) => {
    client.query("SET timezone TO 'America/Sao_Paulo'")
        .catch(err => console.error("⚠️ Erro ao definir Timezone na conexão:", err.message));
});

pool.on('error', (err) => console.error('❌ Erro inesperado no Pool do Postgres:', err.message));

export class DatabaseService {
    
    async executeQuery(text, params = []) {
        try {
            return await pool.query(text, params);
        } catch (error) {
            console.error(`⚠️ Erro na query: ${error.message} | SQL: ${text}`);
            throw error;
        }
    }

// [ATUALIZAR O INIT DA CLASSE DatabaseService]

async init() {
        // [ATENÇÃO] Removemos o 'SET timezone' daqui porque o evento 'connect' acima já cuida disso automaticamente.
        let client;
        try {
            client = await pool.connect();

            // --- 1. TABELA DE PRODUTOS ---
            await client.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS prioridade BOOLEAN DEFAULT FALSE;`);
            await client.query(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS colecao TEXT;`);

            // --- 2. TABELA DE CONFIGURAÇÕES ---
            await client.query(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value JSONB);`);

            // --- 3. TABELA DE AGENDAMENTO ---
            await client.query(`
                CREATE TABLE IF NOT EXISTS campaign_schedule (
                    id SERIAL PRIMARY KEY,
                    nome_evento TEXT NOT NULL,
                    data_inicio TIMESTAMP WITH TIME ZONE NOT NULL,
                    data_fim TIMESTAMP WITH TIME ZONE NOT NULL,
                    modo TEXT NOT NULL,
                    filtro TEXT,
                    msg_pre_lancamento TEXT,
                    pre_lancamento_enviado BOOLEAN DEFAULT FALSE,
                    msg_inicio_enviada BOOLEAN DEFAULT FALSE,
                    msg_fim_enviada BOOLEAN DEFAULT FALSE,
                    status TEXT DEFAULT 'PENDING'
                );
            `);

                        // Dentro do init()...
            await client.query(`
                CREATE TABLE IF NOT EXISTS leads_vip (
                    id SERIAL PRIMARY KEY,
                    nome TEXT NOT NULL,
                    whatsapp TEXT NOT NULL UNIQUE,
                    data_nascimento DATE NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);
            
            await client.query(`ALTER TABLE campaign_schedule ADD COLUMN IF NOT EXISTS msg_inicio_enviada BOOLEAN DEFAULT FALSE;`);
            await client.query(`ALTER TABLE campaign_schedule ADD COLUMN IF NOT EXISTS msg_fim_enviada BOOLEAN DEFAULT FALSE;`);

            // Configurações padrão se vazio...
            const check = await client.query('SELECT COUNT(*) FROM app_config');
            if (parseInt(check.rows[0].count) === 0) {
                const defaults = {
                    'HORARIO_INICIO': config.HORARIO.INICIO, 
                    'HORARIO_FIM': config.HORARIO.FIM,
                    'INTERVALO_NORMAL': config.MODES.NORMAL.INTERVALO_LOTE, 
                    'PROMPT_NORMAL': config.MODES.NORMAL.PROMPT_STYLE,
                    'INTERVALO_BLITZ': config.MODES.BLITZ.INTERVALO_LOTE, 
                    'PROMPT_BLITZ': config.MODES.BLITZ.PROMPT_STYLE,
                    'INTERVALO_COLECAO': config.MODES.COLECAO.INTERVALO_LOTE, 
                    'PROMPT_COLECAO': config.MODES.COLECAO.PROMPT_STYLE
                };
                for (const [key, val] of Object.entries(defaults)) {
                    await client.query('INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, JSON.stringify(val)]);
                }
            }
            console.log("✅ Banco de Dados Inicializado (Fuso Horário: SP).");
        } catch (error) {
            console.error('❌ Erro Crítico ao inicializar Banco:', error.message);
        } finally {
            if(client) client.release();
        }
    }

    // =========================================================
    // MÉTODOS DE AGENDAMENTO (DITA O RITMO DO BOT)
    // =========================================================

    async createSchedule(data) {
        await this.executeQuery(
            `INSERT INTO campaign_schedule (nome_evento, data_inicio, data_fim, modo, filtro, msg_pre_lancamento)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [data.nome, data.inicio, data.fim, data.modo, data.filtro, data.msg_pre]
        );
    }

    async updateSchedule(id, data) {
        // [IMPORTANTE] Reseta TODAS as flags ao editar. 
        // Se você mudar o horário de uma campanha que já acabou, ela poderá rodar de novo.
        await this.executeQuery(
            `UPDATE campaign_schedule 
             SET nome_evento = $1, data_inicio = $2, data_fim = $3, modo = $4, filtro = $5, msg_pre_lancamento = $6,
                 pre_lancamento_enviado = FALSE, msg_inicio_enviada = FALSE, msg_fim_enviada = FALSE
             WHERE id = $7`,
            // data.inicio aqui será a string "2026-02-18T08:00:00-03:00"
            [data.nome, data.inicio, data.fim, data.modo, data.filtro, data.msg_pre, id]
        );
    }

    async getSchedules() {
        // Pega apenas campanhas futuras ou recentes (últimos 30 dias)
        const res = await this.executeQuery(`SELECT * FROM campaign_schedule WHERE data_fim > (NOW() - INTERVAL '30 days') ORDER BY data_inicio ASC`);
        return res.rows;
    }

    async deleteSchedule(id) {
        await this.executeQuery(`DELETE FROM campaign_schedule WHERE id = $1`, [id]);
    }

    // [CRÍTICO] Verifica se existe campanha ativa AGORA
    // Usa NOW() do banco para evitar conflito de hora da máquina local
    // [ATUALIZAR checkActiveSchedule]
    async checkActiveSchedule() {
        // Usa NOW() do banco (que agora está em 'America/Sao_Paulo')
        // Adicionamos tolerância de 5 segundos para compensar latências de rede
        const res = await this.executeQuery(`
            SELECT * FROM campaign_schedule 
            WHERE data_inicio <= (NOW() + INTERVAL '5 seconds') 
            AND data_fim >= NOW()
            ORDER BY data_inicio DESC LIMIT 1
        `);
        return res.rows[0] || null;
    }

    // [ATUALIZAR getNextSchedule]
    async getNextSchedule() {
        const res = await this.executeQuery(`
            SELECT * FROM campaign_schedule 
            WHERE data_inicio > NOW() 
            ORDER BY data_inicio ASC LIMIT 1
        `);
        return res.rows[0] || null;
    }

    async checkPreLaunchMessages() {
        const res = await this.executeQuery(`
            SELECT * FROM campaign_schedule 
            WHERE pre_lancamento_enviado = FALSE 
            AND msg_pre_lancamento IS NOT NULL 
            AND msg_pre_lancamento != ''
            AND data_inicio <= (NOW() + INTERVAL '24 hours')
            AND data_inicio > NOW()
        `);
        return res.rows;
    }

    async markPreLaunchAsSent(id) {
        await this.executeQuery(`UPDATE campaign_schedule SET pre_lancamento_enviado = TRUE WHERE id = $1`, [id]);
    }

    async markStartMsgAsSent(id) {
        await this.executeQuery(`UPDATE campaign_schedule SET msg_inicio_enviada = TRUE WHERE id = $1`, [id]);
    }

    // [NOVO] Marca que a mensagem de fim foi enviada para travar o loop
    async markEndMsgAsSent(id) {
        await this.executeQuery(`UPDATE campaign_schedule SET msg_fim_enviada = TRUE WHERE id = $1`, [id]);
    }

    // =========================================================
    // MÉTODOS DE CONFIGURAÇÃO E PRODUTOS
    // =========================================================

    async getSettings() {
        try {
            const res = await this.executeQuery('SELECT key, value FROM app_config');
            const settings = {};
            res.rows.forEach(r => settings[r.key] = r.value);
            return settings;
        } catch(e) { return {}; }
    }

    async updateSetting(key, value) {
        await this.executeQuery('INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, JSON.stringify(value)]);
    }
    
    async getPendentesCount() {
        try {
            const res = await this.executeQuery(`SELECT COUNT(*) FROM produtos WHERE status != 'ENVIADO' AND status != 'ERRO_IMG' AND estoque > 0`);
            return parseInt(res.rows[0].count);
        } catch (e) { return 0; }
    }

    async getCampaignProducts(mode, filterValue, limit) {
        let query = ''; let params = [];
        if (mode === 'BLITZ') {
            query = `SELECT * FROM produtos WHERE status != 'ENVIADO' AND status != 'ERRO_IMG' AND estoque > 0 AND prioridade = TRUE ORDER BY id ASC LIMIT $1`;
            params = [limit];
        } else {
            query = `SELECT * FROM produtos WHERE status != 'ENVIADO' AND status != 'ERRO_IMG' AND estoque > 0 AND colecao = $1 ORDER BY id ASC LIMIT $2`;
            params = [filterValue, limit];
        }
        const res = await this.executeQuery(query, params);
        return res.rows;
    }

    async getMelhorMix(limit) {
        try {
            const lote = [];
            // 1. Pega prioridades (estrelas)
            const resPrioridade = await this.executeQuery(`SELECT * FROM produtos WHERE status != 'ENVIADO' AND status != 'ERRO_IMG' AND estoque > 0 AND prioridade = TRUE LIMIT $1`, [limit]);
            lote.push(...resPrioridade.rows);
            
            // 2. Preenche o resto com itens normais
            if (lote.length < limit) {
                const idsExcluir = lote.length > 0 ? lote.map(i => i.id) : [0];
                const resResto = await this.executeQuery(`SELECT * FROM produtos WHERE status != 'ENVIADO' AND status != 'ERRO_IMG' AND estoque > 0 AND id != ALL($1::int[]) LIMIT $2`, [idsExcluir, limit - lote.length]);
                lote.push(...resResto.rows);
            }
            return lote;
        } catch(e) { return []; }
    }

    async resetarCatalogo() {
        await this.executeQuery(`UPDATE produtos SET status = '', prioridade = FALSE WHERE status IN ('ENVIADO', 'ERRO_IMG') OR status IS NULL`);
    }

    async marcarComoEnviado(sku) {
        await this.executeQuery("UPDATE produtos SET status = 'ENVIADO', prioridade = FALSE WHERE sku = $1", [sku]);
    }

    async marcarErroImagem(sku) {
        await this.executeQuery("UPDATE produtos SET status = 'ERRO_IMG' WHERE sku = $1", [sku]);
    }

    async getAllProducts() {
        try {
            const res = await this.executeQuery('SELECT * FROM produtos ORDER BY prioridade DESC, id ASC');
            return res.rows;
        } catch(e) { return []; }
    }

    async resetarItem(sku) {
        await this.executeQuery("UPDATE produtos SET status = '' WHERE sku = $1", [sku]);
    }

    async togglePrioridade(sku) {
        await this.executeQuery("UPDATE produtos SET prioridade = NOT prioridade WHERE sku = $1", [sku]);
    }

    async getCollectionsList() {
        try {
            const res = await this.executeQuery(`SELECT DISTINCT colecao FROM produtos WHERE colecao IS NOT NULL AND colecao != '' AND length(colecao) > 1 ORDER BY colecao ASC`);
            return res.rows.map(r => r.colecao);
        } catch(e) { return []; }
    }
}