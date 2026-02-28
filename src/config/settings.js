// ./config/settings.js
import "dotenv/config";

function getGoogleCredsFromEnv() {
  if (!process.env.GOOGLE_PRIVATE_KEY) return {};

  return {
    type: process.env.GOOGLE_TYPE || "service_account",
    project_id: process.env.GOOGLE_PROJECT_ID,
    private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    auth_uri: process.env.GOOGLE_AUTH_URI,
    token_uri: process.env.GOOGLE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_CERT_URL,
    client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL,
    universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
  };
}

export const config = {
  // WhatsApp
  GROUP_ID_REAL: process.env.GROUP_ID_REAL || '',
  GROUP_ID: process.env.GROUP_ID || '',
  SEU_NUMERO_ATENDIMENTO: process.env.SEU_NUMERO_ATENDIMENTO || '',

  // Banco
  DATABASE_URL: process.env.DATABASE_URL || '',

  // Admin
  NUMERO_ADMIN: process.env.NUMERO_ADMIN || '',

  DASHBOARD: {
    USER: process.env.DASHBOARD_USER || '',
    PASS: process.env.DASHBOARD_PASS || '',
    SESSION_SECRET:
      process.env.SESSION_SECRET ||
      process.env.DASHBOARD_SESSION_SECRET ||
      '',
  },

  // Google Sheets / Drive
  SHEET_ID: process.env.SHEET_ID || '',
  COLUNA_STATUS: process.env.COLUNA_STATUS || 'Status Bot',
  GOOGLE_CREDS: getGoogleCredsFromEnv(),

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

  // Controle do Bot
  ITENS_POR_VEZ: Number(process.env.ITENS_POR_VEZ || 3),

  MODES: {
    NORMAL: {
      ID: 'NORMAL',
      NOME: 'Modo Normal',
      DELAY_ENTRE_MSGS: { MIN: 15000, MAX: 30000 },
      INTERVALO_LOTE: 60,
      ITENS_LOTE: 3,
      PROMPT_STYLE:
        'Elegante, descritivo e luxuoso. Foque na qualidade da joia.',
    },
    BLITZ: {
      ID: 'BLITZ',
      NOME: '⚡ Blitz Relâmpago',
      DELAY_ENTRE_MSGS: { MIN: 5000, MAX: 10000 },
      INTERVALO_LOTE: 2,
      ITENS_LOTE: 1,
      PROMPT_STYLE:
        'URGENTE, Curto e Direto. Use CAPS LOCK em palavras chave. Foque em ESCASSEZ, OPORTUNIDADE ÚNICA e "QUEM VIU LEVOU".',
    },
    COLECAO: {
      ID: 'COLECAO',
      NOME: '💎 Desfile de Coleção',
      DELAY_ENTRE_MSGS: { MIN: 20000, MAX: 40000 },
      INTERVALO_LOTE: 30,
      ITENS_LOTE: 2,
      PROMPT_STYLE:
        'Storytelling envolvente. Não foque apenas em venda, foque em DESEJO, inspiração de look e sofisticação.',
    },
  },

  HORARIO: {
    INICIO: Number(process.env.HORARIO_INICIO || 8),
    FIM: Number(process.env.HORARIO_FIM || 20),
  },
};