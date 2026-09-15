const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

const PAYMENT_METHODS = ['dinheiro', 'pix', 'cartao'];

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().split('T')[0];
}

// ---- Planos ----
router.get('/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM subscription_plans WHERE tenant_id = ? ORDER BY id ASC').all(req.tenantId);
  res.json(plans.map(p => ({ ...p, active: !!p.active })));
});

router.post('/plans', (req, res) => {
  const { name, price, description } = req.body || {};
  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome do plano inválido' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Preço inválido' });

  const result = db.prepare('INSERT INTO subscription_plans (tenant_id, name, price, description) VALUES (?, ?, ?, ?)')
    .run(req.tenantId, name.trim(), price, (description || '').trim());
  res.status(201).json(db.prepare('SELECT * FROM subscription_plans WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/plans/:id', (req, res) => {
  const { name, price, description, active } = req.body || {};
  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome do plano inválido' });
  if (!price || price <= 0) return res.status(400).json({ error: 'Preço inválido' });

  const info = db.prepare('UPDATE subscription_plans SET name = ?, price = ?, description = ?, active = ? WHERE id = ? AND tenant_id = ?')
    .run(name.trim(), price, (description || '').trim(), active === false ? 0 : 1, req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Plano não encontrado' });

  res.json(db.prepare('SELECT * FROM subscription_plans WHERE id = ?').get(req.params.id));
});

router.delete('/plans/:id', (req, res) => {
  const info = db.prepare('DELETE FROM subscription_plans WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Plano não encontrado' });
  res.json({ ok: true });
});

// ---- Assinaturas de clientes ----
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT cs.id, cs.status, cs.started_at, cs.next_billing_date,
           u.id AS user_id, u.full_name, u.phone,
           p.id AS plan_id, p.name AS plan_name, p.price AS plan_price
    FROM client_subscriptions cs
    JOIN users u ON u.id = cs.user_id
    JOIN subscription_plans p ON p.id = cs.plan_id
    WHERE cs.tenant_id = ?
    ORDER BY cs.status ASC, cs.next_billing_date ASC
  `).all(req.tenantId);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

  res.json(rows.map(r => ({
    id: r.id,
    status: r.status,
    started_at: r.started_at,
    next_billing_date: r.next_billing_date,
    overdue: r.status === 'active' && r.next_billing_date < today,
    client: { id: r.user_id, full_name: r.full_name, phone: r.phone },
    plan: { id: r.plan_id, name: r.plan_name, price: r.plan_price }
  })));
});

router.post('/', (req, res) => {
  const { user_id, plan_id } = req.body || {};
  if (!user_id || !plan_id) return res.status(400).json({ error: 'Informe o cliente e o plano' });

  const user = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(user_id, req.tenantId);
  if (!user) return res.status(400).json({ error: 'Cliente inválido' });
  const plan = db.prepare('SELECT * FROM subscription_plans WHERE id = ? AND tenant_id = ?').get(plan_id, req.tenantId);
  if (!plan) return res.status(400).json({ error: 'Plano inválido' });

  const existing = db.prepare("SELECT id FROM client_subscriptions WHERE tenant_id = ? AND user_id = ? AND status = 'active'").get(req.tenantId, user_id);
  if (existing) return res.status(409).json({ error: 'Este cliente já possui uma assinatura ativa' });

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const nextBilling = addMonths(today, 1);

  const result = db.prepare(`
    INSERT INTO client_subscriptions (tenant_id, user_id, plan_id, status, started_at, next_billing_date)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(req.tenantId, user_id, plan_id, today, nextBilling);

  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id/cancel', (req, res) => {
  const info = db.prepare("UPDATE client_subscriptions SET status = 'cancelled' WHERE id = ? AND tenant_id = ?")
    .run(req.params.id, req.tenantId);
  if (info.changes === 0) return res.status(404).json({ error: 'Assinatura não encontrada' });
  res.json({ ok: true });
});

// Gestor registra que recebeu o pagamento do mes (na maquininha, pix ou dinheiro) - avanca a proxima cobranca em 1 mes
router.post('/:id/payments', (req, res) => {
  const { payment_method, amount } = req.body || {};
  if (!PAYMENT_METHODS.includes(payment_method)) return res.status(400).json({ error: 'Forma de pagamento inválida' });

  const sub = db.prepare('SELECT cs.*, p.price AS plan_price FROM client_subscriptions cs JOIN subscription_plans p ON p.id = cs.plan_id WHERE cs.id = ? AND cs.tenant_id = ?')
    .get(req.params.id, req.tenantId);
  if (!sub) return res.status(404).json({ error: 'Assinatura não encontrada' });

  const finalAmount = Number(amount) > 0 ? Number(amount) : sub.plan_price;

  db.prepare('INSERT INTO subscription_payments (tenant_id, client_subscription_id, amount, payment_method) VALUES (?, ?, ?, ?)')
    .run(req.tenantId, sub.id, finalAmount, payment_method);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const baseDate = sub.next_billing_date < today ? today : sub.next_billing_date;
  const newNextBilling = addMonths(baseDate, 1);

  db.prepare("UPDATE client_subscriptions SET next_billing_date = ?, status = 'active' WHERE id = ?").run(newNextBilling, sub.id);

  res.status(201).json({ ok: true, next_billing_date: newNextBilling });
});

router.get('/:id/payments', (req, res) => {
  const sub = db.prepare('SELECT id FROM client_subscriptions WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!sub) return res.status(404).json({ error: 'Assinatura não encontrada' });

  const payments = db.prepare('SELECT * FROM subscription_payments WHERE client_subscription_id = ? ORDER BY paid_at DESC').all(req.params.id);
  res.json(payments);
});

module.exports = router;
