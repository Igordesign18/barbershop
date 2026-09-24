// Cliente para a WuzAPI (github.com/asternic/wuzapi), escrito a partir do API.md e do codigo-fonte.
// .env: WUZAPI_URL (ex: https://wuzapi.seudominio.com) e WUZAPI_ADMIN_TOKEN (o mesmo do .env da WuzAPI).
//
// Como a WuzAPI funciona:
// - Cada barbearia e um "usuario" da WuzAPI, criado com o token de admin (header Authorization).
// - Todas as outras rotas usam o token do proprio usuario (header "token"). Guardamos esse token no banco.
// - Respostas vem no envelope { code, data, success }.
// - O webhook pode chegar como JSON ou como formulario (jsonData=...), conforme WEBHOOK_FORMAT da WuzAPI.

const crypto = require('crypto');

// TEMPORARIO: URL fixa como padrao (a pagina /api e so a documentacao; a API fica na raiz).
// Se WUZAPI_URL estiver no .env, ela tem prioridade.
const BASE_URL = (process.env.WUZAPI_URL || 'https://projeto-wuazapi.xtknqq.easypanel.host').replace(/\/$/, '').replace(/\/api$/, '');
// TEMPORARIO: token de admin fixo como padrao (e o valor de exemplo da WuzAPI: TROCAR o quanto antes).
// Se WUZAPI_ADMIN_TOKEN estiver no .env, ele tem prioridade.
const ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN || '1234ABCD';

function isConfigured() {
  return Boolean(BASE_URL && ADMIN_TOKEN);
}

async function wzFetch(path, { method = 'GET', body, token, admin = false } = {}) {
  if (!isConfigured()) {
    throw new Error('WuzAPI não configurada (defina WUZAPI_URL e WUZAPI_ADMIN_TOKEN no .env)');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers.Authorization = ADMIN_TOKEN;
  else headers.token = token;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  }).catch(err => {
    throw new Error(err.name === 'TimeoutError' ? 'a WuzAPI demorou demais para responder' : `não consegui acessar a WuzAPI (${err.message})`);
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok || (data && data.success === false)) {
    const message = (data && (data.error || data.message)) || `WuzAPI retornou ${response.status}`;
    const err = new Error(String(message));
    err.status = response.status;
    throw err;
  }

  return data && Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data;
}

// ==================== Usuarios (admin) ====================

async function listUsers() {
  const data = await wzFetch('/admin/users', { admin: true });
  return Array.isArray(data) ? data : [];
}

// Cria o usuario da barbearia (ou reaproveita um existente com o mesmo nome). Retorna { id, token }.
async function createUser(name) {
  const existing = (await listUsers().catch(() => [])).find(u => u.name === name);
  if (existing) return { id: existing.id, token: existing.token };

  const token = crypto.randomBytes(24).toString('hex');
  const created = await wzFetch('/admin/users', { method: 'POST', admin: true, body: { name, token, events: 'Message' } });
  let id = created?.id ?? null;
  if (id === null) id = (await listUsers().catch(() => [])).find(u => u.name === name)?.id ?? null;
  return { id, token };
}

async function deleteUser(id) {
  if (id === null || id === undefined || id === '') return null;
  return wzFetch(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true });
}

// ==================== Sessao ====================

// Define o webhook e conecta (gera QR se ainda nao estiver pareado)
async function connect(token, webhookUrl) {
  if (webhookUrl) {
    await wzFetch('/webhook', { method: 'POST', token, body: { webhookurl: webhookUrl, events: ['Message'] } });
  }
  try {
    await wzFetch('/session/connect', { method: 'POST', token, body: { Subscribe: ['Message'], Immediate: true } });
  } catch (err) {
    if (!/already connected/i.test(err.message)) throw err;
  }
}

async function setWebhook(token, webhookUrl) {
  return wzFetch('/webhook', { method: 'POST', token, body: { webhookurl: webhookUrl, events: ['Message'] } });
}

// Data URL da imagem do QR, ou null se ainda nao foi gerado
async function getQr(token) {
  const data = await wzFetch('/session/qr', { token });
  const qr = data?.QRCode || data?.qrcode || '';
  return qr || null;
}

// 'connected' | 'connecting' | 'disconnected'
async function getStatus(token) {
  const data = await wzFetch('/session/status', { token });
  const loggedIn = data?.loggedIn ?? data?.LoggedIn;
  const connected = data?.connected ?? data?.Connected;
  if (loggedIn) return connected ? 'connected' : 'connecting';
  return connected ? 'connecting' : 'disconnected';
}

async function logout(token) {
  return wzFetch('/session/logout', { method: 'POST', token });
}

// ==================== Envio ====================

async function sendText(token, phone, text) {
  const data = await wzFetch('/chat/send/text', { method: 'POST', token, body: { Phone: phone, Body: text } });
  return data?.Id || null;
}

// Confere quais numeros existem no WhatsApp e o JID certo de cada um
// (ex: celular cadastrado com o 9 extra, mas registrado no WhatsApp sem ele)
async function checkUsers(token, phones) {
  const data = await wzFetch('/user/check', { method: 'POST', token, body: { Phone: phones } });
  return Array.isArray(data?.Users) ? data.Users : [];
}

// image (opcional): data URL ("data:image/jpeg;base64,...") ou URL http(s) publica; vira a foto no topo
async function sendButtons(token, phone, { text, footer, buttons, image }) {
  const data = await wzFetch('/chat/send/buttons', {
    method: 'POST',
    token,
    body: {
      Phone: phone,
      Body: text,
      Footer: footer && footer.trim() ? footer : undefined,
      Image: image || undefined,
      Buttons: buttons.map(b => ({ type: 'reply', title: b.text, id: b.id }))
    }
  });
  return data?.Id || null;
}

async function sendList(token, phone, { title, text, footer, buttonText, sections }) {
  const data = await wzFetch('/chat/send/list', {
    method: 'POST',
    token,
    body: {
      Phone: phone,
      TopText: title || undefined,
      Desc: text,
      FooterText: footer && footer.trim() ? footer : undefined,
      ButtonText: buttonText || 'Ver opções',
      Sections: sections.map(sec => ({
        title: sec.title || 'Opções',
        rows: sec.rows.map(r => ({ title: r.title, desc: r.description || '', RowId: r.id }))
      }))
    }
  });
  return data?.Id || null;
}

// Enquete. Na WuzAPI a enquete e sempre de escolha unica.
async function sendPoll(token, phone, { question, options }) {
  const data = await wzFetch('/chat/send/poll', { method: 'POST', token, body: { group: phone, header: question, options } });
  return data?.Id || null;
}

async function sendPresence(token, phone) {
  return wzFetch('/chat/presence', { method: 'POST', token, body: { Phone: phone, State: 'composing', Media: '' } });
}

// audio = objeto audioMessage que veio no webhook
async function downloadAudio(token, audio) {
  const data = await wzFetch('/chat/downloadaudio', {
    method: 'POST',
    token,
    body: {
      Url: audio.URL || audio.url,
      DirectPath: audio.directPath,
      MediaKey: audio.mediaKey,
      Mimetype: audio.mimetype,
      FileEncSHA256: audio.fileEncSHA256,
      FileSHA256: audio.fileSHA256,
      FileLength: Number(audio.fileLength || 0)
    }
  });
  const dataUrl = String(data?.Data || '');
  const comma = dataUrl.indexOf(',');
  return {
    base64: comma === -1 ? dataUrl || null : dataUrl.slice(comma + 1),
    mimetype: data?.Mimetype || audio.mimetype || 'audio/ogg'
  };
}

module.exports = {
  isConfigured,
  createUser,
  deleteUser,
  connect,
  setWebhook,
  getQr,
  getStatus,
  logout,
  checkUsers,
  sendText,
  sendButtons,
  sendList,
  sendPoll,
  sendPresence,
  downloadAudio
};
