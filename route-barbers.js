const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');
const { makeUpload } = require('./image-upload');
const barberServices = require('./barber-services');

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
  res.json(barberServices.withServiceIds(barbers));
});

// ==================== Bloqueio de agenda (folgas) do barbeiro ====================
const BLOCK_PERIODS = ['', 'manha', 'tarde', 'noite'];
const BLOCK_LABELS = { '': 'Dia inteiro', manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };

function ownBarber(req) {
  return db.prepare('SELECT id FROM barbers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
}

router.get('/:id/blocks', (req, res) => {
  if (!ownBarber(req)) return res.status(404).json({ error: 'Barbeiro nao encontrado' });
  const today = new Date().toISOString().slice(0, 10);
  res.json(db.prepare('SELECT id, date, period, reason FROM barber_blocked_dates WHERE barber_id = ? AND date >= ? ORDER BY date ASC, period ASC').all(req.params.id, today));
});

// Bloqueia um dia (ou um periodo de dias, com end_date) e opcionalmente so um turno
router.post('/:id/blocks', (req, res) => {
  if (!ownBarber(req)) return res.status(404).json({ error: 'Barbeiro nao encontrado' });
  const { date, end_date, reason } = req.body || {};
  const period = BLOCK_PERIODS.includes(req.body?.period) ? req.body.period : '';
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(new Date(v + 'T12:00:00Z'));
  if (!isDate(date)) return res.status(400).json({ error: 'Informe uma data válida' });
  const last = end_date ? end_date : date;
  if (!isDate(last) || last < date) return res.status(400).json({ error: 'A data final deve ser igual ou depois da inicial' });

  const days = [];
  for (let d = new Date(date + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= last && days.length < 91; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  if (days.length > 90) return res.status(400).json({ error: 'Máximo de 90 dias de uma vez' });

  const cleanReason = String(reason || '').trim().slice(0, 120) || null;
  const ins = db.prepare('INSERT OR IGNORE INTO barber_blocked_dates (tenant_id, barber_id, date, period, reason) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  db.transaction(() => { for (const day of days) added += ins.run(req.tenantId, req.params.id, day, period, cleanReason).changes; })();
  if (!added) return res.status(400).json({ error: `${BLOCK_LABELS[period]} já estava bloqueado nesse(s) dia(s)` });
  res.status(201).json({ ok: true, added });
});

router.delete('/:id/blocks/:blockId', (req, res) => {
  if (!ownBarber(req)) return res.status(404).json({ error: 'Barbeiro nao encontrado' });
  const info = db.prepare('DELETE FROM barber_blocked_dates WHERE id = ? AND barber_id = ? AND tenant_id = ?').run(req.params.blockId, req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Bloqueio não encontrado' });
  res.json({ ok: true });
});

router.get('/:id', (req, res) => {
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!barber) return res.status(404).json({ error: 'Barbeiro nao encontrado' });
  res.json({ ...barber, service_ids: barberServices.getServiceIds(barber.id), service_durations: barberServices.getDurations(barber.id) });
});

// WhatsApp do barbeiro para avisos: so digitos, com DDD (10 ou 11) ou ja com 55. Invalido/vazio = sem aviso.
function cleanPhone(value) {
  const n = String(value || '').replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) return '55' + n;
  if (n.startsWith('55') && (n.length === 12 || n.length === 13)) return n;
  return null;
}

router.post('/', upload.single('photo'), (req, res) => {
  const name = (req.body.name || '').trim();
  const specialty = (req.body.specialty || '').trim() || null;

  if (!name || name.length < 3) return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });

  const photoUrl = req.file ? `/uploads/barbers/${req.file.filename}` : null;

  const notifyPhone = cleanPhone(req.body.notify_phone);
  if (String(req.body.notify_phone || '').replace(/\D/g, '') && !notifyPhone) return res.status(400).json({ error: 'WhatsApp do barbeiro inválido. Use DDD + número.' });

  const result = db.prepare('INSERT INTO barbers (tenant_id, name, specialty, photo_url, notify_phone) VALUES (?, ?, ?, ?, ?)')
    .run(req.tenantId, name, specialty, photoUrl, notifyPhone);
  // Servicos que o barbeiro faz (vazio = todos)
  const serviceIds = barberServices.setServiceIds(req.tenantId, result.lastInsertRowid, barberServices.parseIds(req.body.service_ids));
  const durations = barberServices.setDurations(req.tenantId, result.lastInsertRowid, barberServices.parseDurations(req.body.service_durations));
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ ...barber, service_ids: serviceIds, service_durations: durations });
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

  // WhatsApp para avisos: so mexe se o formulario mandou o campo (vazio = remove)
  let notifyPhone = existing.notify_phone;
  if (req.body.notify_phone !== undefined) {
    notifyPhone = cleanPhone(req.body.notify_phone);
    if (String(req.body.notify_phone || '').replace(/\D/g, '') && !notifyPhone) return res.status(400).json({ error: 'WhatsApp do barbeiro inválido. Use DDD + número.' });
  }

  db.prepare('UPDATE barbers SET name = ?, specialty = ?, photo_url = ?, notify_phone = ? WHERE id = ? AND tenant_id = ?')
    .run(name, specialty, photoUrl, notifyPhone, req.params.id, req.tenantId);

  // So mexe nos servicos se o formulario mandou o campo
  const ids = barberServices.parseIds(req.body.service_ids);
  if (ids !== undefined) barberServices.setServiceIds(req.tenantId, req.params.id, ids);

  // Tempo proprio por servico: so mexe se o formulario mandou o campo
  const durs = barberServices.parseDurations(req.body.service_durations);
  if (durs !== undefined) barberServices.setDurations(req.tenantId, req.params.id, durs);

  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.params.id);
  res.json({ ...barber, service_ids: barberServices.getServiceIds(barber.id), service_durations: barberServices.getDurations(barber.id) });
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM barbers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Barbeiro nao encontrado' });

  deletePhotoFile(existing.photo_url);
  db.prepare('DELETE FROM barbers WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);
  res.json({ ok: true });
});

module.exports = router;
