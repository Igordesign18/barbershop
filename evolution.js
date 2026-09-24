// Wrapper simples para a Evolution API (padrao self-hosted, v2).
// Configuravel via .env: EVOLUTION_API_URL e EVOLUTION_API_KEY (chave global do seu servidor Evolution).
// Documentacao de referencia: https://doc.evolution-api.com

const BASE_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const API_KEY = process.env.EVOLUTION_API_KEY || '';

function isConfigured() {
  return Boolean(BASE_URL && API_KEY);
}

async function evoFetch(path, options = {}) {
  if (!isConfigured()) {
    throw new Error('Evolution API não configurada (defina EVOLUTION_API_URL e EVOLUTION_API_KEY no .env)');
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: API_KEY,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const message = (data && (data.message || data.error)) || `Evolution API retornou ${response.status}`;
    const err = new Error(Array.isArray(message) ? message.join(', ') : message);
    err.status = response.status;
    throw err;
  }

  return data;
}

// Cria a instancia (uma por barbearia) e ja devolve o QR code para parear
async function createInstance(instanceName) {
  return evoFetch('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS'
    })
  });
}

// Pede um novo QR code para uma instancia que ja existe (ex: apos desconectar)
async function getQrCode(instanceName) {
  return evoFetch(`/instance/connect/${encodeURIComponent(instanceName)}`, { method: 'GET' });
}

// Estado atual da conexao: 'open' (conectado), 'connecting', 'close' (desconectado)
async function getConnectionState(instanceName) {
  const data = await evoFetch(`/instance/connectionState/${encodeURIComponent(instanceName)}`, { method: 'GET' });
  return data?.instance?.state || 'close';
}

async function logoutInstance(instanceName) {
  return evoFetch(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: 'DELETE' });
}

async function deleteInstance(instanceName) {
  return evoFetch(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: 'DELETE' });
}

// IDs das mensagens enviadas pelo proprio sistema (confirmacao, lembrete, IA).
// O atendente IA usa isso para diferenciar "mensagem que o sistema mandou" de
// "mensagem que o gestor digitou no celular" (quando o gestor assume o chat, a IA pausa).
const recentlySentIds = new Map(); // id -> timestamp
function rememberSentId(id) {
  if (!id) return;
  recentlySentIds.set(id, Date.now());
  if (recentlySentIds.size > 5000) {
    const limit = Date.now() - 6 * 60 * 60 * 1000;
    for (const [key, ts] of recentlySentIds) if (ts < limit) recentlySentIds.delete(key);
  }
}
function wasSentBySystem(id) {
  return !!id && recentlySentIds.has(id);
}

// numberDigitsOnly: numero com DDI, ex "5588999999999" (sem +, sem espacos)
async function sendText(instanceName, numberDigitsOnly, text) {
  const data = await evoFetch(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ number: numberDigitsOnly, text })
  });
  rememberSentId(data?.key?.id);
  return data;
}

// Botoes de resposta rapida (maximo 3). Na 2.3.7 com Baileys costuma dar erro 400;
// quem chama (wa-provider) cai automaticamente para texto numerado.
async function sendButtons(instanceName, number, { title, text, footer, buttons }) {
  const data = await evoFetch(`/message/sendButtons/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({
      number,
      title: title || '',
      description: text,
      footer: footer || '',
      buttons: buttons.map(b => ({ type: 'reply', displayText: b.text, id: b.id }))
    })
  });
  rememberSentId(data?.key?.id);
  return data;
}

async function sendList(instanceName, number, { title, text, footer, buttonText, sections }) {
  const data = await evoFetch(`/message/sendList/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({
      number,
      title: title || 'Opções',
      description: text,
      buttonText: buttonText || 'Ver opções',
      footerText: footer || ' ',
      sections: sections.map(sec => ({
        title: sec.title || 'Opções',
        rows: sec.rows.map(r => ({ title: r.title, description: r.description || '', rowId: r.id }))
      }))
    })
  });
  rememberSentId(data?.key?.id);
  return data;
}

// Enquete (recurso comum do WhatsApp, aparece em qualquer celular)
async function sendPoll(instanceName, number, { question, options, maxAnswer }) {
  const data = await evoFetch(`/message/sendPoll/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ number, name: question, selectableCount: maxAnswer || 1, values: options })
  });
  rememberSentId(data?.key?.id);
  return data;
}

// Mostra "digitando..." / "gravando..." pro cliente (best-effort, nunca quebra nada)
async function sendPresence(instanceName, numberDigitsOnly, presence = 'composing', delay = 1500) {
  try {
    await evoFetch(`/chat/sendPresence/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      body: JSON.stringify({ number: numberDigitsOnly, presence, delay })
    });
  } catch (_) { /* ignora */ }
}

// Configura o webhook da instancia (Evolution v2: corpo aninhado em "webhook")
async function setWebhook(instanceName, url) {
  return evoFetch(`/webhook/set/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url,
        webhookByEvents: false,
        webhookBase64: false,
        events: ['MESSAGES_UPSERT']
      }
    })
  });
}

// Baixa a midia (ex: audio) de uma mensagem recebida, em base64
async function getBase64FromMediaMessage(instanceName, messageKey) {
  return evoFetch(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ message: { key: messageKey }, convertToMp4: false })
  });
}

module.exports = {
  isConfigured,
  createInstance,
  getQrCode,
  getConnectionState,
  logoutInstance,
  deleteInstance,
  sendText,
  sendButtons,
  sendList,
  sendPoll,
  sendPresence,
  setWebhook,
  getBase64FromMediaMessage,
  wasSentBySystem
};
