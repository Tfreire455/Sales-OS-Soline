import OpenAI from 'openai';
import { config } from '../config/settings.js';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export const gerarCopyComIA = async (
  nome,
  preco,
  sku,
  estoque,
  isReposicao,
  nomeColecao,
  campaignConfig = null
) => {
  try {
    let instrucaoEspecial = '';

    let estiloTexto = 'Foque na elegância, brilho e luxo da peça.';

    if (campaignConfig) {
      estiloTexto = campaignConfig.PROMPT_STYLE;
      instrucaoEspecial += `\n⚠️ MODO DE CAMPANHA ATIVO: Estamos operando no modo "${campaignConfig.NOME}". O estilo do texto deve seguir estritamente: ${campaignConfig.PROMPT_STYLE}\n`;
    }

    if (isReposicao) {
      instrucaoEspecial += `
🔥 GATILHO DE RETORNO: Este é um produto de REPOSIÇÃO.
Obrigatório usar: "Voltou!", "Finalmente conseguimos reposição", "O queridinho está de volta".
`;
    }

    if (nomeColecao) {
      instrucaoEspecial += `
✨ GATILHO DE COLEÇÃO: Pertence à coleção "${nomeColecao}".
Valorize o design e o conceito da coleção.
`;
    }

    if (estoque === 1) {
      instrucaoEspecial += `
🚨 ESCASSEZ EXTREMA: Apenas 1 unidade (Peça Única).
Use: "Última chance", "Quem viu levou".
`;
    } else if (estoque <= 3) {
      instrucaoEspecial += `
⚠️ ESCASSEZ ALTA: Restam apenas ${estoque} unidades.
Crie urgência.
`;
    }

    const prompt = `
Atue como um copywriter de elite especializado em joias de luxo.
Objetivo: Criar uma legenda curta e persuasiva para WhatsApp (Máximo 3 linhas).

ESTILO DE ESCRITA: ${estiloTexto}

DADOS DO PRODUTO:
- Nome: "${nome}"
- Preço: ${preco}
- SKU: ${sku}

INSTRUÇÕES E GATILHOS:
${instrucaoEspecial}

DIRETRIZES GERAIS:
- Use emojis elegantes (✨, 💎, 💍, 🔥) ou de alerta (🚨, ⚡) conforme o estilo.
- NÃO use saudações (Olá, Bom dia).
- Texto limpo e direto.
`;

    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4o',
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('⚠️ Falha na OpenAI, usando fallback:', error.message);

    let prefixo = '';

    if (campaignConfig && campaignConfig.ID === 'BLITZ') {
      prefixo = '⚡ *OFERTA RELÂMPAGO!* ';
    } else if (isReposicao) {
      prefixo = '🔥 *VOLTOU!* ';
    }

    if (estoque === 1) prefixo += '🚨 *ÚLTIMA PEÇA!* ';

    return `${prefixo}✨ *${nome}*\n💎 Ref: ${sku}\n💰 ${preco}\n\n👇 Garanta o seu:`;
  }
};
