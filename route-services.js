const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');
const { makeUpload } = require('./image-upload');
const barberServices = require('./barber-services');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

const UPLOAD_DIR = path.join(__dirname, 'uploads', 'services');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = makeUpload(UPLOAD_DIR);

router.get('/', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE tenant_id = ? ORDER BY id ASC').all(req.tenantId);
  res.json(services);
});

router.get('/:id', (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!service) return res.status(404).json({ error: 'Servico nao encontrado' });
  // Barbeiros que fazem este servico e o tempo proprio de cada um (null = usa o padrao)
  res.json({ ...service, barbers: barberServices.getBarberTimesForService(req.tenantId, service.id) });
});

router.post('/', (req, res) => {
  const { name, price, duration } = req.body || {};
  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome do servico invalido' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Preco invalido' });
  if (!duration || duration < 5) return res.status(400).json({ error: 'Duracao minima: 5 minutos' });

  const result = db.prepare('INSERT INTO services (tenant_id, name, price, duration) VALUES (?, ?, ?, ?)')
    .run(req.tenantId, name.trim(), price, duration);
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(service);
});

router.put('/:id', (req, res) => {
  const { name, price, duration } = req.body || {};
  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome do servico invalido' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Preco invalido' });
  if (!duration || duration < 5) return res.status(400).json({ error: 'Duracao minima: 5 minutos' });

  const info = db.prepare('UPDATE services SET name = ?, price = ?, duration = ? WHERE id = ? AND tenant_id = ?')
    .run(name.trim(), price, duration, req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Servico nao encontrado' });

  // Tempo proprio de cada barbeiro neste servico: so mexe se o painel mandou o campo
  if (req.body.barber_durations !== undefined) barberServices.setBarberTimesForService(req.tenantId, Number(req.params.id), req.body.barber_durations);

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  res.json(service);
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT photo_url FROM services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  const info = db.prepare('DELETE FROM services WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Servico nao encontrado' });
  if (existing?.photo_url) fs.unlink(path.join(UPLOAD_DIR, path.basename(existing.photo_url)), () => {});
  res.json({ ok: true });
});

// Foto do servico (aparece em circulo na pagina do cliente, ex: foto de um corte especifico)
router.post('/:id/photo', upload.single('photo'), (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!service) return res.status(404).json({ error: 'Servico nao encontrado' });
  if (!req.file) return res.status(400).json({ error: 'Envie uma imagem' });

  if (service.photo_url) fs.unlink(path.join(UPLOAD_DIR, path.basename(service.photo_url)), () => {});

  const photoUrl = `/uploads/services/${req.file.filename}`;
  db.prepare('UPDATE services SET photo_url = ? WHERE id = ?').run(photoUrl, req.params.id);
  res.json({ photo_url: photoUrl });
});

router.delete('/:id/photo', (req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!service) return res.status(404).json({ error: 'Servico nao encontrado' });

  if (service.photo_url) fs.unlink(path.join(UPLOAD_DIR, path.basename(service.photo_url)), () => {});
  db.prepare('UPDATE services SET photo_url = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
