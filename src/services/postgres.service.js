import pg from 'pg';
import { config } from '../config/settings.js';
import { parseMoneyBR, toFixedMoney, seemsLegacyCentsBug } from '../utils/currency.js';

// Configuração do pool para ambientes locais e hospedados (SquareCloud/Neon)
const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_URL ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
    keepAlive: true,
});

pool.on('error', (err) => console.error('❌ Erro inesperado no Pool do Postgres:', err.message));

export class DatabaseService {
    constructor() {
        this.rehydratePromise = null;
        this.rehydrateDone = false;
    }

    async executeQuery(text, params = []) {
        try {
            return await pool.query(text, params);
        } catch (error) {
            console.error(`⚠️ Erro na query: ${error.message} | SQL: ${text}`);
            throw error;
        }
    }

    normalizeMoney(value) {
        return toFixedMoney(parseMoneyBR(value));
    }

    normalizeBoolean(value) {
        return value === true || value === 'true' || value === 1 || value === '1';
    }

    normalizeStock(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    normalizeSingleProductValues(product = {}) {
        const valorNormalizado = this.normalizeMoney(
            product.valor ?? product.preco ?? product.price ?? 0
        );

        const estoqueNormalizado = this.normalizeStock(
            product.estoque ?? product.stock ?? 0
        );

        return {
            ...product,
            valor: valorNormalizado,
            preco: valorNormalizado,
            price: valorNormalizado,
            estoque: estoqueNormalizado,
            stock: estoqueNormalizado,
            prioridade: this.normalizeBoolean(product.prioridade),
        };
    }

    async normalizeProductValues() {
        const res = await this.executeQuery(`
            SELECT id, valor, estoque, prioridade
            FROM produtos
        `);

        for (const produto of res.rows) {
            const normalizado = this.normalizeSingleProductValues(produto);

            await this.executeQuery(
                `
                UPDATE produtos
                SET valor = $1,
                    estoque = $2,
                    prioridade = $3
                WHERE id = $4
                `,
                [
                    normalizado.valor,
                    normalizado.estoque,
                    normalizado.prioridade,
                    produto.id
                ]
            );
        }

        return true;
    }

    derivePaymentStatus(valorTotal, valorPago) {
        const total = this.normalizeMoney(valorTotal);
        const pago = this.normalizeMoney(valorPago);
        const restante = Math.max(this.normalizeMoney(total - pago), 0);

        let status = 'aberto';
        if (pago >= total && total > 0) status = 'pago';
        else if (pago > 0 && pago < total) status = 'parcial';

        return { total, pago, restante, status };
    }

    async init() {
        let client;
        try {
            client = await pool.connect();
            await client.query("SET timezone TO 'America/Sao_Paulo'");

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
                    await client.query(
                        'INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                        [key, JSON.stringify(val)]
                    );
                }
            }

            console.log("✅ Banco de Dados Inicializado (Fuso Horário: SP).");
            this.ensureVendasHydrated().catch((err) => {
                console.error("⚠️ Falha ao reidratar vendas em background:", err.message);
            });
        } catch (error) {
            console.error('❌ Erro Crítico ao inicializar Banco:', error.message);
        } finally {
            if (client) client.release();
        }
    }

    // =========================================================
    // MÉTODOS DE AGENDAMENTO
    // =========================================================

    async createSchedule(data) {
        await this.executeQuery(
            `INSERT INTO campaign_schedule (nome_evento, data_inicio, data_fim, modo, filtro, msg_pre_lancamento)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [data.nome, data.inicio, data.fim, data.modo, data.filtro, data.msg_pre]
        );
    }

    async updateSchedule(id, data) {
        await this.executeQuery(
            `UPDATE campaign_schedule
             SET nome_evento = $1, data_inicio = $2, data_fim = $3, modo = $4, filtro = $5, msg_pre_lancamento = $6,
                 pre_lancamento_enviado = FALSE, msg_inicio_enviada = FALSE, msg_fim_enviada = FALSE
             WHERE id = $7`,
            [data.nome, data.inicio, data.fim, data.modo, data.filtro, data.msg_pre, id]
        );
    }

    async getSchedules() {
        const res = await this.executeQuery(`
            SELECT *
            FROM campaign_schedule
            WHERE data_fim > (NOW() - INTERVAL '30 days')
            ORDER BY data_inicio ASC
        `);
        return res.rows;
    }

    async deleteSchedule(id) {
        await this.executeQuery(`DELETE FROM campaign_schedule WHERE id = $1`, [id]);
    }

    async checkActiveSchedule() {
        const res = await this.executeQuery(`
            SELECT *
            FROM campaign_schedule
            WHERE data_inicio <= (NOW() + INTERVAL '5 seconds')
              AND data_fim >= NOW()
            ORDER BY data_inicio DESC
            LIMIT 1
        `);
        return res.rows[0] || null;
    }

    async getNextSchedule() {
        const res = await this.executeQuery(`
            SELECT *
            FROM campaign_schedule
            WHERE data_inicio > NOW()
            ORDER BY data_inicio ASC
            LIMIT 1
        `);
        return res.rows[0] || null;
    }

    async checkPreLaunchMessages() {
        const res = await this.executeQuery(`
            SELECT *
            FROM campaign_schedule
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
            res.rows.forEach(r => { settings[r.key] = r.value; });
            return settings;
        } catch {
            return {};
        }
    }

    async updateSetting(key, value) {
        await this.executeQuery(
            'INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
            [key, JSON.stringify(value)]
        );
    }

    async getPendentesCount() {
        try {
            const res = await this.executeQuery(`
                SELECT COUNT(*)
                FROM produtos
                WHERE status != 'ENVIADO'
                  AND status != 'ERRO_IMG'
                  AND estoque > 0
            `);
            return parseInt(res.rows[0].count);
        } catch {
            return 0;
        }
    }

    async getCampaignProducts(mode, filterValue, limit) {
        let query = '';
        let params = [];

        if (mode === 'BLITZ') {
            query = `
                SELECT *
                FROM produtos
                WHERE status != 'ENVIADO'
                  AND status != 'ERRO_IMG'
                  AND estoque > 0
                  AND prioridade = TRUE
                ORDER BY id ASC
                LIMIT $1
            `;
            params = [limit];
        } else {
            query = `
                SELECT *
                FROM produtos
                WHERE status != 'ENVIADO'
                  AND status != 'ERRO_IMG'
                  AND estoque > 0
                  AND colecao = $1
                ORDER BY id ASC
                LIMIT $2
            `;
            params = [filterValue, limit];
        }

        const res = await this.executeQuery(query, params);
        return res.rows;
    }

    async getMelhorMix(limit) {
        try {
            const lote = [];

            const resPrioridade = await this.executeQuery(`
                SELECT *
                FROM produtos
                WHERE status != 'ENVIADO'
                  AND status != 'ERRO_IMG'
                  AND estoque > 0
                  AND prioridade = TRUE
                LIMIT $1
            `, [limit]);

            lote.push(...resPrioridade.rows);

            if (lote.length < limit) {
                const idsExcluir = lote.length > 0 ? lote.map(i => i.id) : [0];
                const resResto = await this.executeQuery(`
                    SELECT *
                    FROM produtos
                    WHERE status != 'ENVIADO'
                      AND status != 'ERRO_IMG'
                      AND estoque > 0
                      AND id != ALL($1::int[])
                    LIMIT $2
                `, [idsExcluir, limit - lote.length]);

                lote.push(...resResto.rows);
            }

            return lote;
        } catch {
            return [];
        }
    }

    async resetarCatalogo() {
        await this.executeQuery(`
            UPDATE produtos
            SET status = '', prioridade = FALSE
            WHERE status IN ('ENVIADO', 'ERRO_IMG') OR status IS NULL
        `);
    }

    async marcarComoEnviado(sku) {
        await this.executeQuery(
            "UPDATE produtos SET status = 'ENVIADO', prioridade = FALSE WHERE sku = $1",
            [sku]
        );
    }

    async marcarErroImagem(sku) {
        await this.executeQuery(
            "UPDATE produtos SET status = 'ERRO_IMG' WHERE sku = $1",
            [sku]
        );
    }

    async getAllProducts() {
        try {
            const res = await this.executeQuery('SELECT * FROM produtos ORDER BY prioridade DESC, id ASC');
            return res.rows;
        } catch {
            return [];
        }
    }

    async resetarItem(sku) {
        await this.executeQuery("UPDATE produtos SET status = '' WHERE sku = $1", [sku]);
    }

    async togglePrioridade(sku) {
        await this.executeQuery("UPDATE produtos SET prioridade = NOT prioridade WHERE sku = $1", [sku]);
    }

    async getCollectionsList() {
        try {
            const res = await this.executeQuery(`
                SELECT DISTINCT colecao
                FROM produtos
                WHERE colecao IS NOT NULL
                  AND colecao != ''
                  AND length(colecao) > 1
                ORDER BY colecao ASC
            `);
            return res.rows.map(r => r.colecao);
        } catch {
            return [];
        }
    }

    // =========================================================
    // CRM — CLIENTES, PEDIDOS, PAGAMENTOS & COBRANCAS
    // =========================================================

    async initCRM() {
        await this.executeQuery(`
            CREATE TABLE IF NOT EXISTS clientes (
                id SERIAL PRIMARY KEY,
                nome TEXT NOT NULL,
                whatsapp TEXT UNIQUE NOT NULL,
                email TEXT,
                observacoes TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);
        await this.executeQuery(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);

        await this.executeQuery(`
            CREATE TABLE IF NOT EXISTS vendas (
                id SERIAL PRIMARY KEY,
                cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                produto_sku TEXT NOT NULL,
                produto_nome TEXT NOT NULL,
                valor TEXT,
                quantidade INTEGER DEFAULT 1,
                pago BOOLEAN DEFAULT FALSE,
                data_pagamento DATE,
                lembrete_enviado BOOLEAN DEFAULT FALSE,
                observacoes TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                tamanho TEXT,
                valor_unitario NUMERIC(12,2) DEFAULT 0,
                valor_total NUMERIC(12,2) DEFAULT 0,
                valor_pago NUMERIC(12,2) DEFAULT 0,
                valor_restante NUMERIC(12,2) DEFAULT 0,
                status_pagamento TEXT DEFAULT 'aberto',
                forma_pagamento TEXT,
                categoria TEXT,
                colecao TEXT,
                pagamento_observacao TEXT
            );
        `);

        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS tamanho TEXT;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS valor_unitario NUMERIC(12,2) DEFAULT 0;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS valor_total NUMERIC(12,2) DEFAULT 0;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS valor_pago NUMERIC(12,2) DEFAULT 0;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS valor_restante NUMERIC(12,2) DEFAULT 0;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS status_pagamento TEXT DEFAULT 'aberto';`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS forma_pagamento TEXT;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS categoria TEXT;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS colecao TEXT;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pagamento_observacao TEXT;`);
        await this.executeQuery(`ALTER TABLE vendas ADD COLUMN IF NOT EXISTS lembrete_enviado BOOLEAN DEFAULT FALSE;`);

        await this.executeQuery(`
            CREATE TABLE IF NOT EXISTS pagamentos (
                id SERIAL PRIMARY KEY,
                venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
                cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                valor NUMERIC(12,2) NOT NULL,
                forma_pagamento TEXT,
                observacoes TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await this.normalizeProductValues();
        await this.ensureVendasHydrated();

        console.log("   CRM: Tabelas clientes/vendas/pagamentos prontas.");
    }

    async refreshVendaFinanceiro(vendaId) {
        const vendaRes = await this.executeQuery(
            `SELECT valor_total FROM vendas WHERE id = $1`,
            [vendaId]
        );

        if (!vendaRes.rows.length) return null;

        const total = this.normalizeMoney(vendaRes.rows[0].valor_total);

        const pgRes = await this.executeQuery(
            `SELECT COALESCE(SUM(valor), 0) AS total_pago FROM pagamentos WHERE venda_id = $1`,
            [vendaId]
        );

        const totalPago = this.normalizeMoney(pgRes.rows[0].total_pago);
        const financeiro = this.derivePaymentStatus(total, totalPago);

        await this.executeQuery(
            `UPDATE vendas
             SET valor_pago = $1,
                 valor_restante = $2,
                 status_pagamento = $3,
                 pago = $4
             WHERE id = $5`,
            [financeiro.pago, financeiro.restante, financeiro.status, financeiro.status === 'pago', vendaId]
        );

        return financeiro;
    }

    async rehydrateVendaValores(vendaId) {
        const res = await this.executeQuery(`
            SELECT
                v.id,
                v.produto_sku,
                v.valor,
                v.quantidade,
                v.valor_unitario,
                v.valor_total,
                p.valor AS produto_valor
            FROM vendas v
            LEFT JOIN produtos p ON p.sku = v.produto_sku
            WHERE v.id = $1
        `, [vendaId]);

        const venda = res.rows[0];
        if (!venda) return null;

        const quantidade = Math.max(Number(venda.quantidade || 1), 1);
        let valorUnitario = this.normalizeMoney(venda.valor_unitario);
        let valorTotal = this.normalizeMoney(venda.valor_total);
        const valorLegado = this.normalizeMoney(venda.valor);
        const valorProdutoAtual = this.normalizeMoney(venda.produto_valor);

        const suspeito = (n) => seemsLegacyCentsBug(n);

        if (valorProdutoAtual > 0) {
            if (valorUnitario <= 0 || suspeito(valorUnitario)) {
                valorUnitario = valorProdutoAtual;
            }
            if (valorTotal <= 0 || suspeito(valorTotal) || suspeito(valorLegado)) {
                valorTotal = toFixedMoney(valorProdutoAtual * quantidade);
            }
        }

        if (valorUnitario <= 0 && valorLegado > 0) {
            valorUnitario = quantidade > 0 ? toFixedMoney(valorLegado / quantidade) : valorLegado;
        }

        if (valorTotal <= 0) {
            if (valorLegado > 0) {
                valorTotal = valorLegado;
            } else if (valorUnitario > 0) {
                valorTotal = toFixedMoney(valorUnitario * quantidade);
            }
        }

        if (valorUnitario <= 0 && valorTotal > 0) {
            valorUnitario = toFixedMoney(valorTotal / quantidade);
        }

        await this.executeQuery(
            `UPDATE vendas
             SET valor_unitario = $1,
                 valor_total = $2,
                 valor = $3
             WHERE id = $4`,
            [valorUnitario, valorTotal, String(valorTotal.toFixed(2)), vendaId]
        );

        return { valor_unitario: valorUnitario, valor_total: valorTotal, quantidade };
    }

    async rehydrateAllVendas() {
        const res = await this.executeQuery(`SELECT id FROM vendas ORDER BY id ASC`);

        for (const row of res.rows) {
            await this.rehydrateVendaValores(row.id);
            await this.refreshVendaFinanceiro(row.id);
        }

        return true;
    }

    async ensureVendasHydrated() {
        if (this.rehydrateDone) return true;
        if (!this.rehydratePromise) {
            this.rehydratePromise = (async () => {
                await this.rehydrateAllVendas();
                this.rehydrateDone = true;
                return true;
            })().finally(() => {
                this.rehydratePromise = null;
            });
        }
        return this.rehydratePromise;
    }

    async buildClienteResumo(clienteId) {
        const res = await this.executeQuery(`
            SELECT c.*,
                   COUNT(v.id) AS total_compras,
                   COALESCE(SUM(v.quantidade), 0) AS total_itens,
                   COALESCE(SUM(v.valor_pago), 0) AS valor_pago_total,
                   COALESCE(SUM(v.valor_restante), 0) AS valor_em_aberto,
                   COALESCE(AVG(NULLIF(v.valor_total, 0)), 0) AS ticket_medio,
                   COUNT(v.id) FILTER (WHERE v.status_pagamento IN ('aberto','parcial')) AS pendentes
            FROM clientes c
            LEFT JOIN vendas v ON v.cliente_id = c.id
            WHERE c.id = $1
            GROUP BY c.id
        `, [clienteId]);

        const cliente = res.rows[0] || null;
        if (!cliente) return null;

        const statusFinanceiro = Number(cliente.valor_em_aberto || 0) > 0
            ? (Number(cliente.valor_pago_total || 0) > 0 ? 'parcial' : 'aberto')
            : 'pago';

        return {
            cliente_id: cliente.id,
            nome: cliente.nome,
            whatsapp: cliente.whatsapp,
            email: cliente.email || '',
            observacoes: cliente.observacoes || '',
            total_pedidos: cliente.total_compras,
            total_itens: cliente.total_itens,
            valor_em_aberto: this.normalizeMoney(cliente.valor_em_aberto),
            valor_pago: this.normalizeMoney(cliente.valor_pago_total),
            ticket_medio: this.normalizeMoney(cliente.ticket_medio),
            status_financeiro: statusFinanceiro,
            created_at: cliente.created_at,
            updated_at: cliente.updated_at || cliente.created_at,
        };
    }

    async buildPreferenciaCliente(clienteId) {
        const res = await this.executeQuery(`
            SELECT
              COALESCE(string_agg(DISTINCT categoria, ', '), '') AS categorias,
              COALESCE(string_agg(DISTINCT colecao, ', '), '') AS colecoes,
              COALESCE(string_agg(DISTINCT tamanho, ', '), '') AS tamanhos,
              COALESCE(AVG(NULLIF(valor_total, 0)), 0) AS ticket_medio,
              MAX(created_at) AS ultima_compra_em
            FROM vendas
            WHERE cliente_id = $1
        `, [clienteId]);

        const row = res.rows[0] || {};
        const resumo = [];

        if (row.categorias) resumo.push(`Categorias: ${row.categorias}`);
        if (row.colecoes) resumo.push(`Coleções: ${row.colecoes}`);
        if (row.tamanhos) resumo.push(`Tamanhos: ${row.tamanhos}`);

        return {
            cliente_id: clienteId,
            categorias_favoritas: row.categorias || '',
            colecoes_favoritas: row.colecoes || '',
            banhos_favoritos: '',
            faixa_preco: this.normalizeMoney(row.ticket_medio),
            tamanhos_favoritos: row.tamanhos || '',
            ticket_medio: this.normalizeMoney(row.ticket_medio),
            ultima_compra_em: row.ultima_compra_em || '',
            resumo_ia: resumo.join(' | '),
            updated_at: new Date().toISOString(),
        };
    }

    // --- CLIENTES ---

    async createCliente(data) {
        const res = await this.executeQuery(
            `INSERT INTO clientes (nome, whatsapp, email, observacoes, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING *`,
            [data.nome, data.whatsapp, data.email || null, data.observacoes || null]
        );
        return res.rows[0];
    }

    async updateCliente(id, data) {
        await this.executeQuery(
            `UPDATE clientes
             SET nome = $1, whatsapp = $2, email = $3, observacoes = $4, updated_at = NOW()
             WHERE id = $5`,
            [data.nome, data.whatsapp, data.email || null, data.observacoes || null, id]
        );
    }

    async deleteCliente(id) {
        await this.executeQuery(`DELETE FROM clientes WHERE id = $1`, [id]);
    }

    async getAllClientes() {
        await this.ensureVendasHydrated();

        const res = await this.executeQuery(`
            SELECT c.*,
                   COUNT(v.id) AS total_compras,
                   COUNT(v.id) FILTER (WHERE v.status_pagamento IN ('aberto', 'parcial')) AS pendentes,
                   COALESCE(SUM(v.valor_pago), 0) AS valor_pago_total,
                   COALESCE(SUM(v.valor_restante), 0) AS valor_em_aberto,
                   COALESCE(AVG(NULLIF(v.valor_total, 0)), 0) AS ticket_medio
            FROM clientes c
            LEFT JOIN vendas v ON v.cliente_id = c.id
            GROUP BY c.id
            ORDER BY c.nome ASC
        `);

        return res.rows;
    }

    async getClienteById(id) {
        const res = await this.executeQuery(`SELECT * FROM clientes WHERE id = $1`, [id]);
        return res.rows[0] || null;
    }

    // --- VENDAS / PEDIDOS ---

    async createVenda(data) {
        const financeiro = this.derivePaymentStatus(data.valor_total, data.valor_pago);
        const quantidade = Math.max(Number(data.quantidade || 1), 1);
        const valorUnitario = quantidade > 0
            ? this.normalizeMoney(financeiro.total / quantidade)
            : this.normalizeMoney(financeiro.total);

        const res = await this.executeQuery(
            `INSERT INTO vendas (
                cliente_id, produto_sku, produto_nome, valor, quantidade, pago, data_pagamento, observacoes,
                tamanho, valor_unitario, valor_total, valor_pago, valor_restante, status_pagamento,
                forma_pagamento, categoria, colecao, pagamento_observacao
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            RETURNING *`,
            [
                data.cliente_id,
                data.produto_sku,
                data.produto_nome,
                String(financeiro.total),
                quantidade,
                financeiro.status === 'pago',
                data.data_pagamento || null,
                data.observacoes || null,
                data.tamanho || null,
                valorUnitario,
                financeiro.total,
                financeiro.pago,
                financeiro.restante,
                financeiro.status,
                data.forma_pagamento || null,
                data.categoria || null,
                data.colecao || null,
                data.pagamento_observacao || null
            ]
        );

        const venda = res.rows[0];

        if (financeiro.pago > 0) {
            await this.addPagamento({
                venda_id: venda.id,
                cliente_id: data.cliente_id,
                valor: financeiro.pago,
                forma_pagamento: data.forma_pagamento || null,
                observacoes: data.pagamento_observacao || 'Pagamento inicial'
            });
            await this.refreshVendaFinanceiro(venda.id);
        }

        const refreshed = await this.executeQuery(`SELECT * FROM vendas WHERE id = $1`, [venda.id]);
        return refreshed.rows[0];
    }

    async getVendasByCliente(clienteId) {
        const res = await this.executeQuery(
            `SELECT id FROM vendas WHERE cliente_id = $1 ORDER BY created_at DESC`,
            [clienteId]
        );

        for (const row of res.rows) {
            await this.rehydrateVendaValores(row.id);
            await this.refreshVendaFinanceiro(row.id);
        }

        const refreshed = await this.executeQuery(
            `SELECT * FROM vendas WHERE cliente_id = $1 ORDER BY created_at DESC`,
            [clienteId]
        );

        return refreshed.rows;
    }

    async getAllVendas() {
        await this.ensureVendasHydrated();

        const res = await this.executeQuery(`
            SELECT v.*, c.nome AS cliente_nome, c.whatsapp AS cliente_whatsapp
            FROM vendas v
            JOIN clientes c ON c.id = v.cliente_id
            ORDER BY v.created_at DESC
        `);

        return res.rows;
    }

    async updateVendaPago(id, pago) {
        const vendaRes = await this.executeQuery(`SELECT * FROM vendas WHERE id = $1`, [id]);
        const venda = vendaRes.rows[0];
        if (!venda) return;

        if (pago) {
            const restante = this.normalizeMoney(venda.valor_restante || venda.valor_total || venda.valor || 0);
            if (restante > 0) {
                await this.addPagamento({
                    venda_id: venda.id,
                    cliente_id: venda.cliente_id,
                    valor: restante,
                    forma_pagamento: venda.forma_pagamento || null,
                    observacoes: 'Quitação total'
                });
            }
        } else {
            await this.executeQuery(`DELETE FROM pagamentos WHERE venda_id = $1`, [id]);
        }

        await this.refreshVendaFinanceiro(id);
    }

    async updateVendaDataPagamento(id, data) {
        await this.executeQuery(
            `UPDATE vendas SET data_pagamento = $1, lembrete_enviado = FALSE WHERE id = $2`,
            [data, id]
        );
    }

    async updateVendaFinanceiro(id, data) {
        const vendaRes = await this.executeQuery(`SELECT * FROM vendas WHERE id = $1`, [id]);
        const venda = vendaRes.rows[0];
        if (!venda) return null;

        await this.executeQuery(`DELETE FROM pagamentos WHERE venda_id = $1`, [id]);

        const valorPago = this.normalizeMoney(data.valor_pago);
        if (valorPago > 0) {
            await this.addPagamento({
                venda_id: venda.id,
                cliente_id: venda.cliente_id,
                valor: valorPago,
                forma_pagamento: data.forma_pagamento || venda.forma_pagamento || null,
                observacoes: data.observacoes || 'Pagamento ajustado'
            });
        }

        await this.executeQuery(
            `UPDATE vendas
             SET forma_pagamento = $1,
                 data_pagamento = $2,
                 observacoes = COALESCE($3, observacoes)
             WHERE id = $4`,
            [
                data.forma_pagamento || venda.forma_pagamento || null,
                data.data_pagamento || venda.data_pagamento || null,
                data.observacoes || null,
                id
            ]
        );

        await this.refreshVendaFinanceiro(id);

        const refreshed = await this.executeQuery(`SELECT * FROM vendas WHERE id = $1`, [id]);
        return refreshed.rows[0] || null;
    }

    async deleteVenda(id) {
        await this.executeQuery(`DELETE FROM vendas WHERE id = $1`, [id]);
    }

    async decrementarEstoque(sku, qtd = 1) {
        await this.executeQuery(
            `UPDATE produtos SET estoque = GREATEST(estoque - $1, 0) WHERE sku = $2`,
            [qtd, sku]
        );
    }

    async addPagamento(data) {
        const valor = this.normalizeMoney(data.valor);
        if (valor <= 0) return null;

        const res = await this.executeQuery(
            `INSERT INTO pagamentos (venda_id, cliente_id, valor, forma_pagamento, observacoes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [data.venda_id, data.cliente_id, valor, data.forma_pagamento || null, data.observacoes || null]
        );

        return res.rows[0];
    }

    async getPagamentosByVenda(vendaId) {
        const res = await this.executeQuery(
            `SELECT * FROM pagamentos WHERE venda_id = $1 ORDER BY created_at ASC`,
            [vendaId]
        );
        return res.rows;
    }

    // --- COBRANÇAS ---

    async getCobrancasPendentes() {
        const res = await this.executeQuery(`
            SELECT v.id, v.produto_nome, v.valor_total AS valor, v.data_pagamento, v.observacoes,
                   c.nome AS cliente_nome, c.whatsapp
            FROM vendas v
            JOIN clientes c ON c.id = v.cliente_id
            WHERE v.status_pagamento IN ('aberto', 'parcial')
              AND v.data_pagamento IS NOT NULL
              AND v.data_pagamento <= CURRENT_DATE
              AND v.lembrete_enviado = FALSE
        `);

        return res.rows;
    }

    async marcarLembreteEnviado(vendaId) {
        await this.executeQuery(`UPDATE vendas SET lembrete_enviado = TRUE WHERE id = $1`, [vendaId]);
    }
}

export default new DatabaseService();