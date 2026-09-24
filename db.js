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

  -- Avaliacao do cliente sobre um atendimento (so depois que o gestor marca como concluido).
  -- Interna: so o gestor ve, nao aparece na pagina publica.
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Pacotes: combo de servicos por um preco fechado (ex: "Corte + Barba" por R$60 em vez da soma avulsa)
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS package_services (
    package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    PRIMARY KEY (package_id, service_id)
  );

  -- Assinaturas: plano recorrente que o gestor cria e cobra manualmente (dinheiro/Pix/cartao na maquininha).
  -- Nao ha processamento de pagamento automatico - o gestor so registra que recebeu.
  CREATE TABLE IF NOT EXISTS subscription_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS client_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_billing_date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscription_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_subscription_id INTEGER NOT NULL REFERENCES client_subscriptions(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    paid_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Datas especificas em que a barbearia nao vai abrir (ex: feriado, viagem, imprevisto),
  -- por fora do horario semanal recorrente em schedule_config. period = '' bloqueia o dia
  -- inteiro; 'manha'/'tarde'/'noite' bloqueia so aquele turno, permitindo abrir os demais.
  CREATE TABLE IF NOT EXISTS blocked_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, date, period)
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_tenant_date ON bookings(tenant_id, booking_date);
  CREATE INDEX IF NOT EXISTS idx_blocked_dates_tenant_date ON blocked_dates(tenant_id, date);
  CREATE INDEX IF NOT EXISTS idx_bookings_barber ON bookings(barber_id);
  CREATE INDEX IF NOT EXISTS idx_services_tenant ON services(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_barbers_tenant ON barbers(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
`);

// Migracao leve: adiciona colunas novas em bancos que ja existiam antes do modulo de Fidelidade.
// CREATE TABLE IF NOT EXISTS nao adiciona coluna em tabela ja criada, entao verificamos na mao.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('users', 'loyalty_progress', 'REAL NOT NULL DEFAULT 0');
ensureColumn('bookings', 'discount_applied', 'REAL NOT NULL DEFAULT 0');
ensureColumn('bookings', 'reward_label', 'TEXT');
ensureColumn('bookings', 'package_id', 'INTEGER REFERENCES packages(id)');
ensureColumn('bookings', 'item_price', 'REAL');
ensureColumn('bookings', 'item_duration', 'INTEGER');
ensureColumn('bookings', 'item_name', 'TEXT');
ensureColumn('services', 'photo_url', 'TEXT');
ensureColumn('bookings', 'reminder_sent', 'INTEGER NOT NULL DEFAULT 0');

// Plano da barbearia: 'basic' (padrao) ou 'pro'. So o PRO libera o atendente com IA no WhatsApp.
ensureColumn('tenants', 'plan', "TEXT NOT NULL DEFAULT 'basic'");
// Origem do agendamento: 'link' (pagina publica), 'whatsapp_ia' (atendente IA), etc.
ensureColumn('bookings', 'source', 'TEXT');

// Enquetes enviadas pelo atendente IA: guarda as opcoes para traduzir o voto do cliente
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_polls (
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    poll_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, poll_id)
  );
`);

// Configuracoes globais do sistema, editadas pelo super admin (ex: chave da OpenAI)
db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Motor do WhatsApp de cada barbearia: 'evolution' (Evolution API v2) ou 'evogo' (Evolution GO)
ensureColumn('tenants', 'whatsapp_provider', "TEXT NOT NULL DEFAULT 'evolution'");
ensureColumn('whatsapp_instances', 'provider', "TEXT NOT NULL DEFAULT 'evolution'");
ensureColumn('whatsapp_instances', 'instance_token', 'TEXT'); // Evolution GO: token da instancia
ensureColumn('whatsapp_instances', 'external_id', 'TEXT');    // Evolution GO: id (uuid) da instancia

// Conversa do atendente IA com cada contato do WhatsApp (uma linha por barbearia + numero).
// messages = historico no formato da OpenAI (JSON), paused_until = IA pausada porque o gestor
// respondeu manualmente naquele chat.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_conversations (
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    phone TEXT,
    customer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    paused_until TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, chat_id)
  );
`);

// blocked_dates ja existia (sem coluna period) em bancos criados antes do bloqueio por turno.
// ensureColumn nao resolve aqui porque tambem precisamos trocar a constraint UNIQUE
// (antes so tenant_id+date, agora tenant_id+date+period), entao recriamos a tabela.
(function ensureBlockedDatesPeriodColumn() {
  const columns = db.prepare("PRAGMA table_info(blocked_dates)").all().map(c => c.name);
  if (columns.length === 0 || columns.includes('period')) return;

  db.exec(`
    ALTER TABLE blocked_dates RENAME TO blocked_dates_old;
    CREATE TABLE blocked_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '',
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, date, period)
    );
    INSERT INTO blocked_dates (id, tenant_id, date, period, reason, created_at)
      SELECT id, tenant_id, date, '', reason, created_at FROM blocked_dates_old;
    DROP TABLE blocked_dates_old;
  `);
})();

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

const DEFAULT_REMINDER_TEMPLATE =
  'Ola {{cliente}}! Passando pra lembrar do seu agendamento na *{{barbearia}}*.\n\n' +
  'Servico: {{servico}}\n' +
  'Barbeiro: {{barbeiro}}\n' +
  'Data: {{data}}\n' +
  'Horario: {{hora}}\n\n' +
  'Te esperamos!';

// Lembrete comeca desligado - o gestor liga e escolhe a antecedencia no painel (em horas)
const DEFAULT_REMINDER_CONFIG = {
  enabled: false,
  hours_before: 2,
  template: DEFAULT_REMINDER_TEMPLATE
};

// Fidelidade comeca desligada - o gestor liga e escolhe a regra no painel
const DEFAULT_LOYALTY_CONFIG = {
  enabled: false,
  mode: 'stamps', // 'stamps' (selo por visita) ou 'points' (pontos por valor gasto)
  threshold: 10,
  points_per_currency: 1,
  reward_type: 'free_service', // 'free_service' | 'discount_percent' | 'discount_fixed'
  reward_value: 0,
  reward_description: 'Corte grátis'
};

function seedTenantDefaults(tenantId) {
  const upsert = db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, key) DO NOTHING
  `);
  upsert.run(tenantId, 'schedule_config', JSON.stringify(DEFAULT_SCHEDULE));
  upsert.run(tenantId, 'interval_time', '30');
  upsert.run(tenantId, 'whatsapp_template', DEFAULT_WHATSAPP_TEMPLATE);
  upsert.run(tenantId, 'theme', 'ouro_negro');
  upsert.run(tenantId, 'loyalty_config', JSON.stringify(DEFAULT_LOYALTY_CONFIG));
  upsert.run(tenantId, 'reminder_config', JSON.stringify(DEFAULT_REMINDER_CONFIG));
}

const superAdminCount = db.prepare('SELECT COUNT(*) AS c FROM super_admins').get().c;
if (superAdminCount === 0) {
  const email = process.env.SUPERADMIN_EMAIL || 'super@barbersync.com';
  const password = process.env.SUPERADMIN_PASSWORD || 'mude-esta-senha';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO super_admins (email, password_hash) VALUES (?, ?)').run(email, hash);
  console.log(`[setup] Super admin criado automaticamente: ${email} (defina SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD no .env para mudar)`);
}

module.exports = { db, seedTenantDefaults, DEFAULT_SCHEDULE, DEFAULT_WHATSAPP_TEMPLATE, DEFAULT_LOYALTY_CONFIG, DEFAULT_REMINDER_CONFIG, DEFAULT_REMINDER_TEMPLATE };
