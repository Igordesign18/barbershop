const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

const UPLOAD_DIR = path.join(__dirname, 'uploads', 'banners');
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
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Arquivo deve ser uma imagem'));
    cb(null, true);
  }
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE tenant_id = ?').all(req.tenantId);
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  res.json(result);
});

router.put('/', (req, res) => {
  const { schedule_config, interval_time } = req.body || {};
  if (!schedule_config || !interval_time) {
    return res.status(400).json({ error: 'Informe schedule_config e interval_time' });
  }

  const upsert = db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `);
  upsert.run(req.tenantId, 'schedule_config', JSON.stringify(schedule_config));
  upsert.run(req.tenantId, 'interval_time', String(interval_time));

  res.json({ ok: true });
});

// Banner (foto de capa) e frase de efeito da pagina publica da barbearia
router.put('/branding', upload.single('banner'), (req, res) => {
  const tagline = (req.body.tagline || '').trim();

  const upsert = db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `);

  if (req.file) {
    const existing = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'banner_url'").get(req.tenantId);
    if (existing?.value) {
      const oldPath = path.join(UPLOAD_DIR, path.basename(existing.value));
      fs.unlink(oldPath, () => {});
    }
    upsert.run(req.tenantId, 'banner_url', `/uploads/banners/${req.file.filename}`);
  }

  if (req.body.tagline !== undefined) {
    upsert.run(req.tenantId, 'tagline', tagline);
  }

  res.json({ ok: true });
});

router.delete('/branding/banner', (req, res) => {
  const existing = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'banner_url'").get(req.tenantId);
  if (existing?.value) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(existing.value)), () => {});
  }
  db.prepare("DELETE FROM settings WHERE tenant_id = ? AND key = 'banner_url'").run(req.tenantId);
  res.json({ ok: true });
});

module.exports = router;
