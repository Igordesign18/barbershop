const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');
const { normalizePhone } = require('./phone');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

router.get('/', (req, res) => {
  const nameFilter = (req.query.name || '').toLowerCase();

  const users = db.prepare('SELECT id, full_name, email, phone, created_at FROM users WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenantId);
  const filtered = nameFilter
    ? users.filter(u => (u.full_name || '').toLowerCase().includes(nameFilter))
    : users;

  const withStats = filtered.map(user => {
    const bookings = db.prepare('SELECT status FROM bookings WHERE user_id = ? AND tenant_id = ?').all(user.id, req.tenantId);
    return {
      ...user,
      totalBookings: bookings.length,
      completedBookings: bookings.filter(b => b.status === 'completed').length
    };
  });

  res.json(withStats);
});

router.get('/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!client) return res.status(404).json({ error: 'Cliente nao encontrado' });
  res.json(client);
});

router.post('/', (req, res) => {
  const { full_name, email, phone } = req.body || {};
  if (!full_name || full_name.trim().length < 3) return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalido' });
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'Telefone invalido' });

  const normalizedPhone = normalizePhone(phone);
  const existing = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND phone = ?').get(req.tenantId, normalizedPhone);
  if (existing) return res.status(409).json({ error: 'Já existe um cliente cadastrado com esse telefone' });

  const result = db.prepare('INSERT INTO users (tenant_id, full_name, email, phone) VALUES (?, ?, ?, ?)')
    .run(req.tenantId, full_name.trim(), email.trim(), normalizedPhone);

  res.status(201).json(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const { full_name, email, phone } = req.body || {};
  if (!full_name || full_name.trim().length < 3) return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalido' });
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'Telefone invalido' });

  const normalizedPhone = normalizePhone(phone);
  const duplicate = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND phone = ? AND id != ?').get(req.tenantId, normalizedPhone, req.params.id);
  if (duplicate) return res.status(409).json({ error: 'Já existe outro cliente cadastrado com esse telefone' });

  const info = db.prepare('UPDATE users SET full_name = ?, email = ?, phone = ? WHERE id = ? AND tenant_id = ?')
    .run(full_name.trim(), email.trim(), normalizedPhone, req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Cliente nao encontrado' });

  res.json(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Cliente nao encontrado' });

  db.prepare('DELETE FROM bookings WHERE user_id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);
  db.prepare('DELETE FROM users WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);

  res.json({ ok: true });
});

module.exports = router;
