const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

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

module.exports = router;
