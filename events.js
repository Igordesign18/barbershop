// Substitui o supabase.channel(...).on('postgres_changes', ...) por Server-Sent Events,
// um "canal" por barbearia (tenant) para o gestor de uma loja nao ver eventos de outra.
const clientsByTenant = new Map(); // tenantId -> Set<res>

function addClient(tenantId, res) {
  if (!clientsByTenant.has(tenantId)) clientsByTenant.set(tenantId, new Set());
  clientsByTenant.get(tenantId).add(res);
}

function removeClient(tenantId, res) {
  const set = clientsByTenant.get(tenantId);
  if (set) set.delete(res);
}

function broadcastBookingChange(tenantId, eventType, booking) {
  const set = clientsByTenant.get(tenantId);
  if (!set || set.size === 0) return;

  const payload = JSON.stringify({ eventType, booking });
  for (const res of set) {
    res.write(`data: ${payload}\n\n`);
  }
}

module.exports = { addClient, removeClient, broadcastBookingChange };
