// Painel do REVENDEDOR (/revendedor): cria clientes, acompanha cobrancas e o que deve repassar.
// Tudo filtrado pelo revendedor logado: ele nunca enxerga barbearias nem cobrancas de outro.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { requireReseller } = require('./auth');
const R = require('./resellers');

const router = express.Router();
router.use(requireReseller);

function handle(fn) {
  return (req, res) => {
    try { fn(req, res); }
    catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[revendedor] erro:', err);
      res.status(500).json({ error: 'Erro interno. Tente novamente.' });
    }
  };
}

router.get('/me', handle((req, res) => {
  res.json({
    reseller: R.publicReseller(req.reseller),
    prices: R.getPrices(),
    lead_days: R.LEAD_DAYS
  });
}));

router.get('/summary', handle((req, res) => {
  res.json(R.resellerStats(req.resellerId));
}));

router.get('/clients', handle((req, res) => {
  res.json(R.listClients(req.resellerId));
}));

router.post('/clients', handle((req, res) => {
  const tenant = R.createClientForReseller(req.reseller, req.body);
  res.status(201).json(R.clientView(tenant, req.reseller));
}));

// Trocar a senha do gestor de um cliente dele ou o WhatsApp de avisos
router.put('/clients/:id', handle((req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ? AND reseller_id = ?').get(req.params.id, req.resellerId);
  if (!tenant) return res.status(404).json({ error: 'Cliente não encontrado' });
  const { manager_password, notify_phone } = req.body || {};

  if (manager_password !== undefined && manager_password !== '') {
    if (String(manager_password).length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
    const manager = db.prepare('SELECT id FROM managers WHERE tenant_id = ?').get(tenant.id);
    if (!manager) return res.status(404).json({ error: 'Gestor não encontrado para esse cliente' });
    db.prepare('UPDATE managers SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(manager_password), 10), manager.id);
  }
  if (notify_phone !== undefined) {
    const phone = R.cleanPhone(notify_phone);
    if (String(notify_phone).replace(/\D/g, '') && !phone) return res.status(400).json({ error: 'WhatsApp inválido. Use DDD + número.' });
    db.prepare('UPDATE tenants SET notify_phone = ? WHERE id = ?').run(phone, tenant.id);
  }
  res.json(R.clientView(db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id), req.reseller));
}));

router.get('/charges', handle((req, res) => {
  const stage = ['cobrar', 'repassar', 'repassado'].includes(req.query.stage) ? req.query.stage : undefined;
  res.json(R.listCharges({ resellerId: req.resellerId, stage }));
}));

// O cliente pagou o revendedor: registra e renova o acesso da barbearia
router.post('/charges/:id/client-paid', handle((req, res) => {
  res.json(R.markClientPaid(Number(req.params.id), req.resellerId));
}));

module.exports = router;
