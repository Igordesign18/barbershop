const express = require('express');
const { db } = require('./db');
const { getTenantBySlug, checkTenantActive } = require('./tenant');
const { sendBookingConfirmation } = require('./whatsapp');
const { normalizePhone } = require('./phone');

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

router.get('/:slug/barbers', (req, res) => {
  const barbers = db.prepare('SELECT * FROM barbers WHERE tenant_id = ? ORDER BY id ASC').all(req.tenantId);
  res.json(barbers);
});

router.get('/:slug/settings', (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE tenant_id = ? AND key IN ('schedule_config', 'interval_time')").all(req.tenantId);
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  res.json(result);
});

router.get('/:slug/bookings/availability', (req, res) => {
  const { date, barberId } = req.query;
  if (!date || !barberId) return res.status(400).json({ error: 'Informe date e barberId' });

  const rows = db.prepare(`
    SELECT b.booking_time, s.duration AS duration
    FROM bookings b
    LEFT JOIN services s ON s.id = b.service_id
    WHERE b.tenant_id = ? AND b.booking_date = ? AND b.barber_id = ? AND b.status = 'confirmed'
  `).all(req.tenantId, date, barberId);

  res.json(rows);
});

router.post('/:slug/bookings', async (req, res) => {
  const { customer_full_name, customer_phone, service_id, barber_id, booking_date, booking_time } = req.body || {};

  if (!customer_full_name || customer_full_name.trim().length < 3) {
    return res.status(400).json({ error: 'Nome completo invalido' });
  }
  if (!customer_phone) return res.status(400).json({ error: 'Telefone invalido' });
  if (!service_id || !booking_date || !booking_time) {
    return res.status(400).json({ error: 'Dados do agendamento incompletos' });
  }

  const service = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(service_id, req.tenantId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido' });

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
    INSERT INTO bookings (tenant_id, user_id, customer_full_name, customer_phone, service_id, barber_id, booking_date, booking_time, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
  `).run(req.tenantId, user.id, finalName, finalPhone, service_id, barber_id || null, booking_date, booking_time);

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json({
    id: booking.id,
    booking_date: booking.booking_date,
    booking_time: booking.booking_time,
    status: booking.status
  });

  // Dispara a confirmação por WhatsApp em segundo plano (nunca atrasa nem quebra a resposta do agendamento)
  sendBookingConfirmation({
    tenant: req.tenant,
    booking,
    clientName: finalName,
    clientPhone: finalPhone,
    serviceName: service.name,
    servicePrice: service.price,
    barberName: barber ? barber.name : null
  });

  // Notifica o painel do gestor em tempo real (mesmo mecanismo usado no admin)
  try {
    require('./events').broadcastBookingChange(req.tenantId, 'INSERT', { id: booking.id, status: booking.status });
  } catch (_) { /* SSE é best-effort */ }
});

module.exports = router;
