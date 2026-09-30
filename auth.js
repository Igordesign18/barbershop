const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-troque-em-producao';

function signToken(payload) {
  // payload: { sub, email, role: 'superadmin' | 'manager', tenant_id }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

// Aceita o token tanto no header Authorization: Bearer quanto em ?token=
// (necessario porque o EventSource do SSE e o <img> do QR code nao mandam headers customizados)
function getTokenFromRequest(req) {
  const header = req.headers.authorization || '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  return headerToken || req.query.token || null;
}

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Nao autenticado' });

  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

// Só gestor (dono de barbearia). Preenche req.tenantId para as rotas usarem.
function requireManager(req, res, next) {
  requireAuth(req, res, () => {
    if (req.auth.role !== 'manager' || !req.auth.tenant_id) {
      return res.status(403).json({ error: 'Acesso restrito ao gestor da barbearia' });
    }
    req.tenantId = req.auth.tenant_id;
    next();
  });
}

// Só você (super admin).
function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.auth.role !== 'superadmin') {
      return res.status(403).json({ error: 'Acesso restrito ao super admin' });
    }
    next();
  });
}

// So revendedor. Confere no banco a cada chamada: revendedor suspenso/excluido perde o acesso na hora
// (nao espera o token de 7 dias vencer). Preenche req.resellerId e req.reseller.
function requireReseller(req, res, next) {
  requireAuth(req, res, () => {
    if (req.auth.role !== 'reseller' || !req.auth.reseller_id) {
      return res.status(403).json({ error: 'Acesso restrito ao revendedor' });
    }
    const { db } = require('./db');
    const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.auth.reseller_id);
    if (!reseller) return res.status(401).json({ error: 'Conta de revendedor não encontrada' });
    if (reseller.status !== 'active') return res.status(403).json({ error: 'Conta suspensa. Fale com o suporte.' });
    req.resellerId = reseller.id;
    req.reseller = reseller;
    next();
  });
}

module.exports = { signToken, requireAuth, requireManager, requireSuperAdmin, requireReseller, JWT_SECRET };
