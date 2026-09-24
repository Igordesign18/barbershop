// Cliente para a Evolution GO (whatsmeow), testado contra as rotas da versao 0.7.x.
// .env: EVOGO_API_URL e EVOGO_API_KEY (GLOBAL_API_KEY do seu servidor Evolution GO).
//
// Diferencas importantes em relacao a Evolution API v2:
// - Criar/listar instancias usa a chave global; todo o resto usa o TOKEN da propria instancia
//   (header apikey = token da instancia). Por isso guardamos o token no banco.
// - O webhook e definido no /instance/connect (webhookUrl + subscribe).
// - As rotas nao levam o nome da instancia na URL: a instancia e identificada pelo token.

const crypto = require('crypto');

// TEMPORARIO: URL fixa como padrao. Se EVOGO_API_URL estiver no .env, ela tem prioridade.
const BASE_URL = (process.env.EVOGO_API_URL || 'https://projeto-evo-go.xtknqq.easypanel.host').replace(/\/$/, '');
// TEMPORARIO: chave global fixa como padrao. Se EVOGO_API_KEY estiver no .env, ela tem prioridade.
// Trocar/remover esta chave assim que possivel.
const GLOBAL_KEY = process.env.EVOGO_API_KEY || '5uGzzrmjgwuXWzg40jshPLhuUdajfWqG';

function isConfigured() {
  return Boolean(BASE_URL && GLOBAL_KEY);
}

async function goFetch(path, { method = 'GET', body, token } = {}) {
  if (!isConfigured()) {
    throw new Error('Evolution GO não configurada (defina EVOGO_API_URL e EVOGO_API_KEY no .env)');
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: token || GLOBAL_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000) // nunca deixa o painel travado esperando o GO
  }).catch(err => {
    throw new Error(err.name === 'TimeoutError' ? 'o servidor Evolution GO demorou demais para responder' : `não consegui acessar o servidor Evolution GO (${err.message})`);
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const message = (data && (data.error || data.message)) || `Evolution GO retornou ${response.status}`;
    const err = new Error(response.status === 503 ? 'Evolution GO sem licença ativa (ative no /manager do servidor GO)' : String(message));
    err.status = response.status;
    throw err;
  }

  return data?.data !== undefined ? data.data : data;
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Cria a instancia (ou reaproveita uma que ja exista com o mesmo nome) e devolve { id, token }
async function createInstance(name) {
  const token = newToken();
  try {
    const created = await goFetch('/instance/create', { method: 'POST', body: { name, token } });
    return { id: created?.id || null, token: created?.token || token };
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
    const all = await goFetch('/instance/all');
    const found = (Array.isArray(all) ? all : []).find(i => i.name === name);
    if (!found) throw err;
    return { id: found.id, token: found.token };
  }
}

// Liga a instancia (gera QR se ainda nao pareada) e ja registra o webhook
async function connect(token, webhookUrl) {
  return goFetch('/instance/connect', {
    method: 'POST',
    token,
    body: { webhookUrl: webhookUrl || '', subscribe: ['MESSAGE'], immediate: true }
  });
}

// Devolve o data URL da imagem do QR ("data:image/png;base64,...")
async function getQr(token) {
  const data = await goFetch('/instance/qr', { token });
  return data?.qrcode || null;
}

// 'connected' | 'connecting' | 'disconnected'
async function getStatus(token) {
  const data = await goFetch('/instance/status', { token });
  if (data?.LoggedIn || data?.loggedIn) return (data.Connected ?? data.connected) ? 'connected' : 'connecting';
  return (data?.Connected ?? data?.connected) ? 'connecting' : 'disconnected';
}

// Le a instancia direto do banco do GO (chave global), sem efeitos colaterais.
// Diferente de /instance/qr, que tenta iniciar um cliente novo se ainda nao houver um
// e pode brigar com o cliente que o /instance/connect acabou de iniciar.
async function getInfo(instanceId) {
  return goFetch(`/instance/info/${encodeURIComponent(instanceId)}`);
}

async function findByName(name) {
  const all = await goFetch('/instance/all');
  return (Array.isArray(all) ? all : []).find(i => i.name === name) || null;
}

// QR salvo pelo GO vem como "data:image/png;base64,...|codigo"
function qrFromInfo(info) {
  const raw = String(info?.qrcode || '');
  return raw ? raw.split('|')[0] : null;
}

async function logout(token) {
  return goFetch('/instance/logout', { method: 'DELETE', token });
}

async function deleteInstance(instanceId) {
  if (!instanceId) return null;
  return goFetch(`/instance/delete/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
}

// Retorna o ID da mensagem enviada
async function sendText(token, number, text) {
  const data = await goFetch('/send/text', { method: 'POST', token, body: { number, text } });
  return data?.Info?.ID || data?.info?.id || null;
}

// Botoes de resposta rapida (maximo 3 do tipo reply)
async function sendButtons(token, number, { title, text, footer, buttons }) {
  const data = await goFetch('/send/button', {
    method: 'POST',
    token,
    body: {
      number,
      title: title || ' ',
      description: text,
      footer: footer || ' ',
      buttons: buttons.map(b => ({ type: 'reply', displayText: b.text, id: b.id }))
    }
  });
  return data?.Info?.ID || null;
}

async function sendList(token, number, { title, text, footer, buttonText, sections }) {
  const data = await goFetch('/send/list', {
    method: 'POST',
    token,
    body: {
      number,
      title: title || 'Opções',
      description: text,
      buttonText: buttonText || 'Ver opções',
      footerText: footer || ' ',
      sections: sections.map(sec => ({
        title: sec.title || 'Opções',
        rows: sec.rows.map(r => ({ title: r.title, description: r.description || '', rowId: r.id }))
      }))
    }
  });
  return data?.Info?.ID || null;
}

// Carrossel: cards com foto, texto e botao de resposta. As imagens precisam ser URLs publicas
// (o servidor GO baixa a imagem para montar o card).
async function sendCarousel(token, number, { text, footer, cards }) {
  const data = await goFetch('/send/carousel', {
    method: 'POST',
    token,
    body: {
      number,
      body: text || '',
      footer: footer || '',
      cards: cards.map(c => ({
        header: { title: c.title || '', imageUrl: c.imageUrl },
        body: { text: c.body || c.title || ' ' },
        footer: c.footer || '',
        buttons: (c.buttons || []).map(b => ({ type: 'REPLY', displayText: b.text, id: b.id }))
      }))
    }
  });
  return data?.Info?.ID || null;
}

async function sendPresence(token, number, delay = 1500) {
  return goFetch('/message/presence', { method: 'POST', token, body: { number, state: 'composing', delay } });
}

// message: objeto "Message" que veio no webhook (com o audioMessage dentro)
async function downloadMedia(token, message) {
  const data = await goFetch('/message/downloadmedia', { method: 'POST', token, body: { message } });
  const dataUrl = String(data?.base64 || '');
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return { base64: dataUrl || null, mimetype: 'audio/ogg' };
  const mimetype = dataUrl.slice(5, comma).split(';')[0] || 'audio/ogg';
  return { base64: dataUrl.slice(comma + 1), mimetype };
}

module.exports = {
  isConfigured,
  createInstance,
  connect,
  getQr,
  getInfo,
  findByName,
  qrFromInfo,
  getStatus,
  logout,
  deleteInstance,
  sendText,
  sendButtons,
  sendList,
  sendCarousel,
  sendPresence,
  downloadMedia
};
