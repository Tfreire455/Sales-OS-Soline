// SUBSTITUA TODO O ARQUIVO migrar.js POR ESTE

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import pg from "pg";
import { config } from "./src/config/settings.js";

const pool = new pg.Pool({
	connectionString: config.DATABASE_URL,
	ssl: { rejectUnauthorized: false },
	max: Number(process.env.PG_POOL_MAX || 5),
	idleTimeoutMillis: 30000,
	connectionTimeoutMillis: 30000,
	keepAlive: true,
});

const normalize = (str) => {
	if (!str) return "";
	return str
		.toString()
		.trim()
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
};

export async function migrar() {
	console.log("🚀 Iniciando Sincronização BLINDADA (Planilha -> Banco)...");

	if (!config.DATABASE_URL) throw new Error("DATABASE_URL não configurada");
	if (!config.SHEET_ID) throw new Error("SHEET_ID não configurado");
	if (
		!config.GOOGLE_CREDS?.client_email ||
		!config.GOOGLE_CREDS?.private_key
	) {
		throw new Error("GOOGLE_CREDS incompleto");
	}

	let client;

	try {
		client = await pool.connect();

		console.log("🛠️ Verificando banco de dados...");
		await client.query(`
			CREATE TABLE IF NOT EXISTS produtos (
				id SERIAL PRIMARY KEY,
				nome TEXT NOT NULL,
				sku TEXT UNIQUE NOT NULL,
				valor TEXT,
				categoria TEXT,
				estoque INTEGER DEFAULT 0,
				image_url TEXT,
				reposicao BOOLEAN DEFAULT FALSE,
				colecao TEXT,
				status TEXT DEFAULT '',
				prioridade BOOLEAN DEFAULT FALSE
			);
		`);

		await client.query(`
			ALTER TABLE produtos
			ADD COLUMN IF NOT EXISTS prioridade BOOLEAN DEFAULT FALSE;
		`);

		await client.query(`
			ALTER TABLE produtos
			ADD COLUMN IF NOT EXISTS colecao TEXT;
		`);

		console.log("📊 Lendo Google Sheets...");
		const auth = new JWT({
			email: config.GOOGLE_CREDS.client_email,
			key: config.GOOGLE_CREDS.private_key,
			scopes: ["https://www.googleapis.com/auth/spreadsheets"],
		});

		const doc = new GoogleSpreadsheet(config.SHEET_ID, auth);
		await doc.loadInfo();

		const sheet = doc.sheetsByIndex[0];
		await sheet.loadHeaderRow();

		const headerValues = sheet.headerValues;
		const rows = await sheet.getRows();

		console.log(`📋 Cabeçalhos detectados: [${headerValues.join(", ")}]`);

		const findKey = (possiveisNomes) => {
			return headerValues.find((h) => possiveisNomes.includes(normalize(h)));
		};

		const keySKU = findKey(["sku", "codigo", "ref", "cod"]);
		const keyNome = findKey(["nome", "name", "produto", "titulo", "descricao"]);
		const keyValor = findKey(["valor", "preco", "price"]);
		const keyEstoque = findKey(["estoque", "qtd", "quantidade"]);
		const keyImg = findKey(["imagem", "foto", "image", "url", "link", "imageurl"]);
		const keyCat = findKey(["categoria", "category", "tipo"]);
		const keyRepo = findKey(["reposicao", "reposição", "repo"]);
		const keyCol = findKey(["colecao", "coleção", "collection", "campanha", "tema"]);

		if (!keySKU) {
			throw new Error("❌ Coluna SKU não encontrada na planilha!");
		}

		console.log(
			`✅ Mapeamento de Coleção: ${
				keyCol ? `Coluna encontrada: "${keyCol}"` : "❌ NÃO ENCONTRADA"
			}`,
		);

		const skusNaPlanilha = [];
		let inseridos = 0;
		let colecoesEncontradas = 0;

		await client.query("BEGIN");

		for (const row of rows) {
			const sku = row.get(keySKU);
			if (!sku) continue;

			skusNaPlanilha.push(sku);

			const nome = row.get(keyNome) || "Produto Sem Nome";
			const valor = row.get(keyValor);
			const estoque = parseInt(row.get(keyEstoque), 10) || 0;
			const img = row.get(keyImg);
			const cat = row.get(keyCat) || "Geral";

			const repoRaw = row.get(keyRepo);
			const repo = repoRaw
				? ["sim", "true", "1"].includes(String(repoRaw).trim().toLowerCase())
				: false;

			let col = null;
			if (keyCol) {
				const rawCol = row.get(keyCol);
				if (rawCol && typeof rawCol === "string" && rawCol.trim() !== "") {
					col = rawCol.trim();
					colecoesEncontradas++;
				}
			}

			await client.query(
				`
				INSERT INTO produtos (
					nome,
					sku,
					valor,
					categoria,
					estoque,
					image_url,
					reposicao,
					colecao
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				ON CONFLICT (sku) DO UPDATE SET
					nome = EXCLUDED.nome,
					estoque = EXCLUDED.estoque,
					valor = EXCLUDED.valor,
					categoria = EXCLUDED.categoria,
					reposicao = EXCLUDED.reposicao,
					colecao = EXCLUDED.colecao,
					image_url = EXCLUDED.image_url
				`,
				[nome, sku, valor, cat, estoque, img, repo, col],
			);

			inseridos++;
		}

		if (skusNaPlanilha.length > 0) {
			const resDelete = await client.query(
				`
				DELETE FROM produtos
				WHERE sku != ALL($1::text[])
				`,
				[skusNaPlanilha],
			);

			if (resDelete.rowCount > 0) {
				console.log(`🗑️ ${resDelete.rowCount} itens antigos removidos.`);
			}
		}

		await client.query("COMMIT");

		console.log("\n✨ SINCRONIZAÇÃO CONCLUÍDA!");
		console.log(`✅ Total Processado: ${inseridos}`);
		console.log(`💎 Produtos com Coleção Identificada: ${colecoesEncontradas}`);

		if (colecoesEncontradas === 0) {
			console.warn(
				"⚠️ ALERTA: Nenhuma coleção foi salva. Verifique se a coluna 'Coleção' está preenchida no Google Sheets.",
			);
		}

		return {
			success: true,
			totalProcessado: inseridos,
			colecoesEncontradas,
		};
	} catch (error) {
		if (client) {
			try {
				await client.query("ROLLBACK");
			} catch {}
		}

		console.error("\n❌ ERRO FATAL NA MIGRAÇÃO:", error);
		throw error;
	} finally {
		if (client) client.release();
		await pool.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	migrar().catch((error) => {
		console.error("\n❌ ERRO FATAL NA MIGRAÇÃO:", error);
		process.exitCode = 1;
	});
}