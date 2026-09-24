// Camada unica de WhatsApp: o resto do sistema chama estas funcoes e nao precisa saber
// se a barbearia usa a Evolution API v2 (Baileys) ou a Evolution GO (whatsmeow).
// O motor de cada barbearia e escolhido no /superadmin (tenants.whatsapp_provider).

const { db } = require('./db');
const evolution = require('./evolution');
const evogo = require('./evolution-go');
const crypto = require('crypto');

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

// Alguns contatos (conta Business, numero fixo, contas novas com LID) nao passam na checagem
// "numero existe no WhatsApp" do Evolution GO e o envio pelo telefone falha com
// "is not registered on WhatsApp". O webhook traz o LID do contato; guardamos para reenviar por ele.
const altJids = new Map(); // digitos do telefone -> "xxxx@lid"
function onlyDigits(value) {
  return String(value || '').split('@')[0].replace(/\D/g, '');
}
function rememberAltJid(phone, lid) {
  const digits = onlyDigits(phone);
  if (!digits || !lid || !String(lid).endsWith('@lid')) return;
  altJids.set(digits, lid);
  // mesmo numero com/sem o 9 (o sistema pode guardar o telefone com o 9 adicionado)
  if (digits.startsWith('55') && digits.length === 12) altJids.set(digits.slice(0, 4) + '9' + digits.slice(4), lid);
  if (digits.startsWith('55') && digits.length === 13 && digits[4] === '9') altJids.set(digits.slice(0, 4) + digits.slice(5), lid);
  if (altJids.size > 20000) altJids.delete(altJids.keys().next().value);
}
function altJidFor(number) {
  return altJids.get(onlyDigits(number)) || null;
}
function isNotRegisteredError(err) {
  return /not registered on WhatsApp/i.test(err?.message || '');
}

// Executa um envio no GO; se o numero "nao existe", tenta de novo pelo LID do contato
async function goSend(number, fn) {
  try {
    return await fn(number);
  } catch (err) {
    const lid = isNotRegisteredError(err) ? altJidFor(number) : null;
    if (!lid) throw err;
    console.warn(`[whatsapp] ${onlyDigits(number)} recusado pelo GO, reenviando pelo LID ${lid}`);
    return fn(lid);
  }
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
  return connectEvoGo(tenant, instance, instanceName, webhookUrl);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cria (ou recria) a instancia no GO e grava token/id no banco
async function createEvoGoInstance(tenantId, instanceName) {
  const created = await evogo.createInstance(instanceName);
  let externalId = created.id;
  if (!externalId) externalId = (await evogo.findByName(instanceName))?.id || null;
  db.prepare(`
    INSERT INTO whatsapp_instances (tenant_id, instance_name, status, provider, instance_token, external_id)
    VALUES (?, ?, 'connecting', 'evogo', ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET provider = 'evogo', instance_name = excluded.instance_name,
      instance_token = excluded.instance_token, external_id = excluded.external_id,
      status = 'connecting', updated_at = datetime('now')
  `).run(tenantId, instanceName, created.token, externalId);
  return getInstance(tenantId);
}

// Espera o GO gerar o QR (ou perceber que ja esta pareado). Le o QR pelo /instance/info,
// que so consulta o banco do GO e nao dispara um segundo cliente.
async function waitEvoGoQr(instance, maxMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await sleep(1500);
    try {
      const status = await evogo.getStatus(instance.instance_token);
      if (status === 'connected') return { qrcode_base64: null, status: 'connected' };
    } catch (_) { /* segue tentando */ }
    try {
      const qr = evogo.qrFromInfo(await evogo.getInfo(instance.external_id));
      if (qr) return { qrcode_base64: qr, status: 'connecting' };
    } catch (_) { /* segue tentando */ }
  }
  return null;
}

async function connectEvoGo(tenant, instance, instanceName, webhookUrl) {
  if (!instance || !instance.instance_token) {
    instance = await createEvoGoInstance(tenant.id, instanceName);
  }
  if (!instance.external_id) {
    const found = await evogo.findByName(instance.instance_name).catch(() => null);
    if (found) {
      db.prepare('UPDATE whatsapp_instances SET external_id = ? WHERE tenant_id = ?').run(found.id, tenant.id);
      instance = getInstance(tenant.id);
    }
  }

  await evogo.connect(instance.instance_token, webhookUrl);
  let result = instance.external_id ? await waitEvoGoQr(instance) : null;

  // Sem QR: a sessao no GO ficou travada (ex.: uma tentativa anterior falhou e o GO acha que o
  // cliente ainda esta rodando). Apaga a instancia la no GO e cria de novo, limpa.
  if (!result) {
    console.warn(`[whatsapp] GO sem QR para ${instanceName}, recriando a instância`);
    if (instance.external_id) await evogo.deleteInstance(instance.external_id).catch(err => console.error('[whatsapp] GO delete:', err.message));
    await sleep(1500);
    instance = await createEvoGoInstance(tenant.id, instanceName);
    await evogo.connect(instance.instance_token, webhookUrl);
    result = await waitEvoGoQr(instance, 20000);
  }

  if (!result) {
    throw new Error('o servidor Evolution GO não gerou o QR code. Veja o log do container do GO (erro de conexão com o WhatsApp ou proxy).');
  }

  setStatus(tenant.id, result.status);
  return result;
}

// QR atual (o GO troca o QR a cada ~20s; o painel busca de novo enquanto espera a leitura)
async function currentQr(instance) {
  if (normalizeProvider(instance.provider) !== 'evogo' || !instance.external_id) return null;
  return evogo.qrFromInfo(await evogo.getInfo(instance.external_id));
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
    const id = await goSend(number, to => evogo.sendText(instance.instance_token, to, text));
    rememberSentId(id);
    return id;
  }
  const data = await evolution.sendText(instance.instance_name, number, text);
  rememberSentId(data?.key?.id);
  return data?.key?.id || null;
}

// Recursos interativos de cada motor.
function supports(instance, kind) {
  if (kind === 'poll') return !!instance;
  return kind === 'buttons' || kind === 'list';
}

// Envia uma enquete e devolve o ID da mensagem (usado para ligar o voto a ela depois)
async function sendPoll(instance, number, { question, options, maxAnswer }) {
  let id;
  if (normalizeProvider(instance.provider) === 'evogo') {
    id = await goSend(number, to => evogo.sendPoll(instance.instance_token, to, { question, options, maxAnswer }));
  } else {
    const data = await evolution.sendPoll(instance.instance_name, number, { question, options, maxAnswer });
    id = data?.key?.id || null;
  }
  rememberSentId(id);
  return id;
}

// Traduz um voto (msg.pollVote do normalizeWebhook) para os textos das opcoes marcadas.
// options = textos exatos das opcoes da enquete enviada.
async function resolvePollVote(instance, pollVote, options) {
  // Evolution v2 ja entrega os nomes das opcoes marcadas
  if (Array.isArray(pollVote.names)) return pollVote.names.filter(n => options.includes(n));

  if (normalizeProvider(instance.provider) !== 'evogo') return null;

  // Evolution GO: grava o voto decifrado e expoe por /polls/:id/results com hashes SHA-256.
  // O voto e gravado em segundo plano, entao tentamos algumas vezes.
  const hashToOption = new Map(options.map(o => [crypto.createHash('sha256').update(o).digest('hex'), o]));
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 0 ? 800 : 1200));
    const results = await evogo.getPollResults(instance.instance_token, pollVote.pollId).catch(() => null);
    const votes = Array.isArray(results?.votes) ? results.votes : [];
    if (!votes.length) continue;
    const vote = votes.find(v => v.voteMessageId === pollVote.voteId) || votes[votes.length - 1];
    if (pollVote.voteId && vote.voteMessageId !== pollVote.voteId && attempt < 4) continue; // ainda nao gravou este voto
    return (vote.selectedOptions || []).map(h => hashToOption.get(String(h).toLowerCase())).filter(Boolean);
  }
  return null;
}

// Envia botoes/lista. Se o motor recusar (erro), manda o texto numerado no lugar,
// entao o cliente nunca fica sem as opcoes. Retorna 'interativo' ou 'texto'.
async function sendInteractive(instance, number, kind, payload, fallbackText) {
  const provider = normalizeProvider(instance.provider);
  try {
    if (!supports(instance, kind)) throw new Error(`${kind} não suportado neste motor`);
    let id = null;
    if (provider === 'evogo') {
      id = await goSend(number, to => kind === 'buttons'
        ? evogo.sendButtons(instance.instance_token, to, payload)
        : evogo.sendList(instance.instance_token, to, payload));
    } else {
      const data = kind === 'buttons'
        ? await evolution.sendButtons(instance.instance_name, number, payload)
        : await evolution.sendList(instance.instance_name, number, payload);
      id = data?.key?.id || null;
    }
    rememberSentId(id);
    console.log(`[whatsapp] ${kind} enviado para ${onlyDigits(number)} (id ${id || '?'})`);
    return 'interativo';
  } catch (err) {
    console.error(`[whatsapp] ${kind} falhou (${provider}), enviando texto:`, err.message);
    await sendText(instance, number, fallbackText);
    return 'texto';
  }
}

async function sendPresence(instance, number, delay = 1500) {
  try {
    if (normalizeProvider(instance.provider) === 'evogo') await evogo.sendPresence(instance.instance_token, altJidFor(number) || number, delay);
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

// Clique em botao / item de lista vira texto para a IA, com o id da opcao
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
    const goPhone = phoneFromJid(info.Sender) || phoneFromJid(chatId) || phoneFromJid(info.SenderAlt);
    const goLid = [info.SenderAlt, info.Sender, info.Chat].map(String).find(j => j.endsWith('@lid'));
    if (goPhone && goLid && !info.IsFromMe) rememberAltJid(goPhone, goLid.split(':')[0].replace(/\.\d+@/, '@'));
    return [{
      id: info.ID,
      chatId,
      isGroup: !!info.IsGroup || chatId.endsWith('@g.us'),
      fromMe: !!info.IsFromMe,
      senderPhone: goPhone,
      pushName: info.PushName || '',
      timestamp: info.Timestamp ? Math.floor(new Date(info.Timestamp).getTime() / 1000) : 0,
      text: textFromMessage(message).trim(),
      pollVote: message.pollUpdateMessage ? {
        pollId: message.pollUpdateMessage.pollCreationMessageKey?.ID || message.pollUpdateMessage.pollCreationMessageKey?.id || null,
        voteId: info.ID
      } : null,
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
    const v2Lid = [key.remoteJid, key.remoteJidAlt, key.senderLid].map(String).find(j => j.endsWith('@lid'));
    if (senderPhone && v2Lid && !key.fromMe) rememberAltJid(senderPhone, v2Lid);
    return {
      id: key.id,
      chatId: key.remoteJid,
      isGroup: key.remoteJid.endsWith('@g.us'),
      fromMe: !!key.fromMe,
      senderPhone,
      pushName: data.pushName || '',
      timestamp: Number(data.messageTimestamp || 0),
      text: textFromMessage(data.message).trim(),
      pollVote: data.message?.pollUpdateMessage ? {
        pollId: data.message.pollUpdateMessage.pollCreationMessageKey?.id || null,
        voteId: key.id,
        // A v2 ja troca os hashes pelos nomes das opcoes marcadas
        names: (data.message.pollUpdateMessage.vote?.selectedOptions || []).filter(o => typeof o === 'string')
      } : null,
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
  currentQr,
  disconnect,
  setWebhook,
  sendText,
  supports,
  sendInteractive,
  sendPoll,
  resolvePollVote,
  sendPresence,
  downloadAudio,
  normalizeWebhook,
  wasSentBySystem
};
