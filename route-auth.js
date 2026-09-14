const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { signToken, requireAuth } = require('./auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Informe email e senha' });
  }

  // Tenta como super admin primeiro, depois como gestor de barbearia
  const superAdmin = db.prepare('SELECT * FROM super_admins WHERE email = ?').get(email);
  if (superAdmin && bcrypt.compareSync(password, superAdmin.password_hash)) {
    const token = signToken({ sub: superAdmin.id, email: superAdmin.email, role: 'superadmin' });
    return res.json({ token, role: 'superadmin', admin: { id: superAdmin.id, email: superAdmin.email } });
  }

  const manager = db.prepare('SELECT * FROM managers WHERE email = ?').get(email);
  if (manager && bcrypt.compareSync(password, manager.password_hash)) {
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(manager.tenant_id);
    const token = signToken({ sub: manager.id, email: manager.email, role: 'manager', tenant_id: manager.tenant_id });
    return res.json({
      token,
      role: 'manager',
      admin: { id: manager.id, email: manager.email },
      tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status } : null
    });
  }

  return res.status(401).json({ error: 'Email ou senha invalidos' });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ auth: req.auth });
});

module.exports = router;
