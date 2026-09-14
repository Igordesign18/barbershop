const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'barbershop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Voce (dono do sistema). Cria e controla as barbearias/gestores.
  CREATE TABLE IF NOT EXISTS super_admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Cada barbearia (loja) que voce vende o sistema.
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    subscription_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Login do gestor (dono/responsavel) de cada barbearia.
  CREATE TABLE IF NOT EXISTS managers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    duration INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS barbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    specialty TEXT,
    photo_url TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    full_name TEXT,
    email TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_full_name TEXT,
    customer_phone TEXT,
    service_id INTEGER NOT NULL REFERENCES services(id),
    barber_id INTEGER REFERENCES barbers(id),
    booking_date TEXT NOT NULL,
    booking_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    whatsapp_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (tenant_id, key)
  );

  CREATE TABLE IF NOT EXISTS whatsapp_instances (
    tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    instance_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disconnected',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_tenant_date ON bookings(tenant_id, booking_date);
  CREATE INDEX IF NOT EXISTS idx_bookings_barber ON bookings(barber_id);
  CREATE INDEX IF NOT EXISTS idx_services_tenant ON services(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_barbers_tenant ON barbers(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
`);

const DEFAULT_SCHEDULE = {
  0: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
  1: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
  2: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
  3: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
  4: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
  5: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
  6: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] }
};

const DEFAULT_WHATSAPP_TEMPLATE =
  'Ola {{cliente}}! Seu agendamento na *{{barbearia}}* foi confirmado.\n\n' +
  'Servico: {{servico}}\n' +
  'Barbeiro: {{barbeiro}}\n' +
  'Data: {{data}}\n' +
  'Horario: {{hora}}\n' +
  'Valor: R$ {{valor}}\n\n' +
  'Qualquer imprevisto, e so chamar por aqui. Ate ja!';

function seedTenantDefaults(tenantId) {
  const upsert = db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, key) DO NOTHING
  `);
  upsert.run(tenantId, 'schedule_config', JSON.stringify(DEFAULT_SCHEDULE));
  upsert.run(tenantId, 'interval_time', '30');
  upsert.run(tenantId, 'whatsapp_template', DEFAULT_WHATSAPP_TEMPLATE);
}

const superAdminCount = db.prepare('SELECT COUNT(*) AS c FROM super_admins').get().c;
if (superAdminCount === 0) {
  const email = process.env.SUPERADMIN_EMAIL || 'super@barbersync.com';
  const password = process.env.SUPERADMIN_PASSWORD || 'mude-esta-senha';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO super_admins (email, password_hash) VALUES (?, ?)').run(email, hash);
  console.log(`[setup] Super admin criado automaticamente: ${email} (defina SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD no .env para mudar)`);
}

module.exports = { db, seedTenantDefaults, DEFAULT_SCHEDULE, DEFAULT_WHATSAPP_TEMPLATE };
