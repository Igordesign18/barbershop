const express = require('express');
const { db } = require('./db');
const { requireManager } = require('./auth');
const { requireActiveTenant } = require('./tenant');

const router = express.Router();
router.use(requireManager, requireActiveTenant);

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.rating, r.comment, r.created_at,
           b.booking_date, b.booking_time, b.customer_full_name,
           s.name AS service_name,
           br.name AS barber_name
    FROM reviews r
    JOIN bookings b ON b.id = r.booking_id
    LEFT JOIN services s ON s.id = b.service_id
    LEFT JOIN barbers br ON br.id = b.barber_id
    WHERE r.tenant_id = ?
    ORDER BY r.created_at DESC
  `).all(req.tenantId);

  const average = rows.length ? rows.reduce((sum, r) => sum + r.rating, 0) / rows.length : 0;

  res.json({
    reviews: rows,
    average: Math.round(average * 10) / 10,
    total: rows.length
  });
});

module.exports = router;
