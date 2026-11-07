// Fila de espera de horarios.
//
// Regras (resumo):
// - A fila e POR TURNO (manha, tarde, noite): o cliente escolhe um turno ou varios de um dia de UM barbeiro.
//   Entrar na fila nao cria agendamento e NAO GARANTE VAGA: para ter certeza, ele precisa agendar outro horario.
// - Quando surge um horario livre dentro de um turno da fila (cancelamento/remarcacao/folga removida), a vaga e
//   oferecida ao primeiro da fila (ordem de chegada) com os botoes Aceitar / Recusar e fica reservada por alguns minutos.
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

function toHHMM(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); }

// Minutos ate o inicio do horario (negativo = ja passou)
function minutesUntil(date, time) {
  const n = nowBR();
  const days = Math.round((new Date(date + 'T12:00:00Z') - new Date(n.date + 'T12:00:00Z')) / 86400000);
  return days * 1440 + toMin(time) - n.minutes;
}

const SHIFT_KEYS = ['manha', 'tarde', 'noite'];
const SHIFT_LABEL = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };
function parseShifts(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return SHIFT_KEYS.filter(k => arr.map(x => String(x).trim()).includes(k));
}
function shiftsText(csv) {
  const list = parseShifts(csv);
  if (!list.length) return '';
  return list.length === 3 ? 'todos os turnos' : list.map(k => SHIFT_LABEL[k].toLowerCase()).join(' e ');
}
const NO_GUARANTEE = '⚠️ *Atenção:* a fila *não garante a vaga*. Só avisamos se um horário vagar, e quem aceitar primeiro fica com ele. Para ter certeza, *agende outro horário*.';

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

// Horarios livres para o cliente agendar agora (mesmo barbeiro e servico): primeiro o proprio dia, depois os proximos.
// Devolve ate 4 dias com horarios: [{ date, times: ['09:00', ...] }]
function alternativesFor(tenantId, barberId, date, duration) {
  const { computeFreeSlots } = require('./ai-agent');
  const out = [];
  const base = new Date(date + 'T12:00:00Z');
  for (let i = 0; i < 14 && out.length < 4; i++) {
    const d = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
    const times = computeFreeSlots(tenantId, barberId, d, duration).filter(t => minutesUntil(d, t) > CLOSE_MINUTES);
    if (times.length) out.push({ date: d, times: times.slice(0, 16) });
  }
  return out;
}

// body: { customer_full_name, customer_phone, service_id | package_id, barber_id, booking_date, shifts: ['manha','tarde','noite'] | 'all' }
function createEntry(tenant, body) {
  const bs = require('./barber-services');
  const { shiftInfo } = require('./ai-agent');
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
  if (!barberId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, json: { error: 'Dados incompletos' } };
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

  const blocked = require('./client-block').check(tenant, phone, item.price);
  if (blocked) return { status: blocked.status, json: blocked.json };
  if (!channelAvailable(tenant.id)) return { status: 400, json: { error: 'A fila de espera não está disponível nesta barbearia.' } };

  // Turnos cheios (existem, tem expediente e nenhum horario livre) sao os unicos em que faz sentido esperar
  const info = shiftInfo(tenant.id, barberId, date, item.duration);
  const full = SHIFT_KEYS.filter(k => info[k].exists && info[k].free.length === 0 && minutesUntil(date, toHHMM(info[k].endMin)) > CLOSE_MINUTES);
  const wantAll = body.shifts === 'all' || body.shifts == null || body.shifts === '';
  const chosen = wantAll ? full : parseShifts(body.shifts).filter(k => full.includes(k));
  if (!chosen.length) {
    const anyFree = SHIFT_KEYS.some(k => info[k].exists && info[k].free.length);
    return { status: anyFree && wantAll ? 409 : 400, json: { error: anyFree ? 'Esse turno tem horário livre agora. É só agendar normalmente.' : 'Não há turno disponível para entrar na fila nesse dia.' } };
  }
  const shifts = chosen.join(',');

  const mine = activeEntries(tenant.id, phone);
  const dup = mine.find(e => e.barber_id === barberId && e.booking_date === date);
  if (dup) {
    // Mesmo barbeiro e dia: atualiza os turnos em vez de duplicar a fila
    if (dup.status === 'waiting' && dup.shifts !== shifts) db.prepare('UPDATE waitlist SET shifts = ? WHERE id = ?').run(shifts, dup.id);
    return { status: 200, json: { id: dup.id, already: true, shifts: dup.status === 'waiting' ? shifts : dup.shifts, alternatives: alternativesFor(tenant.id, barberId, date, item.duration), bookings: futureBookingsOf(tenant.id, phone), replace_booking_id: dup.replace_booking_id || null } };
  }
  if (mine.length >= MAX_ACTIVE_PER_PHONE) return { status: 400, json: { error: `Você já está em ${MAX_ACTIVE_PER_PHONE} filas. Saia de alguma antes de entrar em outra.` } };

  const r = db.prepare(`
    INSERT INTO waitlist (tenant_id, customer_full_name, customer_phone, service_id, package_id, item_name, item_price, item_duration, barber_id, booking_date, booking_time, shifts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '00:00', ?)
  `).run(tenant.id, name, phone, item.service_id, item.package_id, item.name, item.price, item.duration, barberId, date, shifts);
  // Avisa o gestor (WhatsApp + painel em tempo real), de qualquer barbeiro
  try {
    gn().notifyWaitlistJoin(tenant.id, { customer_full_name: name, customer_phone: phone, item_name: item.name, barber_id: barberId, booking_date: date, shifts });
    require('./events').broadcastEvent(tenant.id, { eventType: 'WAITLIST', waitlist: { id: r.lastInsertRowid, name, barber: barber.name, date, shifts } });
  } catch (_) { /* aviso e best-effort */ }
  return { status: 201, json: { id: r.lastInsertRowid, shifts, alternatives: alternativesFor(tenant.id, barberId, date, item.duration), bookings: futureBookingsOf(tenant.id, phone), replace_booking_id: null } };
}

// Quais turnos de um barbeiro/dia estao cheios (da para entrar na fila) e quais tem horario livre. Para a pagina publica.
function shiftStatus(tenant, barberId, date, serviceId, packageId) {
  const bs = require('./barber-services');
  const { shiftInfo } = require('./ai-agent');
  barberId = Number(barberId);
  if (!barberId || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { status: 400, json: { error: 'Dados incompletos' } };
  let duration = 30;
  if (packageId) {
    const svcs = db.prepare('SELECT s.id, s.duration FROM package_services ps JOIN services s ON s.id = ps.service_id JOIN packages p ON p.id = ps.package_id WHERE ps.package_id = ? AND p.tenant_id = ?').all(packageId, tenant.id);
    if (svcs.length) duration = bs.totalDuration(barberId, svcs);
  } else if (serviceId) {
    const svc = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(serviceId, tenant.id);
    if (svc) duration = bs.durationFor(barberId, svc.id, svc.duration);
  }
  const info = shiftInfo(tenant.id, barberId, date, duration);
  const shifts = {};
  for (const k of SHIFT_KEYS) {
    const state = !info[k].exists ? 'closed' : info[k].free.length ? 'free' : (minutesUntil(date, toHHMM(info[k].endMin)) > CLOSE_MINUTES ? 'full' : 'closed');
    shifts[k] = { label: SHIFT_LABEL[k], state, free: info[k].free.length };
  }
  return { status: 200, json: { available: channelAvailable(tenant.id), shifts } };
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
    SELECT w.id, w.booking_date, w.shifts, w.offered_time, w.item_name, w.status, w.replace_booking_id, br.name AS barbeiro,
           rb.booking_date AS replace_date, rb.booking_time AS replace_time
    FROM waitlist w LEFT JOIN barbers br ON br.id = w.barber_id
    LEFT JOIN bookings rb ON rb.id = w.replace_booking_id AND rb.status = 'confirmed'
    WHERE w.tenant_id = ? AND w.customer_phone = ? AND w.status IN ('waiting','offered') ORDER BY w.booking_date, w.id
  `).all(tenantId, p);
}

// Lista para o painel do gestor
function listForTenant(tenantId) {
  const n = nowBR();
  return db.prepare(`
    SELECT w.id, w.customer_full_name, w.customer_phone, w.item_name, w.booking_date, w.shifts, w.offered_time, w.status, w.offer_expires_at,
           w.created_at, br.name AS barbeiro
    FROM waitlist w LEFT JOIN barbers br ON br.id = w.barber_id
    WHERE w.tenant_id = ? AND w.status IN ('waiting','offered') AND w.booking_date >= ?
    ORDER BY w.booking_date, w.id
  `).all(tenantId, n.date);
}

// ==================== Ofertas ====================

// Texto de "o prazo acabou": deixa claro o que acontece com o horario que ele ja tinha
function slotTimeOf(e) { return String(e.offered_time || e.booking_time).slice(0, 5); }

function expiredText(e, late = false) {
  const slot = `${fmtDate(e.booking_date)} às ${slotTimeOf(e)}`;
  let kept = '';
  if (e.replace_booking_id) {
    const rb = db.prepare("SELECT booking_date, booking_time FROM bookings WHERE id = ? AND tenant_id = ? AND customer_phone = ? AND status = 'confirmed'").get(e.replace_booking_id, e.tenant_id, e.customer_phone);
    if (rb) kept = `\n\n✅ *Você continua com o seu horário de ${fmtDate(rb.booking_date)} às ${rb.booking_time.slice(0, 5)}.* Nada foi cancelado, está tudo certo.`;
  }
  return `⏳ *O prazo para aceitar acabou.*\n\nComo não recebemos sua resposta a tempo, a vaga de *${slot}* foi liberada para a próxima pessoa da fila.${kept}` +
    (late ? '\n\nPor isso não dá mais para confirmar essa vaga. Se ainda quiser, entre na fila de novo pelo site.' : '') +
    '\n\n💡 Lembrete: a fila não garante vaga. Para ter certeza do seu horário, agende pelo site.';
}

function offerMinutesFor(e) {
  const until = minutesUntil(e.booking_date, slotTimeOf(e));
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
  const turno = shiftsText(e.shifts);
  const text = `Boa notícia, ${String(e.customer_full_name).split(' ')[0]}! 🎉\n\nUm horário vagou na *${tenant.name}*${turno ? ` (fila: ${turno})` : ''}:\n\n` +
    `✂️ *Serviço:* ${e.item_name}\n💈 *Barbeiro:* ${barber ? barber.name : '-'}\n🗓️ *Data:* ${fmtDate(e.booking_date)}\n⏰ *Horário:* ${slotTimeOf(e)}` +
    `${swap}\n\nReservamos para você por *${minutes} minutos*. Quer ficar com ele?\n\n_Lembrete: a fila não garante vaga. Se não responder a tempo, ela passa para a próxima pessoa._`;
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
    const { shiftInfo } = require('./ai-agent');
    const now = Date.now();

    for (const e of db.prepare("SELECT * FROM waitlist WHERE tenant_id = ? AND status = 'offered' AND offer_expires_at <= ?").all(tenantId, now)) {
      db.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ? AND status = 'offered'").run(e.id);
      sendToClient(tenantId, e.customer_phone, expiredText(e), [], '').catch(err => console.error(`[fila] aviso de prazo não enviado (fila ${e.id}): ${err.message}`));
    }

    const waiting = db.prepare("SELECT * FROM waitlist WHERE tenant_id = ? AND status = 'waiting' ORDER BY id").all(tenantId);
    for (const e of waiting) {
      const cur = db.prepare('SELECT status FROM waitlist WHERE id = ?').get(e.id);
      if (!cur || cur.status !== 'waiting') continue;
      const shifts = parseShifts(e.shifts);
      const info = shiftInfo(tenantId, e.barber_id, e.booking_date, e.item_duration);
      // A fila encerra quando o ultimo turno escolhido esta acabando (ou o dia ja passou)
      const lastEnd = Math.max(0, ...shifts.map(k => info[k].endRaw));
      if (!shifts.length || minutesUntil(e.booking_date, toHHMM(lastEnd)) <= CLOSE_MINUTES) { db.prepare("UPDATE waitlist SET status = 'closed' WHERE id = ?").run(e.id); continue; }
      // Primeiro horario livre dentro dos turnos da fila (nao oferece horario quase comecando)
      const free = shifts.flatMap(k => info[k].free).filter(t => minutesUntil(e.booking_date, t) > CLOSE_MINUTES).sort();
      if (!free.length) continue;
      e.offered_time = free[0];
      if (!channelAvailable(tenantId)) { console.log(`[fila] tenant ${tenantId}: vaga livre, mas sem WhatsApp para avisar`); break; }
      // O horario que ele quer trocar deixou de existir: oferece sem cancelar nada
      if (e.replace_booking_id && !db.prepare("SELECT 1 FROM bookings WHERE id = ? AND tenant_id = ? AND customer_phone = ? AND status = 'confirmed'").get(e.replace_booking_id, tenantId, e.customer_phone)) {
        db.prepare('UPDATE waitlist SET replace_booking_id = NULL WHERE id = ?').run(e.id);
        e.replace_booking_id = null;
      }
      const minutes = offerMinutesFor(e);
      // Reserva primeiro (sincrono): ninguem mais consegue pegar o horario enquanto a mensagem vai
      db.prepare("UPDATE waitlist SET status = 'offered', offered_time = ?, offered_at = ?, offer_expires_at = ? WHERE id = ? AND status = 'waiting'").run(e.offered_time, Date.now(), Date.now() + minutes * 60000, e.id);
      try {
        await sendOffer(e, minutes);
        console.log(`[fila] vaga oferecida (tenant ${tenantId}, fila ${e.id}, ${e.booking_date} ${e.offered_time})`);
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
  const slot = slotTimeOf(e);
  if (!slotIsFree(tenantId, e.barber_id, e.booking_date, slot, e.item_duration, { ignoreWaitlistId: e.id })) {
    db.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ?").run(e.id);
    kick(tenantId);
    return { ok: false, text: 'Poxa, esse horário acabou de ser ocupado. Seu horário anterior (se houver) continua valendo. Lembre: a fila não garante vaga, agende pelo site para ter certeza. 🙏' };
  }

  let bookingId = null, cancelled = null;
  try {
    db.transaction(() => {
      let user = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND phone = ?').get(tenantId, e.customer_phone);
      if (!user) user = { id: db.prepare('INSERT INTO users (tenant_id, full_name, phone) VALUES (?, ?, ?)').run(tenantId, e.customer_full_name, e.customer_phone).lastInsertRowid };
      bookingId = db.prepare(`
        INSERT INTO bookings (tenant_id, user_id, customer_full_name, customer_phone, service_id, package_id, item_name, item_price, item_duration, barber_id, booking_date, booking_time, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
      `).run(tenantId, user.id, e.customer_full_name, e.customer_phone, e.service_id, e.package_id, e.item_name, e.item_price, e.item_duration, e.barber_id, e.booking_date, slot).lastInsertRowid;
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
  return { ok: true, text: `✅ *Vaga garantida!*\n_${tenant.name}_\n\n🗓️ ${fmtDate(e.booking_date)} às ${slot}\n✂️ ${e.item_name}\n💈 ${barber ? barber.name : '-'}${extra}` };
}

function decline(entryId, senderPhone) {
  const { sameNumber } = gn();
  const e = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(Number(entryId));
  if (!e || !sameNumber(e.customer_phone, senderPhone)) return { ok: false, text: 'Não encontrei essa vaga. 🙏' };
  if (e.status === 'expired') return { ok: false, text: expiredText(e) };
  if (e.status !== 'offered') return { ok: false, text: 'Essa vaga já não está mais com você. 🙏' };
  db.prepare("UPDATE waitlist SET status = 'declined' WHERE id = ?").run(e.id);
  kick(e.tenant_id);
  return { ok: true, text: `👍 Tudo bem! Passamos a vaga para a próxima pessoa.${e.replace_booking_id ? ' Seu horário anterior continua valendo.' : ''}\n\nSe ainda quiser um horário, entre na fila de novo ou agende pelo site. A fila não garante vaga.` };
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
  createEntry, shiftStatus, linkEntry, leaveEntry, lookup, listForTenant, channelAvailable,
  kick, processTenant, startWaitlistScheduler, accept, decline, handleReply, singleOfferFor
};
