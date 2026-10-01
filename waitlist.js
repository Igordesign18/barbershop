// Fila de espera de horarios.
//
// Regras (resumo):
// - O cliente entra na fila de UM horario ocupado de UM barbeiro. Entrar na fila nao cria agendamento.
// - Quando o horario vaga (qualquer cancelamento/remarcacao/folga removida), a vaga e oferecida ao primeiro da fila
//   (ordem de chegada) com os botoes Aceitar / Recusar e fica reservada por alguns minutos.
// - Recusou ou nao respondeu: a oferta passa para o proximo. Nada acontece com o horario que o cliente ja tinha.
// - Aceitou: cria o agendamento e, na MESMA transacao, cancela o horario que ele ligou a fila (replace_booking_id).
// - Isolamento: toda consulta e filtrada por tenant_id; o cancelamento so atinge agendamento do mesmo telefone e da mesma barbearia.
const { db } = require('./db');
const { normalizePhone } = require('./phone');

const OFFER_MINUTES = 15;        // prazo normal para aceitar
const OFFER_MINUTES_SOON = 5;    // prazo quando o horario esta perto
const SOON_MINUTES = 60;         // "perto" = menos de 1 hora
const CLOSE_MINUTES = 30;        // a fila fecha 30 min antes do horario
const MAX_ACTIVE_PER_PHONE = 5;
const SWEEP_MS = 30 * 1000;

const TZ = 'America/Sao_Paulo';

function nowBR() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(hour) * 60 + Number(parts.minute) };
}

function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); }

// Minutos ate o inicio do horario (negativo = ja passou)
function minutesUntil(date, time) {
  const n = nowBR();
  const days = Math.round((new Date(date + 'T12:00:00Z') - new Date(n.date + 'T12:00:00Z')) / 86400000);
  return days * 1440 + toMin(time) - n.minutes;
}

function fmtDate(iso) {
  const [y, m, d] = String(iso).split('-');
  const wd = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][new Date(iso + 'T12:00:00Z').getUTCDay()];
  return `${wd}, ${d}/${m}/${y}`;
}

function gn() { return require('./gestor-notify'); }
function wa() { return require('./wa-provider'); }

// ==================== Canal de envio ====================
// Mesma regra do resto do sistema: numero central se a barbearia optou e nao tem WhatsApp proprio conectado;
// senao o WhatsApp proprio. Sem nenhum dos dois, nao ha como avisar e a fila nao e oferecida.
function ownInstance(tenantId) {
  const inst = db.prepare('SELECT * FROM whatsapp_instances WHERE tenant_id = ?').get(tenantId);
  return inst && wa().isConfigured(inst.provider) ? inst : null;
}

function channelAvailable(tenantId) {
  try {
    if (gn().usesCentral(tenantId)) return gn().hasToken();
    const inst = ownInstance(tenantId);
    return !!inst && inst.status === 'connected';
  } catch (_) { return false; }
}

// buttons: [{ text, id }]. Lanca erro se nao conseguir enviar.
async function sendToClient(tenantId, phone, text, buttons, footer) {
  const fallbackText = `${text}\n\n${buttons.map(b => `• Responda *${b.text.toLowerCase().startsWith('aceitar') ? 'sim' : 'não'}* para ${b.text.toLowerCase()}`).join('\n')}`;
  if (gn().usesCentral(tenantId)) {
    if (!gn().hasToken()) throw new Error('WhatsApp do sistema não conectado');
    await gn().sendTo(phone, text, buttons.length ? { buttons, footer, fallbackText } : null);
    return;
  }
  let inst = ownInstance(tenantId);
  if (!inst) throw new Error('a barbearia não tem WhatsApp conectado');
  if (inst.status !== 'connected') {
    const live = await wa().refreshStatus(inst).catch(() => inst.status);
    if (live !== 'connected') throw new Error(`WhatsApp da barbearia está "${live}"`);
  }
  // Botoes so chegam de verdade pela WuzAPI; nos outros motores vai texto ("responda sim ou nao")
  if (buttons.length && wa().normalizeProvider(inst.provider) === 'wuzapi') await wa().sendInteractive(inst, phone, 'buttons', { text, footer, buttons }, fallbackText);
  else await wa().sendText(inst, phone, buttons.length ? fallbackText : text);
}

// ==================== Entrar / sair / ligar ao horario atual ====================

function activeEntries(tenantId, phone) {
  return db.prepare("SELECT * FROM waitlist WHERE tenant_id = ? AND customer_phone = ? AND status IN ('waiting','offered') ORDER BY id").all(tenantId, phone);
}

function futureBookingsOf(tenantId, phone) {
  const n = nowBR();
  const nowHHMM = `${String(Math.floor(n.minutes / 60)).padStart(2, '0')}:${String(n.minutes % 60).padStart(2, '0')}`;
  return db.prepare(`
    SELECT b.id, b.booking_date, b.booking_time, COALESCE(b.item_name, s.name) AS servico, br.name AS barbeiro
    FROM bookings b LEFT JOIN services s ON s.id = b.service_id LEFT JOIN barbers br ON br.id = b.barber_id
    WHERE b.tenant_id = ? AND b.customer_phone = ? AND b.status = 'confirmed'
      AND (b.booking_date > ? OR (b.booking_date = ? AND substr(b.booking_time,1,5) > ?))
    ORDER BY b.booking_date, b.booking_time LIMIT 8
  `).all(tenantId, phone, n.date, n.date, nowHHMM);
}

// body: { customer_full_name, customer_phone, service_id | package_id, barber_id, booking_date, booking_time }
function createEntry(tenant, body) {
  const bs = require('./barber-services');
  const { slotIsFree } = require('./ai-agent');
  const phone = normalizePhone(body.customer_phone);
  if (!phone) return { status: 400, json: { error: 'Telefone inválido' } };

  let name = String(body.customer_full_name || '').trim();
  if (name.length < 3) {
    const known = db.prepare('SELECT full_name FROM users WHERE tenant_id = ? AND phone = ?').get(tenant.id, phone);
    name = known?.full_name || '';
  }
  if (name.length < 3) return { status: 400, json: { error: 'Informe seu nome completo' } };

  const barberId = Number(body.barber_id);
  const date = String(body.booking_date || '');
  const time = String(body.booking_time || '').slice(0, 5);
  if (!barberId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { status: 400, json: { error: 'Dados incompletos' } };
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ? AND tenant_id = ?').get(barberId, tenant.id);
  if (!barber) return { status: 400, json: { error: 'Profissional inválido' } };

  let item;
  if (body.package_id) {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND tenant_id = ? AND active = 1').get(body.package_id, tenant.id);
    if (!pkg) return { status: 400, json: { error: 'Pacote inválido' } };
    const svcs = db.prepare('SELECT s.id, s.duration FROM package_services ps JOIN services s ON s.id = ps.service_id WHERE ps.package_id = ?').all(pkg.id);
    if (!svcs.length) return { status: 400, json: { error: 'Pacote sem serviços' } };
    if (!bs.barberDoesAll(barberId, svcs.map(s => s.id))) return { status: 400, json: { error: `${barber.name} não faz esse serviço.` } };
    item = { service_id: svcs[0].id, package_id: pkg.id, name: pkg.name, price: pkg.price, duration: bs.totalDuration(barberId, svcs) };
  } else {
    const svc = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(body.service_id, tenant.id);
    if (!svc) return { status: 400, json: { error: 'Serviço inválido' } };
    if (!bs.barberDoesAll(barberId, [svc.id])) return { status: 400, json: { error: `${barber.name} não faz esse serviço.` } };
    item = { service_id: svc.id, package_id: null, name: svc.name, price: svc.price, duration: bs.durationFor(barberId, svc.id, svc.duration) };
  }

  if (!channelAvailable(tenant.id)) return { status: 400, json: { error: 'A fila de espera não está disponível nesta barbearia.' } };
  if (minutesUntil(date, time) <= CLOSE_MINUTES) return { status: 400, json: { error: 'Esse horário está muito próximo para entrar na fila.' } };
  // Horario livre: nao precisa de fila, e so agendar
  if (slotIsFree(tenant.id, barberId, date, time, item.duration)) return { status: 409, json: { error: 'Esse horário está livre agora. É só agendar normalmente.' } };

  const mine = activeEntries(tenant.id, phone);
  const dup = mine.find(e => e.barber_id === barberId && e.booking_date === date && e.booking_time === time);
  if (dup) return { status: 200, json: { id: dup.id, already: true, bookings: futureBookingsOf(tenant.id, phone), replace_booking_id: dup.replace_booking_id || null } };
  if (mine.length >= MAX_ACTIVE_PER_PHONE) return { status: 400, json: { error: `Você já está em ${MAX_ACTIVE_PER_PHONE} filas. Saia de alguma antes de entrar em outra.` } };

  const r = db.prepare(`
    INSERT INTO waitlist (tenant_id, customer_full_name, customer_phone, service_id, package_id, item_name, item_price, item_duration, barber_id, booking_date, booking_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tenant.id, name, phone, item.service_id, item.package_id, item.name, item.price, item.duration, barberId, date, time);
  return { status: 201, json: { id: r.lastInsertRowid, bookings: futureBookingsOf(tenant.id, phone), replace_booking_id: null } };
}

function ownEntry(tenantId, id, phone) {
  const p = normalizePhone(phone);
  const e = db.prepare('SELECT * FROM waitlist WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!e) return { status: 404, error: 'Fila não encontrada' };
  if (!p || p !== e.customer_phone) return { status: 403, error: 'Esta fila não pertence a este telefone' };
  return { e };
}

// Escolhe qual horario atual o cliente troca se ganhar a vaga (ou null = nao trocar nada)
function linkEntry(tenantId, id, phone, bookingId) {
  const o = ownEntry(tenantId, id, phone);
  if (o.error) return o;
  if (!['waiting', 'offered'].includes(o.e.status)) return { status: 400, error: 'Esta fila já foi encerrada' };
  if (bookingId == null) { db.prepare('UPDATE waitlist SET replace_booking_id = NULL WHERE id = ?').run(id); return { ok: true }; }
  const b = db.prepare("SELECT id FROM bookings WHERE id = ? AND tenant_id = ? AND customer_phone = ? AND status = 'confirmed'").get(Number(bookingId), tenantId, o.e.customer_phone);
  if (!b) return { status: 404, error: 'Agendamento não encontrado' };
  db.prepare('UPDATE waitlist SET replace_booking_id = ? WHERE id = ?').run(b.id, id);
  return { ok: true };
}

function leaveEntry(tenantId, id, phone) {
  const o = ownEntry(tenantId, id, phone);
  if (o.error) return o;
  if (['waiting', 'offered'].includes(o.e.status)) {
    db.prepare("UPDATE waitlist SET status = 'left' WHERE id = ?").run(id);
    kick(tenantId); // se tinha a vaga reservada, ela segue para o proximo
  }
  return { ok: true };
}

function lookup(tenantId, phone) {
  const p = normalizePhone(phone);
  if (!p) return [];
  return db.prepare(`
    SELECT w.id, w.booking_date, w.booking_time, w.item_name, w.status, w.replace_booking_id, br.name AS barbeiro,
           rb.booking_date AS replace_date, rb.booking_time AS replace_time
    FROM waitlist w LEFT JOIN barbers br ON br.id = w.barber_id
    LEFT JOIN bookings rb ON rb.id = w.replace_booking_id AND rb.status = 'confirmed'
    WHERE w.tenant_id = ? AND w.customer_phone = ? AND w.status IN ('waiting','offered') ORDER BY w.booking_date, w.booking_time
  `).all(tenantId, p);
}

// Lista para o painel do gestor
function listForTenant(tenantId) {
  const n = nowBR();
  return db.prepare(`
    SELECT w.id, w.customer_full_name, w.customer_phone, w.item_name, w.booking_date, w.booking_time, w.status, w.offer_expires_at,
           w.created_at, br.name AS barbeiro
    FROM waitlist w LEFT JOIN barbers br ON br.id = w.barber_id
    WHERE w.tenant_id = ? AND w.status IN ('waiting','offered') AND w.booking_date >= ?
    ORDER BY w.booking_date, w.booking_time, w.id
  `).all(tenantId, n.date);
}

// ==================== Ofertas ====================

// Texto de "o prazo acabou": deixa claro o que acontece com o horario que ele ja tinha
function expiredText(e, late = false) {
  const slot = `${fmtDate(e.booking_date)} às ${e.booking_time.slice(0, 5)}`;
  let kept = '';
  if (e.replace_booking_id) {
    const rb = db.prepare("SELECT booking_date, booking_time FROM bookings WHERE id = ? AND tenant_id = ? AND customer_phone = ? AND status = 'confirmed'").get(e.replace_booking_id, e.tenant_id, e.customer_phone);
    if (rb) kept = `\n\n✅ *Você continua com o seu horário de ${fmtDate(rb.booking_date)} às ${rb.booking_time.slice(0, 5)}.* Nada foi cancelado, está tudo certo.`;
  }
  return `⏳ *O prazo para aceitar acabou.*\n\nComo não recebemos sua resposta a tempo, a vaga de *${slot}* foi liberada para a próxima pessoa da fila.${kept}` +
    (late ? '\n\nPor isso não dá mais para confirmar essa vaga. Se ainda quiser, entre na fila de novo pelo site.' : '');
}

function offerMinutesFor(e) {
  const until = minutesUntil(e.booking_date, e.booking_time);
  const base = until < SOON_MINUTES ? OFFER_MINUTES_SOON : OFFER_MINUTES;
  return Math.max(1, Math.min(base, until - 5)); // nunca vence depois do horario
}

async function sendOffer(e, minutes) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(e.tenant_id);
  const barber = db.prepare('SELECT name FROM barbers WHERE id = ?').get(e.barber_id);
  let swap = '';
  if (e.replace_booking_id) {
    const rb = db.prepare("SELECT booking_date, booking_time FROM bookings WHERE id = ? AND tenant_id = ? AND customer_phone = ? AND status = 'confirmed'").get(e.replace_booking_id, e.tenant_id, e.customer_phone);
    if (rb) swap = `\n\n⚠️ Se você aceitar, seu horário de *${fmtDate(rb.booking_date)} às ${rb.booking_time.slice(0, 5)}* será cancelado.`;
  }
  const text = `Boa notícia, ${String(e.customer_full_name).split(' ')[0]}! 🎉\n\nO horário que você esperava vagou na *${tenant.name}*:\n\n` +
    `✂️ *Serviço:* ${e.item_name}\n💈 *Barbeiro:* ${barber ? barber.name : '-'}\n🗓️ *Data:* ${fmtDate(e.booking_date)}\n⏰ *Horário:* ${e.booking_time.slice(0, 5)}` +
    `${swap}\n\nReservamos para você por *${minutes} minutos*. Quer ficar com ele?`;
  await sendToClient(e.tenant_id, e.customer_phone, text, [
    { text: 'Aceitar', id: `cli_wok:${e.id}` },
    { text: 'Recusar', id: `cli_wno:${e.id}` }
  ], tenant.name);
}

const running = new Set();
const again = new Set();

// Expira ofertas, fecha filas de horarios proximos e oferece vagas livres. Idempotente.
async function processTenant(tenantId) {
  if (running.has(tenantId)) { again.add(tenantId); return; }
  running.add(tenantId);
  try {
    const { slotIsFree } = require('./ai-agent');
    const now = Date.now();

    for (const e of db.prepare("SELECT * FROM waitlist WHERE tenant_id = ? AND status = 'offered' AND offer_expires_at <= ?").all(tenantId, now)) {
      db.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ? AND status = 'offered'").run(e.id);
      sendToClient(tenantId, e.customer_phone, expiredText(e), [], '').catch(err => console.error(`[fila] aviso de prazo não enviado (fila ${e.id}): ${err.message}`));
    }

    for (const e of db.prepare("SELECT * FROM waitlist WHERE tenant_id = ? AND status = 'waiting'").all(tenantId)) {
      if (minutesUntil(e.booking_date, e.booking_time) <= CLOSE_MINUTES) db.prepare("UPDATE waitlist SET status = 'closed' WHERE id = ?").run(e.id);
    }

    const waiting = db.prepare("SELECT * FROM waitlist WHERE tenant_id = ? AND status = 'waiting' ORDER BY id").all(tenantId);
    for (const e of waiting) {
      const cur = db.prepare('SELECT status FROM waitlist WHERE id = ?').get(e.id);
      if (!cur || cur.status !== 'waiting') continue;
      if (!slotIsFree(tenantId, e.barber_id, e.booking_date, e.booking_time.slice(0, 5), e.item_duration)) continue;
      if (!channelAvailable(tenantId)) { console.log(`[fila] tenant ${tenantId}: vaga livre, mas sem WhatsApp para avisar`); break; }
      // O horario que ele quer trocar deixou de existir: oferece sem cancelar nada
      if (e.replace_booking_id && !db.prepare("SELECT 1 FROM bookings WHERE id = ? AND tenant_id = ? AND customer_phone = ? AND status = 'confirmed'").get(e.replace_booking_id, tenantId, e.customer_phone)) {
        db.prepare('UPDATE waitlist SET replace_booking_id = NULL WHERE id = ?').run(e.id);
        e.replace_booking_id = null;
      }
      const minutes = offerMinutesFor(e);
      // Reserva primeiro (sincrono): ninguem mais consegue pegar o horario enquanto a mensagem vai
      db.prepare("UPDATE waitlist SET status = 'offered', offered_at = ?, offer_expires_at = ? WHERE id = ? AND status = 'waiting'").run(Date.now(), Date.now() + minutes * 60000, e.id);
      try {
        await sendOffer(e, minutes);
        console.log(`[fila] vaga oferecida (tenant ${tenantId}, fila ${e.id}, ${e.booking_date} ${e.booking_time})`);
        // Avisa no minuto exato em que o prazo acaba (o conferidor de 30s fica de reserva)
        setTimeout(() => processTenant(tenantId).catch(() => {}), minutes * 60000 + 1500).unref();
      } catch (err) {
        console.error(`[fila] não consegui avisar (tenant ${tenantId}, fila ${e.id}): ${err.message}`);
        db.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ?").run(e.id); // segue para o proximo
        again.add(tenantId);
      }
    }
  } catch (err) {
    console.error(`[fila] erro (tenant ${tenantId}):`, err.message);
  } finally {
    running.delete(tenantId);
    if (again.delete(tenantId)) setImmediate(() => processTenant(tenantId));
  }
}

// Chamar sempre que um horario pode ter vagado
function kick(tenantId) {
  if (!tenantId) return;
  setImmediate(() => { processTenant(tenantId).catch(() => {}); });
}

function startWaitlistScheduler() {
  setInterval(() => {
    try {
      const ids = db.prepare("SELECT DISTINCT tenant_id FROM waitlist WHERE status IN ('waiting','offered')").all().map(r => r.tenant_id);
      ids.forEach(id => processTenant(id).catch(() => {}));
    } catch (err) { console.error('[fila] ciclo:', err.message); }
  }, SWEEP_MS);
}

// ==================== Resposta do cliente ====================

// Sincrono: dois "aceitar" ao mesmo tempo nunca passam juntos.
function accept(entryId, senderPhone) {
  const { slotIsFree } = require('./ai-agent');
  const { sameNumber } = gn();
  const e = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(Number(entryId));
  if (!e || !sameNumber(e.customer_phone, senderPhone)) return { ok: false, text: 'Não encontrei essa vaga. Ela pode ter expirado. 🙏' };
  if (e.status === 'offered' && e.offer_expires_at <= Date.now()) {
    // Prazo vencido e o conferidor ainda nao rodou: encerra aqui, sem criar nada
    db.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ? AND status = 'offered'").run(e.id);
    kick(e.tenant_id);
    return { ok: false, text: expiredText(e, true) };
  }
  if (e.status === 'expired') return { ok: false, text: expiredText(e, true) };
  if (e.status !== 'offered') return { ok: false, text: 'Essa vaga não está mais disponível. 🙏' };
  const tenantId = e.tenant_id;
  if (!slotIsFree(tenantId, e.barber_id, e.booking_date, e.booking_time.slice(0, 5), e.item_duration, { ignoreWaitlistId: e.id })) {
    db.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ?").run(e.id);
    kick(tenantId);
    return { ok: false, text: 'Poxa, esse horário acabou de ser ocupado. Seu horário anterior (se houver) continua valendo. 🙏' };
  }

  let bookingId = null, cancelled = null;
  try {
    db.transaction(() => {
      let user = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND phone = ?').get(tenantId, e.customer_phone);
      if (!user) user = { id: db.prepare('INSERT INTO users (tenant_id, full_name, phone) VALUES (?, ?, ?)').run(tenantId, e.customer_full_name, e.customer_phone).lastInsertRowid };
      bookingId = db.prepare(`
        INSERT INTO bookings (tenant_id, user_id, customer_full_name, customer_phone, service_id, package_id, item_name, item_price, item_duration, barber_id, booking_date, booking_time, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
      `).run(tenantId, user.id, e.customer_full_name, e.customer_phone, e.service_id, e.package_id, e.item_name, e.item_price, e.item_duration, e.barber_id, e.booking_date, e.booking_time).lastInsertRowid;
      try {
        const reward = require('./loyalty').tryApplyReward(tenantId, user.id, e.item_price);
        if (reward.discount > 0) db.prepare('UPDATE bookings SET discount_applied = ?, reward_label = ? WHERE id = ?').run(reward.discount, reward.label, bookingId);
      } catch (_) { /* fidelidade e best-effort */ }
      // Troca: so cancela o horario que ELE ligou a fila, do mesmo telefone e da mesma barbearia, ainda confirmado
      if (e.replace_booking_id) {
        const old = db.prepare("SELECT id, booking_date, booking_time FROM bookings WHERE id = ? AND tenant_id = ? AND customer_phone = ? AND status = 'confirmed'").get(e.replace_booking_id, tenantId, e.customer_phone);
        if (old) {
          db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'fila_espera', cancel_reason = 'Cliente trocou pelo horário da fila de espera' WHERE id = ?").run(old.id);
          cancelled = old;
        }
      }
      db.prepare("UPDATE waitlist SET status = 'accepted' WHERE id = ?").run(e.id);
    })();
  } catch (err) {
    console.error('[fila] falha ao aceitar:', err.message);
    return { ok: false, text: 'Não consegui confirmar agora. Tente de novo em instantes ou fale com a barbearia. 🙏' };
  }

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  const barber = db.prepare('SELECT name FROM barbers WHERE id = ?').get(e.barber_id);
  setImmediate(() => {
    try {
      const ev = require('./events');
      ev.broadcastBookingChange(tenantId, 'INSERT', { id: bookingId, status: 'confirmed' });
      if (cancelled) ev.broadcastBookingChange(tenantId, 'UPDATE', { id: cancelled.id, status: 'cancelled' });
    } catch (_) {}
    gn().notifyBooking(tenantId, bookingId, 'novo');
    if (cancelled) gn().notifyBooking(tenantId, cancelled.id, 'cancelado', { reason: 'Cliente trocou pelo horário da fila de espera' });
    // Cartao de confirmacao com Reagendar/Cancelar, como em qualquer agendamento
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    require('./whatsapp').sendBookingConfirmation({
      tenant, booking, clientName: e.customer_full_name, clientPhone: e.customer_phone, serviceName: e.item_name,
      servicePrice: Math.max(0, (e.item_price || 0) - (booking.discount_applied || 0)), barberName: barber ? barber.name : null
    }).catch(() => {});
    if (cancelled) kick(tenantId); // o horario antigo vagou: proximo da fila dele
  });

  const extra = cancelled ? `\n\n❌ Seu horário de *${fmtDate(cancelled.booking_date)} às ${cancelled.booking_time.slice(0, 5)}* foi cancelado.` : '';
  return { ok: true, text: `✅ *Vaga garantida!*\n_${tenant.name}_\n\n🗓️ ${fmtDate(e.booking_date)} às ${e.booking_time.slice(0, 5)}\n✂️ ${e.item_name}\n💈 ${barber ? barber.name : '-'}${extra}` };
}

function decline(entryId, senderPhone) {
  const { sameNumber } = gn();
  const e = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(Number(entryId));
  if (!e || !sameNumber(e.customer_phone, senderPhone)) return { ok: false, text: 'Não encontrei essa vaga. 🙏' };
  if (e.status === 'expired') return { ok: false, text: expiredText(e) };
  if (e.status !== 'offered') return { ok: false, text: 'Essa vaga já não está mais com você. 🙏' };
  db.prepare("UPDATE waitlist SET status = 'declined' WHERE id = ?").run(e.id);
  kick(e.tenant_id);
  return { ok: true, text: `👍 Tudo bem! Passamos a vaga para a próxima pessoa.${e.replace_booking_id ? ' Seu horário anterior continua valendo.' : ''}` };
}

// Oferta aberta para este telefone (usado para "sim"/"nao" digitados). Retorna null se nao houver ou se houver mais de uma.
function singleOfferFor(phone, tenantId = null) {
  const { sameNumber } = gn();
  const rows = db.prepare("SELECT * FROM waitlist WHERE status = 'offered' AND offer_expires_at > ?" + (tenantId ? ' AND tenant_id = ?' : '')).all(...(tenantId ? [Date.now(), tenantId] : [Date.now()]))
    .filter(r => sameNumber(r.customer_phone, phone));
  return rows.length === 1 ? rows[0] : null;
}

// Trata toque (cli_wok / cli_wno) ou texto "sim"/"nao" quando ha oferta aberta. Devolve o texto de resposta ou null se nao era para a fila.
function handleReply(text, senderPhone, tenantId = null) {
  const m = /id:\s*cli_(wok|wno):(\d+)/.exec(String(text || ''));
  if (m) return (m[1] === 'wok' ? accept(m[2], senderPhone) : decline(m[2], senderPhone)).text;
  const word = String(text || '').replace(/[^\p{L}\s]/gu, '').trim().toLowerCase();
  if (/^(sim|aceito|aceitar|quero)$/.test(word) || /^(nao|não|recuso|recusar)$/.test(word)) {
    const o = singleOfferFor(senderPhone, tenantId);
    if (!o) return null;
    return (/^(sim|aceito|aceitar|quero)$/.test(word) ? accept(o.id, senderPhone) : decline(o.id, senderPhone)).text;
  }
  return null;
}

module.exports = {
  createEntry, linkEntry, leaveEntry, lookup, listForTenant, channelAvailable,
  kick, processTenant, startWaitlistScheduler, accept, decline, handleReply, singleOfferFor
};
