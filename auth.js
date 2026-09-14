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

module.exports = { signToken, requireAuth, requireManager, requireSuperAdmin, JWT_SECRET };
