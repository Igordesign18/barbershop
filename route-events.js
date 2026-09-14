const express = require('express');
const { requireManager } = require('./auth');
const { addClient, removeClient } = require('./events');

const router = express.Router();

router.get('/', requireManager, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // evita que proxies (nginx/Traefik, como o do EasyPanel) armazenem a resposta em buffer e atrasem o tempo real
  });
  res.flushHeaders();
  res.write(': conectado\n\n');

  addClient(req.tenantId, res);

  // Ping periodico pra manter a conexao viva atraves de proxies que fecham conexoes ociosas
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(req.tenantId, res);
  });
});

module.exports = router;
