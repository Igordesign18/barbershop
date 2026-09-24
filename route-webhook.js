// Webhook que a Evolution API chama a cada mensagem recebida no WhatsApp de uma barbearia.
// Rota publica (a Evolution nao manda JWT), protegida por um segredo na URL derivado do JWT_SECRET.
const express = require('express');
const crypto = require('crypto');
const { JWT_SECRET } = require('./auth');
const { handleWebhookEvent } = require('./ai-agent');

const router = express.Router();

function webhookSecret(instanceName) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`evo-webhook:${instanceName}`).digest('hex').slice(0, 32);
}

// URL publica completa do webhook de uma instancia
function buildWebhookUrl(baseUrl, instanceName) {
  return `${baseUrl.replace(/\/$/, '')}/api/webhook/evolution/${encodeURIComponent(instanceName)}/${webhookSecret(instanceName)}`;
}

// A Evolution GO pode mandar a midia inteira em base64 no webhook (WEBHOOK_FILES), por isso o limite folgado.
// A mesma rota atende os dois motores (Evolution API v2 e Evolution GO).
router.post('/evolution/:instance/:secret', express.json({ limit: '50mb' }), (req, res) => {
  const { instance, secret } = req.params;
  const expected = webhookSecret(instance);
  if (secret.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expected))) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Responde na hora (a Evolution nao precisa esperar a IA) e processa em segundo plano
  res.json({ ok: true });
  handleWebhookEvent(instance, req.body).catch(err => console.error('[webhook] erro:', err.message));
});

module.exports = { router, buildWebhookUrl };
