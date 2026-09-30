// Super admin: controle de revendedores (cadastro, comissao, clientes, cobrancas, repasses, precos e avisos).
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { requireSuperAdmin } = require('./auth');
const { getSystemSetting, setSystemSetting } = require('./system-settings');
const R = require('./resellers');

const router = express.Router();
router.use(requireSuperAdmin);

function handle(fn) {
  return (req, res) => {
    try { fn(req, res); }
    catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[super admin/revendedores] erro:', err);
      res.status(500).json({ error: 'Erro interno. Tente novamente.' });
    }
  };
}

function getReseller(id) {
  return db.prepare('SELECT * FROM resellers WHERE id = ?').get(id);
}

// ---------- Resumo geral ----------
router.get('/overview', handle((req, res) => {
  res.json(R.overview());
}));

// ---------- Configuracoes: preco dos planos e WhatsApp do dono ----------
router.get('/settings', handle((req, res) => {
  res.json({ prices: R.getPrices(), owner_notify_phone: getSystemSetting('owner_notify_phone') || '' });
}));

router.put('/settings', handle((req, res) => {
  const { price_basic, price_pro, owner_notify_phone } = req.body || {};
  const prices = R.setPrices({ basic: price_basic, pro: price_pro });
  if (owner_notify_phone !== undefined) {
    const digits = String(owner_notify_phone || '').replace(/\D/g, '');
    if (digits && !R.cleanPhone(owner_notify_phone)) return res.status(400).json({ error: 'WhatsApp inválido. Use DDD + número.' });
    setSystemSetting('owner_notify_phone', digits ? R.cleanPhone(owner_notify_phone) : null);
  }
  res.json({ prices, owner_notify_phone: getSystemSetting('owner_notify_phone') || '' });
}));

// ---------- Avisos ----------
router.get('/notifications', handle((req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const items = db.prepare(`
    SELECT n.*, r.name AS reseller_name FROM owner_notifications n LEFT JOIN resellers r ON r.id = n.reseller_id
    ORDER BY n.id DESC LIMIT ?`).all(limit);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM owner_notifications WHERE read_at IS NULL').get().n;
  res.json({ items, unread });
}));

router.post('/notifications/read', handle((req, res) => {
  db.prepare("UPDATE owner_notifications SET read_at = datetime('now') WHERE read_at IS NULL").run();
  res.json({ ok: true });
}));

// ---------- Cobrancas (todas) ----------
router.get('/charges', handle((req, res) => {
  const stage = ['cobrar', 'repassar', 'repassado'].includes(req.query.stage) ? req.query.stage : undefined;
  const resellerId = req.query.reseller_id ? Number(req.query.reseller_id) : undefined;
  res.json(R.listCharges({ resellerId, stage }));
}));

// O dono confirma (value: true) ou desfaz (false) o recebimento do repasse
router.post('/charges/:id/repassed', handle((req, res) => {
  res.json(R.setRepassed(Number(req.params.id), (req.body || {}).value !== false));
}));

// ---------- Revendedores ----------
router.get('/', handle((req, res) => {
  res.json(R.overview().resellers);
}));

router.post('/', handle((req, res) => {
  const reseller = R.createReseller(req.body || {});
  res.status(201).json({ ...R.publicReseller(reseller), stats: R.resellerStats(reseller.id) });
}));

router.get('/:id', handle((req, res) => {
  const reseller = getReseller(req.params.id);
  if (!reseller) return res.status(404).json({ error: 'Revendedor não encontrado' });
  res.json({
    reseller: R.publicReseller(reseller),
    stats: R.resellerStats(reseller.id),
    clients: R.listClients(reseller.id),
    charges: R.listCharges({ resellerId: reseller.id })
  });
}));

router.put('/:id', handle((req, res) => {
  const reseller = getReseller(req.params.id);
  if (!reseller) return res.status(404).json({ error: 'Revendedor não encontrado' });
  const { name, email, phone, commission_percent, status, password, apply_to_clients } = req.body || {};

  const finalName = name !== undefined ? String(name).trim() : reseller.name;
  if (finalName.length < 2) return res.status(400).json({ error: 'Nome do revendedor inválido' });

  let finalEmail = reseller.email;
  if (email !== undefined && String(email).trim().toLowerCase() !== reseller.email.toLowerCase()) {
    finalEmail = String(email).trim().toLowerCase();
    if (!finalEmail.includes('@')) return res.status(400).json({ error: 'Email inválido' });
    if (R.emailInUse(finalEmail, { resellerId: reseller.id })) return res.status(409).json({ error: 'Já existe um login com esse email' });
  }

  let finalPhone = reseller.phone;
  if (phone !== undefined) {
    finalPhone = R.cleanPhone(phone);
    if (String(phone).replace(/\D/g, '') && !finalPhone) return res.status(400).json({ error: 'WhatsApp inválido. Use DDD + número.' });
  }

  let finalPct = reseller.commission_percent;
  if (commission_percent !== undefined && commission_percent !== '') {
    finalPct = R.validCommission(commission_percent);
    if (finalPct === null) return res.status(400).json({ error: 'Comissão inválida (0 a 100%)' });
  }

  const finalStatus = ['active', 'suspended'].includes(status) ? status : reseller.status;

  let hash = reseller.password_hash;
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
    hash = bcrypt.hashSync(String(password), 10);
  }

  db.transaction(() => {
    db.prepare('UPDATE resellers SET name = ?, email = ?, phone = ?, commission_percent = ?, status = ?, password_hash = ? WHERE id = ?')
      .run(finalName, finalEmail, finalPhone, finalPct, finalStatus, hash, reseller.id);
    // Nova comissao vale para clientes novos. "Aplicar aos clientes atuais" muda os antigos daqui pra frente
    // (cobrancas ainda nao pagas sao recalculadas; as ja pagas nao mudam).
    if (apply_to_clients && finalPct !== reseller.commission_percent) {
      db.prepare('UPDATE tenants SET commission_percent = ? WHERE reseller_id = ?').run(finalPct, reseller.id);
      for (const t of db.prepare('SELECT id FROM tenants WHERE reseller_id = ?').all(reseller.id)) R.recalcOpenCharges(t.id);
    }
  })();

  res.json({ ...R.publicReseller(getReseller(reseller.id)), stats: R.resellerStats(reseller.id) });
}));

// O dono recebeu tudo junto: confirma todos os repasses pendentes deste revendedor
router.post('/:id/repass-all', handle((req, res) => {
  if (!getReseller(req.params.id)) return res.status(404).json({ error: 'Revendedor não encontrado' });
  res.json({ ok: true, confirmed: R.repassAllFor(Number(req.params.id)) });
}));

// So exclui revendedor "vazio". Com clientes ou historico financeiro, o certo e suspender.
router.delete('/:id', handle((req, res) => {
  const reseller = getReseller(req.params.id);
  if (!reseller) return res.status(404).json({ error: 'Revendedor não encontrado' });
  const tenants = db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE reseller_id = ?').get(reseller.id).n;
  const charges = db.prepare('SELECT COUNT(*) AS n FROM reseller_charges WHERE reseller_id = ?').get(reseller.id).n;
  if (tenants || charges) {
    return res.status(409).json({ error: 'Este revendedor tem clientes ou histórico financeiro e não pode ser excluído. Suspenda a conta para bloquear o acesso.' });
  }
  db.prepare('DELETE FROM resellers WHERE id = ?').run(reseller.id);
  res.json({ ok: true });
}));

module.exports = router;
