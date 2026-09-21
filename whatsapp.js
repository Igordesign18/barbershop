const { db } = require('./db');
const evolution = require('./evolution');

function formatCurrencyBRL(value) {
  return Number(value || 0).toFixed(2).replace('.', ',');
}

// Formata a data no fuso de Brasilia, independente de onde o servidor estiver rodando
function formatDateBR(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(value ?? ''),
    template
  );
}

// Chamada depois que um agendamento e criado (rota publica). Nunca deixa o agendamento
// falhar por causa do WhatsApp: qualquer erro aqui so fica registrado no log.
async function sendBookingConfirmation({ tenant, booking, clientName, clientPhone, serviceName, servicePrice, barberName }) {
  try {
    const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE tenant_id = ?').get(tenant.id);
    if (!instance || instance.status !== 'connected') {
      return { sent: false, reason: 'whatsapp_not_connected' };
    }
    if (!evolution.isConfigured()) {
      return { sent: false, reason: 'evolution_not_configured' };
    }

    const templateRow = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tenant.id, 'whatsapp_template');
    const template = templateRow?.value || '{{cliente}}, agendamento confirmado para {{data}} às {{hora}}.';

    const message = fillTemplate(template, {
      cliente: clientName,
      barbearia: tenant.name,
      servico: serviceName,
      barbeiro: barberName || 'a definir',
      data: formatDateBR(booking.booking_date),
      hora: booking.booking_time.substring(0, 5),
      valor: formatCurrencyBRL(servicePrice)
    });

    await evolution.sendText(instance.instance_name, clientPhone, message);

    db.prepare('UPDATE bookings SET whatsapp_sent = 1 WHERE id = ?').run(booking.id);
    return { sent: true };
  } catch (err) {
    console.error(`[whatsapp] Falha ao enviar confirmação (tenant ${tenant.id}):`, err.message);
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

module.exports = { fillTemplate, sendBookingConfirmation, formatDateBR, formatCurrencyBRL };
