const express = require('express');
const bcrypt = require('bcryptjs');
const { db, seedTenantDefaults } = require('./db');
const { requireSuperAdmin } = require('./auth');

const router = express.Router();
router.use(requireSuperAdmin);

function slugify(text) {
  return text
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function tenantWithManager(tenant) {
  const manager = db.prepare('SELECT id, email FROM managers WHERE tenant_id = ?').get(tenant.id);
  const whatsapp = db.prepare('SELECT status FROM whatsapp_instances WHERE tenant_id = ?').get(tenant.id);
  return {
    ...tenant,
    manager: manager || null,
    whatsapp_status: whatsapp ? whatsapp.status : 'disconnected'
  };
}

// Listar todas as barbearias
router.get('/tenants', (req, res) => {
  const tenants = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  res.json(tenants.map(tenantWithManager));
});

// Criar uma nova barbearia + login do gestor, em um passo só
router.post('/tenants', (req, res) => {
  const { name, slug, manager_email, manager_password, subscription_expires_at } = req.body || {};

  if (!name || name.trim().length < 3) return res.status(400).json({ error: 'Nome da barbearia inválido' });
  if (!manager_email || !manager_email.includes('@')) return res.status(400).json({ error: 'Email do gestor inválido' });
  if (!manager_password || manager_password.length < 6) return res.status(400).json({ error: 'Senha do gestor deve ter pelo menos 6 caracteres' });

  const finalSlug = slugify(slug || name);
  if (!finalSlug) return res.status(400).json({ error: 'Não foi possível gerar um link (slug) válido' });

  const slugExists = db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(finalSlug);
  if (slugExists) return res.status(409).json({ error: `Já existe uma barbearia usando o link "${finalSlug}"` });

  const emailExists = db.prepare('SELECT 1 FROM managers WHERE email = ?').get(manager_email);
  if (emailExists) return res.status(409).json({ error: 'Já existe um gestor com esse email' });

  const insertTenant = db.prepare(`
    INSERT INTO tenants (name, slug, status, subscription_expires_at) VALUES (?, ?, 'active', ?)
  `);
  const insertManager = db.prepare(`
    INSERT INTO managers (tenant_id, email, password_hash) VALUES (?, ?, ?)
  `);

  const result = db.transaction(() => {
    const tenantResult = insertTenant.run(name.trim(), finalSlug, subscription_expires_at || null);
    const tenantId = tenantResult.lastInsertRowid;
    const hash = bcrypt.hashSync(manager_password, 10);
    insertManager.run(tenantId, manager_email.trim(), hash);
    seedTenantDefaults(tenantId);
    return tenantId;
  })();

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(result);
  res.status(201).json(tenantWithManager(tenant));
});

// Editar dados da barbearia (nome, link, status, vencimento)
router.put('/tenants/:id', (req, res) => {
  const { name, slug, status, subscription_expires_at } = req.body || {};
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Barbearia não encontrada' });

  const finalName = name && name.trim().length >= 3 ? name.trim() : tenant.name;
  const finalSlug = slug ? slugify(slug) : tenant.slug;
  const finalStatus = ['active', 'suspended'].includes(status) ? status : tenant.status;

  if (finalSlug !== tenant.slug) {
    const slugExists = db.prepare('SELECT 1 FROM tenants WHERE slug = ? AND id != ?').get(finalSlug, tenant.id);
    if (slugExists) return res.status(409).json({ error: `Já existe uma barbearia usando o link "${finalSlug}"` });
  }

  db.prepare(`
    UPDATE tenants SET name = ?, slug = ?, status = ?, subscription_expires_at = ? WHERE id = ?
  `).run(finalName, finalSlug, finalStatus, subscription_expires_at !== undefined ? subscription_expires_at : tenant.subscription_expires_at, tenant.id);

  res.json(tenantWithManager(db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id)));
});

// Trocar email/senha do gestor de uma barbearia
router.put('/tenants/:id/manager', (req, res) => {
  const { email, password } = req.body || {};
  const manager = db.prepare('SELECT * FROM managers WHERE tenant_id = ?').get(req.params.id);
  if (!manager) return res.status(404).json({ error: 'Gestor não encontrado para essa barbearia' });

  const fields = [];
  const values = [];

  if (email && email.includes('@') && email !== manager.email) {
    const emailExists = db.prepare('SELECT 1 FROM managers WHERE email = ? AND id != ?').get(email, manager.id);
    if (emailExists) return res.status(409).json({ error: 'Já existe um gestor com esse email' });
    fields.push('email = ?');
    values.push(email.trim());
  }

  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
    fields.push('password_hash = ?');
    values.push(bcrypt.hashSync(password, 10));
  }

  if (fields.length === 0) return res.status(400).json({ error: 'Informe um novo email e/ou senha' });

  values.push(manager.id);
  db.prepare(`UPDATE managers SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT id, email FROM managers WHERE id = ?').get(manager.id);
  res.json(updated);
});

// Excluir uma barbearia (e tudo relacionado - services, barbers, bookings, etc, via ON DELETE CASCADE)
router.delete('/tenants/:id', (req, res) => {
  const info = db.prepare('DELETE FROM tenants WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Barbearia não encontrada' });
  res.json({ ok: true });
});

module.exports = router;
