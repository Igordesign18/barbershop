const express = require('express');
const { requireManager } = require('./auth');
const { addClient, removeClient } = require('./events');

const router = express.Router();

router.get('/', requireManager, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write(': conectado\n\n');

  addClient(req.tenantId, res);

  req.on('close', () => {
    removeClient(req.tenantId, res);
  });
});

module.exports = router;
