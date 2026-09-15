const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');
const { broadcastBookingChange } = require('./events');
const { addProgressOnCompletion } = require('./loyalty');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

const JOIN_SELECT = `
  SELECT
    b.id, b.user_id, b.customer_full_name, b.customer_phone,
    b.service_id, b.package_id, b.item_name, b.item_price, b.item_duration, b.barber_id, b.booking_date, b.booking_time,
    b.status, b.whatsapp_sent, b.discount_applied, b.reward_label, b.created_at,
    s.name AS service_name, s.price AS service_price, s.duration AS service_duration,
    br.name AS barber_name,
    u.full_name AS user_full_name, u.phone AS user_phone, u.email AS user_email
  FROM bookings b
  LEFT JOIN services s ON s.id = b.service_id
  LEFT JOIN barbers br ON br.id = b.barber_id
  LEFT JOIN users u ON u.id = b.user_id
  WHERE b.tenant_id = ?
`;

function toBookingJson(row) {
  // item_name/item_price/item_duration existem em todo agendamento criado depois do modulo de Pacotes;
  // agendamentos antigos (antes da migracao) caem no fallback dos dados do servico avulso.
  const name = row.item_name || row.service_name;
  const price = row.item_price != null ? row.item_price : row.service_price;
  const duration = row.item_duration != null ? row.item_duration : row.service_duration;

  return {
    id: row.id,
    user_id: row.user_id,
    customer_full_name: row.customer_full_name,
    customer_phone: row.customer_phone,
    service_id: row.service_id,
    package_id: row.package_id,
    is_package: !!row.package_id,
    barber_id: row.barber_id,
    booking_date: row.booking_date,
    booking_time: row.booking_time,
    status: row.status,
    whatsapp_sent: !!row.whatsapp_sent,
    discount_applied: row.discount_applied || 0,
    reward_label: row.reward_label || null,
    created_at: row.created_at,
    services: name ? { name, price, duration } : null,
    barbers: row.barber_id ? { name: row.barber_name } : null,
    users: row.user_id ? { full_name: row.user_full_name, phone: row.user_phone, email: row.user_email } : null
  };
}

router.get('/', (req, res) => {
  const { date, status, start, end } = req.query;

  let sql = JOIN_SELECT;
  const params = [req.tenantId];

  if (date) {
    sql += ' AND b.booking_date = ?';
    params.push(date);
  }
  if (start && end) {
    sql += ' AND b.booking_date >= ? AND b.booking_date <= ?';
    params.push(start, end);
  }
  if (status && status !== 'all') {
    sql += ' AND b.status = ?';
    params.push(status);
  }

  sql += ' ORDER BY b.booking_time DESC';

  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(toBookingJson));
});

router.patch('/:id/status', (req, res) => {
  const { status } = req.body || {};
  const allowed = ['confirmed', 'completed', 'cancelled', 'pending'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status invalido' });

  const before = db.prepare('SELECT status, user_id, service_id, item_price, discount_applied FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!before) return res.status(404).json({ error: 'Agendamento nao encontrado' });

  const info = db.prepare('UPDATE bookings SET status = ? WHERE id = ? AND tenant_id = ?').run(status, req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Agendamento nao encontrado' });

  // Fidelidade: soma progresso do cliente só na transição para 'completed' (evita contar 2x se marcar de novo)
  if (status === 'completed' && before.status !== 'completed' && before.user_id) {
    let originalPrice = before.item_price;
    if (originalPrice == null) {
      const service = db.prepare('SELECT price FROM services WHERE id = ?').get(before.service_id);
      originalPrice = service?.price || 0;
    }
    const paidPrice = Math.max(0, originalPrice - (before.discount_applied || 0));
    addProgressOnCompletion(req.tenantId, before.user_id, paidPrice);
  }

  const row = db.prepare(JOIN_SELECT + ' AND b.id = ?').get(req.tenantId, req.params.id);
  const booking = toBookingJson(row);
  broadcastBookingChange(req.tenantId, 'UPDATE', booking);
  res.json(booking);
});

router.delete('/:id', (req, res) => {
  const row = db.prepare(JOIN_SELECT + ' AND b.id = ?').get(req.tenantId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Agendamento nao encontrado' });

  db.prepare('DELETE FROM bookings WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);
  broadcastBookingChange(req.tenantId, 'DELETE', toBookingJson(row));
  res.json({ ok: true });
});

module.exports = router;
