// Camada unica de WhatsApp: o resto do sistema chama estas funcoes e nao precisa saber
// se a barbearia usa a Evolution API v2 (Baileys) ou a Evolution GO (whatsmeow).
// O motor de cada barbearia e escolhido no /superadmin (tenants.whatsapp_provider).

const { db } = require('./db');
const evolution = require('./evolution');
const evogo = require('./evolution-go');

const PROVIDERS = {
  evolution: 'Evolution API v2',
  evogo: 'Evolution GO'
};

function normalizeProvider(value) {
  return value === 'evogo' ? 'evogo' : 'evolution';
}

function isConfigured(provider) {
  return normalizeProvider(provider) === 'evogo' ? evogo.isConfigured() : evolution.isConfigured();
}

function notConfiguredMessage(provider) {
  return normalizeProvider(provider) === 'evogo'
    ? 'Evolution GO não configurada no servidor. Peça para o suporte preencher EVOGO_API_URL e EVOGO_API_KEY.'
    : 'Evolution API não configurada no servidor. Peça para o suporte preencher EVOLUTION_API_URL e EVOLUTION_API_KEY.';
}

// IDs enviados pelo sistema (os dois motores) - usado para a IA saber quando o gestor respondeu na mao
const sentIds = new Map();
function rememberSentId(id) {
  if (!id) return;
  sentIds.set(id, Date.now());
  if (sentIds.size > 5000) {
    const limit = Date.now() - 6 * 60 * 60 * 1000;
    for (const [key, ts] of sentIds) if (ts < limit) sentIds.delete(key);
  }
}
function wasSentBySystem(id) {
  return !!id && (sentIds.has(id) || evolution.wasSentBySystem(id));
}

function getInstance(tenantId) {
  return db.prepare('SELECT * FROM whatsapp_instances WHERE tenant_id = ?').get(tenantId);
}

function setStatus(tenantId, status) {
  db.prepare("UPDATE whatsapp_instances SET status = ?, updated_at = datetime('now') WHERE tenant_id = ?").run(status, tenantId);
}

// Conecta (ou reconecta) o WhatsApp da barbearia. Retorna { qrcode_base64, status }.
async function connectTenant(tenant, webhookUrl) {
  const provider = normalizeProvider(tenant.whatsapp_provider);
  if (!isConfigured(provider)) throw new Error(notConfiguredMessage(provider));

  let instance = getInstance(tenant.id);

  // Barbearia trocou de motor no super admin: desliga a instancia antiga e comeca do zero
  if (instance && normalizeProvider(instance.provider) !== provider) {
    await disconnect(instance).catch(() => {});
    db.prepare('DELETE FROM whatsapp_instances WHERE tenant_id = ?').run(tenant.id);
    instance = null;
  }

  const instanceName = instance ? instance.instance_name : tenant.slug;

  if (provider === 'evolution') {
    let qrData;
    if (!instance) {
      const created = await evolution.createInstance(instanceName);
      db.prepare("INSERT INTO whatsapp_instances (tenant_id, instance_name, status, provider) VALUES (?, ?, 'connecting', 'evolution')")
        .run(tenant.id, instanceName);
      qrData = created?.qrcode || created;
    } else {
      qrData = await evolution.getQrCode(instanceName);
      setStatus(tenant.id, 'connecting');
    }
    if (webhookUrl) await evolution.setWebhook(instanceName, webhookUrl).catch(err => console.error('[whatsapp] webhook:', err.message));
    return { qrcode_base64: qrData?.base64 || qrData?.qrcode?.base64 || null, status: 'connecting' };
  }

  // Evolution GO
  if (!instance || !instance.instance_token) {
    const created = await evogo.createInstance(instanceName);
    db.prepare(`
      INSERT INTO whatsapp_instances (tenant_id, instance_name, status, provider, instance_token, external_id)
      VALUES (?, ?, 'connecting', 'evogo', ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET provider = 'evogo', instance_token = excluded.instance_token,
        external_id = excluded.external_id, status = 'connecting', updated_at = datetime('now')
    `).run(tenant.id, instanceName, created.token, created.id);
    instance = getInstance(tenant.id);
  }

  await evogo.connect(instance.instance_token, webhookUrl);

  try {
    const qr = await evogo.getQr(instance.instance_token);
    setStatus(tenant.id, 'connecting');
    return { qrcode_base64: qr, status: 'connecting' };
  } catch (err) {
    // Sessao ja pareada: nao existe QR, ja esta conectado
    if (/already logged in/i.test(err.message)) {
      setStatus(tenant.id, 'connected');
      return { qrcode_base64: null, status: 'connected' };
    }
    throw err;
  }
}

// Consulta o estado real no servidor do WhatsApp e atualiza o banco
async function refreshStatus(instance) {
  const provider = normalizeProvider(instance.provider);
  let status;
  if (provider === 'evogo') {
    status = instance.instance_token ? await evogo.getStatus(instance.instance_token) : 'disconnected';
  } else {
    const state = await evolution.getConnectionState(instance.instance_name);
    status = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';
  }
  setStatus(instance.tenant_id, status);
  return status;
}

async function disconnect(instance) {
  const provider = normalizeProvider(instance.provider);
  if (!isConfigured(provider)) return;
  if (provider === 'evogo') {
    if (instance.instance_token) await evogo.logout(instance.instance_token);
  } else {
    await evolution.logoutInstance(instance.instance_name);
  }
}

// Reaponta o webhook (usado quando o gestor liga a IA)
async function setWebhook(instance, webhookUrl) {
  const provider = normalizeProvider(instance.provider);
  if (provider === 'evogo') return evogo.connect(instance.instance_token, webhookUrl);
  return evolution.setWebhook(instance.instance_name, webhookUrl);
}

async function sendText(instance, number, text) {
  const provider = normalizeProvider(instance.provider);
  if (provider === 'evogo') {
    const id = await evogo.sendText(instance.instance_token, number, text);
    rememberSentId(id);
    return id;
  }
  const data = await evolution.sendText(instance.instance_name, number, text);
  rememberSentId(data?.key?.id);
  return data?.key?.id || null;
}

// Recursos interativos de cada motor. Carrossel so existe na Evolution GO.
function supports(instance, kind) {
  const provider = normalizeProvider(instance?.provider);
  if (kind === 'carousel') return provider === 'evogo';
  return kind === 'buttons' || kind === 'list';
}

// Envia botoes/lista/carrossel. Se o motor recusar (erro), manda o texto numerado no lugar,
// entao o cliente nunca fica sem as opcoes. Retorna 'interativo' ou 'texto'.
async function sendInteractive(instance, number, kind, payload, fallbackText) {
  const provider = normalizeProvider(instance.provider);
  try {
    if (!supports(instance, kind)) throw new Error(`${kind} não suportado neste motor`);
    let id = null;
    if (provider === 'evogo') {
      if (kind === 'buttons') id = await evogo.sendButtons(instance.instance_token, number, payload);
      else if (kind === 'list') id = await evogo.sendList(instance.instance_token, number, payload);
      else id = await evogo.sendCarousel(instance.instance_token, number, payload);
    } else {
      const data = kind === 'buttons'
        ? await evolution.sendButtons(instance.instance_name, number, payload)
        : await evolution.sendList(instance.instance_name, number, payload);
      id = data?.key?.id || null;
    }
    rememberSentId(id);
    return 'interativo';
  } catch (err) {
    console.error(`[whatsapp] ${kind} falhou (${provider}), enviando texto:`, err.message);
    await sendText(instance, number, fallbackText);
    return 'texto';
  }
}

async function sendPresence(instance, number, delay = 1500) {
  try {
    if (normalizeProvider(instance.provider) === 'evogo') await evogo.sendPresence(instance.instance_token, number, delay);
    else await evolution.sendPresence(instance.instance_name, number, 'composing', delay);
  } catch (_) { /* best-effort */ }
}

// Baixa o audio de uma mensagem normalizada (ver normalizeWebhook). Retorna { base64, mimetype }.
async function downloadAudio(instance, msg) {
  if (msg.audioInline?.base64) return msg.audioInline;
  if (msg.audioUrl) {
    const response = await fetch(msg.audioUrl);
    if (!response.ok) throw new Error(`falha ao baixar áudio (${response.status})`);
    return { base64: Buffer.from(await response.arrayBuffer()).toString('base64'), mimetype: msg.audioMimetype || 'audio/ogg' };
  }
  if (normalizeProvider(instance.provider) === 'evogo') {
    return evogo.downloadMedia(instance.instance_token, msg.rawMessage);
  }
  const media = await evolution.getBase64FromMediaMessage(instance.instance_name, msg.rawKey);
  return { base64: media?.base64 || null, mimetype: media?.mimetype || msg.audioMimetype || 'audio/ogg' };
}

// ==================== Webhook: converte os dois formatos em um so ====================

// Clique em botao / item de lista / card do carrossel vira texto para a IA, com o id da opcao
function choiceFromMessage(message) {
  if (!message) return null;
  const pick = (title, id) => (title || id) ? `[cliente tocou na opção] ${title || ''}${id ? ` (id: ${id})` : ''}`.trim() : null;

  const nf = message.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nf) {
    let params = {};
    try { params = JSON.parse(nf.paramsJSON || nf.paramsJson || '{}'); } catch { params = {}; }
    const choice = pick(params.display_text || params.title, params.id);
    if (choice) return choice;
  }
  if (message.templateButtonReplyMessage) {
    return pick(message.templateButtonReplyMessage.selectedDisplayText, message.templateButtonReplyMessage.selectedID || message.templateButtonReplyMessage.selectedId);
  }
  if (message.buttonsResponseMessage) {
    return pick(message.buttonsResponseMessage.selectedDisplayText, message.buttonsResponseMessage.selectedButtonID || message.buttonsResponseMessage.selectedButtonId);
  }
  if (message.listResponseMessage) {
    const reply = message.listResponseMessage.singleSelectReply || {};
    return pick(message.listResponseMessage.title, reply.selectedRowID || reply.selectedRowId);
  }
  return null;
}

function textFromMessage(message) {
  if (!message) return '';
  return choiceFromMessage(message)
    || message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || '';
}

function phoneFromJid(jid) {
  if (!jid || !/@s\.whatsapp\.net$/.test(jid)) return null;
  return jid.split('@')[0].split(':')[0];
}

// Retorna uma lista de mensagens no formato:
// { id, chatId, fromMe, senderPhone, pushName, timestamp (segundos), text,
//   hasAudio, audioMimetype, audioInline, audioUrl, rawKey, rawMessage }
function normalizeWebhook(provider, body) {
  const event = String(body?.event || '');

  if (normalizeProvider(provider) === 'evogo') {
    if (event !== 'Message') return [];
    const data = body.data || {};
    const info = data.Info || {};
    const message = data.Message || {};
    const audio = message.audioMessage;
    const chatId = String(info.Chat || '');
    return [{
      id: info.ID,
      chatId,
      isGroup: !!info.IsGroup || chatId.endsWith('@g.us'),
      fromMe: !!info.IsFromMe,
      senderPhone: phoneFromJid(info.Sender) || phoneFromJid(chatId) || phoneFromJid(info.SenderAlt),
      pushName: info.PushName || '',
      timestamp: info.Timestamp ? Math.floor(new Date(info.Timestamp).getTime() / 1000) : 0,
      text: textFromMessage(message).trim(),
      hasAudio: !!audio,
      audioMimetype: message.mimetype || audio?.mimetype || 'audio/ogg',
      audioInline: message.base64 ? { base64: message.base64, mimetype: message.mimetype || 'audio/ogg' } : null,
      audioUrl: message.mediaUrl || null,
      rawKey: null,
      rawMessage: audio ? { audioMessage: audio } : null
    }];
  }

  // Evolution API v2
  const ev = event.toLowerCase().replace('_', '.');
  if (ev !== 'messages.upsert') return [];
  const items = Array.isArray(body.data) ? body.data : [body.data];
  return items.filter(d => d?.key?.remoteJid).map(data => {
    const key = data.key;
    const audio = data.message?.audioMessage;
    const senderPhone = [key.remoteJid, key.remoteJidAlt, key.senderPn, data.senderPn, key.participantAlt]
      .map(phoneFromJid).find(Boolean) || null;
    return {
      id: key.id,
      chatId: key.remoteJid,
      isGroup: key.remoteJid.endsWith('@g.us'),
      fromMe: !!key.fromMe,
      senderPhone,
      pushName: data.pushName || '',
      timestamp: Number(data.messageTimestamp || 0),
      text: textFromMessage(data.message).trim(),
      hasAudio: !!audio,
      audioMimetype: audio?.mimetype || 'audio/ogg',
      audioInline: data.message?.base64 ? { base64: data.message.base64, mimetype: audio?.mimetype || 'audio/ogg' } : null,
      audioUrl: null,
      rawKey: key,
      rawMessage: null
    };
  });
}

module.exports = {
  PROVIDERS,
  normalizeProvider,
  isConfigured,
  notConfiguredMessage,
  getInstance,
  connectTenant,
  refreshStatus,
  disconnect,
  setWebhook,
  sendText,
  supports,
  sendInteractive,
  sendPresence,
  downloadAudio,
  normalizeWebhook,
  wasSentBySystem
};
