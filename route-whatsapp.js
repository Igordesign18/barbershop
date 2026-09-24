const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');
const waProvider = require('./wa-provider');
const openai = require('./openai');
const { buildWebhookUrl } = require('./route-webhook');
const { isProTenant, getAiConfig, saveAiConfig } = require('./ai-agent');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

// URL publica do sistema (para o webhook e para o link enviado pela IA).
// Use PUBLIC_BASE_URL no .env; sem ela, deduz pelo endereco que o gestor esta acessando.
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

// Guarda a URL publica (usada no link que a IA manda) e devolve a URL do webhook da instancia
function prepareWebhookUrl(req, instanceName) {
  const baseUrl = getBaseUrl(req);
  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, 'public_base_url', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(req.tenantId, baseUrl);
  return buildWebhookUrl(baseUrl, instanceName);
}

router.get('/status', async (req, res) => {
  const provider = waProvider.normalizeProvider(req.tenant.whatsapp_provider);
  const instance = waProvider.getInstance(req.tenantId);
  if (!instance) return res.json({ status: 'disconnected', provider });

  // Super admin trocou o motor desta barbearia: precisa reconectar
  if (waProvider.normalizeProvider(instance.provider) !== provider) {
    return res.json({ status: 'disconnected', provider, warning: 'Motor do WhatsApp foi alterado. Conecte novamente.' });
  }

  if (!waProvider.isConfigured(provider)) {
    return res.json({ status: instance.status, provider, warning: waProvider.notConfiguredMessage(provider) });
  }

  try {
    const status = await waProvider.refreshStatus(instance);
    res.json({ status, provider });
  } catch (err) {
    res.json({ status: instance.status, provider, warning: err.message });
  }
});

// Cria a instancia (se ainda nao existir) e devolve o QR code para o gestor escanear.
// O webhook ja fica configurado desde a conexao (so e usado se a barbearia for PRO com IA ligada).
router.post('/connect', async (req, res) => {
  const provider = waProvider.normalizeProvider(req.tenant.whatsapp_provider);
  if (!waProvider.isConfigured(provider)) {
    return res.status(400).json({ error: waProvider.notConfiguredMessage(provider) });
  }

  try {
    const current = waProvider.getInstance(req.tenantId);
    const instanceName = current && waProvider.normalizeProvider(current.provider) === provider ? current.instance_name : req.tenant.slug;
    const result = await waProvider.connectTenant(req.tenant, prepareWebhookUrl(req, instanceName));
    res.json({ qrcode_base64: result.qrcode_base64, status: result.status, provider });
  } catch (err) {
    // 400 e nao 502: proxies como o do EasyPanel/Cloudflare trocam respostas 502 por uma pagina HTML
    // propria, e a mensagem de erro real nunca chegava ao painel ("Erro na requisicao")
    console.error(`[whatsapp] connect (tenant ${req.tenantId}, ${provider}):`, err.message);
    res.status(400).json({ error: `Erro ao falar com a ${waProvider.PROVIDERS[provider]}: ${err.message}` });
  }
});

// QR atualizado enquanto o gestor ainda nao escaneou (Evolution GO troca o QR periodicamente)
router.get('/qr', async (req, res) => {
  const instance = waProvider.getInstance(req.tenantId);
  if (!instance) return res.json({ qrcode_base64: null });
  try {
    res.json({ qrcode_base64: await waProvider.currentQr(instance) });
  } catch (err) {
    res.json({ qrcode_base64: null, warning: err.message });
  }
});

router.delete('/disconnect', async (req, res) => {
  const instance = waProvider.getInstance(req.tenantId);
  if (!instance) return res.json({ ok: true });

  try {
    await waProvider.disconnect(instance).catch(() => {});
  } finally {
    db.prepare('UPDATE whatsapp_instances SET status = ?, updated_at = datetime(\'now\') WHERE tenant_id = ?').run('disconnected', req.tenantId);
  }

  res.json({ ok: true });
});

router.get('/template', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(req.tenantId, 'whatsapp_template');
  res.json({ template: row?.value || '' });
});

router.put('/template', (req, res) => {
  const { template } = req.body || {};
  if (!template || template.trim().length < 10) {
    return res.status(400).json({ error: 'Template inválido (muito curto)' });
  }

  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, 'whatsapp_template', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(req.tenantId, template.trim());

  res.json({ ok: true });
});

// ==================== Atendente IA (somente plano PRO) ====================

router.get('/ai', (req, res) => {
  const instance = waProvider.getInstance(req.tenantId);
  res.json({
    plan: req.tenant.plan || 'basic',
    is_pro: isProTenant(req.tenant),
    openai_configured: openai.isConfigured(),
    whatsapp_status: instance ? instance.status : 'disconnected',
    provider: waProvider.normalizeProvider(req.tenant.whatsapp_provider),
    config: getAiConfig(req.tenantId)
  });
});

router.put('/ai', async (req, res) => {
  if (!isProTenant(req.tenant)) {
    return res.status(403).json({ error: 'O atendente com IA é exclusivo do plano PRO. Fale com o suporte para fazer o upgrade.' });
  }

  const { enabled, assistant_name, extra_instructions, interactive_enabled, carousel_enabled } = req.body || {};
  const current = getAiConfig(req.tenantId);
  const config = {
    ...current,
    enabled: !!enabled,
    assistant_name: String(assistant_name || current.assistant_name || 'Assistente Virtual').trim().slice(0, 40) || 'Assistente Virtual',
    extra_instructions: String(extra_instructions || '').trim().slice(0, 2000),
    interactive_enabled: !!interactive_enabled,
    // Carrossel so existe na Evolution GO
    carousel_enabled: !!carousel_enabled && waProvider.normalizeProvider(req.tenant.whatsapp_provider) === 'evogo'
  };

  if (config.enabled && !openai.isConfigured()) {
    return res.status(400).json({ error: 'A IA ainda não foi configurada pelo suporte (chave da OpenAI).' });
  }

  saveAiConfig(req.tenantId, config);

  let webhook = 'skipped';
  const instance = waProvider.getInstance(req.tenantId);
  if (config.enabled && instance && waProvider.isConfigured(instance.provider)) {
    try {
      await waProvider.setWebhook(instance, prepareWebhookUrl(req, instance.instance_name));
      webhook = 'ok';
    } catch (err) {
      webhook = 'error: ' + err.message;
    }
  }

  res.json({ ok: true, config, webhook });
});

module.exports = router;
