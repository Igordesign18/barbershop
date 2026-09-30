// Avisos de agendamento no WhatsApp do GESTOR de cada barbearia.
// Um numero central do sistema (conectado pelo super admin, via WuzAPI) avisa o dono da
// barbearia sempre que um cliente agenda, cancela, reagenda ou confirma presenca.
// Nunca atrasa nem quebra o agendamento: tudo roda em segundo plano e erros so vao pro log.

const { db } = require('./db');
const wuzapi = require('./wuzapi');
const { getSystemSetting, setSystemSetting } = require('./system-settings');

const USER_NAME = 'barbersync-notificacoes';
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function isUnauthorized(e) {
  return e && (e.status === 401 || /unauthorized/i.test(e.message || ''));
}

function token() {
  return getSystemSetting('notify_wuz_token');
}

// ==================== Conexao (super admin) ====================

async function status() {
  const t = token();
  let state = 'disconnected';
  if (t) {
    try { state = await wuzapi.getStatus(t); }
    catch (e) {
      if (isUnauthorized(e)) { setSystemSetting('notify_wuz_token', ''); state = 'disconnected'; }
      else state = 'erro: ' + e.message;
    }
  }
  return { wuzapi_configured: wuzapi.isConfigured(), has_user: !!t, status: state };
}

async function connect() {
  if (!wuzapi.isConfigured()) throw new Error('WuzAPI não configurada no servidor (WUZAPI_URL / WUZAPI_ADMIN_TOKEN)');
  let t = token();
  // Token salvo mas recusado pela WuzAPI (ex: WuzAPI reinstalada/resetada): descarta e recria o usuario
  if (t) {
    try { await wuzapi.getStatus(t); }
    catch (e) {
      if (e.status === 401 || /unauthorized/i.test(e.message)) { setSystemSetting('notify_wuz_token', ''); t = null; }
    }
  }
  if (!t) {
    const created = await wuzapi.createUser(USER_NAME);
    t = created.token;
    setSystemSetting('notify_wuz_token', t);
  }
  // So envia avisos: nao precisa de webhook
  await wuzapi.connect(t, null);
  const started = Date.now();
  while (Date.now() - started < 20000) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      if (await wuzapi.getStatus(t) === 'connected') { webhookDone = null; ensureWebhook(); return { status: 'connected', qr: null }; }
    } catch (_) {}
    try {
      const qr = await wuzapi.getQr(t);
      if (qr) return { status: 'connecting', qr };
    } catch (e) {
      if (/logged in/i.test(e.message)) { webhookDone = null; ensureWebhook(); return { status: 'connected', qr: null }; }
    }
  }
  throw new Error('A WuzAPI não gerou o QR Code. Tente de novo em alguns segundos.');
}

async function currentQr() {
  const t = token();
  if (!t) return { status: 'disconnected', qr: null };
  let st = 'disconnected';
  try { st = await wuzapi.getStatus(t); } catch (_) {}
  if (st === 'connected') return { status: st, qr: null };
  return { status: st, qr: await wuzapi.getQr(t).catch(() => null) };
}

// Desconecta e APAGA o usuario na WuzAPI + o token salvo: reconectar cria tudo do zero.
async function disconnect() {
  const t = token();
  if (t) await wuzapi.logout(t).catch(() => {});
  try {
    await wuzapi.deleteUserBy({ token: t, name: USER_NAME });
  } catch (err) {
    console.error('[gestor-notify] não consegui apagar o usuário na WuzAPI:', err.message);
    return; // mantem o token salvo para poder tentar de novo
  }
  setSystemSetting('notify_wuz_token', '');
}

// ==================== Envio ====================

function digits55(phone) {
  const n = String(phone || '').replace(/\D/g, '');
  if (!n) return '';
  return n.startsWith('55') ? n : `55${n}`;
}

// Celular com e sem o 9 depois do DDD (contas antigas de WhatsApp ficaram sem o 9)
function variants(n) {
  const list = [n];
  if (n.startsWith('55') && n.length === 13 && n[4] === '9') list.push(n.slice(0, 4) + n.slice(5));
  if (n.startsWith('55') && n.length === 12 && /[6-9]/.test(n[4])) list.push(n.slice(0, 4) + '9' + n.slice(4));
  return list;
}

const resolved = new Map(); // numero -> { to, at }

async function sendTo(phone, text, buttons = null, list = null) {
  const t = token();
  if (!t) throw new Error('WhatsApp de notificações não conectado no super admin');
  const n = digits55(phone);
  if (n.length < 12) throw new Error('Telefone do gestor inválido');

  try { return await sendToInner(t, n, text, buttons, list); }
  catch (err) {
    if (!isUnauthorized(err)) throw err;
    setSystemSetting('notify_wuz_token', '');
    throw new Error('O WhatsApp de avisos do sistema está desconectado (sessão inválida). No Super Admin, clique em Conectar e escaneie o QR Code de novo.');
  }
}

async function sendToInner(t, n, text, buttons = null, list = null) {
  // buttons: { footer, buttons: [{ text, url | id }] }. Se o WhatsApp recusar os botoes, cai para texto puro.
  const doSend = async (to) => {
    if (list && process.env.NOTIFY_BUTTONS !== 'off') {
      try { return await wuzapi.sendList(t, to, list); }
      catch (err) {
        if (isUnauthorized(err) || /no LID found|not (registered|on whatsapp)|not found|invalid/i.test(err.message)) throw err;
        console.error('[aviso] lista recusada, enviando texto:', err.message);
        return wuzapi.sendText(t, to, list.fallbackText || text);
      }
    }
    if (buttons && process.env.NOTIFY_BUTTONS !== 'off') {
      try { return await wuzapi.sendButtons(t, to, { text, footer: buttons.footer, buttons: buttons.buttons }); }
      catch (err) {
        if (isUnauthorized(err) || /no LID found|not (registered|on whatsapp)|not found|invalid/i.test(err.message)) throw err;
        console.error('[aviso] botões recusados, enviando texto:', err.message);
        return wuzapi.sendText(t, to, buttons.fallbackText || text);
      }
    }
    return wuzapi.sendText(t, to, text);
  };
  const known = resolved.get(n);
  const first = known && Date.now() - known.at < 24 * 3600 * 1000 && known.to ? known.to : n;
  try {
    return await doSend(first);
  } catch (err) {
    if (!/no LID found|not (registered|on whatsapp)|not found|invalid/i.test(err.message)) throw err;
    // Numero em formato diferente do registrado no WhatsApp: confere com/sem 9 e reenvia
    const users = await wuzapi.checkUsers(t, variants(n)).catch(() => []);
    const found = users.find(u => u.IsInWhatsapp || u.isInWhatsapp);
    if (!found) throw new Error(`o número ${n} não tem WhatsApp`);
    const to = String(found.JID || found.jid || found.Query).split('@')[0];
    resolved.set(n, { to, at: Date.now() });
    return doSend(to);
  }
}

// ==================== Mensagens ====================

function formatPhone(p) {
  const n = String(p || '').replace(/\D/g, '');
  const local = n.startsWith('55') ? n.slice(2) : n;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return n || '-';
}

function formatDate(date) {
  const d = new Date(String(date) + 'T12:00:00Z');
  if (isNaN(d)) return String(date || '-');
  const [y, m, day] = String(date).split('-');
  return `${WEEKDAYS[d.getUTCDay()]}, ${day}/${m}/${y}`;
}

function brl(v) {
  return (Number(v) || 0).toFixed(2).replace('.', ',');
}

const ORIGINS = {
  link: '🔗 Link de agendamento',
  whatsapp_ia: '🤖 IA no WhatsApp'
};

function bookingDetails(bookingId) {
  return db.prepare(`
    SELECT b.*, COALESCE(b.item_name, s.name, p.name) AS servico, br.name AS profissional,
      COALESCE(b.item_duration, s.duration, 30) AS duracao,
      COALESCE(b.item_price, s.price, 0) AS preco
    FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id
    LEFT JOIN packages p ON p.id = b.package_id
    LEFT JOIN barbers br ON br.id = b.barber_id
    WHERE b.id = ?
  `).get(bookingId);
}

const TITLES = {
  novo: '📅 *Novo agendamento!*',
  cancelado: '❌ *Agendamento cancelado pelo cliente*',
  reagendado: '🔄 *Agendamento reagendado pelo cliente*',
  confirmado: '✅ *Cliente confirmou presença*',
  cancelado_gestor: '❌ *Cancelamento confirmado*',
  avaliacao_baixa: '⚠️ *Avaliação baixa recebida*'
};

function buildMessage(tenant, b, kind, extra = {}) {
  const valor = Math.max(0, Number(b.preco) - Number(b.discount_applied || 0));
  const lines = [
    TITLES[kind] || TITLES.novo,
    `_${tenant.name}_`,
    '',
    `👤 *Cliente:* ${b.customer_full_name || '-'}`,
    `📱 *WhatsApp:* ${formatPhone(b.customer_phone)}`,
    `✂️ *Serviço:* ${b.servico || '-'}`,
    `💈 *Profissional:* ${b.profissional || 'Qualquer um'}`
  ];
  if (kind === 'reagendado' && extra.oldDate) {
    lines.push(`🗓️ *Antes:* ~${formatDate(extra.oldDate)} às ${String(extra.oldTime || '').slice(0, 5)}~`);
    lines.push(`🗓️ *Agora:* ${formatDate(b.booking_date)} às ${String(b.booking_time).slice(0, 5)}`);
  } else {
    lines.push(`🗓️ *Data:* ${formatDate(b.booking_date)} às ${String(b.booking_time).slice(0, 5)}`);
  }
  lines.push(`⏱️ *Duração:* ${b.duracao} min`);
  lines.push(`💰 *Valor:* R$ ${brl(valor)}${b.reward_label ? ` (🎁 ${b.reward_label})` : ''}`);
  if (kind === 'novo') lines.push(`📍 *Origem:* ${ORIGINS[b.source] || ORIGINS.link}`);
  if (kind === 'cancelado' && extra.reason) lines.push(`📝 *Motivo:* ${extra.reason}`);
  if (kind === 'avaliacao_baixa') {
    lines.push(`⭐ *Nota:* ${'⭐'.repeat(extra.rating || 1)} (${extra.rating || '-'} de 5)`);
    lines.push('', '👉 Vale chamar esse cliente para entender o que aconteceu.');
  }
  return lines.join('\n');
}

// Quem recebe o aviso: o gestor (se ligado) e o barbeiro do agendamento (se tiver WhatsApp cadastrado).
// Avaliacao baixa e so para o gestor. extra.onlyBarber = agendamento criado pelo proprio gestor (so avisa o barbeiro).
function recipientsFor(tenant, b, kind, extra = {}) {
  const list = [];
  const barber = b.barber_id ? db.prepare('SELECT name, notify_phone FROM barbers WHERE id = ?').get(b.barber_id) : null;
  // Toggle "receber de todos os barbeiros": desligado = nao recebe os de barbeiros que ja avisam no proprio WhatsApp
  const skipGestor = kind !== 'avaliacao_baixa' && tenant.notify_all_barbers === 0 && barber && barber.notify_phone;
  if (!extra.onlyBarber && !skipGestor && tenant.notify_phone && tenant.notify_enabled !== 0) list.push({ phone: tenant.notify_phone, who: 'gestor' });
  if (kind !== 'avaliacao_baixa' && barber && barber.notify_phone) list.push({ phone: barber.notify_phone, who: `barbeiro ${barber.name}` });
  // sem duplicar quando o gestor e o barbeiro sao a mesma pessoa/numero
  const seen = new Set();
  return list.filter(r => { const k = digits55(r.phone); if (seen.has(k)) return false; seen.add(k); return true; });
}


// ==================== Botoes: "Falar com o cliente" e "Meus agendamentos" ====================

const BTN_AGENDA_ID = 'meus_agendamentos';

function clientChatUrl(b) {
  const n = digits55(b.customer_phone);
  return n.length >= 12 ? `https://wa.me/${n}` : '';
}

// Sempre os mesmos dois botoes abaixo do aviso. Se o telefone do cliente for invalido, so o de agenda.
function bookingButtons(b, text) {
  const url = clientChatUrl(b);
  const list = [];
  if (url) list.push({ text: '💬 WhatsApp', url });
  list.push({ text: '📋 Meus agendamentos', id: BTN_AGENDA_ID });
  return {
    buttons: list,
    // Se o WhatsApp nao mostrar botoes, o link do cliente vai no proprio texto
    fallbackText: url ? `${text}\n\n💬 *WhatsApp do cliente:* ${url}\n📋 Para ver sua agenda, responda *agenda*.` : `${text}\n\n📋 Para ver sua agenda, responda *agenda*.`
  };
}

function sameNumber(a, b) {
  const x = variants(digits55(a));
  return variants(digits55(b)).some(v => x.includes(v));
}

function nowBrasilia() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

const FUTURE_SQL = "b.status IN ('confirmed', 'pending') AND (b.booking_date > ? OR (b.booking_date = ? AND substr(b.booking_time, 1, 5) >= ?))";

// Escopos a que o numero tem acesso: gestor = a barbearia toda; barbeiro = so os agendamentos dele.
function scopesFor(senderPhone) {
  const scopes = [];
  const seenTenant = new Set();
  for (const t of db.prepare("SELECT id, name, notify_phone FROM tenants WHERE notify_phone IS NOT NULL AND notify_phone != ''").all()) {
    if (!sameNumber(t.notify_phone, senderPhone)) continue;
    seenTenant.add(t.id);
    scopes.push({ tenantId: t.id, tenantName: t.name, barberId: 0, barberName: '' });
  }
  const barbers = db.prepare("SELECT br.id, br.name, br.tenant_id, t.name AS tenant_name, br.notify_phone FROM barbers br JOIN tenants t ON t.id = br.tenant_id WHERE br.notify_phone IS NOT NULL AND br.notify_phone != ''").all();
  for (const br of barbers) {
    if (seenTenant.has(br.tenant_id) || !sameNumber(br.notify_phone, senderPhone)) continue; // gestor ja ve tudo
    scopes.push({ tenantId: br.tenant_id, tenantName: br.tenant_name, barberId: br.id, barberName: br.name });
  }
  return scopes;
}

// Datas futuras com agendamento (em ordem), com quantidade e faixa de horarios
function upcomingDays(scope, limit) {
  const now = nowBrasilia();
  const params = [scope.tenantId, now.date, now.date, now.time];
  let sql = `SELECT b.booking_date AS date, COUNT(*) AS total, MIN(substr(b.booking_time, 1, 5)) AS first, MAX(substr(b.booking_time, 1, 5)) AS last
    FROM bookings b WHERE b.tenant_id = ? AND ${FUTURE_SQL}`;
  if (scope.barberId) { sql += ' AND b.barber_id = ?'; params.push(scope.barberId); }
  sql += ' GROUP BY b.booking_date ORDER BY b.booking_date ASC LIMIT ?';
  params.push(limit + 1);
  const rows = db.prepare(sql).all(...params);
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

// Agendamentos de um dia, por horario
function bookingsOfDay(scope, date) {
  const now = nowBrasilia();
  const params = [scope.tenantId, date, now.date, now.date, now.time];
  let sql = `SELECT b.*, COALESCE(b.item_name, s.name, p.name) AS servico, br.name AS profissional
    FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id
    LEFT JOIN packages p ON p.id = b.package_id
    LEFT JOIN barbers br ON br.id = b.barber_id
    WHERE b.tenant_id = ? AND b.booking_date = ? AND ${FUTURE_SQL}`;
  if (scope.barberId) { sql += ' AND b.barber_id = ?'; params.push(scope.barberId); }
  sql += ' ORDER BY b.booking_time ASC, b.id ASC';
  return db.prepare(sql).all(...params);
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// Passo 1: lista de datas (WhatsApp permite ate 10 itens no total)
function buildDaysList(scopes) {
  const perScope = Math.max(1, Math.floor(10 / scopes.length));
  const sections = [];
  const textLines = ['📋 *Meus agendamentos*', ''];
  let any = false;
  for (const sc of scopes) {
    const { rows, more } = upcomingDays(sc, perScope);
    if (!rows.length) continue;
    any = true;
    const label = scopes.length > 1 ? `${sc.tenantName}${sc.barberName ? ' · ' + sc.barberName : ''}` : '';
    if (label) textLines.push(`_${label}_`);
    sections.push({
      title: (label || 'Datas').slice(0, 24),
      rows: rows.map(r => ({
        title: formatDate(r.date),
        description: `${plural(r.total, 'agendamento', 'agendamentos')} · ${r.first === r.last ? r.first : `${r.first} às ${r.last}`}`,
        id: `dia:${sc.tenantId}:${sc.barberId}:${r.date}`
      }))
    });
    for (const r of rows) textLines.push(`🗓️ *${formatDate(r.date)}* · ${plural(r.total, 'agendamento', 'agendamentos')}`);
    if (more) textLines.push('_… há mais datas adiante._');
    textLines.push('');
  }
  if (!any) return null;
  textLines.push('Para ver um dia, responda com a data. Ex: *15/10*');
  const fallbackText = textLines.join('\n');
  return {
    title: '📋 Meus agendamentos',
    text: 'Escolha a data para ver os agendamentos daquele dia. 👇',
    footer: scopes.length === 1 && scopes[0].barberName ? `${scopes[0].tenantName} · ${scopes[0].barberName}` : (scopes.length === 1 ? scopes[0].tenantName : ''),
    buttonText: 'Ver datas',
    sections,
    fallbackText
  };
}

// Passo 2: agendamentos de um dia
function buildDayMessage(scope, date) {
  const rows = bookingsOfDay(scope, date);
  const head = [`🗓️ *${formatDate(date)}*`, `_${scope.tenantName}${scope.barberName ? ` · ${scope.barberName}` : ''}_`, ''];
  if (!rows.length) return [...head, 'Nenhum agendamento nesta data.'].join('\n');
  const out = [...head];
  for (const r of rows) {
    const link = clientChatUrl(r);
    out.push(`🕐 *${String(r.booking_time).slice(0, 5)}* · ${r.customer_full_name || '-'}`);
    out.push(`   ✂️ ${r.servico || '-'}${scope.barberId ? '' : ` · 💈 ${r.profissional || 'Qualquer um'}`}`);
    out.push(`   📱 ${formatPhone(r.customer_phone)}${link ? ` · ${link}` : ''}`);
    out.push('');
  }
  out.push(`Total: ${plural(rows.length, 'agendamento', 'agendamentos')}.`);
  return out.join('\n');
}

const BACK_BUTTONS = { buttons: [{ text: '📋 Ver outras datas', id: BTN_AGENDA_ID }] };

// "15/10" ou "15/10/2026" digitado -> AAAA-MM-DD (ano atual, ou o proximo se a data ja passou)
function parseTypedDate(text) {
  const m = String(text).match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (!m) return null;
  const now = nowBrasilia();
  let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : Number(now.date.slice(0, 4));
  const iso = yy => `${yy}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  if (!m[3] && iso(y) < now.date) y += 1;
  const d = iso(y);
  return isNaN(new Date(d + 'T12:00:00Z')) || Number(m[1]) > 31 || Number(m[2]) > 12 ? null : d;
}

async function sendDay(senderPhone, scopes, date) {
  const found = scopes.filter(sc => bookingsOfDay(sc, date).length);
  if (!found.length) {
    await sendTo(senderPhone, `Não há agendamentos em ${formatDate(date)}.`, BACK_BUTTONS).catch(() => {});
    return;
  }
  for (let i = 0; i < found.length; i++) {
    await sendTo(senderPhone, buildDayMessage(found[i], date), i === found.length - 1 ? BACK_BUTTONS : null)
      .catch(err => console.error('[aviso] falha ao enviar dia:', err.message));
  }
}

// Recebe o webhook do numero central: toque em "Meus agendamentos", numa data da lista, ou texto digitado.
async function handleIncoming(body) {
  const waProvider = require('./wa-provider');
  const messages = waProvider.normalizeWebhook('wuzapi', body);
  for (const msg of messages) {
    if (msg.fromMe || msg.isGroup || !msg.text || !msg.senderPhone) continue;
    if (msg.timestamp && Date.now() / 1000 - msg.timestamp > 300) continue; // historico antigo
    if (seenMsg.has(msg.id)) continue;
    seenMsg.add(msg.id);
    if (seenMsg.size > 500) seenMsg.delete(seenMsg.values().next().value);

    const text = msg.text.toLowerCase();
    // Cliente final mexendo no proprio agendamento (botoes Reagendar / Cancelar)
    if (/id: cli_/.test(text) || !scopesFor(msg.senderPhone).length) {
      if (await handleClientMessage(msg, text).catch(err => { console.error('[aviso] erro cliente:', err.message); return true; })) continue;
    }
    const dayId = text.match(/id: dia:(\d+):(\d+):(\d{4}-\d{2}-\d{2})/);
    const isAgenda = text.includes(BTN_AGENDA_ID) || /^\W*(meus )?agendamentos?\W*$|^\W*agenda\W*$/.test(text) || text.includes('meus agendamentos');
    const typedDate = !dayId && !text.startsWith('[cliente tocou') ? parseTypedDate(text) : null;
    if (!dayId && !isAgenda && !typedDate) continue;

    const scopes = scopesFor(msg.senderPhone);
    if (!scopes.length) {
      await sendTo(msg.senderPhone, 'Este número não está cadastrado como gestor ou barbeiro em nenhuma barbearia. 😕').catch(() => {});
      continue;
    }

    if (dayId) {
      // So mostra o escopo que este numero realmente tem acesso (confere tenant e barbeiro)
      const sc = scopes.find(x => x.tenantId === Number(dayId[1]) && x.barberId === Number(dayId[2]));
      if (sc) await sendDay(msg.senderPhone, [sc], dayId[3]);
      continue;
    }
    if (typedDate) { await sendDay(msg.senderPhone, scopes, typedDate); continue; }

    const list = buildDaysList(scopes);
    if (!list) {
      await sendTo(msg.senderPhone, '📋 *Meus agendamentos*\n\nVocê não tem agendamentos futuros no momento. ✂️').catch(() => {});
      continue;
    }
    await sendTo(msg.senderPhone, list.text, null, list).catch(err => console.error('[aviso] falha ao enviar datas:', err.message));
    console.log(`[aviso] lista de datas enviada para ${msg.senderPhone}`);
  }
}
const seenMsg = new Set();

// ==================== Mensagens ao CLIENTE pelo numero central ====================
// Barbearias que preferem nao conectar o proprio WhatsApp: a confirmacao e o lembrete saem pelo numero
// do sistema, com 3 botoes: WhatsApp da barbearia, Reagendar e Cancelar. Cada toque carrega o id do
// agendamento e so vale se quem tocou e o dono do telefone daquele agendamento (barbearias nunca se misturam).

// O numero do sistema so vale quando a barbearia marcou a opcao E NAO tem WhatsApp proprio conectado.
function usesCentral(tenantId) {
  const t = db.prepare('SELECT client_notify_central FROM tenants WHERE id = ?').get(tenantId);
  if (!t || !t.client_notify_central) return false;
  const inst = db.prepare('SELECT status FROM whatsapp_instances WHERE tenant_id = ?').get(tenantId);
  return !(inst && inst.status === 'connected');
}

// Cliente pode reagendar/cancelar conversando no WhatsApp? Só se o atendente IA estiver ativo (plano PRO).
// Sem a IA, os botoes levam ao link da barbearia (aba "Meus agendamentos").
function manageInChat(tenant) {
  try {
    const ai = require('./ai-agent');
    return ai.isProTenant(tenant) && !!ai.getAiConfig(tenant.id).enabled;
  } catch (_) { return false; }
}

function publicBase() {
  let base = process.env.PUBLIC_BASE_URL;
  if (!base) base = (db.prepare("SELECT value FROM settings WHERE key = 'public_base_url' AND value != '' ORDER BY rowid DESC LIMIT 1").get() || {}).value;
  return base ? base.replace(/\/$/, '') : '';
}

function shopPhone(tenant, barberId) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'shop_profile'").get(tenant.id);
    const phone = row && JSON.parse(row.value).phone;
    if (phone && digits55(phone).length >= 12) return digits55(phone);
  } catch (_) {}
  if (digits55(tenant.notify_phone).length >= 12) return digits55(tenant.notify_phone);
  const br = barberId ? db.prepare('SELECT notify_phone FROM barbers WHERE id = ?').get(barberId) : null;
  return br && digits55(br.notify_phone).length >= 12 ? digits55(br.notify_phone) : '';
}

function clientCardButtons(tenant, b, text, kind, own = false) {
  const phone = shopPhone(tenant, b.barber_id);
  const inChat = own ? false : manageInChat(tenant);
  const base = publicBase();
  const link = (acao) => base ? `${base}/${tenant.slug}?meus=${acao}` : '';
  const list = [];
  let extra = '';

  if (kind === 'lembrete') {
    list.push({ text: '✅ Confirmar', id: `cli_ok:${b.id}` });
    if (inChat) {
      list.push({ text: '🔄 Reagendar', id: `cli_rag:${b.id}` });
      list.push({ text: '❌ Cancelar', id: `cli_can:${b.id}` });
    } else if (base) {
      list.push({ text: '🔄 Reagendar', url: link('reagendar') });
      list.push({ text: '❌ Cancelar', url: link('cancelar') });
      extra = '\n\nℹ️ *Como funciona:*\n• Tudo certo? Toque em *Confirmar* e pronto, não precisa fazer mais nada.\n• Para *reagendar* ou *cancelar*, toque no botão: você vai para o site da barbearia, digita seu telefone, toca em *Buscar* e escolhe o horário.';
    }
  } else {
    if (phone && !own) list.push({ text: '💬 WhatsApp', url: `https://wa.me/${phone}` });
    if (own && base) {
      list.push({ text: '🔄 Reagendar', url: link('reagendar') });
      list.push({ text: '❌ Cancelar', url: link('cancelar') });
      extra = '\n\nℹ️ *Precisa mudar o horário ou cancelar?* Toque em *Reagendar* ou *Cancelar*, digite seu telefone no site da barbearia, toque em *Buscar* e escolha a opção.';
    } else if (inChat) {
      list.push({ text: '🔄 Reagendar', id: `cli_rag:${b.id}` });
      list.push({ text: '❌ Cancelar', id: `cli_can:${b.id}` });
    } else if (base) {
      list.push({ text: '🔄 Reagendar ou cancelar', url: link('1') });
      extra = '\n\nℹ️ *Precisa mudar o horário ou cancelar?* Toque em *Reagendar ou cancelar*, digite seu telefone no site da barbearia, toque em *Buscar* e escolha a opção.';
    }
  }
  const tail = own ? (base ? `\n\n🔗 ${link('1')}` : '') : inChat
    ? `\n\n${kind === 'lembrete' ? '✅ Para confirmar, responda *ok*. ' : ''}🔄 Para reagendar, responda *reagendar*.\n❌ Para cancelar, responda *cancelar*.`
    : (base ? `\n\n🔗 ${link('1')}` : '');
  return {
    text: text + extra,
    buttons: { buttons: list, footer: tenant.name, fallbackText: text + extra + tail + (phone ? `\n💬 Falar com a barbearia: https://wa.me/${phone}` : '') }
  };
}

function fillVars(template, vars) {
  return Object.entries(vars).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(v ?? ''), template);
}

// kind: 'confirmacao' | 'lembrete' | 'reagendado'. Retorna true se enviou. Lanca erro se falhar.
async function sendClientCard(tenantId, bookingId, kind = 'confirmacao') {
  if (!token()) throw new Error('WhatsApp do sistema não conectado');
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant || !usesCentral(tenantId)) return false;
  const b = bookingDetails(bookingId);
  if (!b || b.tenant_id !== tenantId || !b.customer_phone) return false;
  const { DEFAULT_REMINDER_CONFIG } = require('./db');
  const vars = {
    cliente: b.customer_full_name || '', barbearia: tenant.name, servico: b.servico || '',
    barbeiro: b.profissional || 'a definir',
    data: String(b.booking_date).split('-').reverse().join('/'), hora: String(b.booking_time).slice(0, 5),
    valor: brl(Math.max(0, Number(b.preco) - Number(b.discount_applied || 0)))
  };
  let text;
  if (kind === 'lembrete') {
    let cfg = {};
    try { cfg = JSON.parse((db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'reminder_config'").get(tenantId) || {}).value || '{}'); } catch (_) {}
    text = fillVars(cfg.template || DEFAULT_REMINDER_CONFIG.template, vars);
  } else if (kind === 'reagendado') {
    text = `🔄 *Reagendado com sucesso!*\n_${tenant.name}_\n\n🗓️ ${formatDate(b.booking_date)} às ${vars.hora}\n✂️ ${vars.servico}\n💈 ${vars.barbeiro}`;
  } else {
    const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'whatsapp_template'").get(tenantId);
    text = fillVars((row && row.value) || '{{cliente}}, agendamento confirmado para {{data}} às {{hora}}.', vars);
  }
  await ensureWebhook();
  const card = clientCardButtons(tenant, b, text, kind);
  await sendTo(b.customer_phone, card.text, card.buttons);
  return true;
}

// Em segundo plano (confirmacao do agendamento): erro so vai pro log.
function notifyClient(tenantId, bookingId, kind = 'confirmacao') {
  setImmediate(async () => {
    try {
      if (await sendClientCard(tenantId, bookingId, kind)) {
        if (kind === 'confirmacao') db.prepare('UPDATE bookings SET whatsapp_sent = 1 WHERE id = ?').run(bookingId);
        console.log(`[aviso] ${kind} enviada ao cliente (tenant ${tenantId}, agendamento ${bookingId})`);
      }
    } catch (err) {
      console.error(`[aviso] falhou ${kind} ao cliente (tenant ${tenantId}, agendamento ${bookingId}):`, err.message);
    }
  });
}

// Agendamento que ESTE telefone pode mexer: dele, confirmado, futuro e de barbearia que usa o numero central
function clientBooking(id, senderPhone) {
  const b = bookingDetails(Number(id));
  if (!b || b.status !== 'confirmed' || !sameNumber(b.customer_phone, senderPhone)) return null;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(b.tenant_id);
  if (!tenant || !tenant.client_notify_central) return null;
  const now = nowBrasilia();
  if (b.booking_date < now.date || (b.booking_date === now.date && String(b.booking_time).slice(0, 5) < now.time)) return null;
  return { b, tenant };
}

function bookingSummary(b) {
  return [
    `👤 *Nome:* ${b.customer_full_name || '-'}`,
    `📱 *Telefone:* ${formatPhone(b.customer_phone)}`,
    `✂️ *Serviço:* ${b.servico || '-'}`,
    `💈 *Profissional:* ${b.profissional || 'Qualquer um'}`,
    `🗓️ *Data:* ${formatDate(b.booking_date)} às ${String(b.booking_time).slice(0, 5)}`
  ].join('\n');
}

const NOT_FOUND_MSG = 'Não encontrei esse agendamento (ele pode já ter passado ou sido cancelado). Se precisar, fale com a barbearia. 🙏';

function broadcast(tenantId, id) {
  try {
    const row = db.prepare('SELECT id, status FROM bookings WHERE id = ?').get(id);
    require('./events').broadcastBookingChange(tenantId, 'UPDATE', row);
  } catch (_) {}
}

// Passo 1 do cancelamento: pede confirmacao com nome completo e telefone (ja preenchidos)
async function askCancel(phone, found) {
  const { b, tenant } = found;
  const text = `❌ *Cancelar agendamento?*\n_${tenant.name}_\n\n${bookingSummary(b)}\n\nConfirme os dados acima para cancelar.`;
  await sendTo(phone, text, {
    buttons: [{ text: '✅ Sim, cancelar', id: `cli_cok:${b.id}` }, { text: '↩️ Manter', id: `cli_cno:${b.id}` }],
    fallbackText: `${text}\n\nResponda *sim* para cancelar ou *manter* para continuar com o agendamento.`
  });
}

async function doCancel(phone, found) {
  const { b, tenant } = found;
  db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'cliente_whatsapp' WHERE id = ?").run(b.id);
  broadcast(tenant.id, b.id);
  notifyBooking(tenant.id, b.id, 'cancelado');
  const base = publicBase();
  const text = `✅ *Agendamento cancelado.*\n_${tenant.name}_\n\n🗓️ ${formatDate(b.booking_date)} às ${String(b.booking_time).slice(0, 5)} · ${b.servico || ''}\n\nQuando quiser marcar de novo, é só agendar pelo link. ✂️`;
  await sendTo(phone, text, base ? { buttons: [{ text: '📅 Agendar novamente', url: `${base}/${tenant.slug}` }], fallbackText: `${text}\n${base}/${tenant.slug}` } : null);
}

// Reagendar: dias com horario livre -> horarios (paginados) -> confirmacao
function freeSlots(found, date) {
  const { b, tenant } = found;
  return require('./ai-agent').computeFreeSlots(tenant.id, b.barber_id, date, Number(b.duracao), b.id);
}

async function askRescheduleDay(phone, found) {
  const { b, tenant } = found;
  const today = nowBrasilia().date;
  const rows = [];
  for (let i = 0; i < 30 && rows.length < 10; i++) {
    const date = new Date(today + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + i);
    const iso = date.toISOString().slice(0, 10);
    const slots = freeSlots(found, iso);
    if (slots.length) rows.push({ title: formatDate(iso), description: `${plural(slots.length, 'horário livre', 'horários livres')}`, id: `cli_rdia:${b.id}:${iso}` });
  }
  if (!rows.length) {
    await sendTo(phone, `Não há horários livres nos próximos dias para reagendar. 😕 Fale com a barbearia para combinar.`, null);
    return;
  }
  const fallbackText = `🔄 *Reagendar*\n\n${rows.map(r => `🗓️ ${r.title} · ${r.description}`).join('\n')}\n\nResponda com a data desejada. Ex: *15/10*`;
  await sendTo(phone, fallbackText, null, {
    title: '🔄 Reagendar', text: `Escolha o novo dia para ${b.servico || 'seu atendimento'}. 👇`, footer: tenant.name,
    buttonText: 'Ver datas', sections: [{ title: 'Datas disponíveis', rows }], fallbackText
  });
}

const PAGE = 9;
async function askRescheduleTime(phone, found, date, offset = 0) {
  const { b, tenant } = found;
  const slots = freeSlots(found, date);
  if (!slots.length) { await sendTo(phone, `Não há mais horários livres em ${formatDate(date)}. Escolha outra data. 🙏`, { buttons: [{ text: '🔄 Escolher outra data', id: `cli_rag:${b.id}` }] }); return; }
  const page = slots.slice(offset, offset + PAGE);
  const rows = page.map(t => ({ title: t, description: formatDate(date), id: `cli_rhr:${b.id}:${date}:${t.replace(':', '')}` }));
  if (offset + PAGE < slots.length) rows.push({ title: '➡️ Mais horários', description: 'Ver os próximos horários do dia', id: `cli_rmais:${b.id}:${date}:${offset + PAGE}` });
  const fallbackText = `🕐 *Horários em ${formatDate(date)}*\n\n${page.join(' · ')}\n\nResponda com o horário. Ex: *${page[0]}*`;
  await sendTo(phone, fallbackText, null, {
    title: `🕐 ${formatDate(date)}`, text: 'Escolha o novo horário. 👇', footer: tenant.name, buttonText: 'Ver horários',
    sections: [{ title: 'Horários livres', rows }], fallbackText
  });
}

async function askRescheduleConfirm(phone, found, date, hhmm) {
  const { b, tenant } = found;
  const time = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  if (!freeSlots(found, date).includes(time)) { await askRescheduleTime(phone, found, date); return; }
  const text = `🔄 *Confirmar reagendamento?*\n_${tenant.name}_\n\n👤 *Nome:* ${b.customer_full_name || '-'}\n📱 *Telefone:* ${formatPhone(b.customer_phone)}\n✂️ *Serviço:* ${b.servico || '-'}\n\n🗓️ *Antes:* ~${formatDate(b.booking_date)} às ${String(b.booking_time).slice(0, 5)}~\n🗓️ *Novo:* ${formatDate(date)} às ${time}`;
  await sendTo(phone, text, {
    buttons: [{ text: '✅ Confirmar', id: `cli_rok:${b.id}:${date}:${hhmm}` }, { text: '↩️ Voltar', id: `cli_rag:${b.id}` }],
    fallbackText: `${text}\n\nResponda *confirmar* para reagendar.`
  });
}

async function doReschedule(phone, found, date, hhmm) {
  const { b, tenant } = found;
  const time = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  if (!freeSlots(found, date).includes(time)) { await sendTo(phone, 'Esse horário acabou de ser ocupado. Escolha outro. 🙏', { buttons: [{ text: '🔄 Escolher outro', id: `cli_rag:${b.id}` }] }); return; }
  db.prepare("UPDATE bookings SET booking_date = ?, booking_time = ?, rescheduled_at = datetime('now'), client_confirmed_at = NULL, reminder_sent = 0 WHERE id = ?").run(date, time, b.id);
  broadcast(tenant.id, b.id);
  notifyBooking(tenant.id, b.id, 'reagendado', { oldDate: b.booking_date, oldTime: b.booking_time });
  await sendClientCard(tenant.id, b.id, 'reagendado');
}

// Toques do cliente (ids "cli_*") e palavras soltas (cancelar / reagendar / sim / manter / confirmar)
const pendingTyped = new Map(); // telefone -> { action, ... } ultima etapa aguardando resposta digitada
async function handleClientMessage(msg, text) {
  const phone = msg.senderPhone;
  const m = text.match(/id: (cli_[a-z]+):(\d+)(?::(\d{4}-\d{2}-\d{2}))?(?::(\d{1,4}))?/);
  let action = null, id = null, date = null, extra = null;
  if (m) { [, action, id, date, extra] = m; }
  else {
    const word = text.replace(/[^\p{L}\s]/gu, '').trim();
    let last = pendingTyped.get(digits55(phone));
    if (last && Date.now() - (last.at || 0) > 10 * 60 * 1000) { pendingTyped.delete(digits55(phone)); last = null; } // etapa digitada expira em 10 min
    if (/^(cancelar|cancela|cancelamento)$/.test(word) || /^(reagendar|remarcar|reagenda)$/.test(word) || (!(last && last.yes) && /^(ok|confirmo|confirmado|confirmar presenca|confirmar presença)$/.test(word))) {
      const now = nowBrasilia();
      const mine = db.prepare(`SELECT b.id FROM bookings b JOIN tenants t ON t.id = b.tenant_id
        WHERE t.client_notify_central = 1 AND b.status = 'confirmed' AND (b.booking_date > ? OR (b.booking_date = ? AND substr(b.booking_time,1,5) >= ?))
        ORDER BY b.booking_date, b.booking_time`).all(now.date, now.date, now.time).filter(r => { const c = clientBooking(r.id, phone); return !!c; });
      if (!mine.length) return false;
      const isCancel = /cancel/.test(word);
      const isOk = /^(ok|confirm)/.test(word);
      const act = isOk ? 'cli_ok' : isCancel ? 'cli_can' : 'cli_rag';
      if (mine.length > 1) {
        // Mais de um agendamento (ou de mais de uma barbearia): nunca adivinha, o cliente escolhe qual
        const rows = mine.slice(0, 10).map(r => {
          const c = clientBooking(r.id, phone);
          return { title: `${c.tenant.name}`.slice(0, 24), description: `${formatDate(c.b.booking_date)} às ${String(c.b.booking_time).slice(0, 5)} · ${c.b.servico || ''}`.slice(0, 72), id: `${act}:${r.id}` };
        });
        const fallbackText = `${isOk ? '✅ *Confirmar presença*' : isCancel ? '❌ *Cancelar*' : '🔄 *Reagendar*'}\n\nVocê tem mais de um agendamento:\n${mine.slice(0, 10).map(r => { const c = clientBooking(r.id, phone); return `• ${c.tenant.name} — ${formatDate(c.b.booking_date)} às ${String(c.b.booking_time).slice(0, 5)}`; }).join('\n')}\n\nToque no botão da mensagem original do agendamento que quer alterar.`;
        await sendTo(phone, fallbackText, null, { title: isOk ? '✅ Confirmar' : isCancel ? '❌ Cancelar' : '🔄 Reagendar', text: 'Qual agendamento? 👇', buttonText: 'Ver agendamentos', sections: [{ title: 'Seus agendamentos', rows }], fallbackText }).catch(() => {});
        return true;
      }
      action = act; id = mine[0].id;
    } else if (last && last.yes && /^(sim|confirmar|confirmo)$/.test(word)) { ({ id, date, extra } = last); action = last.yes; }
    else if (last && last.yes === 'cli_cok' && /^(manter|nao|não)$/.test(word)) { action = 'cli_cno'; id = last.id; }
    else if (last && last.action === 'day') {
      const d = parseTypedDate(text); if (d) { action = 'cli_rdia'; id = last.id; date = d; }
    } else if (last && last.action === 'time' && /^\d{1,2}[:h]?\d{2}$/.test(word.replace(/\s/g, '')) ) {
      action = 'cli_rhr'; id = last.id; date = last.date; extra = word.replace(/\D/g, '').padStart(4, '0');
    }
    if (!action) return false;
  }
  const found = clientBooking(id, phone);
  if (!found) { await sendTo(phone, NOT_FOUND_MSG, null).catch(() => {}); return true; }
  const key = digits55(phone);
  const origSet = pendingTyped.set.bind(pendingTyped);
  const stamp = (k, v) => origSet(k, { ...v, at: Date.now() });
  try {
    switch (action) {
      case 'cli_ok': {
        db.prepare("UPDATE bookings SET client_confirmed_at = datetime('now') WHERE id = ?").run(found.b.id);
        broadcast(found.tenant.id, found.b.id);
        notifyBooking(found.tenant.id, found.b.id, 'confirmado');
        await sendTo(phone, `✅ *Presença confirmada!*\n_${found.tenant.name}_\n\n🗓️ ${formatDate(found.b.booking_date)} às ${String(found.b.booking_time).slice(0, 5)}\nTe esperamos! 💈`, null);
        break;
      }
      case 'cli_can': stamp(key, { id, yes: 'cli_cok' }); await askCancel(phone, found); break;
      case 'cli_cok': pendingTyped.delete(key); await doCancel(phone, found); break;
      case 'cli_cno': pendingTyped.delete(key); await sendTo(phone, `👍 Combinado! Mantivemos seu agendamento de ${formatDate(found.b.booking_date)} às ${String(found.b.booking_time).slice(0, 5)}.`, null); break;
      case 'cli_rag': stamp(key, { action: 'day', id }); await askRescheduleDay(phone, found); break;
      case 'cli_rdia': stamp(key, { action: 'time', id, date }); await askRescheduleTime(phone, found, date, 0); break;
      case 'cli_rmais': await askRescheduleTime(phone, found, date, Number(extra) || 0); break;
      case 'cli_rhr': stamp(key, { id, yes: 'cli_rok', date, extra }); await askRescheduleConfirm(phone, found, date, String(extra).padStart(4, '0')); break;
      case 'cli_rok': pendingTyped.delete(key); await doReschedule(phone, found, date, String(extra).padStart(4, '0')); break;
      default: return false;
    }
  } catch (err) {
    console.error('[aviso] falha no fluxo do cliente:', err.message);
  }
  return true;
}


// Garante que o numero central avisa este servidor dos toques nos botoes. Usa PUBLIC_BASE_URL ou a URL
// que qualquer gestor ja usou no painel (salva em settings.public_base_url). Roda 1x por URL.
let webhookDone = null;
async function ensureWebhook() {
  const t = token();
  if (!t) return;
  let base = process.env.PUBLIC_BASE_URL;
  if (!base) base = (db.prepare("SELECT value FROM settings WHERE key = 'public_base_url' AND value != '' ORDER BY rowid DESC LIMIT 1").get() || {}).value;
  if (!base) return;
  const url = require('./route-webhook').buildNotifyWebhookUrl(base);
  if (webhookDone === url) return;
  try {
    await wuzapi.setWebhook(t, url);
    webhookDone = url;
    console.log('[aviso] webhook dos botões configurado');
  } catch (err) {
    console.error('[aviso] não consegui configurar o webhook dos botões:', err.message);
  }
}

// Dispara o aviso em segundo plano. kind: 'novo' | 'cancelado' | 'reagendado' | 'confirmado'
function notifyBooking(tenantId, bookingId, kind = 'novo', extra = {}) {
  setImmediate(async () => {
    try {
      if (!token()) return;
      await ensureWebhook();
      const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
      if (!tenant) return;
      const b = bookingDetails(bookingId);
      if (!b) return;
      const recipients = recipientsFor(tenant, b, kind, extra);
      if (!recipients.length) return;
      const text = buildMessage(tenant, b, kind, extra);
      for (const r of recipients) {
        try {
          await sendTo(r.phone, text, bookingButtons(b, text));
          console.log(`[aviso] ${kind} enviado para ${r.who} de ${tenant.name} (agendamento ${bookingId})`);
        } catch (err) {
          console.error(`[aviso] falhou para ${r.who} (tenant ${tenantId}, agendamento ${bookingId}):`, err.message);
        }
      }
    } catch (err) {
      console.error(`[aviso] falhou (tenant ${tenantId}, agendamento ${bookingId}):`, err.message);
    }
  });
}

// Aviso para o DONO do sistema (novo cliente de revendedor, pagamento registrado...).
// Numero cadastrado no super admin (aba Revendedores). Em segundo plano; erro so vai pro log.
function notifyOwner(text) {
  setImmediate(async () => {
    try {
      const phone = getSystemSetting('owner_notify_phone');
      if (!phone || !token()) return;
      await sendTo(phone, text);
    } catch (err) {
      console.error('[aviso] falhou o aviso para o dono:', err.message);
    }
  });
}

async function sendTest(phone, tenantName) {
  return sendTo(phone, [
    '🔔 *Teste de aviso — BarberSync*',
    tenantName ? `_${tenantName}_` : '',
    '',
    'Tudo certo! A partir de agora você recebe aqui cada novo agendamento, cancelamento e reagendamento da sua barbearia. ✂️'
  ].filter(Boolean).join('\n'));
}

// Toque em "Confirmar" do lembrete enviado pelo WhatsApp PROPRIO da barbearia (chega no webhook da instancia dela)
async function handleOwnConfirm(tenant, instance, senderPhone, text) {
  const m = /id:\s*cli_ok:(\d+)/.exec(String(text || ''));
  if (!m) return false;
  const b = bookingDetails(Number(m[1]));
  if (!b || b.tenant_id !== tenant.id || b.status !== 'confirmed' || !sameNumber(b.customer_phone, senderPhone)) return true;
  db.prepare("UPDATE bookings SET client_confirmed_at = datetime('now') WHERE id = ?").run(b.id);
  broadcast(tenant.id, b.id);
  notifyBooking(tenant.id, b.id, 'confirmado');
  await require('./wa-provider').sendText(instance, senderPhone,
    `✅ *Presença confirmada!*\n_${tenant.name}_\n\n🗓️ ${formatDate(b.booking_date)} às ${String(b.booking_time).slice(0, 5)}\nTe esperamos! 💈`).catch(() => {});
  return true;
}

// Monta e envia confirmacao/lembrete com botoes pelo WhatsApp proprio da barbearia. Retorna true se mandou.
async function sendOwnCard(tenant, instance, bookingId, text, kind) {
  const b = bookingDetails(bookingId);
  if (!b) return false;
  const card = clientCardButtons(tenant, b, text, kind, true);
  if (!card.buttons.buttons.length) return false;
  await require('./wa-provider').sendInteractive(instance, b.customer_phone, 'buttons',
    { text: card.text, footer: tenant.name, buttons: card.buttons.buttons }, card.buttons.fallbackText);
  return true;
}

module.exports = { handleOwnConfirm, sendOwnCard, hasToken: () => !!token(), usesCentral, status, connect, currentQr, disconnect, notifyBooking, notifyClient, sendClientCard, sendTest, buildMessage, recipientsFor, handleIncoming, ensureWebhook, notifyOwner };
