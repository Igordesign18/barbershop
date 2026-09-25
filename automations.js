// Automacoes de mensagens do plano PRO (cada uma com liga/desliga no painel do gestor):
//  1. Retorno (follow-up): X dias depois do atendimento concluido, convida o cliente a agendar de novo
//  2. Avaliacao: X horas depois de concluir, pede uma nota de 1 a 5 (lista com estrelas no WhatsApp)
//  3. Aniversario: no dia do aniversario do cliente, parabens em nome da barbearia
// Envia pelo WhatsApp da propria barbearia. Nunca envia de madrugada (so das 9h as 20h).

const { db } = require('./db');
const waProvider = require('./wa-provider');
const { fillTemplate, formatDateBR } = require('./whatsapp');

const DEFAULT_AUTOMATIONS = {
  followup_enabled: false,
  followup_days: 20,
  followup_message: 'Olá, {{cliente}}! 💈 Já faz {{dias}} dias do seu último atendimento aqui na *{{barbearia}}*. Que tal deixar o visual em dia de novo?\n\nAgende em poucos cliques: {{link}}\nOu responda esta mensagem que a gente agenda por aqui. 😉',
  review_enabled: false,
  review_delay_hours: 2,
  birthday_enabled: false,
  birthday_message: '🎉 Parabéns, {{cliente}}! 🎂\n\nToda a equipe da *{{barbearia}}* deseja um feliz aniversário, muita saúde e sucesso! Conte com a gente para deixar você no estilo nesse dia especial. 💈'
};

const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 20;
const REVIEW_REPLY_WINDOW_HOURS = 72; // cliente pode responder a nota ate 3 dias depois

function isPro(tenant) {
  return String(tenant?.plan || '').toLowerCase() === 'pro';
}

function getAutomations(tenantId) {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'automations'").get(tenantId);
  let saved = {};
  try { saved = row?.value ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  // As mensagens sao sempre as padrao do sistema (o gestor nao edita o texto)
  return {
    ...DEFAULT_AUTOMATIONS,
    ...saved,
    followup_message: DEFAULT_AUTOMATIONS.followup_message,
    birthday_message: DEFAULT_AUTOMATIONS.birthday_message
  };
}

function saveAutomations(tenantId, input) {
  const current = getAutomations(tenantId);
  const clampInt = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const config = {
    followup_enabled: !!input.followup_enabled,
    followup_days: clampInt(input.followup_days, 1, 30, current.followup_days),
    review_enabled: !!input.review_enabled,
    review_delay_hours: clampInt(input.review_delay_hours, 1, 48, current.review_delay_hours),
    birthday_enabled: !!input.birthday_enabled
  };
  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, 'automations', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(tenantId, JSON.stringify(config));
  return config;
}

// ==================== Utilitarios ====================

function nowBR() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, year: Number(parts.year), md: `${parts.month}-${parts.day}`, hour };
}

function connectedInstance(tenantId) {
  const instance = waProvider.getInstance(tenantId);
  if (!instance || instance.status !== 'connected' || !waProvider.isConfigured(instance.provider)) return null;
  return instance;
}

function bookingLink(tenant) {
  const base = (process.env.PUBLIC_BASE_URL
    || db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'public_base_url'").get(tenant.id)?.value
    || '').replace(/\/$/, '');
  return base ? `${base}/${tenant.slug}` : '';
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function proTenants() {
  return db.prepare("SELECT * FROM tenants WHERE status = 'active' AND LOWER(COALESCE(plan, '')) = 'pro'").all();
}

// ==================== 1. Retorno (follow-up) ====================

async function runFollowups(tenant, config, instance) {
  if (!config.followup_enabled) return;
  // Ultimo atendimento concluido de cada cliente ha pelo menos N dias, sem retorno enviado
  // e sem outro horario ja marcado
  const rows = db.prepare(`
    SELECT b.* FROM bookings b
    WHERE b.tenant_id = ? AND b.status = 'completed' AND b.followup_sent = 0
      AND b.completed_at IS NOT NULL
      AND b.completed_at <= datetime('now', ?)
      AND b.completed_at >= datetime('now', '-60 days')
      AND NOT EXISTS (
        SELECT 1 FROM bookings nb WHERE nb.tenant_id = b.tenant_id AND nb.customer_phone = b.customer_phone
          AND (nb.status = 'confirmed' OR (nb.status = 'completed' AND nb.completed_at > b.completed_at))
      )
    ORDER BY b.completed_at ASC
    LIMIT 20
  `).all(tenant.id, `-${config.followup_days} days`);

  for (const b of rows) {
    // Marca antes de enviar: nunca manda duas vezes, mesmo se o envio falhar no meio
    db.prepare('UPDATE bookings SET followup_sent = 1 WHERE id = ?').run(b.id);
    try {
      const message = fillTemplate(config.followup_message, {
        cliente: firstName(b.customer_full_name),
        barbearia: tenant.name,
        dias: String(config.followup_days),
        servico: b.item_name || '',
        link: bookingLink(tenant)
      });
      await waProvider.sendText(instance, b.customer_phone, message);
      console.log(`[automacoes] retorno enviado (${tenant.name}, agendamento ${b.id})`);
    } catch (err) {
      console.error(`[automacoes] retorno falhou (agendamento ${b.id}):`, err.message);
    }
    await new Promise(r => setTimeout(r, 2500));
  }
}

// ==================== 2. Pedido de avaliacao ====================

const STAR_OPTIONS = [
  { n: 5, title: '⭐⭐⭐⭐⭐ Excelente' },
  { n: 4, title: '⭐⭐⭐⭐ Muito bom' },
  { n: 3, title: '⭐⭐⭐ Bom' },
  { n: 2, title: '⭐⭐ Regular' },
  { n: 1, title: '⭐ Ruim' }
];

async function runReviewRequests(tenant, config, instance) {
  if (!config.review_enabled) return;
  const rows = db.prepare(`
    SELECT b.*, br.name AS barber_name FROM bookings b
    LEFT JOIN barbers br ON br.id = b.barber_id
    LEFT JOIN reviews r ON r.booking_id = b.id
    WHERE b.tenant_id = ? AND b.status = 'completed' AND b.review_requested_at IS NULL AND r.id IS NULL
      AND b.completed_at IS NOT NULL
      AND b.completed_at <= datetime('now', ?)
      AND b.completed_at >= datetime('now', '-2 days')
    LIMIT 20
  `).all(tenant.id, `-${config.review_delay_hours} hours`);

  for (const b of rows) {
    db.prepare("UPDATE bookings SET review_requested_at = datetime('now') WHERE id = ?").run(b.id);
    const text = `Olá, ${firstName(b.customer_full_name)}! 💈 Obrigado por escolher a *${tenant.name}*.\n\nComo foi seu atendimento${b.barber_name ? ` com ${b.barber_name}` : ''}? Toque abaixo e dê sua nota:`;
    const options = STAR_OPTIONS.map(o => ({ id: `avaliar_${b.id}_${o.n}`, title: o.title }));
    const fallback = `${text}\n\n${STAR_OPTIONS.map(o => `*${o.n}* — ${o.title}`).join('\n')}\n\nResponda com um número de *1 a 5*.`;
    try {
      await waProvider.sendInteractive(instance, b.customer_phone, 'list', {
        title: tenant.name,
        text,
        footer: tenant.name,
        buttonText: '⭐ Avaliar',
        sections: [{ title: 'Sua nota', rows: options.map(o => ({ id: o.id, title: o.title, description: '' })) }]
      }, fallback);
      console.log(`[automacoes] pedido de avaliação enviado (${tenant.name}, agendamento ${b.id})`);
    } catch (err) {
      console.error(`[automacoes] pedido de avaliação falhou (agendamento ${b.id}):`, err.message);
    }
    await new Promise(r => setTimeout(r, 2500));
  }
}

// Resposta do cliente ao pedido de avaliacao. Chamado pelo webhook (ai-agent.js) ANTES da IA.
// text: texto normalizado ("[cliente tocou na opção] ... (id: avaliar_12_5)" ou "5").
// Retorna true se a mensagem era uma nota (e ja foi tratada).
async function handleReviewReply(tenant, instance, phone, text) {
  if (!isPro(tenant) || !getAutomations(tenant.id).review_enabled) return false;

  let bookingId = null;
  let rating = null;
  const tapped = String(text).match(/\(id: avaliar_(\d+)_([1-5])\)/);
  if (tapped) {
    bookingId = Number(tapped[1]);
    rating = Number(tapped[2]);
  } else {
    // Resposta so com o numero (quando a lista foi em texto)
    const digit = String(text).trim().match(/^([1-5])$/);
    if (!digit || !phone) return false;
    const variants = phoneVariants(phone);
    const pending = db.prepare(`
      SELECT b.id FROM bookings b LEFT JOIN reviews r ON r.booking_id = b.id
      WHERE b.tenant_id = ? AND r.id IS NULL AND b.review_requested_at IS NOT NULL
        AND b.review_requested_at >= datetime('now', ?)
        AND b.customer_phone IN (${variants.map(() => '?').join(',')})
      ORDER BY b.review_requested_at DESC LIMIT 1
    `).get(tenant.id, `-${REVIEW_REPLY_WINDOW_HOURS} hours`, ...variants);
    if (!pending) return false;
    bookingId = pending.id;
    rating = Number(digit[1]);
  }

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(bookingId, tenant.id);
  if (!booking) return false;

  const already = db.prepare('SELECT id FROM reviews WHERE booking_id = ?').get(booking.id);
  if (already) {
    await waProvider.sendText(instance, phone, 'Você já avaliou esse atendimento. Obrigado! 🙏').catch(() => {});
    return true;
  }
  db.prepare('INSERT INTO reviews (tenant_id, booking_id, rating, comment) VALUES (?, ?, ?, ?)').run(tenant.id, booking.id, rating, null);

  const reply = rating >= 4
    ? `Muito obrigado pela nota ${'⭐'.repeat(rating)}! 🙌 Ficamos felizes em te atender. Até a próxima na *${tenant.name}*! 💈`
    : `Obrigado pela sinceridade (${'⭐'.repeat(rating)}). 🙏 Vamos usar sua opinião para melhorar. Se quiser contar o que aconteceu, é só responder por aqui.`;
  await waProvider.sendText(instance, phone, reply).catch(() => {});

  // Nota baixa: avisa o dono na hora
  if (rating <= 3) {
    try {
      require('./gestor-notify').notifyBooking(tenant.id, booking.id, 'avaliacao_baixa', { rating });
    } catch (_) {}
  }
  console.log(`[automacoes] avaliação ${rating}★ recebida (${tenant.name}, agendamento ${booking.id})`);
  return true;
}

function phoneVariants(phone) {
  const n = String(phone || '').replace(/\D/g, '');
  const list = [n];
  if (n.startsWith('55') && n.length === 12 && /[6-9]/.test(n[4])) list.push(n.slice(0, 4) + '9' + n.slice(4));
  if (n.startsWith('55') && n.length === 13 && n[4] === '9') list.push(n.slice(0, 4) + n.slice(5));
  return list;
}

// ==================== 3. Aniversario ====================

async function runBirthdays(tenant, config, instance, now) {
  if (!config.birthday_enabled) return;
  const rows = db.prepare(`
    SELECT * FROM users
    WHERE tenant_id = ? AND birth_date IS NOT NULL AND substr(birth_date, 6, 5) = ?
      AND COALESCE(birthday_sent_year, 0) < ? AND phone IS NOT NULL AND phone != ''
    LIMIT 50
  `).all(tenant.id, now.md, now.year);

  for (const u of rows) {
    db.prepare('UPDATE users SET birthday_sent_year = ? WHERE id = ?').run(now.year, u.id);
    try {
      const message = fillTemplate(config.birthday_message, {
        cliente: firstName(u.full_name),
        barbearia: tenant.name,
        link: bookingLink(tenant)
      });
      await waProvider.sendText(instance, u.phone, message);
      console.log(`[automacoes] parabéns enviado (${tenant.name}, cliente ${u.id})`);
    } catch (err) {
      console.error(`[automacoes] parabéns falhou (cliente ${u.id}):`, err.message);
    }
    await new Promise(r => setTimeout(r, 2500));
  }
}

// ==================== Agendador ====================

let running = false;

async function runAutomations() {
  if (running) return;
  running = true;
  try {
    const now = nowBR();
    if (now.hour < SEND_FROM_HOUR || now.hour >= SEND_UNTIL_HOUR) return;
    const { checkTenantActive } = require('./tenant');
    for (const tenant of proTenants()) {
      if (!checkTenantActive(tenant).ok) continue; // assinatura vencida ou suspensa
      const config = getAutomations(tenant.id);
      if (!config.followup_enabled && !config.review_enabled && !config.birthday_enabled) continue;
      const instance = connectedInstance(tenant.id);
      if (!instance) continue;
      try {
        await runReviewRequests(tenant, config, instance);
        await runFollowups(tenant, config, instance);
        await runBirthdays(tenant, config, instance, now);
      } catch (err) {
        console.error(`[automacoes] erro na barbearia ${tenant.id}:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

function startAutomationsScheduler() {
  // Primeira rodada 1 min depois de subir; depois a cada 10 min
  setTimeout(() => runAutomations().catch(e => console.error('[automacoes]', e.message)), 60 * 1000);
  setInterval(() => runAutomations().catch(e => console.error('[automacoes]', e.message)), 10 * 60 * 1000);
}

module.exports = {
  DEFAULT_AUTOMATIONS,
  isPro,
  getAutomations,
  saveAutomations,
  handleReviewReply,
  runAutomations,
  startAutomationsScheduler,
  formatDateBR
};
