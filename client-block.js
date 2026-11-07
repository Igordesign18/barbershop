// Bloqueio de clientes (por barbearia). O gestor escolhe a penalidade:
//   'pay' = o cliente so agenda pagando o valor do servico ANTES (o gestor combina o pagamento pelo WhatsApp e agenda pelo painel)
//   'ban' = bloqueio definitivo: o cliente nao consegue agendar de jeito nenhum
// A trava vale para o link publico, a fila de espera, o reagendamento e a IA do WhatsApp.
// Agendamentos criados pelo proprio gestor no painel nao sao travados.
const { db } = require('./db');
const { normalizePhone } = require('./phone');

const PENALTIES = { pay: 'Pagar o valor do corte imediatamente', ban: 'Bloqueio definitivo' };

// Colunas novas na tabela users (migracao leve, segura para bancos existentes)
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('blocked_penalty')) db.exec('ALTER TABLE users ADD COLUMN blocked_penalty TEXT');
  if (!cols.includes('blocked_reason')) db.exec('ALTER TABLE users ADD COLUMN blocked_reason TEXT');
  if (!cols.includes('blocked_at')) db.exec('ALTER TABLE users ADD COLUMN blocked_at TEXT');
})();

function getBlock(tenantId, phone) {
  const p = normalizePhone(phone || '');
  if (!p) return null;
  const u = db.prepare("SELECT id, full_name, blocked_penalty, blocked_reason FROM users WHERE tenant_id = ? AND phone = ? AND blocked_penalty IN ('pay','ban')").get(tenantId, p);
  return u ? { userId: u.id, name: u.full_name, penalty: u.blocked_penalty, reason: u.blocked_reason || '' } : null;
}

function brl(v) { return (Number(v) || 0).toFixed(2).replace('.', ','); }

function shopWhatsApp(tenant) {
  const digits = v => { const n = String(v || '').replace(/\D/g, ''); return n.length >= 10 && !n.startsWith('55') ? '55' + n : n; };
  try {
    const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'shop_profile'").get(tenant.id);
    const phone = row && JSON.parse(row.value).phone;
    if (digits(phone).length >= 12) return digits(phone);
  } catch (_) {}
  return digits(tenant.notify_phone).length >= 12 ? digits(tenant.notify_phone) : '';
}

// Texto para o cliente (site e WhatsApp). price = valor do servico que ele tentou agendar (opcional).
function messageFor(tenant, block, price) {
  const wa = shopWhatsApp(tenant);
  const contato = wa ? ' Fale com a barbearia pelo WhatsApp.' : ' Fale com a barbearia.';
  if (block.penalty === 'pay') {
    const valor = price > 0 ? ` (R$ ${brl(price)})` : '';
    return `Para agendar na ${tenant.name}, é necessário pagar o valor do corte${valor} imediatamente, antes do horário ser confirmado.${contato} Depois do pagamento, a barbearia agenda o seu horário.`;
  }
  return `Não é possível agendar na ${tenant.name}: seu cadastro está bloqueado definitivamente.${contato}`;
}

// null = pode agendar. Senao { status, json } pronto para responder na API publica.
function check(tenant, phone, price) {
  const block = getBlock(tenant.id, phone);
  if (!block) return null;
  const wa = shopWhatsApp(tenant);
  const message = messageFor(tenant, block, price);
  return {
    block,
    message,
    status: 403,
    json: {
      error: message,
      code: 'CLIENT_BLOCKED',
      penalty: block.penalty,
      amount: block.penalty === 'pay' && price > 0 ? Number(price) : null,
      whatsapp_url: wa ? `https://wa.me/${wa}` : ''
    }
  };
}

function setBlock(tenantId, userId, penalty, reason) {
  if (!PENALTIES[penalty]) return false;
  const info = db.prepare("UPDATE users SET blocked_penalty = ?, blocked_reason = ?, blocked_at = datetime('now') WHERE id = ? AND tenant_id = ?")
    .run(penalty, String(reason || '').trim().slice(0, 300) || null, userId, tenantId);
  return info.changes > 0;
}

function clearBlock(tenantId, userId) {
  return db.prepare('UPDATE users SET blocked_penalty = NULL, blocked_reason = NULL, blocked_at = NULL WHERE id = ? AND tenant_id = ?').run(userId, tenantId).changes > 0;
}

module.exports = { PENALTIES, getBlock, check, messageFor, setBlock, clearBlock };
