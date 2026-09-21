const express = require('express');
const { db } = require('./db');
const { getTenantBySlug, checkTenantActive } = require('./tenant');
const { sendBookingConfirmation } = require('./whatsapp');
const { normalizePhone } = require('./phone');
const { tryApplyReward, getLoyaltyStatus, getLoyaltyConfig } = require('./loyalty');

const router = express.Router({ mergeParams: true });

const TENANT_ERROR_MESSAGES = {
  not_found: 'Barbearia não encontrada.',
  suspended: 'Esta barbearia está com o acesso suspenso no momento.',
  expired: 'O acesso desta barbearia está temporariamente indisponível.'
};

// Resolve o tenant a partir do :slug na URL e bloqueia se suspenso/vencido/inexistente
function loadTenant(req, res, next) {
  const tenant = getTenantBySlug(req.params.slug);
  const check = checkTenantActive(tenant);
  if (!check.ok) {
    const status = check.reason === 'not_found' ? 404 : 403;
    return res.status(status).json({ error: TENANT_ERROR_MESSAGES[check.reason] });
  }
  req.tenant = tenant;
  req.tenantId = tenant.id;
  next();
}

router.use('/:slug', loadTenant);

router.get('/:slug/info', (req, res) => {
  res.json({ id: req.tenant.id, name: req.tenant.name, slug: req.tenant.slug });
});

router.get('/:slug/services', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE tenant_id = ? ORDER BY id ASC').all(req.tenantId);
  res.json(services);
});

router.get('/:slug/packages', (req, res) => {
  const packages = db.prepare('SELECT id, name, price FROM packages WHERE tenant_id = ? AND active = 1 ORDER BY id ASC').all(req.tenantId);
  const withServices = packages.map(pkg => {
    const services = db.prepare(`
      SELECT s.id, s.name, s.duration
      FROM package_services ps
      JOIN services s ON s.id = ps.service_id
      WHERE ps.package_id = ?
    `).all(pkg.id);
    return { ...pkg, services, total_duration: services.reduce((sum, s) => sum + s.duration, 0) };
  });
  res.json(withServices);
});

router.get('/:slug/barbers', (req, res) => {
  const barbers = db.prepare('SELECT * FROM barbers WHERE tenant_id = ? ORDER BY id ASC').all(req.tenantId);
  res.json(barbers);
});

router.get('/:slug/settings', (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE tenant_id = ? AND key IN ('schedule_config', 'interval_time', 'banner_url', 'logo_url', 'tagline', 'gallery', 'cover_images', 'shop_profile', 'theme')").all(req.tenantId);
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });

  // Datas especificas em que a barbearia nao vai abrir (feriado, viagem, imprevisto).
  // So envia as de hoje em diante - datas passadas nao interessam pro calendario do cliente.
  const today = new Date().toISOString().slice(0, 10);
  result.blocked_dates = db.prepare('SELECT date, reason FROM blocked_dates WHERE tenant_id = ? AND date >= ? ORDER BY date ASC').all(req.tenantId, today);

  res.json(result);
});

// Cores de cada tema, usadas para colorir a tela de splash do PWA instalado (mesma paleta do client.js)
const THEME_COLORS = {
  ouro_negro: { bg: '#0e0c0a', accent: '#c6a15b' },
  meia_noite: { bg: '#0a0e14', accent: '#6f9bc7' },
  esmeralda: { bg: '#0a120e', accent: '#4f9d6e' },
  grafite: { bg: '#121212', accent: '#c17d4f' },
  marfim: { bg: '#f5f0e6', accent: '#8a5a3a' },
  vinho_tinto: { bg: '#170a0c', accent: '#c9a15c' },
  petroleo: { bg: '#07141a', accent: '#c97a4d' },
  roxo_real: { bg: '#120a18', accent: '#caa06a' },
  preto_neon: { bg: '#0a0a0a', accent: '#39e6a0' },
  areia_dourada: { bg: '#faf6ee', accent: '#b8863a' },
  cinza_urbano: { bg: '#f4f4f4', accent: '#1c1c1c' },
  azul_nautico: { bg: '#f2f6fa', accent: '#2f5d8a' },
  verde_salvia: { bg: '#f4f7f1', accent: '#5c8a52' },
  aurora: { bg: '#120a1c', accent: '#6fd8c9' },
  por_do_sol: { bg: '#1a0e10', accent: '#e8935a' },
  oceano_profundo: { bg: '#04121c', accent: '#4fa8d8' },
  neon_cyber: { bg: '#0c0616', accent: '#ff5fd1' }
};

// Manifesto do PWA, gerado na hora com o nome, logo e cores da barbearia — permite "Instalar app"
router.get('/:slug/manifest.json', (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE tenant_id = ? AND key IN ('logo_url', 'theme')").all(req.tenantId);
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });

  const colors = THEME_COLORS[settings.theme] || THEME_COLORS.ouro_negro;
  const icons = settings.logo_url
    ? [
        { src: settings.logo_url, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: settings.logo_url, sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    : [
        { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
      ];

  res.set('Content-Type', 'application/manifest+json');
  res.json({
    name: req.tenant.name,
    short_name: req.tenant.name.slice(0, 20),
    description: `Agende seu horário na ${req.tenant.name}`,
    start_url: `/${req.tenant.slug}`,
    scope: `/${req.tenant.slug}`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: colors.bg,
    theme_color: colors.bg,
    icons
  });
});

// Progresso de fidelidade do cliente (mostrado na pagina publica, sem precisar de login)
router.get('/:slug/loyalty/status', (req, res) => {
  const { phone } = req.query;
  const config = getLoyaltyConfig(req.tenantId);
  if (!config.enabled) return res.json({ enabled: false });

  if (!phone) return res.json({ enabled: true, mode: config.mode, threshold: config.threshold, progress: 0, remaining: config.threshold, reward_description: config.reward_description, ready: false });

  const user = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND phone = ?').get(req.tenantId, normalizePhone(phone));
  res.json(getLoyaltyStatus(req.tenantId, user ? user.id : null));
});

// Cliente consulta os proprios agendamentos digitando o telefone (sem precisar de login)
router.get('/:slug/bookings/lookup', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Informe o telefone' });

  const normalizedPhone = normalizePhone(phone);
  const rows = db.prepare(`
    SELECT b.id, b.booking_date, b.booking_time, b.status,
           s.name AS service_name, s.price AS service_price,
           br.name AS barber_name,
           r.id AS review_id
    FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id
    LEFT JOIN barbers br ON br.id = b.barber_id
    LEFT JOIN reviews r ON r.booking_id = b.id
    WHERE b.tenant_id = ? AND b.customer_phone = ?
    ORDER BY b.booking_date DESC, b.booking_time DESC
    LIMIT 30
  `).all(req.tenantId, normalizedPhone);

  res.json(rows.map(row => ({
    ...row,
    can_review: row.status === 'completed' && !row.review_id,
    has_review: !!row.review_id
  })));
});

// Cliente avalia um atendimento - so permitido se o gestor ja marcou como concluido,
// se o telefone bate com o do agendamento, e se ainda nao existe avaliacao pra ele
router.post('/:slug/bookings/:id/review', (req, res) => {
  const { phone, rating, comment } = req.body || {};

  if (!phone) return res.status(400).json({ error: 'Informe o telefone' });
  const ratingNum = parseInt(rating);
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) return res.status(400).json({ error: 'Nota deve ser de 1 a 5' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!booking) return res.status(404).json({ error: 'Agendamento não encontrado' });

  if (normalizePhone(phone) !== booking.customer_phone) {
    return res.status(403).json({ error: 'Telefone não corresponde a este agendamento' });
  }
  if (booking.status !== 'completed') {
    return res.status(400).json({ error: 'Este atendimento ainda não foi concluído' });
  }

  const existing = db.prepare('SELECT id FROM reviews WHERE booking_id = ?').get(booking.id);
  if (existing) return res.status(409).json({ error: 'Este atendimento já foi avaliado' });

  db.prepare('INSERT INTO reviews (tenant_id, booking_id, rating, comment) VALUES (?, ?, ?, ?)')
    .run(req.tenantId, booking.id, ratingNum, (comment || '').trim().slice(0, 500));

  res.status(201).json({ ok: true });
});

router.get('/:slug/bookings/availability', (req, res) => {
  const { date, barberId } = req.query;
  if (!date || !barberId) return res.status(400).json({ error: 'Informe date e barberId' });

  const rows = db.prepare(`
    SELECT b.booking_time, COALESCE(b.item_duration, s.duration) AS duration
    FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id
    WHERE b.tenant_id = ? AND b.booking_date = ? AND b.barber_id = ? AND b.status = 'confirmed'
  `).all(req.tenantId, date, barberId);

  res.json(rows);
});

router.post('/:slug/bookings', async (req, res) => {
  const { customer_full_name, customer_phone, service_id, package_id, barber_id, booking_date, booking_time } = req.body || {};

  if (!customer_full_name || customer_full_name.trim().length < 3) {
    return res.status(400).json({ error: 'Nome completo invalido' });
  }
  if (!customer_phone) return res.status(400).json({ error: 'Telefone invalido' });
  if ((!service_id && !package_id) || !booking_date || !booking_time) {
    return res.status(400).json({ error: 'Dados do agendamento incompletos' });
  }

  const blocked = db.prepare('SELECT 1 FROM blocked_dates WHERE tenant_id = ? AND date = ?').get(req.tenantId, booking_date);
  if (blocked) {
    return res.status(400).json({ error: 'A barbearia não vai abrir nessa data. Escolha outro dia.' });
  }

  // Um agendamento e ou um servico avulso, ou um pacote - nunca os dois
  let service = null;
  let pkg = null;
  let itemName, itemPrice, itemDuration, effectiveServiceId;

  if (package_id) {
    pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND tenant_id = ? AND active = 1').get(package_id, req.tenantId);
    if (!pkg) return res.status(400).json({ error: 'Pacote inválido' });

    const pkgServices = db.prepare(`
      SELECT s.id, s.duration FROM package_services ps JOIN services s ON s.id = ps.service_id WHERE ps.package_id = ?
    `).all(pkg.id);
    if (!pkgServices.length) return res.status(400).json({ error: 'Pacote sem serviços configurados' });

    itemName = pkg.name;
    itemPrice = pkg.price;
    itemDuration = pkgServices.reduce((sum, s) => sum + s.duration, 0);
    effectiveServiceId = pkgServices[0].id; // mantem a FK valida; o nome/preco reais vem de item_name/item_price
  } else {
    service = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(service_id, req.tenantId);
    if (!service) return res.status(400).json({ error: 'Serviço inválido' });

    itemName = service.name;
    itemPrice = service.price;
    itemDuration = service.duration;
    effectiveServiceId = service.id;
  }

  const barber = barber_id ? db.prepare('SELECT * FROM barbers WHERE id = ? AND tenant_id = ?').get(barber_id, req.tenantId) : null;

  // Cadastra (ou reconhece) o cliente automaticamente pelo telefone, dentro desta barbearia.
  // Assim toda pessoa que agenda pelo link público já aparece em "Gerenciar Clientes" do gestor,
  // e da próxima vez que agendar com o mesmo telefone, é reconhecida como o mesmo cliente.
  const finalName = customer_full_name.trim();
  const finalPhone = normalizePhone(customer_phone);
  if (!finalPhone) return res.status(400).json({ error: 'Telefone invalido' });

  let user = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND phone = ?').get(req.tenantId, finalPhone);
  if (user) {
    if (user.full_name !== finalName) {
      db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(finalName, user.id);
    }
  } else {
    const userResult = db.prepare('INSERT INTO users (tenant_id, full_name, phone) VALUES (?, ?, ?)')
      .run(req.tenantId, finalName, finalPhone);
    user = { id: userResult.lastInsertRowid };
  }

  const result = db.prepare(`
    INSERT INTO bookings (tenant_id, user_id, customer_full_name, customer_phone, service_id, package_id, item_name, item_price, item_duration, barber_id, booking_date, booking_time, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
  `).run(req.tenantId, user.id, finalName, finalPhone, effectiveServiceId, pkg ? pkg.id : null, itemName, itemPrice, itemDuration, barber_id || null, booking_date, booking_time);

  // Fidelidade: se o cliente ja atingiu a meta, aplica o desconto/gratuidade automaticamente neste agendamento
  const reward = tryApplyReward(req.tenantId, user.id, itemPrice);
  if (reward.discount > 0) {
    db.prepare('UPDATE bookings SET discount_applied = ?, reward_label = ? WHERE id = ?')
      .run(reward.discount, reward.label, result.lastInsertRowid);
  }

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json({
    id: booking.id,
    booking_date: booking.booking_date,
    booking_time: booking.booking_time,
    status: booking.status,
    discount_applied: booking.discount_applied || 0,
    reward_label: booking.reward_label || null,
    final_price: Math.max(0, itemPrice - (booking.discount_applied || 0))
  });

  // Dispara a confirmação por WhatsApp em segundo plano (nunca atrasa nem quebra a resposta do agendamento)
  sendBookingConfirmation({
    tenant: req.tenant,
    booking,
    clientName: finalName,
    clientPhone: finalPhone,
    serviceName: itemName,
    servicePrice: Math.max(0, itemPrice - (booking.discount_applied || 0)),
    barberName: barber ? barber.name : null
  });

  // Notifica o painel do gestor em tempo real (mesmo mecanismo usado no admin)
  try {
    require('./events').broadcastBookingChange(req.tenantId, 'INSERT', { id: booking.id, status: booking.status });
  } catch (_) { /* SSE é best-effort */ }
});

module.exports = router;
