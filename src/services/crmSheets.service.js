import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { config } from "../config/settings.js";

const DEFAULT_TABS = {
  clientes: "Clientes",
  pedidos: "Pedidos",
  itens: "ItensPedido",
  pagamentos: "Pagamentos",
  preferencias: "PreferenciasIA",
};

export class CRMSheetsService {
  constructor() {
    this.enabled = Boolean(config.SHEET_ID && config.GOOGLE_CREDS?.client_email && config.GOOGLE_CREDS?.private_key);
    this.doc = null;
    this.sheets = {};
  }

  get tabNames() {
    return { ...DEFAULT_TABS, ...(config.CRM_SHEET_TABS || {}) };
  }

  get headers() {
    return {
      [this.tabNames.clientes]: [
        "cliente_id","nome","whatsapp","email","observacoes","total_pedidos","total_itens","valor_em_aberto","valor_pago","ticket_medio","status_financeiro","created_at","updated_at"
      ],
      [this.tabNames.pedidos]: [
        "pedido_id","cliente_id","cliente_nome","cliente_whatsapp","produto_sku","produto_nome","categoria","colecao","tamanho","quantidade","valor_unitario","valor_total","valor_pago","valor_restante","status_pagamento","forma_pagamento","data_pagamento","observacoes","created_at","updated_at"
      ],
      [this.tabNames.itens]: [
        "item_id","pedido_id","cliente_id","produto_sku","produto_nome","categoria","colecao","tamanho","quantidade","valor_unitario","subtotal","estoque_apos_venda","created_at"
      ],
      [this.tabNames.pagamentos]: [
        "pagamento_id","pedido_id","cliente_id","valor_pago","forma_pagamento","descricao","created_at"
      ],
      [this.tabNames.preferencias]: [
        "cliente_id","categorias_favoritas","colecoes_favoritas","banhos_favoritos","faixa_preco","tamanhos_favoritos","ticket_medio","ultima_compra_em","resumo_ia","updated_at"
      ],
    };
  }

  async init() {
    if (!this.enabled) return false;
    if (this.doc) return true;
    const auth = new JWT({
      email: config.GOOGLE_CREDS.client_email,
      key: config.GOOGLE_CREDS.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.doc = new GoogleSpreadsheet(config.SHEET_ID, auth);
    await this.doc.loadInfo();
    await this.ensureSheets();
    return true;
  }

  async ensureSheets() {
    const wanted = this.headers;
    for (const [title, headerValues] of Object.entries(wanted)) {
      let sheet = this.doc.sheetsByTitle[title];
      if (!sheet) {
        sheet = await this.doc.addSheet({ title, headerValues, gridProperties: { rowCount: 2000, columnCount: headerValues.length + 2 } });
      } else {
        await sheet.loadHeaderRow();
        const current = sheet.headerValues || [];
        const same = current.length === headerValues.length && current.every((v, i) => v === headerValues[i]);
        if (!same) await sheet.setHeaderRow(headerValues);
      }
      this.sheets[title] = sheet;
    }
  }

  async getSheet(title) {
    await this.init();
    const sheet = this.sheets[title] || this.doc.sheetsByTitle[title];
    if (!sheet) throw new Error(`Aba não encontrada: ${title}`);
    await sheet.loadHeaderRow();
    return sheet;
  }

  normalizeValue(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  async upsertRow(title, keyField, data) {
    if (!this.enabled) return;
    const sheet = await this.getSheet(title);
    const rows = await sheet.getRows();
    const match = rows.find((row) => String(row.get(keyField)) === String(data[keyField]));
    if (match) {
      Object.entries(data).forEach(([key, value]) => match.set(key, this.normalizeValue(value)));
      await match.save();
      return;
    }
    const payload = {};
    (sheet.headerValues || []).forEach((header) => {
      payload[header] = this.normalizeValue(data[header]);
    });
    await sheet.addRow(payload);
  }

  async deleteRow(title, keyField, idValue) {
    if (!this.enabled) return;
    const sheet = await this.getSheet(title);
    const rows = await sheet.getRows();
    const row = rows.find((r) => String(r.get(keyField)) === String(idValue));
    if (row) await row.delete();
  }

  async upsertCliente(clienteResumo) {
    return this.upsertRow(this.tabNames.clientes, "cliente_id", clienteResumo);
  }

  async deleteCliente(clienteId) {
    await this.deleteRow(this.tabNames.clientes, "cliente_id", clienteId);
  }

  async upsertPedido(pedido) {
    return this.upsertRow(this.tabNames.pedidos, "pedido_id", pedido);
  }

  async deletePedido(pedidoId) {
    await this.deleteRow(this.tabNames.pedidos, "pedido_id", pedidoId);
  }

  async upsertItem(item) {
    return this.upsertRow(this.tabNames.itens, "item_id", item);
  }

  async deleteItem(itemId) {
    await this.deleteRow(this.tabNames.itens, "item_id", itemId);
  }

  async upsertPagamento(pagamento) {
    return this.upsertRow(this.tabNames.pagamentos, "pagamento_id", pagamento);
  }

  async deletePagamento(pagamentoId) {
    await this.deleteRow(this.tabNames.pagamentos, "pagamento_id", pagamentoId);
  }

  async upsertPreferencia(pref) {
    return this.upsertRow(this.tabNames.preferencias, "cliente_id", pref);
  }
}
