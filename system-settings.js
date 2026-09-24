// Configuracoes globais (valem para todas as barbearias), salvas pelo super admin no banco.
const { db } = require('./db');

function getSystemSetting(key) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row && row.value ? row.value : null;
}

function setSystemSetting(key, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM system_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}

module.exports = { getSystemSetting, setSystemSetting };
