const { db, DEFAULT_REMINDER_CONFIG } = require('./db');
const waProvider = require('./wa-provider');
const { fillTemplate, formatDateBR, formatCurrencyBRL } = require('./whatsapp');

function getReminderConfig(tenantId) {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'reminder_config'").get(tenantId);
  if (!row?.value) return { ...DEFAULT_REMINDER_CONFIG };
  try { return { ...DEFAULT_REMINDER_CONFIG, ...JSON.parse(row.value) }; } catch { return { ...DEFAULT_REMINDER_CONFIG }; }
}

// Roda a cada minuto: procura agendamentos confirmados, ainda sem lembrete enviado,
// cujo horario de disparo (inicio do agendamento - antecedencia configurada) ja chegou,
// mas que ainda nao aconteceram.
async function checkAndSendReminders() {
  const rows = db.prepare(`
    SELECT b.id, b.tenant_id, b.customer_full_name, b.customer_phone, b.booking_date, b.booking_time,
           b.item_name, b.item_price, b.discount_applied,
           t.name AS tenant_name,
           br.name AS barber_name
    FROM bookings b
    JOIN tenants t ON t.id = b.tenant_id
    LEFT JOIN barbers br ON br.id = b.barber_id
    WHERE b.status = 'confirmed' AND b.reminder_sent = 0
      AND b.booking_date >= date('now', 'localtime')
      AND b.booking_date <= date('now', '+3 days', 'localtime')
  `).all();

  if (!rows.length) return;

  const now = Date.now();

  for (const row of rows) {
    try {
      const config = getReminderConfig(row.tenant_id);
      if (!config.enabled) continue;

      const bookingDateTime = new Date(`${row.booking_date}T${row.booking_time}`);
      const sendAt = bookingDateTime.getTime() - Number(config.hours_before || 0) * 60 * 60 * 1000;

      // So dispara dentro da janela: ja passou da hora de avisar, mas o atendimento ainda nao comecou
      if (now < sendAt || now >= bookingDateTime.getTime()) continue;

      const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE tenant_id = ?').get(row.tenant_id);
      if (!instance || instance.status !== 'connected' || !waProvider.isConfigured(instance.provider)) continue;

      const message = fillTemplate(config.template || DEFAULT_REMINDER_CONFIG.template, {
        cliente: row.customer_full_name,
        barbearia: row.tenant_name,
        servico: row.item_name || '',
        barbeiro: row.barber_name || 'a definir',
        data: formatDateBR(row.booking_date),
        hora: row.booking_time.substring(0, 5),
        valor: formatCurrencyBRL(Math.max(0, (row.item_price || 0) - (row.discount_applied || 0)))
      });

      await waProvider.sendText(instance, row.customer_phone, message);
      db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(row.id);
    } catch (err) {
      console.error(`[reminders] Falha ao enviar lembrete (agendamento ${row.id}):`, err.message);
    }
  }
}

function startReminderScheduler() {
  setInterval(() => {
    checkAndSendReminders().catch(err => console.error('[reminders] Erro no ciclo de lembretes:', err.message));
  }, 60 * 1000);
}

module.exports = { startReminderScheduler, checkAndSendReminders, getReminderConfig };
