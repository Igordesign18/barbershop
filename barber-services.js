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

// Anexa service_ids (null = todos) a uma lista de barbeiros
function withServiceIds(barbers) {
  return barbers.map(b => ({ ...b, service_ids: getServiceIds(b.id) }));
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

module.exports = { getServiceIds, setServiceIds, barberDoesAll, withServiceIds, parseIds };
