// Aba "Revendedores" do super admin. Usa as funções globais da página: apiFetch, customConfirm,
// showNotification e formatDateBR (definidas em superadmin.html).

(function () {
    const STAGE = {
        cobrar: { label: 'A cobrar do cliente', cls: 'st-wait' },
        repassar: { label: 'Cliente pagou · aguardando repasse', cls: 'st-repass' },
        repassado: { label: 'Repassado', cls: 'st-done' }
    };

    function esc(v) {
        return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function brl(cents) {
        return 'R$ ' + ((Number(cents) || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function pct(n) {
        return (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
    }
    function fmtDate(iso) {
        return iso ? formatDateBR(iso) : '—';
    }
    // "2026-09-29 21:00:00" (UTC, do SQLite) -> data e hora de Brasília
    function fmtDateTime(sql) {
        if (!sql) return '—';
        const d = new Date(String(sql).replace(' ', 'T') + 'Z');
        return isNaN(d) ? sql : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function fmtPhone(p) {
        const n = String(p || '').replace(/\D/g, '');
        const l = n.startsWith('55') ? n.slice(2) : n;
        if (l.length === 11) return `(${l.slice(0, 2)}) ${l.slice(2, 7)}-${l.slice(7)}`;
        if (l.length === 10) return `(${l.slice(0, 2)}) ${l.slice(2, 6)}-${l.slice(6)}`;
        return n || '—';
    }
    const $ = id => document.getElementById(id);

    let currentDetailId = null;
    let detailFilter = 'todas';
    let detailData = null;

    // ==================== Abas ====================
    window.switchMainTab = function (name) {
        $('tabTenants').classList.toggle('hidden', name !== 'tenants');
        $('tabResellers').classList.toggle('hidden', name !== 'resellers');
        document.querySelectorAll('.main-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
        if (name === 'resellers') loadResellersTab();
    };

    window.initResellers = function () {
        loadResellerOptions();
        refreshNotifBadge();
    };

    // ==================== Carregar tudo ====================
    async function loadResellersTab() {
        await Promise.all([loadOverview(), loadSettings(), loadNotifications()]);
    }
    window.loadResellersTab = loadResellersTab;

    async function loadOverview() {
        const list = $('resellersList');
        try {
            const o = await apiFetch('/resellers/overview');
            const t = o.totals || {};
            $('resStats').innerHTML = [
                stat('fa-user-tie', 'Revendedores ativos', `${o.resellers_active} de ${o.resellers_total}`),
                stat('fa-store', 'Clientes ativos', t.clients_active || 0),
                stat('fa-coins', 'Faturamento mensal (clientes)', brl(t.mrr_cents), 'soma do que os clientes pagam por mês'),
                stat('fa-percent', 'Comissões por mês', brl(t.commission_month_cents), 'parte dos revendedores'),
                stat('fa-hand-holding-dollar', 'A receber dos revendedores', brl(t.to_repass_cents), 'cliente já pagou, falta repassar', t.to_repass_cents > 0 ? 'hl' : ''),
                stat('fa-circle-check', 'Já recebido', brl(t.repassed_cents), 'repasses confirmados'),
                stat('fa-hourglass-half', 'Aguardando clientes', brl(t.to_collect_cents), 'ainda não pagaram o revendedor'),
                stat('fa-triangle-exclamation', 'Cobranças atrasadas', t.overdue_count || 0, 'ciclo acabou e o cliente não pagou', t.overdue_count > 0 ? 'warn' : '')
            ].join('');
            window.__resellers = o.resellers;
            if (!o.resellers.length) {
                list.innerHTML = '<div class="empty-state">Nenhum revendedor cadastrado ainda. Crie o primeiro acima.</div>';
                return;
            }
            list.innerHTML = o.resellers.map(r => {
                const s = r.stats;
                return `
                <div class="tenant-item ${r.status === 'suspended' ? 'suspended' : ''}">
                    <div style="min-width:240px; flex:1;">
                        <div class="name">${esc(r.name)}</div>
                        <div class="meta">
                            <span class="pill ${r.status === 'active' ? 'active' : 'suspended'}">${r.status === 'active' ? 'Ativo' : 'Suspenso'}</span>
                            <span class="pill plan-pro">${pct(r.commission_percent)} de comissão</span>
                            <span>${esc(r.email)}</span>
                            ${r.phone ? `<span>${esc(fmtPhone(r.phone))}</span>` : ''}
                        </div>
                        <div class="res-numbers">
                            <span><b>${s.clients_active}</b> cliente${s.clients_active === 1 ? '' : 's'} ativo${s.clients_active === 1 ? '' : 's'} <small>(${s.clients_pro} PRO · ${s.clients_basic} Básico)</small></span>
                            <span>Faturamento/mês: <b>${brl(s.mrr_cents)}</b></span>
                            <span>Comissão/mês: <b>${brl(s.commission_month_cents)}</b></span>
                            <span class="${s.to_repass_cents > 0 ? 'money-hl' : ''}">A receber: <b>${brl(s.to_repass_cents)}</b></span>
                            ${s.overdue_count > 0 ? `<span class="money-warn">${s.overdue_count} atrasada${s.overdue_count === 1 ? '' : 's'}</span>` : ''}
                        </div>
                    </div>
                    <div class="actions">
                        <button class="btn btn-sm" onclick="openResellerDetail(${r.id})"><i class="fas fa-folder-open" aria-hidden="true"></i> Abrir</button>
                        <button class="btn btn-secondary btn-sm" onclick="openResellerEdit(${r.id})"><i class="fas fa-edit" aria-hidden="true"></i> Editar</button>
                        <button class="btn btn-sm ${r.status === 'active' ? 'btn-danger' : ''}" onclick="toggleResellerStatus(${r.id})"><i class="fas fa-power-off" aria-hidden="true"></i> ${r.status === 'active' ? 'Suspender' : 'Reativar'}</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteReseller(${r.id})" title="Excluir"><i class="fas fa-trash" aria-hidden="true"></i></button>
                    </div>
                </div>`;
            }).join('');
        } catch (e) {
            list.innerHTML = '<div class="empty-state">Erro ao carregar revendedores.</div>';
            showNotification(e.message, 'error');
        }
    }

    function stat(icon, label, value, hint, cls) {
        return `<div class="stat ${cls || ''}"><i class="fas ${icon}" aria-hidden="true"></i><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${hint ? `<div class="stat-hint">${hint}</div>` : ''}</div>`;
    }

    async function loadSettings() {
        try {
            const s = await apiFetch('/resellers/settings');
            $('priceBasic').value = (s.prices.basic_cents / 100).toFixed(2).replace('.', ',');
            $('pricePro').value = (s.prices.pro_cents / 100).toFixed(2).replace('.', ',');
            $('ownerNotifyPhone').value = s.owner_notify_phone ? String(s.owner_notify_phone).replace(/^55/, '') : '';
        } catch (e) { showNotification(e.message, 'error'); }
    }

    async function loadNotifications() {
        const box = $('resNotifs');
        try {
            const n = await apiFetch('/resellers/notifications?limit=15');
            setBadge(n.unread);
            if (!n.items.length) { box.innerHTML = '<div class="empty-state" style="padding:20px;">Nenhum aviso ainda. Quando um revendedor criar um cliente ou registrar um pagamento, aparece aqui (e no seu WhatsApp).</div>'; return; }
            box.innerHTML = n.items.map(i => `
                <div class="notif ${i.read_at ? '' : 'unread'}">
                    <div class="notif-head"><b>${esc(i.title)}</b><small>${esc(fmtDateTime(i.created_at))}</small></div>
                    <div class="notif-msg">${esc(i.message).replace(/\n/g, '<br>')}</div>
                </div>`).join('');
        } catch (e) { box.innerHTML = ''; }
    }

    function setBadge(n) {
        const b = $('resTabBadge');
        b.textContent = n > 99 ? '99+' : n;
        b.classList.toggle('hidden', !n);
    }
    async function refreshNotifBadge() {
        try { setBadge((await apiFetch('/resellers/notifications?limit=1')).unread); } catch (_) {}
    }

    window.markNotifsRead = async function () {
        try { await apiFetch('/resellers/notifications/read', { method: 'POST' }); loadNotifications(); }
        catch (e) { showNotification(e.message, 'error'); }
    };

    // Lista de revendedores no formulario de "Nova Barbearia"
    async function loadResellerOptions() {
        const sel = $('tenantReseller');
        if (!sel) return;
        try {
            const list = await apiFetch('/resellers');
            const keep = sel.value;
            sel.innerHTML = '<option value="">Nenhum (cliente direto meu)</option>' +
                list.filter(r => r.status === 'active').map(r => `<option value="${r.id}">${esc(r.name)} (${pct(r.commission_percent)})</option>`).join('');
            sel.value = keep;
        } catch (_) {}
    }
    window.loadResellerOptions = loadResellerOptions;

    // ==================== Configuracoes ====================
    window.saveResellerSettings = async function () {
        try {
            await apiFetch('/resellers/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    price_basic: $('priceBasic').value,
                    price_pro: $('pricePro').value,
                    owner_notify_phone: $('ownerNotifyPhone').value
                })
            });
            showNotification('Preços e avisos salvos! Clientes já cadastrados mantêm o valor de quando entraram.', 'success');
            loadSettings();
        } catch (e) { showNotification(e.message, 'error'); }
    };

    // ==================== Novo revendedor ====================
    document.addEventListener('submit', async (e) => {
        if (e.target.id !== 'newResellerForm') return;
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            await apiFetch('/resellers', {
                method: 'POST',
                body: JSON.stringify({
                    name: $('resName').value,
                    email: $('resEmail').value,
                    password: $('resPassword').value,
                    phone: $('resPhone').value,
                    commission_percent: $('resCommission').value
                })
            });
            showNotification('Revendedor criado! Ele entra em /revendedor com esse email e senha.', 'success');
            e.target.reset();
            toggleCollapse('cardNewReseller', false);
            loadOverview();
            loadResellerOptions();
        } catch (err) { showNotification(err.message, 'error'); }
        finally { btn.disabled = false; }
    });

    // ==================== Editar / suspender / excluir ====================
    window.openResellerEdit = function (id) {
        const r = (window.__resellers || []).find(x => x.id === id);
        if (!r) return;
        $('editResId').value = r.id;
        $('editResName').value = r.name;
        $('editResEmail').value = r.email;
        $('editResPhone').value = r.phone ? String(r.phone).replace(/^55/, '') : '';
        $('editResCommission').value = r.commission_percent;
        $('editResApply').checked = false;
        $('editResPassword').value = '';
        $('editResStatus').value = r.status;
        $('editResModal').classList.remove('hidden');
    };
    window.closeResellerEdit = function () { $('editResModal').classList.add('hidden'); };

    document.addEventListener('submit', async (e) => {
        if (e.target.id !== 'editResForm') return;
        e.preventDefault();
        const id = $('editResId').value;
        const body = {
            name: $('editResName').value,
            email: $('editResEmail').value,
            phone: $('editResPhone').value,
            commission_percent: $('editResCommission').value,
            apply_to_clients: $('editResApply').checked,
            status: $('editResStatus').value
        };
        if ($('editResPassword').value) body.password = $('editResPassword').value;
        try {
            await apiFetch(`/resellers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
            showNotification('Revendedor atualizado!', 'success');
            closeResellerEdit();
            loadOverview();
            loadResellerOptions();
            if (currentDetailId && String(currentDetailId) === String(id)) openResellerDetail(currentDetailId);
        } catch (err) { showNotification(err.message, 'error'); }
    });

    window.toggleResellerStatus = async function (id) {
        const r = (window.__resellers || []).find(x => x.id === id);
        if (!r) return;
        const suspend = r.status === 'active';
        if (!(await customConfirm(suspend
            ? `Suspender ${r.name}? Ele perde o acesso ao painel na hora. As barbearias dele continuam funcionando normalmente.`
            : `Reativar ${r.name}?`))) return;
        try {
            await apiFetch(`/resellers/${id}`, { method: 'PUT', body: JSON.stringify({ status: suspend ? 'suspended' : 'active' }) });
            showNotification(suspend ? 'Revendedor suspenso.' : 'Revendedor reativado!', suspend ? 'info' : 'success');
            loadOverview(); loadResellerOptions();
        } catch (e) { showNotification(e.message, 'error'); }
    };

    window.deleteReseller = async function (id) {
        const r = (window.__resellers || []).find(x => x.id === id);
        if (!r) return;
        if (!(await customConfirm(`Excluir o revendedor ${r.name}? Só é possível se ele não tiver clientes nem histórico financeiro.`))) return;
        try {
            await apiFetch(`/resellers/${id}`, { method: 'DELETE' });
            showNotification('Revendedor excluído.', 'info');
            loadOverview(); loadResellerOptions();
        } catch (e) { showNotification(e.message, 'error'); }
    };

    // ==================== Detalhe do revendedor ====================
    window.openResellerDetail = async function (id) {
        currentDetailId = id;
        detailFilter = 'todas';
        $('detailModal').classList.remove('hidden');
        $('detailBody').innerHTML = '<div class="empty-state">Carregando...</div>';
        try {
            detailData = await apiFetch(`/resellers/${id}`);
            renderDetail();
        } catch (e) {
            $('detailBody').innerHTML = '<div class="empty-state">Erro ao carregar.</div>';
            showNotification(e.message, 'error');
        }
    };
    window.closeResellerDetail = function () {
        $('detailModal').classList.add('hidden');
        currentDetailId = null;
        loadOverview();
    };

    window.setDetailFilter = function (f) { detailFilter = f; renderDetail(); };

    function stagePill(c) {
        if (c.stage === 'cobrar' && c.overdue) return '<span class="pill st-late">Atrasada · cliente não pagou</span>';
        const s = STAGE[c.stage];
        return `<span class="pill ${s.cls}">${s.label}</span>`;
    }

    function renderDetail() {
        const { reseller: r, stats: s, clients, charges } = detailData;
        const counts = { todas: charges.length, cobrar: 0, repassar: 0, repassado: 0 };
        charges.forEach(c => counts[c.stage]++);
        const shown = detailFilter === 'todas' ? charges : charges.filter(c => c.stage === detailFilter);

        $('detailBody').innerHTML = `
            <div class="detail-head">
                <div>
                    <h3 style="margin-bottom:6px;">${esc(r.name)}</h3>
                    <div class="meta" style="display:flex; gap:10px; flex-wrap:wrap; font-size:12px; color:var(--ivory-muted);">
                        <span class="pill ${r.status === 'active' ? 'active' : 'suspended'}">${r.status === 'active' ? 'Ativo' : 'Suspenso'}</span>
                        <span class="pill plan-pro">${pct(r.commission_percent)} de comissão</span>
                        <span>${esc(r.email)}</span>
                        ${r.phone ? `<span>${esc(fmtPhone(r.phone))}</span>` : ''}
                    </div>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="closeResellerDetail()"><i class="fas fa-xmark" aria-hidden="true"></i> Fechar</button>
            </div>

            <div class="stat-grid small">
                ${stat('fa-store', 'Clientes ativos', s.clients_active, `${s.clients_pro} PRO · ${s.clients_basic} Básico`)}
                ${stat('fa-coins', 'Faturamento/mês', brl(s.mrr_cents))}
                ${stat('fa-percent', 'Comissão dele/mês', brl(s.commission_month_cents))}
                ${stat('fa-wallet', 'Seu repasse/mês', brl(s.owner_month_cents), 'o que ele deve te passar por mês')}
                ${stat('fa-hand-holding-dollar', 'A receber agora', brl(s.to_repass_cents), `${s.to_repass_count} cobrança${s.to_repass_count === 1 ? '' : 's'} paga${s.to_repass_count === 1 ? '' : 's'} pelo cliente`, s.to_repass_cents > 0 ? 'hl' : '')}
                ${stat('fa-circle-check', 'Já recebido', brl(s.repassed_cents))}
            </div>

            <h4 class="sec-title"><i class="fas fa-store" aria-hidden="true"></i> Clientes deste revendedor (${clients.length})</h4>
            ${clients.length ? `<div class="table-wrap"><table>
                <thead><tr><th>Barbearia</th><th>Plano</th><th>Valor/mês</th><th>Comissão</th><th>Vence em</th><th>Status</th><th>Gestor</th></tr></thead>
                <tbody>${clients.map(c => `
                    <tr>
                        <td><b>${esc(c.name)}</b><br><a class="tenant-link" style="margin-top:2px;" href="/${esc(c.slug)}" target="_blank">/${esc(c.slug)}</a></td>
                        <td><span class="pill ${c.plan === 'pro' ? 'plan-pro' : 'plan-basic'}">${c.plan === 'pro' ? 'PRO' : 'Básico'}</span></td>
                        <td>${brl(c.monthly_price_cents)}</td>
                        <td>${pct(c.commission_percent)} · ${brl(c.commission_cents)}</td>
                        <td>${fmtDate(c.subscription_expires_at)}${c.overdue_charges ? '<br><span class="money-warn">pagamento atrasado</span>' : ''}</td>
                        <td><span class="pill ${c.status === 'active' ? 'active' : 'suspended'}">${c.status === 'active' ? 'Ativo' : 'Suspenso'}</span></td>
                        <td>${esc(c.manager_email || '—')}</td>
                    </tr>`).join('')}
                </tbody></table></div>` : '<div class="empty-state" style="padding:20px;">Este revendedor ainda não cadastrou clientes.</div>'}

            <h4 class="sec-title"><i class="fas fa-file-invoice-dollar" aria-hidden="true"></i> Cobranças e repasses</h4>
            <div class="filters">
                ${[['todas', 'Todas'], ['cobrar', 'A cobrar do cliente'], ['repassar', 'Aguardando repasse'], ['repassado', 'Repassadas']].map(([k, l]) =>
                    `<button class="marketing-chip ${detailFilter === k ? 'active' : ''}" onclick="setDetailFilter('${k}')">${l} (${counts[k]})</button>`).join('')}
                ${counts.repassar ? `<button class="btn btn-sm" style="margin-left:auto;" onclick="repassAll(${r.id})"><i class="fas fa-check-double" aria-hidden="true"></i> Confirmar todos os repasses (${brl(s.to_repass_cents)})</button>` : ''}
            </div>
            ${shown.length ? `<div class="table-wrap"><table>
                <thead><tr><th>Ciclo</th><th>Barbearia</th><th>Cliente paga</th><th>Comissão</th><th>Repasse a você</th><th>Situação</th><th></th></tr></thead>
                <tbody>${shown.map(c => `
                    <tr>
                        <td>${fmtDate(c.cycle_start)}<br><small>até ${fmtDate(c.cycle_end)}</small></td>
                        <td>${esc(c.tenant_name)}${c.deleted_tenant ? '<br><small>(barbearia excluída)</small>' : ''}</td>
                        <td>${brl(c.amount_cents)}</td>
                        <td>${brl(c.commission_cents)}<br><small>${pct(c.commission_percent)}</small></td>
                        <td><b>${brl(c.owner_cents)}</b></td>
                        <td>${stagePill(c)}${c.client_paid_at ? `<br><small>cliente pagou em ${esc(fmtDateTime(c.client_paid_at))}</small>` : ''}${c.repassed_at ? `<br><small>repasse em ${esc(fmtDateTime(c.repassed_at))}</small>` : ''}</td>
                        <td style="text-align:right; white-space:nowrap;">
                            ${c.stage === 'repassar' ? `<button class="btn btn-sm" onclick="setRepassed(${c.id}, true)"><i class="fas fa-check" aria-hidden="true"></i> Recebi</button>` : ''}
                            ${c.stage === 'repassado' ? `<button class="btn btn-secondary btn-sm" onclick="setRepassed(${c.id}, false)" title="Desfazer confirmação"><i class="fas fa-rotate-left" aria-hidden="true"></i> Desfazer</button>` : ''}
                        </td>
                    </tr>`).join('')}
                </tbody></table></div>` : '<div class="empty-state" style="padding:20px;">Nenhuma cobrança neste filtro.</div>'}
        `;
    }

    window.setRepassed = async function (chargeId, value) {
        try {
            await apiFetch(`/resellers/charges/${chargeId}/repassed`, { method: 'POST', body: JSON.stringify({ value }) });
            showNotification(value ? 'Repasse confirmado!' : 'Confirmação desfeita.', value ? 'success' : 'info');
            openResellerDetail(currentDetailId);
        } catch (e) { showNotification(e.message, 'error'); }
    };

    window.repassAll = async function (id) {
        if (!(await customConfirm('Confirmar que você recebeu TODOS os repasses pendentes deste revendedor?'))) return;
        try {
            const r = await apiFetch(`/resellers/${id}/repass-all`, { method: 'POST' });
            showNotification(`${r.confirmed} repasse${r.confirmed === 1 ? '' : 's'} confirmado${r.confirmed === 1 ? '' : 's'}!`, 'success');
            openResellerDetail(id);
        } catch (e) { showNotification(e.message, 'error'); }
    };
})();
