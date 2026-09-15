const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');
const { getLoyaltyConfig, saveLoyaltyConfig } = require('./loyalty');

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

const GALLERY_DIR = path.join(__dirname, 'uploads', 'gallery');
if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });

const galleryStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, GALLERY_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const uploadGalleryPhoto = multer({
  storage: galleryStorage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Arquivo deve ser uma imagem'));
    cb(null, true);
  }
});

const MAX_GALLERY_PHOTOS = 8;

function getGallery(tenantId) {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'gallery'").get(tenantId);
  if (!row?.value) return [];
  try { return JSON.parse(row.value); } catch { return []; }
}

function saveGallery(tenantId, gallery) {
  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, 'gallery', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(tenantId, JSON.stringify(gallery));
}

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

// Galeria de fotos (varias imagens, uma por upload, mostradas em carrossel na pagina do cliente)
router.get('/gallery', (req, res) => {
  res.json({ photos: getGallery(req.tenantId) });
});

router.post('/gallery', uploadGalleryPhoto.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie uma imagem' });

  const gallery = getGallery(req.tenantId);
  if (gallery.length >= MAX_GALLERY_PHOTOS) {
    fs.unlink(path.join(GALLERY_DIR, req.file.filename), () => {});
    return res.status(400).json({ error: `Máximo de ${MAX_GALLERY_PHOTOS} fotos na galeria` });
  }

  gallery.push(`/uploads/gallery/${req.file.filename}`);
  saveGallery(req.tenantId, gallery);
  res.status(201).json({ photos: gallery });
});

router.delete('/gallery', (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Informe a url da foto' });

  const gallery = getGallery(req.tenantId).filter(p => p !== url);
  saveGallery(req.tenantId, gallery);
  fs.unlink(path.join(GALLERY_DIR, path.basename(url)), () => {});
  res.json({ photos: gallery });
});

// Perfil da barbearia: comodidades, formas de pagamento, redes sociais, contato e endereco
router.put('/profile', (req, res) => {
  const { amenities, payment_methods, social, phone, address } = req.body || {};

  const profile = {
    amenities: amenities && typeof amenities === 'object' ? amenities : {},
    payment_methods: Array.isArray(payment_methods) ? payment_methods : [],
    social: social && typeof social === 'object' ? {
      whatsapp: social.whatsapp || '',
      instagram: social.instagram || '',
      facebook: social.facebook || ''
    } : { whatsapp: '', instagram: '', facebook: '' },
    phone: phone || '',
    address: address || ''
  };

  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, 'shop_profile', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(req.tenantId, JSON.stringify(profile));

  res.json({ ok: true });
});

// Configuracao do programa de fidelidade
router.get('/loyalty', (req, res) => {
  res.json(getLoyaltyConfig(req.tenantId));
});

router.put('/loyalty', (req, res) => {
  const { enabled, mode, threshold, points_per_currency, reward_type, reward_value, reward_description } = req.body || {};

  if (mode && !['stamps', 'points'].includes(mode)) return res.status(400).json({ error: 'Modo inválido' });
  if (reward_type && !['free_service', 'discount_percent', 'discount_fixed'].includes(reward_type)) {
    return res.status(400).json({ error: 'Tipo de recompensa inválido' });
  }
  if (threshold !== undefined && (!Number.isFinite(Number(threshold)) || Number(threshold) <= 0)) {
    return res.status(400).json({ error: 'Meta deve ser um número maior que zero' });
  }

  const config = {
    enabled: !!enabled,
    mode: mode || 'stamps',
    threshold: Number(threshold) || 10,
    points_per_currency: Number(points_per_currency) || 1,
    reward_type: reward_type || 'free_service',
    reward_value: Number(reward_value) || 0,
    reward_description: (reward_description || '').trim() || 'Recompensa'
  };

  saveLoyaltyConfig(req.tenantId, config);
  res.json({ ok: true });
});

module.exports = router;
