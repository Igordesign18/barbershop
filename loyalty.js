const { db, DEFAULT_LOYALTY_CONFIG } = require('./db');

function getLoyaltyConfig(tenantId) {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'loyalty_config'").get(tenantId);
  if (!row?.value) return { ...DEFAULT_LOYALTY_CONFIG };
  try { return { ...DEFAULT_LOYALTY_CONFIG, ...JSON.parse(row.value) }; } catch { return { ...DEFAULT_LOYALTY_CONFIG }; }
}

function saveLoyaltyConfig(tenantId, config) {
  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, 'loyalty_config', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(tenantId, JSON.stringify(config));
}

// Calcula o desconto (em R$) que a recompensa representa para um servico de determinado preco
function computeRewardDiscount(config, servicePrice) {
  if (config.reward_type === 'free_service') return servicePrice;
  if (config.reward_type === 'discount_percent') return Math.min(servicePrice, servicePrice * (Number(config.reward_value) || 0) / 100);
  if (config.reward_type === 'discount_fixed') return Math.min(servicePrice, Number(config.reward_value) || 0);
  return 0;
}

// Chamado na criacao de um agendamento publico: se o cliente ja atingiu a meta de fidelidade,
// aplica a recompensa automaticamente nesse agendamento e consome (desconta) o progresso acumulado.
function tryApplyReward(tenantId, userId, servicePrice) {
  const config = getLoyaltyConfig(tenantId);
  if (!config.enabled || !userId) return { discount: 0, label: null };

  const user = db.prepare('SELECT loyalty_progress FROM users WHERE id = ?').get(userId);
  if (!user || user.loyalty_progress < config.threshold) return { discount: 0, label: null };

  const discount = computeRewardDiscount(config, servicePrice);
  const newProgress = Math.max(0, user.loyalty_progress - config.threshold);
  db.prepare('UPDATE users SET loyalty_progress = ? WHERE id = ?').run(newProgress, userId);

  return { discount, label: `Fidelidade: ${config.reward_description || 'recompensa aplicada'}` };
}

// Chamado quando um agendamento passa a status 'completed': soma progresso de fidelidade do cliente
function addProgressOnCompletion(tenantId, userId, servicePrice) {
  if (!userId) return;
  const config = getLoyaltyConfig(tenantId);
  if (!config.enabled) return;

  const increment = config.mode === 'points' ? (Number(servicePrice) || 0) * (Number(config.points_per_currency) || 1) : 1;
  db.prepare('UPDATE users SET loyalty_progress = loyalty_progress + ? WHERE id = ?').run(increment, userId);
}

// Status de fidelidade de um cliente especifico (usado na pagina publica)
function getLoyaltyStatus(tenantId, userId) {
  const config = getLoyaltyConfig(tenantId);
  if (!config.enabled) return { enabled: false };

  const user = userId ? db.prepare('SELECT loyalty_progress FROM users WHERE id = ?').get(userId) : null;
  const progress = user ? user.loyalty_progress : 0;

  return {
    enabled: true,
    mode: config.mode,
    threshold: config.threshold,
    progress,
    remaining: Math.max(0, config.threshold - progress),
    reward_description: config.reward_description,
    ready: progress >= config.threshold
  };
}

module.exports = { getLoyaltyConfig, saveLoyaltyConfig, computeRewardDiscount, tryApplyReward, addProgressOnCompletion, getLoyaltyStatus };
