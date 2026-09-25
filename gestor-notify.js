// Avisos de agendamento no WhatsApp do GESTOR de cada barbearia.
// Um numero central do sistema (conectado pelo super admin, via WuzAPI) avisa o dono da
// barbearia sempre que um cliente agenda, cancela, reagenda ou confirma presenca.
// Nunca atrasa nem quebra o agendamento: tudo roda em segundo plano e erros so vao pro log.

const { db } = require('./db');
const wuzapi = require('./wuzapi');
const { getSystemSetting, setSystemSetting } = require('./system-settings');

const USER_NAME = 'barbersync-notificacoes';
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function token() {
  return getSystemSetting('notify_wuz_token');
}

// ==================== Conexao (super admin) ====================

async function status() {
  const t = token();
  let state = 'disconnected';
  if (t) {
    try { state = await wuzapi.getStatus(t); } catch (e) { state = 'erro: ' + e.message; }
  }
  return { wuzapi_configured: wuzapi.isConfigured(), has_user: !!t, status: state };
}

async function connect() {
  if (!wuzapi.isConfigured()) throw new Error('WuzAPI não configurada no servidor (WUZAPI_URL / WUZAPI_ADMIN_TOKEN)');
  let t = token();
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
      if (await wuzapi.getStatus(t) === 'connected') return { status: 'connected', qr: null };
    } catch (_) {}
    try {
      const qr = await wuzapi.getQr(t);
      if (qr) return { status: 'connecting', qr };
    } catch (e) {
      if (/logged in/i.test(e.message)) return { status: 'connected', qr: null };
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

async function disconnect() {
  const t = token();
  if (t) await wuzapi.logout(t).catch(() => {});
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

async function sendTo(phone, text) {
  const t = token();
  if (!t) throw new Error('WhatsApp de notificações não conectado no super admin');
  const n = digits55(phone);
  if (n.length < 12) throw new Error('Telefone do gestor inválido');

  const known = resolved.get(n);
  const first = known && Date.now() - known.at < 24 * 3600 * 1000 && known.to ? known.to : n;
  try {
    return await wuzapi.sendText(t, first, text);
  } catch (err) {
    if (!/no LID found|not (registered|on whatsapp)|not found|invalid/i.test(err.message)) throw err;
    // Numero em formato diferente do registrado no WhatsApp: confere com/sem 9 e reenvia
    const users = await wuzapi.checkUsers(t, variants(n)).catch(() => []);
    const found = users.find(u => u.IsInWhatsapp || u.isInWhatsapp);
    if (!found) throw new Error(`o número ${n} não tem WhatsApp`);
    const to = String(found.JID || found.jid || found.Query).split('@')[0];
    resolved.set(n, { to, at: Date.now() });
    return wuzapi.sendText(t, to, text);
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

// Dispara o aviso em segundo plano. kind: 'novo' | 'cancelado' | 'reagendado' | 'confirmado'
function notifyBooking(tenantId, bookingId, kind = 'novo', extra = {}) {
  setImmediate(async () => {
    try {
      if (!token()) return;
      const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
      if (!tenant || !tenant.notify_phone || tenant.notify_enabled === 0) return;
      const b = bookingDetails(bookingId);
      if (!b) return;
      await sendTo(tenant.notify_phone, buildMessage(tenant, b, kind, extra));
      console.log(`[aviso-gestor] ${kind} enviado para ${tenant.name} (agendamento ${bookingId})`);
    } catch (err) {
      console.error(`[aviso-gestor] falhou (tenant ${tenantId}, agendamento ${bookingId}):`, err.message);
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

module.exports = { status, connect, currentQr, disconnect, notifyBooking, sendTest, buildMessage };
