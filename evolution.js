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

// numberDigitsOnly: numero com DDI, ex "5588999999999" (sem +, sem espacos)
async function sendText(instanceName, numberDigitsOnly, text) {
  return evoFetch(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ number: numberDigitsOnly, text })
  });
}

module.exports = {
  isConfigured,
  createInstance,
  getQrCode,
  getConnectionState,
  logoutInstance,
  deleteInstance,
  sendText
};
