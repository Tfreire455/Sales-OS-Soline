<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:1C1C1C,100:FEE580&height=220&section=header&text=Soline%20Sales%20OS&fontSize=42&fontColor=FFFFFF&animation=fadeIn&fontAlignY=35" width="100%"/>

<br>

# 💎 Soline Sales OS

### Motor Autônomo de Vendas B2B e Orquestração para WhatsApp

<br>

<p>
  <img src="https://img.shields.io/badge/Node.js-0B0F1A?style=for-the-badge&logo=nodedotjs&logoColor=FEE580"/>
  <img src="https://img.shields.io/badge/Express.js-0B0F1A?style=for-the-badge&logo=express&logoColor=FEE580"/>
  <img src="https://img.shields.io/badge/PostgreSQL-0B0F1A?style=for-the-badge&logo=postgresql&logoColor=FEE580"/>
  <img src="https://img.shields.io/badge/Socket.IO-0B0F1A?style=for-the-badge&logo=socketdotio&logoColor=FEE580"/>
  <img src="https://img.shields.io/badge/WhatsApp-0B0F1A?style=for-the-badge&logo=whatsapp&logoColor=FEE580"/>
  <img src="https://img.shields.io/badge/OpenAI-0B0F1A?style=for-the-badge&logo=openai&logoColor=FEE580"/>
</p>

<br>

**Orquestrador B2B e Motor de Vendas Autônomo para WhatsApp.**  
Escala operações em grupos VIP com agendamento assíncrono, captura de leads (CRM) e copywriting gerado por IA.

<br>

---

</div>

<br>

## 🚀 O que é o Soline Sales OS

O **Soline Sales OS** é um sistema SaaS assíncrono projetado para resolver o gargalo operacional de lojistas que vendem em alto volume via **Grupos VIP de WhatsApp**.

Ele atua como um **funcionário digital 24/7**, responsável por:

> 📦 Organizar fila de produtos  
> ✍️ Gerar copy persuasiva com IA  
> 📤 Enviar campanhas automaticamente  
> 🔁 Manter consistência e ritmo de vendas  

**Sem esforço manual.**

<br>

## 🧩 Problema vs Solução

<table>
<tr>
<th align="center">❌ Processo Manual</th>
<th align="center">✅ Engenharia B2B</th>
</tr>
<tr>
<td>

&nbsp;&nbsp;⛔ Envio manual exaustivo  
&nbsp;&nbsp;⛔ Erros de preço e texto  
&nbsp;&nbsp;⛔ Alto tempo de tela  
&nbsp;&nbsp;⛔ Escala limitada  
&nbsp;&nbsp;⛔ Risco de banimento  
&nbsp;&nbsp;⛔ Sem métricas  

</td>
<td>

&nbsp;&nbsp;✅ Automação total  
&nbsp;&nbsp;✅ Dados sincronizados  
&nbsp;&nbsp;✅ Agendamento automático  
&nbsp;&nbsp;✅ Operação 24/7  
&nbsp;&nbsp;✅ Delays humanizados  
&nbsp;&nbsp;✅ Dashboard em tempo real  

</td>
</tr>
</table>

<br>

## ⚙️ Funcionalidades Principais

<br>

### ⏰ Agendador de Alta Precisão

Timer backend com conversão bidirecional de timezone:

```
Local → UTC → Local
```

> O bot inicia campanhas **exatamente** no horário programado.

<br>

### 🧠 Copywriting Dinâmico com IA

A IA analisa os atributos do produto e gera legendas únicas com gatilhos estratégicos:

| 📋 Dados de Entrada | 🎯 Gatilhos Gerados |
|:---:|:---:|
| Nome do produto | Escassez |
| Preço | Urgência |
| Coleção | Desejo |
| Estoque | Exclusividade |

<br>

### 🛡️ Resiliência de Rede

Sistema tolerante a falhas do WhatsApp:

```
retry automático → buffer em memória → fallback de mídia → prevenção de fetch failed
```

> Projetado para **zero downtime** em conexões instáveis.

<br>

### 📊 Modos Estratégicos

| Modo | Descrição |
|:---|:---|
| 🟢 **NORMAL** | Envio espaçado para manter engajamento orgânico |
| 🔴 **BLITZ** | Alta intensidade focada em favoritos ⭐ |
| 🟣 **COLEÇÃO** | Storytelling e curadoria por nicho |

<br>

### 👥 CRM e Captura de Leads

Landing page integrada com captura de **nome**, **telefone** e **aniversário**.

Cron automático envia:

> 🎟️ Cupons personalizados  
> 💬 Mensagens VIP  
> 🎄 Campanhas sazonais  

<br>

### ⚡ Dashboard em Tempo Real

Comunicação bidirecional via **Socket.IO**:

> 📝 Logs do motor &nbsp;•&nbsp; 📡 Status de campanha &nbsp;•&nbsp; 📱 QR WhatsApp &nbsp;•&nbsp; 📋 Fila de envio

<br>

## 🧠 Engenharia Avançada

<br>

<details>
<summary><b>🔒 Prevenção de Memory Leak</b></summary>
<br>

Engine reescrita para execução contínua de longa duração:

- Loop contínuo controlado  
- Tokens canceláveis  
- Zero recursão infinita  

> Executa **meses** sem degradação de performance.

</details>

<details>
<summary><b>🚫 Anti-Spam por Banco</b></summary>
<br>

Flags rígidas no PostgreSQL impedem duplicação:

```sql
msg_inicio_enviada  BOOLEAN DEFAULT FALSE
msg_fim_enviada     BOOLEAN DEFAULT FALSE
```

> Reinícios do servidor **não causam duplicação** de mensagens.

</details>

<details>
<summary><b>🌎 Fuso Horário Imune</b></summary>
<br>

Timezone fixada via `Intl.DateTimeFormat`:

```js
Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" })
```

Imune a divergências de VPS, banco e cliente.

</details>

<br>

---

<div align="center">

<br>

**Thiago Moabi — TM Dev**  
Arquiteto de sistemas e automações SaaS

<br>

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0B0F1A?style=for-the-badge&logo=linkedin&logoColor=FEE580)](https://www.linkedin.com/in/thiago-moabi-359885221/)
[![Portfólio](https://img.shields.io/badge/Portfólio-0B0F1A?style=for-the-badge&logo=googlechrome&logoColor=FEE580)](https://tmdev-one.vercel.app)

<br>

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:1C1C1C,100:FEE580&height=140&section=footer"/>

</div>
