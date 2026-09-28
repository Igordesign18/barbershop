// Quais servicos cada barbeiro faz (ex: um so corta, outro so faz barba, outro pinta).
// Regra: barbeiro sem nenhum servico marcado = faz TODOS (padrao, nao muda nada para quem nao configurar).
const { db } = require('./db');

// Lista de ids de servicos do barbeiro, ou null quando ele faz todos
function getServiceIds(barberId) {
  // JOIN garante que servico excluido nao conta
  const rows = db.prepare(`
    SELECT bs.service_id FROM barber_services bs JOIN services s ON s.id = bs.service_id WHERE bs.barber_id = ?
  `).all(barberId);
  return rows.length ? rows.map(r => r.service_id) : null;
}

// ids = null/[] -> todos os servicos; senao so os informados (apenas servicos da mesma barbearia)
function setServiceIds(tenantId, barberId, ids) {
  const clean = Array.isArray(ids)
    ? [...new Set(ids.map(Number).filter(Boolean))].filter(id =>
        db.prepare('SELECT 1 FROM services WHERE id = ? AND tenant_id = ?').get(id, tenantId))
    : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM barber_services WHERE barber_id = ?').run(barberId);
    const ins = db.prepare('INSERT INTO barber_services (barber_id, service_id) VALUES (?, ?)');
    for (const id of clean) ins.run(barberId, id);
  });
  tx();
  return clean.length ? clean : null;
}

// O barbeiro faz todos estes servicos?
function barberDoesAll(barberId, serviceIds) {
  const allowed = getServiceIds(barberId);
  if (!allowed) return true;
  return (serviceIds || []).every(id => allowed.includes(Number(id)));
}

// ==================== Tempo proprio do barbeiro em cada servico ====================
// Mapa { service_id: minutos } so com os servicos em que o barbeiro tem tempo diferente do padrao
function getDurations(barberId) {
  const rows = db.prepare(`
    SELECT d.service_id, d.duration FROM barber_service_durations d JOIN services s ON s.id = d.service_id WHERE d.barber_id = ?
  `).all(barberId);
  const map = {};
  for (const r of rows) map[r.service_id] = r.duration;
  return map;
}

// map = { service_id: minutos }. Valor vazio/invalido ou < 5 = volta ao padrao do servico.
function setDurations(tenantId, barberId, map) {
  const clean = [];
  for (const [sid, raw] of Object.entries(map && typeof map === 'object' ? map : {})) {
    const minutes = Math.round(Number(raw));
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 720) continue;
    if (!db.prepare('SELECT 1 FROM services WHERE id = ? AND tenant_id = ?').get(Number(sid), tenantId)) continue;
    clean.push([Number(sid), minutes]);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM barber_service_durations WHERE barber_id = ?').run(barberId);
    const ins = db.prepare('INSERT INTO barber_service_durations (barber_id, service_id, duration) VALUES (?, ?, ?)');
    for (const [sid, minutes] of clean) ins.run(barberId, sid, minutes);
  })();
  return getDurations(barberId);
}

// Barbeiros da barbearia que fazem este servico, com o tempo proprio de cada um (duration = null -> usa o padrao)
function getBarberTimesForService(tenantId, serviceId) {
  const barbers = db.prepare('SELECT id, name FROM barbers WHERE tenant_id = ? ORDER BY id').all(tenantId);
  const custom = {};
  for (const r of db.prepare('SELECT barber_id, duration FROM barber_service_durations WHERE service_id = ?').all(serviceId)) custom[r.barber_id] = r.duration;
  return barbers
    .filter(b => { const ids = getServiceIds(b.id); return !ids || ids.includes(Number(serviceId)); })
    .map(b => ({ id: b.id, name: b.name, duration: custom[b.id] ?? null }));
}

// map = { barber_id: minutos } para UM servico. Vazio/invalido = volta ao padrao do servico.
function setBarberTimesForService(tenantId, serviceId, map) {
  const barberIds = new Set(db.prepare('SELECT id FROM barbers WHERE tenant_id = ?').all(tenantId).map(b => b.id));
  const clean = [];
  for (const [bid, raw] of Object.entries(map && typeof map === 'object' ? map : {})) {
    const minutes = Math.round(Number(raw));
    if (!barberIds.has(Number(bid)) || !Number.isFinite(minutes) || minutes < 5 || minutes > 720) continue;
    clean.push([Number(bid), minutes]);
  }
  db.transaction(() => {
    for (const bid of barberIds) db.prepare('DELETE FROM barber_service_durations WHERE barber_id = ? AND service_id = ?').run(bid, serviceId);
    const ins = db.prepare('INSERT INTO barber_service_durations (barber_id, service_id, duration) VALUES (?, ?, ?)');
    for (const [bid, minutes] of clean) ins.run(bid, serviceId, minutes);
  })();
}

// Duracao de um servico para este barbeiro (barberId pode ser null = padrao do servico)
function durationFor(barberId, serviceId, defaultDuration) {
  if (barberId) {
    const row = db.prepare('SELECT duration FROM barber_service_durations WHERE barber_id = ? AND service_id = ?').get(barberId, serviceId);
    if (row) return row.duration;
  }
  return defaultDuration;
}

// Soma das duracoes de varios servicos ({ id, duration }) para este barbeiro
function totalDuration(barberId, services) {
  return (services || []).reduce((sum, s) => sum + durationFor(barberId, s.id, s.duration), 0);
}

// Anexa service_ids (null = todos) e service_durations a uma lista de barbeiros
function withServiceIds(barbers) {
  return barbers.map(b => ({ ...b, service_ids: getServiceIds(b.id), service_durations: getDurations(b.id) }));
}

// Converte o que vem do formulario (JSON em texto no multipart, ou array)
function parseIds(raw) {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Converte o JSON do formulario em objeto (undefined = campo nao enviado)
function parseDurations(raw) {
  if (raw === undefined) return undefined;
  if (raw && typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

module.exports = { getServiceIds, setServiceIds, barberDoesAll, withServiceIds, parseIds, getDurations, setDurations, getBarberTimesForService, setBarberTimesForService, durationFor, totalDuration, parseDurations };
