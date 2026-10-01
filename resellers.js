// Revendedores: cadastro de clientes por revendedor, cobranca mensal recorrente, comissao e repasse.
//
// Como funciona o dinheiro (tudo em centavos, para nao ter erro de arredondamento):
// - Cada barbearia criada por um revendedor guarda o valor mensal do plano e a % de comissao NA HORA
//   da criacao (mudar o preco depois nao mexe nos clientes antigos).
// - Cada cliente gera uma cobranca por ciclo mensal (a partir do dia em que foi criado). A cobranca aparece
//   LEAD_DAYS dias antes do ciclo comecar, para dar tempo do revendedor cobrar.
// - Etapas de cada cobranca: a cobrar do cliente -> cliente pagou (o revendedor fica com a comissao e deve
//   repassar o resto ao dono) -> repassado (o dono confirma que recebeu).
// - "Cliente pagou" renova o acesso da barbearia ate o fim daquele ciclo.

const bcrypt = require('bcryptjs');
const { db, seedTenantDefaults } = require('./db');
const { getSystemSetting, setSystemSetting } = require('./system-settings');

const LEAD_DAYS = 5;
const DEFAULT_PRICES_CENTS = { basic: 2999, pro: 4999 };
const DEFAULT_COMMISSION = 40;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ==================== Datas ====================

function todayBR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Soma meses sem "estourar" o dia (31/01 + 1 mes = 28/02, e nao 03/03)
function addMonthsClamped(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (m - 1) + n;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// ==================== Precos e valores ====================

function planPriceCents(plan) {
  const key = plan === 'pro' ? 'pro' : 'basic';
  const saved = parseInt(getSystemSetting(`price_${key}_cents`), 10);
  return saved > 0 ? saved : DEFAULT_PRICES_CENTS[key];
}

function getPrices() {
  return { basic_cents: planPriceCents('basic'), pro_cents: planPriceCents('pro') };
}

// Recebe valores em reais (numero ou texto "29,99")
function toCents(value) {
  const n = Number(String(value).replace(',', '.'));
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}

function setPrices({ basic, pro }) {
  const b = basic !== undefined ? toCents(basic) : null;
  const p = pro !== undefined ? toCents(pro) : null;
  for (const [label, v] of [['Básico', b], ['PRO', p]]) {
    if (v !== null && (v < 100 || v > 1000000)) throw httpError(400, `Preço do plano ${label} inválido (entre R$ 1,00 e R$ 10.000,00)`);
  }
  if (b !== null) setSystemSetting('price_basic_cents', b);
  if (p !== null) setSystemSetting('price_pro_cents', p);
  return getPrices();
}

function splitAmount(amountCents, commissionPercent) {
  const commission = Math.round(amountCents * Number(commissionPercent) / 100);
  return { commission_cents: commission, owner_cents: amountCents - commission };
}

function validCommission(value) {
  const n = Number(String(value).replace(',', '.'));
  return isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null;
}

function brl(cents) {
  return 'R$ ' + (cents / 100).toFixed(2).replace('.', ',');
}

function formatDateBR(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}

// ==================== Cadastro ====================

function cleanPhone(value) {
  const n = String(value || '').replace(/\D/g, '');
  if (!n) return null;
  if (n.length === 10 || n.length === 11) return '55' + n;
  if (n.startsWith('55') && (n.length === 12 || n.length === 13)) return n;
  return null;
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// O login procura em super admin, gestores e revendedores: o mesmo email nao pode existir em dois lugares.
function emailInUse(email, ignore = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (db.prepare('SELECT 1 FROM super_admins WHERE LOWER(email) = ?').get(e)) return true;
  const m = db.prepare('SELECT id FROM managers WHERE LOWER(email) = ?').get(e);
  if (m && m.id !== ignore.managerId) return true;
  const r = db.prepare('SELECT id FROM resellers WHERE LOWER(email) = ?').get(e);
  if (r && r.id !== ignore.resellerId) return true;
  return false;
}

// Plano PRO ja nasce pronto: atendente IA ligado no modo lista (o cliente so conecta o WhatsApp).
// Nao sobrescreve configuracao que o gestor ja tenha salvo.
function applyPlanDefaults(tenantId, plan, { setProvider = false } = {}) {
  if (plan !== 'pro') return;
  if (setProvider) {
    const hasInstance = db.prepare('SELECT 1 FROM whatsapp_instances WHERE tenant_id = ?').get(tenantId);
    if (!hasInstance) db.prepare("UPDATE tenants SET whatsapp_provider = 'wuzapi' WHERE id = ?").run(tenantId);
  }
  const has = db.prepare("SELECT 1 FROM settings WHERE tenant_id = ? AND key = 'ai_config'").get(tenantId);
  if (!has) {
    const ai = require('./ai-agent');
    ai.saveAiConfig(tenantId, { ...ai.DEFAULT_AI_CONFIG, enabled: true, choice_format: 'list' });
  }
}

function publicReseller(r) {
  if (!r) return null;
  const { password_hash, ...pub } = r;
  return pub;
}

function createReseller({ name, email, password, phone, commission_percent }) {
  if (!name || String(name).trim().length < 2) throw httpError(400, 'Nome do revendedor inválido');
  const mail = String(email || '').trim().toLowerCase();
  if (!mail.includes('@')) throw httpError(400, 'Email do revendedor inválido');
  if (!password || String(password).length < 6) throw httpError(400, 'Senha deve ter pelo menos 6 caracteres');
  if (commission_percent === undefined || commission_percent === null || commission_percent === '') throw httpError(400, 'Informe a porcentagem de comissão do revendedor');
  const pct = validCommission(commission_percent);
  if (pct === null) throw httpError(400, 'Comissão inválida (0 a 100%)');
  if (phone && !cleanPhone(phone)) throw httpError(400, 'WhatsApp do revendedor inválido. Use DDD + número.');
  if (emailInUse(mail)) throw httpError(409, 'Já existe um login com esse email');

  const result = db.prepare('INSERT INTO resellers (name, email, password_hash, phone, commission_percent) VALUES (?, ?, ?, ?, ?)')
    .run(String(name).trim(), mail, bcrypt.hashSync(String(password), 10), cleanPhone(phone), pct);
  return db.prepare('SELECT * FROM resellers WHERE id = ?').get(result.lastInsertRowid);
}

// Cria a barbearia + login do gestor para um revendedor. `data`: name, slug, manager_email, manager_password, plan, notify_phone
function createClientForReseller(reseller, data) {
  const { name, slug, manager_email, manager_password, notify_phone } = data || {};
  const plan = data && data.plan === 'pro' ? 'pro' : 'basic';

  if (!name || String(name).trim().length < 3) throw httpError(400, 'Nome da barbearia inválido');
  if (!manager_email || !String(manager_email).includes('@')) throw httpError(400, 'Email do gestor inválido');
  if (!manager_password || String(manager_password).length < 6) throw httpError(400, 'Senha do gestor deve ter pelo menos 6 caracteres');
  if (notify_phone && !cleanPhone(notify_phone)) throw httpError(400, 'WhatsApp do gestor inválido. Use DDD + número.');

  const finalSlug = slugify(slug || name);
  if (!finalSlug) throw httpError(400, 'Não foi possível gerar um link (slug) válido');
  if (db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(finalSlug)) throw httpError(409, `Já existe uma barbearia usando o link "${finalSlug}"`);
  if (emailInUse(manager_email)) throw httpError(409, 'Já existe um login com esse email');

  const today = todayBR();
  const priceCents = planPriceCents(plan);

  const tenantId = db.transaction(() => {
    const t = db.prepare(`
      INSERT INTO tenants (name, slug, status, subscription_expires_at, plan, whatsapp_provider, notify_phone,
                           reseller_id, monthly_price_cents, commission_percent, billing_anchor)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(name).trim(), finalSlug, addMonthsClamped(today, 1), plan, 'wuzapi', cleanPhone(notify_phone),
      reseller.id, priceCents, reseller.commission_percent, today);
    const id = t.lastInsertRowid;
    db.prepare('INSERT INTO managers (tenant_id, email, password_hash) VALUES (?, ?, ?)')
      .run(id, String(manager_email).trim(), bcrypt.hashSync(String(manager_password), 10));
    seedTenantDefaults(id);
    applyPlanDefaults(id, plan, { setProvider: true });
    ensureChargesForTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(id));
    return id;
  })();

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  notifyOwner('novo_cliente', '🆕 Novo cliente de revendedor',
    [
      `👤 Revendedor: ${reseller.name}`,
      `💈 Barbearia: ${tenant.name}`,
      `📦 Plano: ${plan === 'pro' ? 'PRO (com IA)' : 'Básico'} · ${brl(priceCents)}/mês`,
      `💰 Comissão: ${reseller.commission_percent}% (${brl(splitAmount(priceCents, reseller.commission_percent).commission_cents)}/mês)`
    ].join('\n'), reseller.id);
  return tenant;
}

// ==================== Cobrancas ====================

// Gera (se ainda nao existir) a cobranca do ciclo atual do cliente. So para clientes ativos de revendedor.
function ensureChargesForTenant(t) {
  if (!t || !t.reseller_id || !t.billing_anchor || !t.monthly_price_cents || t.status !== 'active') return false;
  const today = todayBR();
  if (addDays(t.billing_anchor, -LEAD_DAYS) > today) return false;

  // Maior ciclo k cuja cobranca ja "abriu" (comeca em LEAD_DAYS dias)
  let k = 0;
  while (k < 1200 && addDays(addMonthsClamped(t.billing_anchor, k + 1), -LEAD_DAYS) <= today) k++;

  const start = addMonthsClamped(t.billing_anchor, k);
  const end = addMonthsClamped(t.billing_anchor, k + 1);
  const pct = t.commission_percent !== null && t.commission_percent !== undefined
    ? t.commission_percent
    : (db.prepare('SELECT commission_percent FROM resellers WHERE id = ?').get(t.reseller_id) || {}).commission_percent ?? DEFAULT_COMMISSION;
  const split = splitAmount(t.monthly_price_cents, pct);

  const info = db.prepare(`
    INSERT OR IGNORE INTO reseller_charges
      (reseller_id, tenant_id, tenant_name, plan, cycle_start, cycle_end, amount_cents, commission_percent, commission_cents, owner_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.reseller_id, t.id, t.name, t.plan, start, end, t.monthly_price_cents, pct, split.commission_cents, split.owner_cents);
  return info.changes > 0;
}

function ensureCharges() {
  let created = 0;
  for (const t of db.prepare('SELECT * FROM tenants WHERE reseller_id IS NOT NULL').all()) {
    try { if (ensureChargesForTenant(t)) created++; }
    catch (err) { console.error(`[revendedores] falha ao gerar cobrança (barbearia ${t.id}):`, err.message); }
  }
  return created;
}

function startChargesScheduler() {
  const run = () => { try { ensureCharges(); } catch (err) { console.error('[revendedores] erro no ciclo de cobranças:', err.message); } };
  run();
  setInterval(run, 60 * 60 * 1000);
}

function chargeView(c, today = todayBR()) {
  const stage = c.repassed_at ? 'repassado' : c.client_paid_at ? 'repassar' : 'cobrar';
  return {
    id: c.id,
    reseller_id: c.reseller_id,
    reseller_name: c.reseller_name,
    tenant_id: c.tenant_id,
    tenant_name: c.tenant_name,
    plan: c.plan,
    cycle_start: c.cycle_start,
    cycle_end: c.cycle_end,
    amount_cents: c.amount_cents,
    commission_percent: c.commission_percent,
    commission_cents: c.commission_cents,
    owner_cents: c.owner_cents,
    client_paid_at: c.client_paid_at,
    repassed_at: c.repassed_at,
    stage,                                                        // cobrar | repassar | repassado
    overdue: stage === 'cobrar' && c.cycle_end < today,           // cliente ainda nao pagou e o ciclo ja acabou
    deleted_tenant: c.tenant_id === null
  };
}

function listCharges({ resellerId, stage } = {}) {
  ensureCharges();
  let sql = `SELECT c.*, r.name AS reseller_name FROM reseller_charges c JOIN resellers r ON r.id = c.reseller_id WHERE 1=1`;
  const params = [];
  if (resellerId) { sql += ' AND c.reseller_id = ?'; params.push(resellerId); }
  if (stage === 'cobrar') sql += ' AND c.client_paid_at IS NULL';
  else if (stage === 'repassar') sql += ' AND c.client_paid_at IS NOT NULL AND c.repassed_at IS NULL';
  else if (stage === 'repassado') sql += ' AND c.repassed_at IS NOT NULL';
  sql += ' ORDER BY c.cycle_start DESC, c.id DESC';
  const today = todayBR();
  return db.prepare(sql).all(...params).map(c => chargeView(c, today));
}

// O cliente pagou o revendedor: registra e renova o acesso da barbearia ate o fim do ciclo pago.
// resellerId (opcional) garante que um revendedor so mexa nas proprias cobrancas.
function markClientPaid(chargeId, resellerId = null) {
  const c = db.prepare('SELECT c.*, r.name AS reseller_name FROM reseller_charges c JOIN resellers r ON r.id = c.reseller_id WHERE c.id = ?').get(chargeId);
  if (!c || (resellerId && c.reseller_id !== resellerId)) throw httpError(404, 'Cobrança não encontrada');
  if (c.client_paid_at) throw httpError(409, 'O pagamento desta cobrança já foi registrado');

  db.transaction(() => {
    db.prepare("UPDATE reseller_charges SET client_paid_at = datetime('now') WHERE id = ?").run(c.id);
    if (c.tenant_id) {
      const t = db.prepare('SELECT subscription_expires_at FROM tenants WHERE id = ?').get(c.tenant_id);
      // Sem vencimento definido = acesso livre: nao cria vencimento
      if (t && t.subscription_expires_at && t.subscription_expires_at < c.cycle_end) {
        db.prepare('UPDATE tenants SET subscription_expires_at = ? WHERE id = ?').run(c.cycle_end, c.tenant_id);
      }
    }
  })();

  notifyOwner('cliente_pagou', '💰 Cliente pagou o revendedor',
    [
      `👤 Revendedor: ${c.reseller_name}`,
      `💈 Barbearia: ${c.tenant_name}`,
      `🗓️ Ciclo: ${formatDateBR(c.cycle_start)} a ${formatDateBR(c.cycle_end)}`,
      `💵 Valor do cliente: ${brl(c.amount_cents)}`,
      `👉 ${c.reseller_name} deve repassar a você: *${brl(c.owner_cents)}*`
    ].join('\n'), c.reseller_id);
  return chargeView(db.prepare('SELECT c.*, r.name AS reseller_name FROM reseller_charges c JOIN resellers r ON r.id = c.reseller_id WHERE c.id = ?').get(c.id));
}

// O dono confirma que recebeu (ou desfaz a confirmacao) o repasse de uma cobranca
function setRepassed(chargeId, value) {
  const c = db.prepare('SELECT * FROM reseller_charges WHERE id = ?').get(chargeId);
  if (!c) throw httpError(404, 'Cobrança não encontrada');
  if (value) {
    if (!c.client_paid_at) throw httpError(400, 'O cliente ainda não pagou esta cobrança');
    db.prepare("UPDATE reseller_charges SET repassed_at = COALESCE(repassed_at, datetime('now')) WHERE id = ?").run(c.id);
  } else {
    db.prepare('UPDATE reseller_charges SET repassed_at = NULL WHERE id = ?').run(c.id);
  }
  return chargeView(db.prepare('SELECT c.*, r.name AS reseller_name FROM reseller_charges c JOIN resellers r ON r.id = c.reseller_id WHERE c.id = ?').get(c.id));
}

// Confirma de uma vez todos os repasses pendentes de um revendedor (o dono recebeu tudo junto)
function repassAllFor(resellerId) {
  const info = db.prepare("UPDATE reseller_charges SET repassed_at = datetime('now') WHERE reseller_id = ? AND client_paid_at IS NOT NULL AND repassed_at IS NULL").run(resellerId);
  return info.changes;
}

// ==================== Numeros (painel) ====================

const AGG_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN client_paid_at IS NULL THEN amount_cents END), 0) AS to_collect_cents,
    COALESCE(SUM(CASE WHEN client_paid_at IS NULL THEN 1 END), 0) AS to_collect_count,
    COALESCE(SUM(CASE WHEN client_paid_at IS NULL AND cycle_end < ? THEN 1 END), 0) AS overdue_count,
    COALESCE(SUM(CASE WHEN client_paid_at IS NOT NULL AND repassed_at IS NULL THEN owner_cents END), 0) AS to_repass_cents,
    COALESCE(SUM(CASE WHEN client_paid_at IS NOT NULL AND repassed_at IS NULL THEN 1 END), 0) AS to_repass_count,
    COALESCE(SUM(CASE WHEN repassed_at IS NOT NULL THEN owner_cents END), 0) AS repassed_cents,
    COALESCE(SUM(CASE WHEN client_paid_at IS NOT NULL THEN commission_cents END), 0) AS commission_earned_cents
  FROM reseller_charges`;

function resellerStats(resellerId) {
  ensureCharges();
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
  const tenants = db.prepare('SELECT * FROM tenants WHERE reseller_id = ?').all(resellerId);
  const active = tenants.filter(t => t.status === 'active');
  let mrr = 0, commissionMonth = 0;
  for (const t of active) {
    const price = t.monthly_price_cents || 0;
    const pct = t.commission_percent ?? (reseller ? reseller.commission_percent : DEFAULT_COMMISSION);
    mrr += price;
    commissionMonth += splitAmount(price, pct).commission_cents;
  }
  const agg = db.prepare(AGG_SQL + ' WHERE reseller_id = ?').get(todayBR(), resellerId);
  return {
    clients_total: tenants.length,
    clients_active: active.length,
    clients_pro: active.filter(t => t.plan === 'pro').length,
    clients_basic: active.filter(t => t.plan !== 'pro').length,
    mrr_cents: mrr,
    commission_month_cents: commissionMonth,
    owner_month_cents: mrr - commissionMonth,
    ...agg
  };
}

function overview() {
  ensureCharges();
  const resellers = db.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all();
  const rows = resellers.map(r => ({ ...publicReseller(r), stats: resellerStats(r.id) }));
  const totals = rows.reduce((a, r) => {
    for (const k of ['clients_total', 'clients_active', 'mrr_cents', 'commission_month_cents', 'owner_month_cents', 'to_collect_cents', 'to_repass_cents', 'repassed_cents', 'commission_earned_cents', 'overdue_count']) {
      a[k] = (a[k] || 0) + (r.stats[k] || 0);
    }
    return a;
  }, {});
  return { resellers_total: resellers.length, resellers_active: resellers.filter(r => r.status === 'active').length, totals, resellers: rows };
}

// ==================== Avisos para o dono ====================

function notifyOwner(type, title, message, resellerId = null) {
  try {
    db.prepare('INSERT INTO owner_notifications (type, title, message, reseller_id) VALUES (?, ?, ?, ?)').run(type, title, message, resellerId);
  } catch (err) {
    console.error('[revendedores] falha ao salvar aviso:', err.message);
  }
  try {
    require('./gestor-notify').notifyOwner(`*${title}*\n${message}`);
  } catch (err) {
    console.error('[revendedores] falha ao avisar no WhatsApp:', err.message);
  }
}

// ==================== Clientes do revendedor ====================

function clientView(t, reseller) {
  const manager = db.prepare('SELECT email FROM managers WHERE tenant_id = ?').get(t.id);
  const wa = db.prepare('SELECT status FROM whatsapp_instances WHERE tenant_id = ?').get(t.id);
  const pct = t.commission_percent ?? (reseller ? reseller.commission_percent : DEFAULT_COMMISSION);
  const price = t.monthly_price_cents || 0;
  const open = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN cycle_end < ? THEN 1 END), 0) AS overdue FROM reseller_charges WHERE tenant_id = ? AND client_paid_at IS NULL').get(todayBR(), t.id);
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan === 'pro' ? 'pro' : 'basic',
    status: t.status,
    subscription_expires_at: t.subscription_expires_at,
    monthly_price_cents: price,
    commission_percent: pct,
    commission_cents: splitAmount(price, pct).commission_cents,
    owner_cents: splitAmount(price, pct).owner_cents,
    manager_email: manager ? manager.email : null,
    notify_phone: t.notify_phone,
    whatsapp_status: wa ? wa.status : 'disconnected',
    created_at: t.created_at,
    open_charges: open.n,
    overdue_charges: open.overdue
  };
}

function listClients(resellerId) {
  ensureCharges();
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
  return db.prepare('SELECT * FROM tenants WHERE reseller_id = ? ORDER BY created_at DESC, id DESC').all(resellerId).map(t => clientView(t, reseller));
}

// Depois de mudar preco/comissao de um cliente: acerta as cobrancas que o cliente ainda nao pagou
// (as ja pagas ficam como estavam, e o historico nao muda).
function recalcOpenCharges(tenantId) {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  if (!t || !t.reseller_id || !t.monthly_price_cents) return 0;
  const reseller = db.prepare('SELECT commission_percent FROM resellers WHERE id = ?').get(t.reseller_id);
  const pct = t.commission_percent ?? (reseller ? reseller.commission_percent : DEFAULT_COMMISSION);
  const split = splitAmount(t.monthly_price_cents, pct);
  return db.prepare(`UPDATE reseller_charges SET amount_cents = ?, commission_percent = ?, commission_cents = ?, owner_cents = ?, plan = ?, tenant_name = ?
    WHERE tenant_id = ? AND client_paid_at IS NULL`).run(t.monthly_price_cents, pct, split.commission_cents, split.owner_cents, t.plan, t.name, tenantId).changes;
}

module.exports = {
  LEAD_DAYS, DEFAULT_COMMISSION,
  httpError, todayBR, addDays, addMonthsClamped,
  planPriceCents, getPrices, setPrices, splitAmount, validCommission, cleanPhone, slugify, brl,
  emailInUse, applyPlanDefaults, publicReseller,
  createReseller, createClientForReseller,
  ensureCharges, ensureChargesForTenant, startChargesScheduler,
  listCharges, chargeView, markClientPaid, setRepassed, repassAllFor,
  resellerStats, overview, notifyOwner,
  clientView, listClients, recalcOpenCharges
};
