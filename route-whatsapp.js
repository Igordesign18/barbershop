const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');
const evolution = require('./evolution');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

router.get('/status', async (req, res) => {
  const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE tenant_id = ?').get(req.tenantId);
  if (!instance) return res.json({ status: 'disconnected' });

  if (!evolution.isConfigured()) {
    return res.json({ status: instance.status, warning: 'Evolution API não configurada no servidor' });
  }

  try {
    const state = await evolution.getConnectionState(instance.instance_name);
    const status = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';
    db.prepare('UPDATE whatsapp_instances SET status = ?, updated_at = datetime(\'now\') WHERE tenant_id = ?').run(status, req.tenantId);
    res.json({ status });
  } catch (err) {
    res.json({ status: instance.status, warning: err.message });
  }
});

// Cria a instancia (se ainda nao existir) e devolve o QR code para o gestor escanear
router.post('/connect', async (req, res) => {
  if (!evolution.isConfigured()) {
    return res.status(400).json({ error: 'Evolution API não configurada no servidor. Peça para o suporte preencher EVOLUTION_API_URL e EVOLUTION_API_KEY.' });
  }

  const instanceName = req.tenant.slug;
  let instance = db.prepare('SELECT * FROM whatsapp_instances WHERE tenant_id = ?').get(req.tenantId);

  try {
    let qrData;
    if (!instance) {
      const created = await evolution.createInstance(instanceName);
      db.prepare('INSERT INTO whatsapp_instances (tenant_id, instance_name, status) VALUES (?, ?, ?)')
        .run(req.tenantId, instanceName, 'connecting');
      qrData = created?.qrcode || created;
    } else {
      qrData = await evolution.getQrCode(instanceName);
      db.prepare('UPDATE whatsapp_instances SET status = ?, updated_at = datetime(\'now\') WHERE tenant_id = ?').run('connecting', req.tenantId);
    }

    const base64 = qrData?.base64 || qrData?.qrcode?.base64 || null;
    res.json({ qrcode_base64: base64, raw: base64 ? undefined : qrData });
  } catch (err) {
    res.status(502).json({ error: 'Erro ao falar com a Evolution API: ' + err.message });
  }
});

router.delete('/disconnect', async (req, res) => {
  const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE tenant_id = ?').get(req.tenantId);
  if (!instance) return res.json({ ok: true });

  try {
    if (evolution.isConfigured()) {
      await evolution.logoutInstance(instance.instance_name).catch(() => {});
    }
  } finally {
    db.prepare('UPDATE whatsapp_instances SET status = ?, updated_at = datetime(\'now\') WHERE tenant_id = ?').run('disconnected', req.tenantId);
  }

  res.json({ ok: true });
});

router.get('/template', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(req.tenantId, 'whatsapp_template');
  res.json({ template: row?.value || '' });
});

router.put('/template', (req, res) => {
  const { template } = req.body || {};
  if (!template || template.trim().length < 10) {
    return res.status(400).json({ error: 'Template inválido (muito curto)' });
  }

  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, 'whatsapp_template', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(req.tenantId, template.trim());

  res.json({ ok: true });
});

module.exports = router;
