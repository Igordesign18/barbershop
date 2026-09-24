// Atendente IA de agendamento pelo WhatsApp (somente plano PRO).
// Fluxo: webhook da Evolution -> (audio? transcreve com OpenAI) -> junta mensagens seguidas
// -> OpenAI com ferramentas (listar profissionais/servicos, horarios, registrar cliente, agendar)
// -> responde o cliente pelo mesmo WhatsApp da barbearia.

const { db } = require('./db');
const waProvider = require('./wa-provider');
const openai = require('./openai');
const { normalizePhone } = require('./phone');
const { checkTenantActive } = require('./tenant');
const { sendBookingConfirmation, formatDateBR, formatCurrencyBRL } = require('./whatsapp');
const { tryApplyReward } = require('./loyalty');

const TZ = 'America/Sao_Paulo';
const DEBOUNCE_MS = 3000;                 // espera o cliente terminar de mandar mensagens seguidas
const SESSION_TTL_HOURS = 4;              // depois disso a conversa recomeca do zero
const HUMAN_TAKEOVER_MINUTES = 60;        // gestor respondeu manualmente -> IA fica quieta nesse chat
const MAX_HISTORY = 40;
const MAX_TOOL_ROUNDS = 6;
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

const DEFAULT_AI_CONFIG = {
  enabled: false,
  assistant_name: 'Assistente Virtual',
  extra_instructions: '',
  interactive_enabled: false, // botoes e listas (PRO)
  carousel_enabled: false     // carrossel com fotos de profissionais/servicos (PRO, so Evolution GO)
};

// ==================== Config / plano ====================

function isProTenant(tenant) {
  return !!tenant && String(tenant.plan || '').toLowerCase() === 'pro';
}

function getAiConfig(tenantId) {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'ai_config'").get(tenantId);
  if (!row) return { ...DEFAULT_AI_CONFIG };
  try { return { ...DEFAULT_AI_CONFIG, ...JSON.parse(row.value) }; } catch { return { ...DEFAULT_AI_CONFIG }; }
}

function saveAiConfig(tenantId, config) {
  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, 'ai_config', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(tenantId, JSON.stringify(config));
}

function getSetting(tenantId, key) {
  return db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, key)?.value || null;
}

// ==================== Telefone ====================

// WhatsApp as vezes entrega celular brasileiro sem o 9 (55 + DDD + 8 digitos).
// Tentamos as duas formas para reconhecer o cliente ja cadastrado.
function phoneVariants(phone) {
  const p = normalizePhone(phone);
  if (!p) return [];
  const list = [p];
  if (p.startsWith('55') && p.length === 12 && /[6-9]/.test(p[4])) list.push(p.slice(0, 4) + '9' + p.slice(4));
  if (p.startsWith('55') && p.length === 13 && p[4] === '9') list.push(p.slice(0, 4) + p.slice(5));
  return list;
}

function toCanonicalPhone(phone) {
  const p = normalizePhone(phone);
  // Guarda sempre com o 9 (mesmo formato da pagina publica de agendamento)
  if (p.startsWith('55') && p.length === 12 && /[6-9]/.test(p[4])) return p.slice(0, 4) + '9' + p.slice(4);
  return p;
}

function formatPhoneBR(phone) {
  const p = toCanonicalPhone(phone);
  const local = p.startsWith('55') ? p.slice(2) : p;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return p;
}

function findUserByPhone(tenantId, phone) {
  for (const variant of phoneVariants(phone)) {
    const user = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND phone = ?').get(tenantId, variant);
    if (user) return user;
  }
  return null;
}

// ==================== Datas e horarios (sempre Brasilia) ====================

function nowBR() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}`, minutes: Number(hour) * 60 + Number(parts.minute) };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function toHHMM(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function periodKey(hour) {
  return hour < 12 ? 'manha' : hour < 18 ? 'tarde' : 'noite';
}

function getScheduleConfig(tenantId) {
  let schedule = {};
  try { schedule = JSON.parse(getSetting(tenantId, 'schedule_config') || '{}'); } catch { schedule = {}; }
  const interval = parseInt(getSetting(tenantId, 'interval_time') || '30', 10) || 30;
  return { schedule, interval };
}

function getBlockedPeriods(tenantId, date) {
  return new Set(db.prepare('SELECT period FROM blocked_dates WHERE tenant_id = ? AND date = ?').all(tenantId, date).map(r => r.period));
}

// Mesma regra da pagina publica (client.js): horarios de "interval" em "interval" dentro de cada turno,
// que caibam a duracao inteira, sem turno bloqueado, sem horario passado e sem conflito com o barbeiro.
function computeFreeSlots(tenantId, barberId, date, duration) {
  const { schedule, interval } = getScheduleConfig(tenantId);
  const dayConfig = schedule[weekdayOf(date)];
  if (!dayConfig || !dayConfig.active) return [];

  const blocked = getBlockedPeriods(tenantId, date);
  if (blocked.has('')) return [];

  const now = nowBR();
  if (date < now.date) return [];

  const busy = db.prepare(`
    SELECT b.booking_time, COALESCE(b.item_duration, s.duration, 30) AS duration
    FROM bookings b LEFT JOIN services s ON s.id = b.service_id
    WHERE b.tenant_id = ? AND b.booking_date = ? AND b.barber_id = ? AND b.status = 'confirmed'
  `).all(tenantId, date, barberId).map(b => {
    const start = toMinutes(b.booking_time);
    return { start, end: start + Number(b.duration || 30) };
  });

  const slots = [];
  for (const period of dayConfig.periods || []) {
    const open = toMinutes(period.start);
    const close = toMinutes(period.end);
    for (let start = open; start + duration <= close; start += interval) {
      if (blocked.has(periodKey(Math.floor(start / 60)))) continue;
      if (date === now.date && start <= now.minutes) continue;
      const end = start + duration;
      if (busy.some(b => start < b.end && end > b.start)) continue;
      slots.push(toHHMM(start));
    }
  }
  return slots;
}

function describeNextDays(tenantId, days = 14) {
  const { schedule } = getScheduleConfig(tenantId);
  const today = nowBR().date;
  const lines = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    const cfg = schedule[weekdayOf(date)];
    const blocked = getBlockedPeriods(tenantId, date);
    let status;
    if (!cfg || !cfg.active || blocked.has('')) {
      status = 'FECHADO';
    } else {
      const periods = (cfg.periods || [])
        .filter(p => !blocked.has(periodKey(Math.floor(toMinutes(p.start) / 60))))
        .map(p => `${p.start}-${p.end}`);
      status = periods.length ? `aberto ${periods.join(', ')}` : 'FECHADO';
    }
    const label = i === 0 ? ' (hoje)' : i === 1 ? ' (amanhã)' : '';
    lines.push(`- ${WEEKDAYS[weekdayOf(date)]} ${formatDateBR(date)} [${date}]${label}: ${status}`);
  }
  return lines.join('\n');
}

// ==================== Conversa (historico) ====================

function loadConversation(tenantId, chatId) {
  let row = db.prepare('SELECT * FROM ai_conversations WHERE tenant_id = ? AND chat_id = ?').get(tenantId, chatId);
  if (!row) {
    db.prepare('INSERT INTO ai_conversations (tenant_id, chat_id) VALUES (?, ?)').run(tenantId, chatId);
    row = db.prepare('SELECT * FROM ai_conversations WHERE tenant_id = ? AND chat_id = ?').get(tenantId, chatId);
  }
  let messages = [];
  try { messages = JSON.parse(row.messages || '[]'); } catch { messages = []; }

  // Conversa parada ha muito tempo: recomeca (o cliente continua reconhecido pelo telefone)
  const updatedAt = new Date(row.updated_at.replace(' ', 'T') + 'Z').getTime();
  if (Date.now() - updatedAt > SESSION_TTL_HOURS * 60 * 60 * 1000) messages = [];

  return { ...row, messages };
}

function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY) return messages;
  let start = messages.length - MAX_HISTORY;
  // Nunca corta no meio de uma chamada de ferramenta: comeca sempre numa mensagem do cliente
  while (start < messages.length && messages[start].role !== 'user') start++;
  return messages.slice(start);
}

function saveConversation(tenantId, chatId, fields) {
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(key === 'messages' ? JSON.stringify(trimHistory(value)) : value);
  }
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE ai_conversations SET ${sets.join(', ')} WHERE tenant_id = ? AND chat_id = ?`).run(...values, tenantId, chatId);
}

function pauseConversation(tenantId, chatId) {
  loadConversation(tenantId, chatId); // garante que a linha existe
  const until = new Date(Date.now() + HUMAN_TAKEOVER_MINUTES * 60 * 1000).toISOString();
  db.prepare('UPDATE ai_conversations SET paused_until = ? WHERE tenant_id = ? AND chat_id = ?').run(until, tenantId, chatId);
}

// ==================== Ferramentas da IA ====================

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'registrar_cliente',
      description: 'Salva/atualiza o cadastro do cliente. Só chame DEPOIS que o cliente confirmou o nome completo e o número de telefone.',
      parameters: {
        type: 'object',
        properties: {
          nome_completo: { type: 'string', description: 'Nome e sobrenome do cliente' },
          telefone: { type: 'string', description: 'Telefone com DDD confirmado pelo cliente (só números)' }
        },
        required: ['nome_completo', 'telefone']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_profissionais',
      description: 'Lista os profissionais (barbeiros) da barbearia.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_servicos',
      description: 'Lista os serviços com preço e duração.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'horarios_disponiveis',
      description: 'Retorna os horários livres de um profissional numa data, considerando a duração somada dos serviços escolhidos.',
      parameters: {
        type: 'object',
        properties: {
          profissional_id: { type: 'integer' },
          data: { type: 'string', description: 'Data no formato AAAA-MM-DD' },
          servicos_ids: { type: 'array', items: { type: 'integer' } }
        },
        required: ['profissional_id', 'data', 'servicos_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_agendamento',
      description: 'Cria o agendamento. Só chame depois que o cliente confirmou explicitamente o resumo (profissional, serviços, data, hora e valor).',
      parameters: {
        type: 'object',
        properties: {
          profissional_id: { type: 'integer' },
          servicos_ids: { type: 'array', items: { type: 'integer' } },
          data: { type: 'string', description: 'AAAA-MM-DD' },
          hora: { type: 'string', description: 'HH:MM' }
        },
        required: ['profissional_id', 'servicos_ids', 'data', 'hora']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'meus_agendamentos',
      description: 'Lista os próximos agendamentos confirmados do cliente já identificado.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// Ferramentas de mensagem interativa (so entram se o gestor ligou e o motor suporta)
const INTERACTIVE_TOOLS = {
  enviar_botoes: {
    type: 'function',
    function: {
      name: 'enviar_botoes',
      description: 'Envia uma pergunta com até 3 botões de resposta rápida (ex: confirmar Sim/Não, "Agendar por aqui" / "Receber o link"). O cliente toca e a escolha volta como mensagem.',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'Pergunta/mensagem que acompanha os botões' },
          opcoes: {
            type: 'array', maxItems: 3,
            items: { type: 'object', properties: { id: { type: 'string' }, titulo: { type: 'string', description: 'Até 20 caracteres' } }, required: ['id', 'titulo'] }
          }
        },
        required: ['texto', 'opcoes']
      }
    }
  },
  enviar_lista: {
    type: 'function',
    function: {
      name: 'enviar_lista',
      description: 'Envia uma lista de até 10 opções (ex: horários livres, serviços, profissionais). O cliente abre a lista e toca numa opção.',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'Mensagem que acompanha a lista' },
          botao: { type: 'string', description: 'Texto do botão que abre a lista, ex: "Ver horários"' },
          opcoes: {
            type: 'array', maxItems: 10,
            items: { type: 'object', properties: { id: { type: 'string' }, titulo: { type: 'string', description: 'Até 24 caracteres' }, descricao: { type: 'string' } }, required: ['id', 'titulo'] }
          }
        },
        required: ['texto', 'opcoes']
      }
    }
  },
  enviar_carrossel: {
    type: 'function',
    function: {
      name: 'enviar_carrossel',
      description: 'Envia um carrossel com fotos dos profissionais ou dos serviços, cada card com um botão para escolher.',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['profissionais', 'servicos'] },
          texto: { type: 'string', description: 'Mensagem que acompanha o carrossel' }
        },
        required: ['tipo', 'texto']
      }
    }
  }
};

function interactiveFlags(ctx) {
  const config = getAiConfig(ctx.tenant.id);
  const allowed = isProTenant(ctx.tenant) && ctx.instance; // somente plano PRO
  return {
    buttons: !!(allowed && config.interactive_enabled && waProvider.supports(ctx.instance, 'buttons')),
    list: !!(allowed && config.interactive_enabled && waProvider.supports(ctx.instance, 'list')),
    carousel: !!(allowed && config.carousel_enabled && waProvider.supports(ctx.instance, 'carousel'))
  };
}

function toolsFor(ctx) {
  const flags = interactiveFlags(ctx);
  const tools = [...TOOLS];
  if (flags.buttons) tools.push(INTERACTIVE_TOOLS.enviar_botoes);
  if (flags.list) tools.push(INTERACTIVE_TOOLS.enviar_lista);
  if (flags.carousel) tools.push(INTERACTIVE_TOOLS.enviar_carrossel);
  return tools;
}

function cut(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function absoluteUrl(tenantId, url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = (process.env.PUBLIC_BASE_URL || getSetting(tenantId, 'public_base_url') || '').replace(/\/$/, '');
  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : null;
}

function numberedFallback(texto, opcoes) {
  return `${texto}\n\n${opcoes.map((o, i) => `*${i + 1}.* ${o.titulo}${o.descricao ? ` — ${o.descricao}` : ''}`).join('\n')}\n\nResponda com o número ou o nome.`;
}

async function runInteractiveTool(name, args, ctx) {
  const { tenant, instance, replyTo } = ctx;
  const flags = interactiveFlags(ctx);
  const footer = cut(tenant.name, 60);
  const texto = String(args.texto || '').trim() || 'Escolha uma opção:';
  const done = format => {
    ctx.interactiveSent = true;
    console.log(`[ia] ${name} enviado como ${format} (tenant ${tenant.id})`);
    return {
      ok: true,
      formato: format,
      instrucao: 'As opções JÁ foram enviadas ao cliente. Não repita as opções. Se não tiver mais nada a dizer agora, responda somente com "-" e aguarde a escolha.'
    };
  };

  if (name === 'enviar_botoes') {
    if (!flags.buttons) return { erro: 'Botões desativados. Envie as opções em texto numerado.' };
    const opcoes = (args.opcoes || []).slice(0, 3).map(o => ({ id: cut(o.id, 60), titulo: cut(o.titulo, 20) })).filter(o => o.titulo);
    if (!opcoes.length) return { erro: 'Informe ao menos uma opção.' };
    const format = await waProvider.sendInteractive(instance, replyTo, 'buttons',
      { title: ' ', text: texto, footer, buttons: opcoes.map(o => ({ id: o.id, text: o.titulo })) },
      numberedFallback(texto, opcoes));
    return done(format);
  }

  if (name === 'enviar_lista') {
    if (!flags.list) return { erro: 'Listas desativadas. Envie as opções em texto numerado.' };
    const opcoes = (args.opcoes || []).slice(0, 10).map(o => ({ id: cut(o.id, 60), titulo: cut(o.titulo, 24), descricao: cut(o.descricao, 72) })).filter(o => o.titulo);
    if (!opcoes.length) return { erro: 'Informe ao menos uma opção.' };
    const format = await waProvider.sendInteractive(instance, replyTo, 'list',
      { title: cut(tenant.name, 60), text: texto, footer, buttonText: cut(args.botao || 'Ver opções', 20), sections: [{ title: 'Opções', rows: opcoes.map(o => ({ id: o.id, title: o.titulo, description: o.descricao })) }] },
      numberedFallback(texto, opcoes));
    return done(format);
  }

  if (name === 'enviar_carrossel') {
    if (!flags.carousel) return { erro: 'Carrossel desativado. Use lista ou texto numerado.' };
    const logo = absoluteUrl(tenant.id, getSetting(tenant.id, 'logo_url'));
    let items;
    if (args.tipo === 'servicos') {
      items = db.prepare('SELECT id, name, price, duration, photo_url FROM services WHERE tenant_id = ? ORDER BY id LIMIT 10').all(tenant.id)
        .map(sv => ({ id: `servico_${sv.id}`, titulo: sv.name, descricao: `R$ ${formatCurrencyBRL(sv.price)} • ${sv.duration} min`, image: absoluteUrl(tenant.id, sv.photo_url) || logo, botao: sv.name }));
    } else {
      items = db.prepare('SELECT id, name, specialty, photo_url FROM barbers WHERE tenant_id = ? ORDER BY id LIMIT 10').all(tenant.id)
        .map(b => ({ id: `profissional_${b.id}`, titulo: b.name, descricao: b.specialty || 'Profissional', image: absoluteUrl(tenant.id, b.photo_url) || logo, botao: b.name.split(' ')[0] }));
    }
    if (!items.length) return { erro: 'Nada cadastrado para mostrar.' };
    // Card de carrossel precisa de imagem: sem foto (e sem logo), cai para lista
    if (items.some(i => !i.image)) return { erro: 'Faltam fotos para o carrossel. Use enviar_lista ou texto numerado.' };

    const format = await waProvider.sendInteractive(instance, replyTo, 'carousel',
      {
        text: texto,
        footer,
        cards: items.map(i => ({ title: cut(i.titulo, 60), imageUrl: i.image, body: `*${i.titulo}*\n${i.descricao}`, buttons: [{ id: i.id, text: cut(`Escolher ${i.botao}`, 20) }] }))
      },
      numberedFallback(texto, items));
    return done(format);
  }

  return { erro: `Ferramenta desconhecida: ${name}` };
}

function loadServices(tenantId, ids) {
  const unique = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!unique.length) return { error: 'Nenhum serviço informado.' };
  const services = unique.map(id => db.prepare('SELECT id, name, price, duration FROM services WHERE id = ? AND tenant_id = ?').get(id, tenantId));
  if (services.some(s => !s)) return { error: 'Algum serviço informado não existe. Chame listar_servicos novamente.' };
  return { services };
}

async function runTool(name, args, ctx) {
  const { tenant, conv } = ctx;
  const tenantId = tenant.id;

  switch (name) {
    case 'registrar_cliente': {
      const fullName = String(args.nome_completo || '').trim().replace(/\s+/g, ' ');
      if (fullName.split(' ').length < 2) return { erro: 'Peça o nome completo (nome e sobrenome).' };
      const phone = toCanonicalPhone(args.telefone || ctx.senderPhone || '');
      if (!phone || phone.length < 12) return { erro: 'Telefone inválido. Peça o número com DDD.' };

      let user = findUserByPhone(tenantId, phone);
      if (user) {
        db.prepare('UPDATE users SET full_name = ?, phone = ? WHERE id = ?').run(fullName, phone, user.id);
      } else {
        const r = db.prepare('INSERT INTO users (tenant_id, full_name, phone) VALUES (?, ?, ?)').run(tenantId, fullName, phone);
        user = { id: r.lastInsertRowid };
      }
      conv.customer_user_id = user.id;
      saveConversation(tenantId, conv.chat_id, { customer_user_id: user.id, phone });
      return { ok: true, cliente: fullName, telefone: formatPhoneBR(phone) };
    }

    case 'listar_profissionais': {
      const barbers = db.prepare('SELECT id, name, specialty FROM barbers WHERE tenant_id = ? ORDER BY id').all(tenantId);
      const flagsB = interactiveFlags(ctx);
      const hintB = barbers.length > 1 ? (flagsB.carousel ? 'Agora mostre com enviar_carrossel tipo "profissionais".' : flagsB.list ? 'Agora mostre com enviar_lista.' : null) : null;
      return { profissionais: barbers.map(b => ({ id: b.id, nome: b.name, especialidade: b.specialty || null })), ...(hintB ? { proximo_passo: hintB } : {}) };
    }

    case 'listar_servicos': {
      const services = db.prepare('SELECT id, name, price, duration FROM services WHERE tenant_id = ? ORDER BY id').all(tenantId);
      const flagsS = interactiveFlags(ctx);
      const hintS = flagsS.carousel ? 'Agora mostre com enviar_carrossel tipo "servicos".' : flagsS.list ? 'Agora mostre com enviar_lista (ids "servico_<id>").' : null;
      return { servicos: services.map(s => ({ id: s.id, nome: s.name, preco: `R$ ${formatCurrencyBRL(s.price)}`, duracao_min: s.duration })), ...(hintS ? { proximo_passo: hintS } : {}) };
    }

    case 'horarios_disponiveis': {
      const barber = db.prepare('SELECT id, name FROM barbers WHERE id = ? AND tenant_id = ?').get(args.profissional_id, tenantId);
      if (!barber) return { erro: 'Profissional inválido. Chame listar_profissionais.' };
      const loaded = loadServices(tenantId, args.servicos_ids);
      if (loaded.error) return { erro: loaded.error };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.data))) return { erro: 'Data inválida, use AAAA-MM-DD.' };

      const duration = loaded.services.reduce((sum, s) => sum + s.duration, 0);
      const slots = computeFreeSlots(tenantId, barber.id, args.data, duration);
      const result = { profissional: barber.name, data: args.data, duracao_total_min: duration, horarios_livres: slots };
      if (slots.length && interactiveFlags(ctx).list) result.proximo_passo = 'Mostre até 10 horários com enviar_lista (ids "hora_HH:MM"), priorizando os mais próximos do que o cliente pediu.';

      if (!slots.length) {
        const alternatives = [];
        for (let i = 1; i <= 14 && alternatives.length < 3; i++) {
          const date = addDays(args.data < nowBR().date ? nowBR().date : args.data, i);
          const s = computeFreeSlots(tenantId, barber.id, date, duration);
          if (s.length) alternatives.push({ data: date, primeiros_horarios: s.slice(0, 4) });
        }
        result.proximas_datas_com_vaga = alternatives;
      }
      return result;
    }

    case 'criar_agendamento': {
      if (!conv.customer_user_id) return { erro: 'Cliente ainda não identificado. Confirme nome completo e telefone e chame registrar_cliente antes.' };
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(conv.customer_user_id, tenantId);
      if (!user) return { erro: 'Cadastro do cliente não encontrado. Chame registrar_cliente novamente.' };

      const barber = db.prepare('SELECT id, name FROM barbers WHERE id = ? AND tenant_id = ?').get(args.profissional_id, tenantId);
      if (!barber) return { erro: 'Profissional inválido.' };
      const loaded = loadServices(tenantId, args.servicos_ids);
      if (loaded.error) return { erro: loaded.error };

      const date = String(args.data);
      const time = String(args.hora).slice(0, 5);
      const duration = loaded.services.reduce((sum, s) => sum + s.duration, 0);
      const price = loaded.services.reduce((sum, s) => sum + Number(s.price), 0);
      const itemName = loaded.services.map(s => s.name).join(' + ');

      // Revalida na hora de gravar (outro cliente pode ter pego o horario no meio da conversa)
      const free = computeFreeSlots(tenantId, barber.id, date, duration);
      if (!free.includes(time)) {
        return { erro: 'Esse horário não está mais disponível.', horarios_livres_nessa_data: free.slice(0, 10) };
      }

      const result = db.prepare(`
        INSERT INTO bookings (tenant_id, user_id, customer_full_name, customer_phone, service_id, item_name, item_price, item_duration, barber_id, booking_date, booking_time, status, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'whatsapp_ia')
      `).run(tenantId, user.id, user.full_name, user.phone, loaded.services[0].id, itemName, price, duration, barber.id, date, time);

      const reward = tryApplyReward(tenantId, user.id, price);
      if (reward.discount > 0) {
        db.prepare('UPDATE bookings SET discount_applied = ?, reward_label = ? WHERE id = ?').run(reward.discount, reward.label, result.lastInsertRowid);
      }
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
      const finalPrice = Math.max(0, price - (booking.discount_applied || 0));

      // Painel do gestor atualiza na hora (mesmo SSE do agendamento pelo link)
      try { require('./events').broadcastBookingChange(tenantId, 'INSERT', { id: booking.id, status: booking.status }); } catch (_) {}

      // Mensagem de confirmacao padrao do gestor (template da aba WhatsApp)
      await sendBookingConfirmation({
        tenant, booking,
        clientName: user.full_name,
        clientPhone: user.phone,
        serviceName: itemName,
        servicePrice: finalPrice,
        barberName: barber.name
      });

      return {
        ok: true,
        agendamento_id: booking.id,
        resumo: { cliente: user.full_name, profissional: barber.name, servicos: itemName, data: formatDateBR(date), hora: time, valor: `R$ ${formatCurrencyBRL(finalPrice)}`, recompensa_fidelidade: booking.reward_label || null },
        observacao: 'A mensagem de confirmação detalhada já foi enviada ao cliente. Responda só com um agradecimento curto.'
      };
    }

    case 'meus_agendamentos': {
      if (!conv.customer_user_id) return { erro: 'Cliente ainda não identificado.' };
      const today = nowBR().date;
      const rows = db.prepare(`
        SELECT b.booking_date, b.booking_time, COALESCE(b.item_name, s.name) AS servico, br.name AS profissional
        FROM bookings b LEFT JOIN services s ON s.id = b.service_id LEFT JOIN barbers br ON br.id = b.barber_id
        WHERE b.tenant_id = ? AND b.user_id = ? AND b.status = 'confirmed' AND b.booking_date >= ?
        ORDER BY b.booking_date, b.booking_time LIMIT 10
      `).all(tenantId, conv.customer_user_id, today);
      return { agendamentos: rows.map(r => ({ data: formatDateBR(r.booking_date), hora: r.booking_time.slice(0, 5), servico: r.servico, profissional: r.profissional })) };
    }

    case 'enviar_botoes':
    case 'enviar_lista':
    case 'enviar_carrossel':
      return runInteractiveTool(name, args, ctx);

    default:
      return { erro: `Ferramenta desconhecida: ${name}` };
  }
}

// ==================== Prompt ====================

function interactivePromptBlock(ctx) {
  const flags = interactiveFlags(ctx);
  if (!flags.buttons && !flags.list && !flags.carousel) return '';
  const lines = ['OPÇÕES INTERATIVAS (use sempre que fizer sentido, em vez de lista em texto):'];
  if (flags.carousel) lines.push('- enviar_carrossel: para mostrar profissionais ou serviços com foto (ids "profissional_<id>" / "servico_<id>").');
  if (flags.list) lines.push('- enviar_lista: para horários livres (até 10 por vez), serviços ou profissionais. Use ids como "hora_14:30", "servico_3", "profissional_2".');
  if (flags.buttons) lines.push('- enviar_botoes: para escolhas curtas de até 3 opções, como confirmar o resumo (ids "confirmar_sim" / "confirmar_nao") ou "Agendar por aqui" / "Receber o link".');
  lines.push('- Quando o cliente tocar numa opção, chega uma mensagem "[cliente tocou na opção] Título (id: ...)". Use o id para saber o que foi escolhido.');
  lines.push('- Depois de enviar opções interativas, não repita as opções em texto.');
  return lines.join('\n') + '\n';
}

// Como mostrar cada etapa: com os recursos interativos ligados, a IA e OBRIGADA a usa-los
function stepInstructions(ctx) {
  const f = interactiveFlags(ctx);
  const choose = (carousel, list, text) => carousel && f.carousel ? carousel : list && f.list ? list : text;
  return {
    first: f.buttons ? ' Faça isso com enviar_botoes (opções "Agendar por aqui" id "agendar_aqui" e "Receber o link" id "receber_link").' : '',
    barber: choose(
      ' Com mais de um profissional, mostre OBRIGATORIAMENTE com enviar_carrossel tipo "profissionais".',
      ' Com mais de um profissional, mostre OBRIGATORIAMENTE com enviar_lista.',
      ' Mostre numerado (1, 2, 3...).'),
    service: choose(
      ' Mostre OBRIGATORIAMENTE com enviar_carrossel tipo "servicos". Depois de cada escolha, pergunte se quer mais algum serviço.',
      ' Mostre OBRIGATORIAMENTE com enviar_lista (id "servico_<id>"). Depois de cada escolha, pergunte se quer mais algum serviço.',
      ' Mostre numerado com preço e duração.'),
    time: f.list ? ' Mostre os horários OBRIGATORIAMENTE com enviar_lista (até 10, ids "hora_HH:MM").' : '',
    confirm: f.buttons ? ' Peça a confirmação OBRIGATORIAMENTE com enviar_botoes (Sim id "confirmar_sim" / Não id "confirmar_nao").' : ''
  };
}

function buildSystemPrompt(ctx) {
  const { tenant, conv, senderPhone, pushName } = ctx;
  const steps = stepInstructions(ctx);
  const config = getAiConfig(tenant.id);
  const now = nowBR();
  const baseUrl = (process.env.PUBLIC_BASE_URL || getSetting(tenant.id, 'public_base_url') || '').replace(/\/$/, '');
  const link = baseUrl ? `${baseUrl}/${tenant.slug}` : null;

  let profile = {};
  try { profile = JSON.parse(getSetting(tenant.id, 'shop_profile') || '{}'); } catch { profile = {}; }

  const customer = conv.customer_user_id ? db.prepare('SELECT full_name, phone FROM users WHERE id = ?').get(conv.customer_user_id) : null;

  let customerBlock;
  if (customer) {
    customerBlock = `CLIENTE JÁ CADASTRADO: ${customer.full_name}, telefone ${formatPhoneBR(customer.phone)}.
Cumprimente pelo primeiro nome. NÃO pergunte o nome nem o telefone de novo.`;
  } else if (senderPhone) {
    customerBlock = `CLIENTE NOVO (sem cadastro). Número do WhatsApp dele: ${formatPhoneBR(senderPhone)}${pushName ? ` (nome no perfil: "${pushName}", pode não ser o nome real)` : ''}.
Antes de qualquer outra etapa do agendamento: peça o NOME COMPLETO e confirme se o agendamento fica nesse número ${formatPhoneBR(senderPhone)} (ou se prefere outro). Com as duas coisas confirmadas, chame registrar_cliente.`;
  } else {
    customerBlock = `CLIENTE NOVO e o número dele não foi identificado. Antes de tudo peça o NOME COMPLETO e o TELEFONE com DDD, confirme e chame registrar_cliente.`;
  }

  return `Você é ${config.assistant_name}, atendente virtual da barbearia *${tenant.name}* no WhatsApp.
Fale sempre em português do Brasil, de forma simpática, curta e objetiva (mensagens de WhatsApp, não textos longos). Use *negrito* do WhatsApp e poucos emojis. O cliente pode escrever ou mandar áudio (os áudios chegam transcritos para você como texto).

Agora: ${WEEKDAYS[weekdayOf(now.date)]}, ${formatDateBR(now.date)}, ${now.time} (horário de Brasília).

Funcionamento dos próximos dias:
${describeNextDays(tenant.id)}

${profile.address ? `Endereço: ${profile.address}\n` : ''}${profile.phone ? `Telefone da barbearia: ${profile.phone}\n` : ''}${Array.isArray(profile.payment_methods) && profile.payment_methods.length ? `Formas de pagamento: ${profile.payment_methods.join(', ')}\n` : ''}
${customerBlock}

COMO ATENDER:
1. No primeiro contato, cumprimente e ofereça as duas opções: ${link ? `agendar sozinho pelo link ${link}` : 'agendar pelo link da barbearia'} OU agendar aqui mesmo pelo WhatsApp, escrevendo ou mandando áudio.${steps.first}
2. Se quiser agendar por aqui: primeiro identifique o cliente (regra acima) — sempre antes de tudo.
3. Profissional: chame listar_profissionais. Se só houver um, apenas informe.${steps.barber}
4. Serviços: chame listar_servicos. O cliente pode escolher VÁRIOS serviços.${steps.service}
5. Data e horário: pergunte o dia de preferência, chame horarios_disponiveis e ofereça algumas opções (não despeje a lista inteira). Entenda "amanhã", "sexta", "depois das 15h" etc. usando a data de hoje acima.${steps.time}
6. Antes de gravar, mostre o RESUMO (nome, telefone, profissional, serviços, data, hora, valor total e duração) e pergunte se pode confirmar. Só chame criar_agendamento depois de um "sim" claro.${steps.confirm}
7. Se o horário não estiver mais livre, ofereça outras opções.

${interactivePromptBlock(ctx)}
REGRAS:
- Nunca invente serviços, preços, profissionais ou horários: use sempre as ferramentas.
- Não mostre IDs nem nomes de ferramentas para o cliente. Aceite que ele responda pelo número da lista ou pelo nome.
- Não marque em dia FECHADO nem em horário passado.
- Se perguntarem algo que você não sabe, diga que vai repassar para a equipe da barbearia.
- Não faça cancelamentos nem remarcações: nesses casos, diga que a equipe vai retornar.
${config.extra_instructions ? `\nINSTRUÇÕES DA BARBEARIA:\n${String(config.extra_instructions).slice(0, 2000)}\n` : ''}`;
}

// ==================== Execucao ====================

async function runAgent(ctx, userText) {
  const { tenant, conv } = ctx;
  const history = [...conv.messages, { role: 'user', content: userText }];

  let reply = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const system = { role: 'system', content: buildSystemPrompt(ctx) };
    const message = await openai.chat([system, ...history], toolsFor(ctx));

    const assistantMsg = { role: 'assistant', content: message.content || null };
    if (message.tool_calls?.length) assistantMsg.tool_calls = message.tool_calls;
    history.push(assistantMsg);

    if (!message.tool_calls?.length) {
      reply = (message.content || '').trim();
      break;
    }

    // Texto que a IA escreveu junto com o envio de botoes/lista/carrossel sai antes das opcoes
    const sendsInteractive = message.tool_calls.some(c => String(c.function?.name).startsWith('enviar_'));
    if (sendsInteractive && message.content && message.content.trim() && message.content.trim() !== '-') {
      await waProvider.sendText(ctx.instance, ctx.replyTo, message.content.trim());
    }

    for (const call of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
      let output;
      try {
        output = await runTool(call.function.name, args, ctx);
      } catch (err) {
        console.error(`[ia] erro na ferramenta ${call.function.name} (tenant ${tenant.id}):`, err.message);
        output = { erro: 'Falha interna ao executar. Peça desculpas e tente de novo.' };
      }
      history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }

  saveConversation(tenant.id, conv.chat_id, { messages: history });

  // Opcoes interativas ja foram enviadas e a IA nao tem mais nada a dizer: nao manda nada
  if (ctx.interactiveSent && (!reply || reply === '-' || reply === '.')) return null;
  return reply && reply !== '-' ? reply : 'Desculpe, não consegui entender. Pode repetir, por favor?';
}

// Fila por chat: processa uma leva de mensagens por vez, na ordem
const chains = new Map();
const buffers = new Map();

function enqueue(key, task) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(task).catch(err => console.error('[ia] erro:', err.message)).finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  chains.set(key, next);
}

async function processBatch({ tenantId, chatId, replyTo, senderPhone, pushName, texts }) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant || !checkTenantActive(tenant).ok || !isProTenant(tenant) || !getAiConfig(tenantId).enabled) return;

  const instance = waProvider.getInstance(tenantId);
  if (!instance) return;

  const conv = loadConversation(tenantId, chatId);
  if (conv.paused_until && new Date(conv.paused_until).getTime() > Date.now()) return;

  // Reconhece cliente ja cadastrado pelo numero do WhatsApp
  if (!conv.customer_user_id && senderPhone) {
    const user = findUserByPhone(tenantId, senderPhone);
    if (user) {
      conv.customer_user_id = user.id;
      saveConversation(tenantId, chatId, { customer_user_id: user.id, phone: user.phone });
    }
  }

  waProvider.sendPresence(instance, replyTo, 2000);

  const ctx = { tenant, conv, senderPhone, pushName, instance, replyTo, interactiveSent: false };
  const reply = await runAgent(ctx, texts.join('\n'));
  if (reply) await waProvider.sendText(instance, replyTo, reply);
}

function queueMessage(payload) {
  const key = `${payload.tenantId}:${payload.chatId}`;
  const buf = buffers.get(key) || { texts: [] };
  buf.texts.push(payload.text);
  buf.payload = payload;
  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buffers.delete(key);
    enqueue(key, () => processBatch({ ...buf.payload, texts: buf.texts }));
  }, DEBOUNCE_MS);
  buffers.set(key, buf);
}

// ==================== Webhook da Evolution ====================

const seenMessageIds = new Map();
function alreadySeen(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.set(id, Date.now());
  if (seenMessageIds.size > 5000) {
    const limit = Date.now() - 60 * 60 * 1000;
    for (const [k, ts] of seenMessageIds) if (ts < limit) seenMessageIds.delete(k);
  }
  return false;
}

// Recebe o webhook dos dois motores (Evolution API v2 e Evolution GO).
// O formato de cada um e convertido para um so em wa-provider.normalizeWebhook.
async function handleWebhookEvent(instanceName, body) {
  const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE instance_name = ?').get(instanceName);
  if (!instance) return;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(instance.tenant_id);
  if (!tenant || !isProTenant(tenant) || !getAiConfig(tenant.id).enabled) return;

  const messages = waProvider.normalizeWebhook(instance.provider, body);
  for (const msg of messages) {
    const chatId = msg.chatId;
    if (!chatId || msg.isGroup || chatId === 'status@broadcast' || chatId.endsWith('@broadcast') || chatId.endsWith('@newsletter')) continue;
    if (alreadySeen(msg.id)) continue;

    // Ignora historico antigo sincronizado ao conectar
    if (msg.timestamp && Date.now() / 1000 - msg.timestamp > 300) continue;

    // Mensagem enviada pelo celular da barbearia (o gestor respondeu na mao) -> IA pausa nesse chat
    if (msg.fromMe) {
      if (!waProvider.wasSentBySystem(msg.id)) pauseConversation(tenant.id, chatId);
      continue;
    }

    const senderPhone = msg.senderPhone;
    const replyTo = senderPhone || chatId;
    let text = msg.text;

    if (!text && msg.hasAudio) {
      if (!openai.isConfigured()) continue;
      try {
        waProvider.sendPresence(instance, replyTo, 3000);
        const media = await waProvider.downloadAudio(instance, msg);
        if (!media?.base64) throw new Error('áudio vazio');
        const transcript = await openai.transcribeAudio(Buffer.from(media.base64, 'base64'), media.mimetype || 'audio/ogg');
        if (!transcript) throw new Error('transcrição vazia');
        text = `[áudio transcrito] ${transcript}`;
      } catch (err) {
        console.error(`[ia] falha ao transcrever áudio (tenant ${tenant.id}):`, err.message);
        await waProvider.sendText(instance, replyTo, 'Não consegui ouvir seu áudio 😕 Pode mandar de novo ou escrever, por favor?').catch(() => {});
        continue;
      }
    }

    if (!text) continue; // figurinha, foto sem legenda, etc.

    queueMessage({ tenantId: tenant.id, chatId, replyTo, senderPhone, pushName: msg.pushName, text });
  }
}

module.exports = {
  DEFAULT_AI_CONFIG,
  isProTenant,
  getAiConfig,
  saveAiConfig,
  handleWebhookEvent,
  computeFreeSlots
};
