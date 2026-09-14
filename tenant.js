const { db } = require('./db');

// Retorna { ok: true } ou { ok: false, reason } explicando por que a barbearia esta bloqueada.
// "Vencido" so bloqueia a partir do dia seguinte ao vencimento (o dia do vencimento ainda funciona).
function checkTenantActive(tenant) {
  if (!tenant) return { ok: false, reason: 'not_found' };
  if (tenant.status === 'suspended') return { ok: false, reason: 'suspended' };

  if (tenant.subscription_expires_at) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
    if (tenant.subscription_expires_at < today) {
      return { ok: false, reason: 'expired' };
    }
  }

  return { ok: true };
}

function getTenantBySlug(slug) {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
}

function getTenantById(id) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

// Middleware para rotas do gestor (ja autenticado, req.tenantId definido por requireManager)
function requireActiveTenant(req, res, next) {
  const tenant = getTenantById(req.tenantId);
  const check = checkTenantActive(tenant);
  if (!check.ok) {
    const messages = {
      not_found: 'Barbearia não encontrada.',
      suspended: 'Acesso suspenso. Fale com o suporte para regularizar.',
      expired: 'Assinatura vencida. Fale com o suporte para renovar o acesso.'
    };
    return res.status(403).json({ error: messages[check.reason] || 'Acesso bloqueado' });
  }
  req.tenant = tenant;
  next();
}

module.exports = { checkTenantActive, getTenantBySlug, getTenantById, requireActiveTenant };
