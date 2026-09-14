const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

router.get('/', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE tenant_id = ? ORDER BY id ASC').all(req.tenantId);
  res.json(services);
});

router.get('/:id', (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!service) return res.status(404).json({ error: 'Servico nao encontrado' });
  res.json(service);
});

router.post('/', (req, res) => {
  const { name, price, duration } = req.body || {};
  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome do servico invalido' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Preco invalido' });
  if (!duration || duration < 15) return res.status(400).json({ error: 'Duracao minima: 15 minutos' });

  const result = db.prepare('INSERT INTO services (tenant_id, name, price, duration) VALUES (?, ?, ?, ?)')
    .run(req.tenantId, name.trim(), price, duration);
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(service);
});

router.put('/:id', (req, res) => {
  const { name, price, duration } = req.body || {};
  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome do servico invalido' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Preco invalido' });
  if (!duration || duration < 15) return res.status(400).json({ error: 'Duracao minima: 15 minutos' });

  const info = db.prepare('UPDATE services SET name = ?, price = ?, duration = ? WHERE id = ? AND tenant_id = ?')
    .run(name.trim(), price, duration, req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Servico nao encontrado' });

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  res.json(service);
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM services WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Servico nao encontrado' });
  res.json({ ok: true });
});

module.exports = router;
