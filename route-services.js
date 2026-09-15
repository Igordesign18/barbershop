const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

const UPLOAD_DIR = path.join(__dirname, 'uploads', 'services');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Arquivo deve ser uma imagem'));
    cb(null, true);
  }
});

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
