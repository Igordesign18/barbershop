const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

function attachServices(pkg, tenantId) {
  const services = db.prepare(`
    SELECT s.id, s.name, s.price, s.duration
    FROM package_services ps
    JOIN services s ON s.id = ps.service_id
    WHERE ps.package_id = ? AND s.tenant_id = ?
  `).all(pkg.id, tenantId);
  return { ...pkg, active: !!pkg.active, services, total_duration: services.reduce((sum, s) => sum + s.duration, 0) };
}

router.get('/', (req, res) => {
  const packages = db.prepare('SELECT * FROM packages WHERE tenant_id = ? ORDER BY id ASC').all(req.tenantId);
  res.json(packages.map(p => attachServices(p, req.tenantId)));
});

router.post('/', (req, res) => {
  const { name, price, service_ids } = req.body || {};

  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome do pacote inválido' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Preço inválido' });
  if (!Array.isArray(service_ids) || service_ids.length < 2) {
    return res.status(400).json({ error: 'Selecione pelo menos 2 serviços para formar o pacote' });
  }

  const validServices = db.prepare(`SELECT id FROM services WHERE tenant_id = ? AND id IN (${service_ids.map(() => '?').join(',')})`)
    .all(req.tenantId, ...service_ids);
  if (validServices.length !== service_ids.length) return res.status(400).json({ error: 'Um ou mais serviços selecionados são inválidos' });

  const result = db.transaction(() => {
    const pkgResult = db.prepare('INSERT INTO packages (tenant_id, name, price) VALUES (?, ?, ?)').run(req.tenantId, name.trim(), price);
    const pkgId = pkgResult.lastInsertRowid;
    const insertLink = db.prepare('INSERT INTO package_services (package_id, service_id) VALUES (?, ?)');
    service_ids.forEach(sid => insertLink.run(pkgId, sid));
    return pkgId;
  })();

  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(result);
  res.status(201).json(attachServices(pkg, req.tenantId));
});

router.put('/:id', (req, res) => {
  const { name, price, service_ids, active } = req.body || {};
  const existing = db.prepare('SELECT * FROM packages WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Pacote não encontrado' });

  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome do pacote inválido' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Preço inválido' });
  if (!Array.isArray(service_ids) || service_ids.length < 2) {
    return res.status(400).json({ error: 'Selecione pelo menos 2 serviços para formar o pacote' });
  }

  const validServices = db.prepare(`SELECT id FROM services WHERE tenant_id = ? AND id IN (${service_ids.map(() => '?').join(',')})`)
    .all(req.tenantId, ...service_ids);
  if (validServices.length !== service_ids.length) return res.status(400).json({ error: 'Um ou mais serviços selecionados são inválidos' });

  db.transaction(() => {
    db.prepare('UPDATE packages SET name = ?, price = ?, active = ? WHERE id = ?')
      .run(name.trim(), price, active === false ? 0 : 1, req.params.id);
    db.prepare('DELETE FROM package_services WHERE package_id = ?').run(req.params.id);
    const insertLink = db.prepare('INSERT INTO package_services (package_id, service_id) VALUES (?, ?)');
    service_ids.forEach(sid => insertLink.run(req.params.id, sid));
  })();

  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  res.json(attachServices(pkg, req.tenantId));
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM packages WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Pacote não encontrado' });
  res.json({ ok: true });
});

module.exports = router;
