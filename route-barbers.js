const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');
const { makeUpload } = require('./image-upload');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, 'uploads', 'barbers');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = makeUpload(UPLOAD_DIR);

function deletePhotoFile(photoUrl) {
  if (!photoUrl) return;
  const filename = path.basename(photoUrl);
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filePath, () => {});
}

// Publico (usado pela pagina de agendamento do cliente) - ver route-public.js
// Aqui ficam so as rotas do gestor (autenticadas, escopadas pelo tenant dele)
router.use(requireManager, requireActiveTenant);

router.get('/', (req, res) => {
  const barbers = db.prepare('SELECT * FROM barbers WHERE tenant_id = ? ORDER BY id ASC').all(req.tenantId);
  res.json(barbers);
});

router.get('/:id', (req, res) => {
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!barber) return res.status(404).json({ error: 'Barbeiro nao encontrado' });
  res.json(barber);
});

router.post('/', upload.single('photo'), (req, res) => {
  const name = (req.body.name || '').trim();
  const specialty = (req.body.specialty || '').trim() || null;

  if (!name || name.length < 3) return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });

  const photoUrl = req.file ? `/uploads/barbers/${req.file.filename}` : null;

  const result = db.prepare('INSERT INTO barbers (tenant_id, name, specialty, photo_url) VALUES (?, ?, ?, ?)')
    .run(req.tenantId, name, specialty, photoUrl);
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(barber);
});

router.put('/:id', upload.single('photo'), (req, res) => {
  const existing = db.prepare('SELECT * FROM barbers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Barbeiro nao encontrado' });

  const name = (req.body.name || '').trim();
  const specialty = (req.body.specialty || '').trim() || null;
  if (!name || name.length < 3) return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });

  let photoUrl = existing.photo_url;
  if (req.file) {
    deletePhotoFile(existing.photo_url);
    photoUrl = `/uploads/barbers/${req.file.filename}`;
  }

  db.prepare('UPDATE barbers SET name = ?, specialty = ?, photo_url = ? WHERE id = ? AND tenant_id = ?')
    .run(name, specialty, photoUrl, req.params.id, req.tenantId);

  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.params.id);
  res.json(barber);
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM barbers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Barbeiro nao encontrado' });

  deletePhotoFile(existing.photo_url);
  db.prepare('DELETE FROM barbers WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);
  res.json({ ok: true });
});

module.exports = router;
