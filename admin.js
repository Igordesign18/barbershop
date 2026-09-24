        const API_URL = '/api';
        const WEBHOOK_URL = 'https://n8n-n8n.rthuab.easypanel.host/webhook/barbearia';

        // Token de login do admin (substitui a sessao do Supabase Auth)
        function getToken() { return localStorage.getItem('adminToken'); }
        function setToken(token) { localStorage.setItem('adminToken', token); }
        function clearToken() { localStorage.removeItem('adminToken'); }

        // Wrapper de fetch que ja manda o token e trata erro/401 de forma padronizada
        async function apiFetch(path, options = {}) {
            const headers = Object.assign({}, options.headers);
            if (!(options.body instanceof FormData)) {
                headers['Content-Type'] = 'application/json';
            }
            const token = getToken();
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const response = await fetch(`${API_URL}${path}`, Object.assign({}, options, { headers }));

            if (response.status === 401) {
                clearToken();
                currentAdmin = null;
                document.getElementById('loginScreen').classList.remove('hidden');
                document.getElementById('mainContent').style.display = 'none';
                document.querySelector('.header-actions').classList.add('hidden');
                throw new Error('Sessão expirada, faça login novamente.');
            }

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || `Erro na requisição (código ${response.status})`);
            }

            if (response.status === 204) return null;
            return response.json();
        }
        
        let currentAdmin = null;
        let currentTenant = null;
        let eventSource = null;
        let bookingsPollInterval = null;
        let currentPeriod = 'today';
        let scheduleConfig = {
            0: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
            1: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
            2: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
            3: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
            4: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
            5: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
            6: { active: true, periods: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] }
        };
        const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

        // Sempre calcula "hoje"/"agora" no fuso de Brasília, independente do fuso do aparelho do gestor
        function nowBR() {
            return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        }
        function todayBR() {
            return nowBR().toLocaleDateString('en-CA'); // YYYY-MM-DD
        }

        let chartsInitialized = false;
        let charts = {};

        // Utility Functions
        // Modal de confirmação premium (substitui window.confirm)
        // Anima um numero subindo ate o valor final (da mais vida aos cards de KPI)
        function animateCountUp(elementId, endValue, prefix = '', suffix = '', decimals = 0) {
            const el = document.getElementById(elementId);
            if (!el) return;
            const startValue = 0;
            const duration = 700;
            const startTime = performance.now();

            function tick(now) {
                const progress = Math.min((now - startTime) / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 3);
                const current = startValue + (endValue - startValue) * eased;
                el.textContent = `${prefix}${current.toFixed(decimals)}${suffix}`;
                if (progress < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        }

        function customConfirm(message) {
            return new Promise((resolve) => {
                const overlay = document.getElementById('customConfirmOverlay');
                const msgEl = document.getElementById('customConfirmMessage');
                const okBtn = document.getElementById('customConfirmOkBtn');
                const cancelBtn = document.getElementById('customConfirmCancelBtn');

                msgEl.textContent = message;
                overlay.classList.remove('hidden');

                const cleanup = (result) => {
                    overlay.classList.add('hidden');
                    okBtn.removeEventListener('click', onOk);
                    cancelBtn.removeEventListener('click', onCancel);
                    resolve(result);
                };
                const onOk = () => cleanup(true);
                const onCancel = () => cleanup(false);

                okBtn.addEventListener('click', onOk);
                cancelBtn.addEventListener('click', onCancel);
            });
        }

        function showNotification(message, type = 'info') {
            const notification = document.createElement('div');
            notification.style.cssText = `
                position: fixed; 
                top: 80px; 
                right: 20px; 
                background: ${type === 'warning' ? 'var(--orange)' : type === 'error' ? 'var(--red)' : 'var(--lime)'}; 
                color: ${type === 'warning' || type === 'error' ? 'white' : 'var(--dark-bg)'}; 
                padding: 15px 20px; 
                border-radius: 8px; 
                box-shadow: 0 5px 20px rgba(0,0,0,0.3); 
                z-index: 1000; 
                animation: slideIn 0.3s; 
                font-weight: bold; 
                max-width: 300px;
                display: flex;
                align-items: center;
                gap: 10px;
            `;
            notification.innerHTML = `<i class="fas fa-${type === 'warning' ? 'exclamation-triangle' : type === 'error' ? 'times-circle' : 'check-circle'}" aria-hidden="true"></i> ${message}`;
            document.body.appendChild(notification);
            
            setTimeout(() => {
                notification.style.animation = 'slideOut 0.3s';
                setTimeout(() => notification.remove(), 300);
            }, 5000);
        }

        function toggleStatCard(card) {
            const isExpanded = card.classList.contains('expanded');
            card.classList.toggle('expanded');
            card.setAttribute('aria-expanded', !isExpanded);
        }

        // Troca de aba do painel - controla qual .tab-panel fica visivel
        function switchTab(tabName) {
            document.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('tab-active'));
            document.querySelectorAll('[data-tab="' + tabName + '"]').forEach(el => el.classList.add('tab-active'));

            document.querySelectorAll('.tab-nav-btn').forEach(btn => btn.classList.remove('active'));
            const activeBtn = document.querySelector('.tab-nav-btn[data-tab-target="' + tabName + '"]');
            if (activeBtn) activeBtn.classList.add('active');

            if (tabName === 'dashboard') {
                const container = document.getElementById('dashboardContainer');
                container.classList.add('active');
                if (!container.dataset.loaded) {
                    loadStats();
                    initializeCharts();
                    container.dataset.loaded = 'true';
                }
            }

            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function changePeriod(period) {
            currentPeriod = period;
            document.querySelectorAll('.period-btn').forEach((btn, index) => {
                btn.classList.remove('active');
                btn.setAttribute('aria-selected', 'false');
            });
            
            const activeBtn = event.target.closest('.period-btn');
            activeBtn.classList.add('active');
            activeBtn.setAttribute('aria-selected', 'true');
            
            if (period === 'custom') {
                showCustomPeriodModal();
            } else {
                loadStats();
                updateCharts();
            }
        }

        function showCustomPeriodModal() {
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 400px;">
                    <div class="modal-header">
                        <h2><i class="fas fa-calendar-alt" aria-hidden="true"></i> Período Personalizado</h2>
                        <button class="close-modal" onclick="this.closest('.modal').remove()" aria-label="Fechar modal">
                            <i class="fas fa-times" aria-hidden="true"></i>
                        </button>
                    </div>
                    <form id="customPeriodForm">
                        <div class="form-group">
                            <label for="customStartDate">De:</label>
                            <input type="date" id="customStartDate" required 
                                   value="${todayBR()}"
                                   max="${todayBR()}">
                        </div>
                        <div class="form-group">
                            <label for="customEndDate">Até:</label>
                            <input type="date" id="customEndDate" required 
                                   value="${todayBR()}"
                                   max="${todayBR()}">
                        </div>
                        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                            <button type="submit" class="btn" style="flex: 1; min-width: 150px;">
                                <i class="fas fa-check" aria-hidden="true"></i> Aplicar
                            </button>
                            <button type="button" class="btn btn-secondary" style="flex: 1; min-width: 150px;" 
                                    onclick="this.closest('.modal').remove(); document.querySelectorAll('.period-btn')[0].click();">
                                Cancelar
                            </button>
                        </div>
                    </form>
                </div>
            `;
            document.body.appendChild(modal);
            
            const firstInput = modal.querySelector('input');
            firstInput.focus();
            
            document.getElementById('customPeriodForm').addEventListener('submit', (e) => {
                e.preventDefault();
                const startDate = document.getElementById('customStartDate').value;
                const endDate = document.getElementById('customEndDate').value;
                
                if (new Date(startDate) > new Date(endDate)) {
                    showNotification('A data inicial não pode ser maior que a data final!', 'error');
                    return;
                }
                
                loadStats(startDate, endDate);
                updateCharts(startDate, endDate);
                modal.remove();
            });
        }

        function toDateStrBR(date) {
            return date.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
        }

        function getPeriodDates() {
            const today = nowBR();
            let startDate, endDate;
            
            switch(currentPeriod) {
                case 'today':
                    startDate = endDate = toDateStrBR(today);
                    break;
                case 'week':
                    const weekStart = new Date(today);
                    weekStart.setDate(today.getDate() - today.getDay());
                    startDate = toDateStrBR(weekStart);
                    endDate = toDateStrBR(today);
                    break;
                case 'month':
                    startDate = toDateStrBR(new Date(today.getFullYear(), today.getMonth(), 1));
                    endDate = toDateStrBR(today);
                    break;
            }
            
            return { startDate, endDate };
        }

        function setupRealtimeListener() {
            if (eventSource) {
                eventSource.close();
            }
            eventSource = new EventSource(`${API_URL}/events?token=${encodeURIComponent(getToken())}`);
            eventSource.onmessage = (e) => {
                const payload = JSON.parse(e.data);
                console.log('Mudança detectada:', payload);
                if (payload.eventType === 'INSERT' && payload.booking.status === 'confirmed') {
                     showNotification('Novo agendamento confirmado automaticamente!', 'success');
                }
                if (payload.eventType === 'DELETE' || (payload.eventType === 'UPDATE' && payload.booking.status === 'cancelled')) {
                    showNotification('Um agendamento foi cancelado/excluído!', 'warning');
                }
                loadBookings();
                if (document.getElementById('dashboardContainer').classList.contains('active')) {
                    loadStats();
                    updateCharts();
                }
            };
        }

        // Authentication Functions
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button[type="submit"]');
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Entrando...';
            
            try {
                const data = await apiFetch('/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({
                        email: document.getElementById('adminEmail').value,
                        password: document.getElementById('adminPassword').value
                    })
                });

                if (data.role !== 'manager') {
                    showNotification('Este login não é de gestor de barbearia. Use o painel de super admin.', 'error');
                    return;
                }
                if (data.tenant && data.tenant.status === 'suspended') {
                    showNotification('Seu acesso está suspenso. Fale com o suporte.', 'error');
                    return;
                }

                setToken(data.token);
                currentAdmin = data.admin;
                currentTenant = data.tenant;
                showAdminPanel();
                showNotification('Login realizado com sucesso!', 'success');
            } catch (error) {
                showNotification('Erro ao fazer login: ' + error.message, 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalText;
            }
        });

        function showAdminPanel() {
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('mainContent').style.display = 'block';
            document.querySelector('.header-actions').classList.remove('hidden');
            document.getElementById('tabNav').classList.remove('hidden');
            switchTab('dashboard');
            setupRealtimeListener();
            loadDashboard();

            // Reforço: recarrega a lista de agendamentos a cada 20s mesmo sem depender
            // do tempo real (SSE) — se algum proxy/rede bloquear o SSE, o agendamento
            // ainda assim aparece em poucos segundos, sem precisar dar F5 manual.
            if (bookingsPollInterval) clearInterval(bookingsPollInterval);
            bookingsPollInterval = setInterval(() => {
                loadBookings();
            }, 20000);
        }

        async function logout() {
            if (await customConfirm('Tem certeza que deseja sair?')) {
                if (eventSource) eventSource.close();
                if (bookingsPollInterval) clearInterval(bookingsPollInterval);
                clearToken();
                currentAdmin = null;
                document.getElementById('loginScreen').classList.remove('hidden');
                document.getElementById('mainContent').style.display = 'none';
                document.querySelector('.header-actions').classList.add('hidden');
                document.getElementById('tabNav').classList.add('hidden');
                showNotification('Logout realizado com sucesso!', 'info');
            }
        }

        async function loadDashboard() {
            try {
                const today = todayBR();
                document.getElementById('filterDate').value = today;
                document.getElementById('filterStatus').value = 'confirmed';
                
                await Promise.all([loadBookings(), loadServices(), loadBarbers(), loadClients(), loadScheduleSettings(), loadBranding(), loadCoverImages(), loadGallery(), loadShopProfile(), loadReviews(), loadLoyaltyConfig(), loadPackages(), loadSubscriptionsSection(), loadThemeSelector(), loadWhatsappTemplate(), loadReminderConfig(), refreshWhatsappStatus(), loadAiConfig()]);
            } catch (error) {
                console.error('Erro ao carregar dashboard:', error);
                showNotification('Erro ao carregar dados do dashboard', 'error');
            }
        }

        // ==================== Personalização (banner / tagline) ====================
        // ==================== Tema Visual ====================
        const THEMES = {
            ouro_negro: { label: 'Ouro Negro', desc: 'Preto + latão dourado', bg:'#0e0c0a', accent:'#c6a15b', accent2:'#7a2f3f' },
            meia_noite: { label: 'Azul Meia-Noite', desc: 'Navy + prata executivo', bg:'#0a0e14', accent:'#6f9bc7', accent2:'#35506b' },
            esmeralda: { label: 'Verde Esmeralda', desc: 'Verde floresta + bronze', bg:'#0a120e', accent:'#4f9d6e', accent2:'#8a6a2e' },
            grafite: { label: 'Grafite Moderno', desc: 'Cinza chumbo + cobre', bg:'#121212', accent:'#c17d4f', accent2:'#5c4a3a' },
            marfim: { label: 'Marfim Clássico', desc: 'Tema claro e elegante', bg:'#f5f0e6', accent:'#8a5a3a', accent2:'#7a2f3f' },
            vinho_tinto: { label: 'Vinho Tinto', desc: 'Bordô profundo + dourado', bg:'#170a0c', accent:'#c9a15c', accent2:'#5c1a26' },
            petroleo: { label: 'Azul Petróleo', desc: 'Petróleo escuro + cobre', bg:'#07141a', accent:'#c97a4d', accent2:'#1f4d54' },
            roxo_real: { label: 'Roxo Real', desc: 'Roxo profundo + dourado', bg:'#120a18', accent:'#caa06a', accent2:'#4a2352' },
            preto_neon: { label: 'Preto Neon', desc: 'Preto puro + verde neon', bg:'#0a0a0a', accent:'#39e6a0', accent2:'#2a2a2a' },
            areia_dourada: { label: 'Areia Dourada', desc: 'Creme quente + dourado', bg:'#faf6ee', accent:'#b8863a', accent2:'#8a4a2e' },
            cinza_urbano: { label: 'Cinza Urbano', desc: 'Cinza claro + preto, minimalista', bg:'#f4f4f4', accent:'#1c1c1c', accent2:'#555555' },
            azul_nautico: { label: 'Azul Náutico', desc: 'Branco + azul-marinho', bg:'#f2f6fa', accent:'#2f5d8a', accent2:'#1c3652' },
            verde_salvia: { label: 'Verde Sálvia', desc: 'Creme + verde sálvia', bg:'#f4f7f1', accent:'#5c8a52', accent2:'#3d5c38' },
            aurora: { label: 'Aurora', desc: 'Degradê roxo, azul e verde', bg:'linear-gradient(135deg, #150a24, #0d1f2e, #0a231d)', accent:'#6fd8c9', accent2:'#2a3d5c' },
            por_do_sol: { label: 'Pôr do Sol', desc: 'Degradê vinho, laranja e terra', bg:'linear-gradient(135deg, #23101c, #4a1a1f, #331206)', accent:'#e8935a', accent2:'#7a2f3f' },
            oceano_profundo: { label: 'Oceano Profundo', desc: 'Degradê azul-marinho profundo', bg:'linear-gradient(135deg, #030d16, #082234, #04121c)', accent:'#4fa8d8', accent2:'#123049' },
            neon_cyber: { label: 'Neon Cyber', desc: 'Degradê roxo, rosa e azul neon', bg:'linear-gradient(135deg, #0c0616, #1a0a2e, #061224)', accent:'#ff5fd1', accent2:'#3a1a52' }
        };

        let currentThemeKey = 'ouro_negro';

        async function loadThemeSelector() {
            try {
                const data = await apiFetch('/settings');
                currentThemeKey = data.theme || 'ouro_negro';
                renderThemeGrid();
            } catch (error) {
                console.error('Erro ao carregar tema:', error);
            }
        }

        function renderThemeGrid() {
            const grid = document.getElementById('themeGrid');
            grid.innerHTML = Object.entries(THEMES).map(([key, t]) => {
                const isSelected = key === currentThemeKey;
                return `
                    <div onclick="selectTheme('${key}')" style="cursor:pointer; border-radius:12px; overflow:hidden; border:2px solid ${isSelected ? 'var(--lime)' : 'transparent'}; transition: var(--transition);">
                        <div style="background:${t.bg}; height:70px; display:flex; align-items:center; justify-content:center; gap:8px;">
                            <div style="width:22px; height:22px; border-radius:50%; background:${t.accent};"></div>
                            <div style="width:22px; height:22px; border-radius:50%; background:${t.accent2};"></div>
                        </div>
                        <div style="background:var(--dark-card); padding:10px; text-align:center;">
                            <div style="font-size:12.5px; font-weight:700; color:var(--text);">${t.label}</div>
                            <div style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${t.desc}</div>
                            ${isSelected ? '<div style="font-size:10px; color:var(--lime); margin-top:4px;"><i class="fas fa-check-circle" aria-hidden="true"></i> Ativo</div>' : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function selectTheme(themeKey) {
            try {
                await apiFetch('/settings/theme', { method: 'PUT', body: JSON.stringify({ theme: themeKey }) });
                currentThemeKey = themeKey;
                renderThemeGrid();
                showNotification(`Tema "${THEMES[themeKey].label}" aplicado na página do cliente!`, 'success');
            } catch (error) {
                showNotification('Erro ao aplicar tema: ' + error.message, 'error');
            }
        }

        async function loadBranding() {
            try {
                const data = await apiFetch('/settings');
                const img = document.getElementById('brandingPreviewImg');
                const empty = document.getElementById('brandingPreviewEmpty');
                const removeBtn = document.getElementById('removeBannerBtn');

                if (data.banner_url) {
                    img.src = data.banner_url;
                    img.style.display = 'block';
                    empty.style.display = 'none';
                    removeBtn.classList.remove('hidden');
                } else {
                    img.style.display = 'none';
                    empty.style.display = 'block';
                    removeBtn.classList.add('hidden');
                }

                const logoImg = document.getElementById('logoPreviewImg');
                const logoEmpty = document.getElementById('logoPreviewEmpty');
                const removeLogoBtn = document.getElementById('removeLogoBtn');

                if (data.logo_url) {
                    logoImg.src = data.logo_url;
                    logoImg.style.display = 'block';
                    logoEmpty.style.display = 'none';
                    removeLogoBtn.classList.remove('hidden');
                } else {
                    logoImg.style.display = 'none';
                    logoEmpty.style.display = 'block';
                    removeLogoBtn.classList.add('hidden');
                }

                document.getElementById('brandingTagline').value = data.tagline || '';
            } catch (error) {
                console.error('Erro ao carregar personalização:', error);
            }
        }

        async function saveBranding() {
            const bannerInput = document.getElementById('brandingBannerInput');
            const logoInput = document.getElementById('brandingLogoInput');
            const tagline = document.getElementById('brandingTagline').value.trim();
            const bannerFile = bannerInput.files[0];
            const logoFile = logoInput.files[0];

            if (bannerFile && bannerFile.size > 15 * 1024 * 1024) {
                showNotification('Foto de capa muito grande! Máximo 15MB.', 'error');
                return;
            }
            if (logoFile && logoFile.size > 15 * 1024 * 1024) {
                showNotification('Logo muito grande! Máximo 15MB.', 'error');
                return;
            }

            try {
                const formData = new FormData();
                if (bannerFile) formData.append('banner', bannerFile);
                if (logoFile) formData.append('logo', logoFile);
                formData.append('tagline', tagline);

                await apiFetch('/settings/branding', { method: 'PUT', body: formData });

                showNotification('Personalização salva com sucesso!', 'success');
                bannerInput.value = '';
                logoInput.value = '';
                loadBranding();
            } catch (error) {
                showNotification('Erro ao salvar personalização: ' + error.message, 'error');
            }
        }

        async function removeBanner() {
            if (!(await customConfirm('Remover a foto de capa da página pública?'))) return;
            try {
                await apiFetch('/settings/branding/banner', { method: 'DELETE' });
                showNotification('Banner removido.', 'info');
                loadBranding();
            } catch (error) {
                showNotification('Erro ao remover banner: ' + error.message, 'error');
            }
        }

        async function removeLogo() {
            if (!(await customConfirm('Remover o logo da página pública?'))) return;
            try {
                await apiFetch('/settings/branding/logo', { method: 'DELETE' });
                showNotification('Logo removido.', 'info');
                loadBranding();
            } catch (error) {
                showNotification('Erro ao remover logo: ' + error.message, 'error');
            }
        }

        // ==================== Imagens da Capa (carrossel) ====================
        async function loadCoverImages() {
            try {
                const data = await apiFetch('/settings/cover-images');
                const grid = document.getElementById('coverImagesGrid');
                if (!data.photos || !data.photos.length) {
                    grid.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">Nenhuma imagem de capa ainda — a "Foto de capa" única está sendo usada.</p>';
                    return;
                }
                grid.innerHTML = data.photos.map(url => `
                    <div style="position:relative; width:90px; height:90px;">
                        <img src="${url}" style="width:100%; height:100%; object-fit:cover; border-radius:8px; border:1px solid var(--hairline, rgba(198,161,91,0.2));">
                        <button onclick="removeCoverImage('${url}')" title="Remover"
                            style="position:absolute; top:-6px; right:-6px; width:22px; height:22px; border-radius:50%; background:var(--red); color:#fff; border:none; cursor:pointer; font-size:11px;">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `).join('');
            } catch (error) {
                console.error('Erro ao carregar imagens da capa:', error);
            }
        }

        document.getElementById('coverImageInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (file.size > 15 * 1024 * 1024) {
                showNotification('Arquivo muito grande! Máximo 15MB.', 'error');
                e.target.value = '';
                return;
            }

            try {
                const formData = new FormData();
                formData.append('photo', file);
                await apiFetch('/settings/cover-images', { method: 'POST', body: formData });
                showNotification('Imagem adicionada à capa!', 'success');
                e.target.value = '';
                loadCoverImages();
            } catch (error) {
                showNotification('Erro ao enviar imagem: ' + error.message, 'error');
                e.target.value = '';
            }
        });

        async function removeCoverImage(url) {
            if (!(await customConfirm('Remover essa imagem da capa?'))) return;
            try {
                await apiFetch('/settings/cover-images', { method: 'DELETE', body: JSON.stringify({ url }) });
                showNotification('Imagem removida.', 'info');
                loadCoverImages();
            } catch (error) {
                showNotification('Erro ao remover imagem: ' + error.message, 'error');
            }
        }

        // ==================== Galeria de Fotos ====================
        async function loadGallery() {
            try {
                const data = await apiFetch('/settings/gallery');
                const grid = document.getElementById('galleryGrid');
                if (!data.photos || !data.photos.length) {
                    grid.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">Nenhuma foto na galeria ainda.</p>';
                    return;
                }
                grid.innerHTML = data.photos.map(url => `
                    <div style="position:relative; width:90px; height:90px;">
                        <img src="${url}" style="width:100%; height:100%; object-fit:cover; border-radius:8px; border:1px solid var(--hairline, rgba(198,161,91,0.2));">
                        <button onclick="removeGalleryPhoto('${url}')" title="Remover"
                            style="position:absolute; top:-6px; right:-6px; width:22px; height:22px; border-radius:50%; background:var(--red); color:#fff; border:none; cursor:pointer; font-size:11px;">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `).join('');
            } catch (error) {
                console.error('Erro ao carregar galeria:', error);
            }
        }

        document.getElementById('galleryPhotoInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (file.size > 15 * 1024 * 1024) {
                showNotification('Arquivo muito grande! Máximo 15MB.', 'error');
                e.target.value = '';
                return;
            }

            try {
                const formData = new FormData();
                formData.append('photo', file);
                await apiFetch('/settings/gallery', { method: 'POST', body: formData });
                showNotification('Foto adicionada à galeria!', 'success');
                e.target.value = '';
                loadGallery();
            } catch (error) {
                showNotification('Erro ao enviar foto: ' + error.message, 'error');
                e.target.value = '';
            }
        });

        async function removeGalleryPhoto(url) {
            if (!(await customConfirm('Remover essa foto da galeria?'))) return;
            try {
                await apiFetch('/settings/gallery', { method: 'DELETE', body: JSON.stringify({ url }) });
                showNotification('Foto removida.', 'info');
                loadGallery();
            } catch (error) {
                showNotification('Erro ao remover foto: ' + error.message, 'error');
            }
        }

        // ==================== Perfil da Barbearia ====================
        async function loadShopProfile() {
            try {
                const data = await apiFetch('/settings');
                const profile = data.shop_profile ? JSON.parse(data.shop_profile) : {};
                const amenities = profile.amenities || {};
                const payments = profile.payment_methods || [];
                const social = profile.social || {};

                document.getElementById('amenityWifi').checked = !!amenities.wifi;
                document.getElementById('amenityParking').checked = !!amenities.parking;
                document.getElementById('amenityAccessible').checked = !!amenities.accessible;
                document.getElementById('amenityPets').checked = !!amenities.pets;

                document.getElementById('paymentDinheiro').checked = payments.includes('dinheiro');
                document.getElementById('paymentPix').checked = payments.includes('pix');
                document.getElementById('paymentCreditCard').checked = payments.includes('cartao_credito');
                document.getElementById('paymentDebitCard').checked = payments.includes('cartao_debito');

                document.getElementById('shopAddress').value = profile.address || '';
                document.getElementById('shopPhone').value = profile.phone || '';
                document.getElementById('socialWhatsapp').value = social.whatsapp || '';
                document.getElementById('socialInstagram').value = social.instagram || '';
                document.getElementById('socialFacebook').value = social.facebook || '';
            } catch (error) {
                console.error('Erro ao carregar perfil da barbearia:', error);
            }
        }

        async function saveShopProfile() {
            const payment_methods = [];
            if (document.getElementById('paymentDinheiro').checked) payment_methods.push('dinheiro');
            if (document.getElementById('paymentPix').checked) payment_methods.push('pix');
            if (document.getElementById('paymentCreditCard').checked) payment_methods.push('cartao_credito');
            if (document.getElementById('paymentDebitCard').checked) payment_methods.push('cartao_debito');

            const body = {
                amenities: {
                    wifi: document.getElementById('amenityWifi').checked,
                    parking: document.getElementById('amenityParking').checked,
                    accessible: document.getElementById('amenityAccessible').checked,
                    pets: document.getElementById('amenityPets').checked
                },
                payment_methods,
                social: {
                    whatsapp: document.getElementById('socialWhatsapp').value.trim(),
                    instagram: document.getElementById('socialInstagram').value.trim(),
                    facebook: document.getElementById('socialFacebook').value.trim()
                },
                address: document.getElementById('shopAddress').value.trim(),
                phone: document.getElementById('shopPhone').value.trim()
            };

            try {
                await apiFetch('/settings/profile', { method: 'PUT', body: JSON.stringify(body) });
                showNotification('Perfil da barbearia salvo com sucesso!', 'success');
            } catch (error) {
                showNotification('Erro ao salvar perfil: ' + error.message, 'error');
            }
        }

        // ==================== Avaliações (interno) ====================
        function starsHtml(rating) {
            let html = '';
            for (let i = 1; i <= 5; i++) {
                html += `<i class="fas fa-star" style="${i > rating ? 'opacity:0.2;' : ''}"></i>`;
            }
            return html;
        }

        // ==================== Assinaturas ====================
        let cachedClientsForSubscriptions = [];

        async function loadSubscriptionsSection() {
            try {
                const [plans, subs, clients] = await Promise.all([
                    apiFetch('/subscriptions/plans'),
                    apiFetch('/subscriptions'),
                    apiFetch('/clients')
                ]);
                cachedClientsForSubscriptions = clients;

                renderPlans(plans);
                renderSubscribeSelects(clients, plans);
                renderSubscriptions(subs);
            } catch (error) {
                console.error('Erro ao carregar assinaturas:', error);
            }
        }

        function renderPlans(plans) {
            const container = document.getElementById('plansList');
            if (!plans.length) {
                container.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">Nenhum plano criado ainda.</p>';
                return;
            }
            container.innerHTML = plans.map(p => `
                <div class="service-item">
                    <div class="service-info">
                        <h4>${p.name} ${!p.active ? '<span style="color:var(--red); font-size:11px;">(inativo)</span>' : ''}</h4>
                        <p>R$ ${p.price.toFixed(2)}/mês ${p.description ? '• ' + p.description : ''}</p>
                    </div>
                    <div class="service-actions">
                        <button class="btn-delete" onclick="deletePlan(${p.id})" aria-label="Excluir plano ${p.name}">
                            <i class="fas fa-trash" aria-hidden="true"></i> Excluir
                        </button>
                    </div>
                </div>
            `).join('');
        }

        function renderSubscribeSelects(clients, plans) {
            const clientSelect = document.getElementById('subscribeClientSelect');
            const planSelect = document.getElementById('subscribePlanSelect');

            clientSelect.innerHTML = clients.length
                ? clients.map(c => `<option value="${c.id}">${c.full_name || 'Sem nome'} (${c.phone || 'sem telefone'})</option>`).join('')
                : '<option value="">Nenhum cliente cadastrado ainda</option>';

            const activePlans = plans.filter(p => p.active);
            planSelect.innerHTML = activePlans.length
                ? activePlans.map(p => `<option value="${p.id}">${p.name} - R$ ${p.price.toFixed(2)}/mês</option>`).join('')
                : '<option value="">Crie um plano primeiro</option>';
        }

        function renderSubscriptions(subs) {
            const container = document.getElementById('subscriptionsList');
            if (!subs.length) {
                container.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">Nenhum cliente assinante ainda.</p>';
                return;
            }

            container.innerHTML = subs.map(s => {
                const nextDate = s.next_billing_date.split('-').reverse().join('/');
                const statusColor = s.status === 'cancelled' ? 'var(--text-muted)' : s.overdue ? 'var(--red)' : 'var(--lime)';
                const statusLabel = s.status === 'cancelled' ? 'Cancelada' : s.overdue ? 'Atrasada' : 'Em dia';

                return `
                    <div class="client-item" style="display:block;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <strong>${s.client.full_name || 'Cliente'}</strong>
                            <span style="color:${statusColor}; font-size:11.5px; font-weight:700;">${statusLabel}</span>
                        </div>
                        <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">
                            ${s.plan.name} • R$ ${s.plan.price.toFixed(2)}/mês • próxima cobrança: ${nextDate}
                        </div>
                        ${s.status === 'active' ? `
                            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                                <button class="btn-edit" onclick="openPaymentModal(${s.id}, ${s.plan.price})">
                                    <i class="fas fa-hand-holding-usd" aria-hidden="true"></i> Registrar Pagamento
                                </button>
                                <button class="btn-delete" onclick="cancelSubscription(${s.id})">
                                    <i class="fas fa-times" aria-hidden="true"></i> Cancelar
                                </button>
                            </div>
                        ` : ''}
                    </div>
                `;
            }).join('');
        }

        async function addPlan() {
            const name = document.getElementById('planName').value.trim();
            const price = parseFloat(document.getElementById('planPrice').value);
            const description = document.getElementById('planDescription').value.trim();

            if (!name || name.length < 3) { showNotification('Nome do plano inválido!', 'error'); return; }
            if (!price || price <= 0) { showNotification('Preço inválido!', 'error'); return; }

            try {
                await apiFetch('/subscriptions/plans', { method: 'POST', body: JSON.stringify({ name, price, description }) });
                showNotification('Plano criado com sucesso!', 'success');
                document.getElementById('planName').value = '';
                document.getElementById('planPrice').value = '';
                document.getElementById('planDescription').value = '';
                loadSubscriptionsSection();
            } catch (error) {
                showNotification('Erro ao criar plano: ' + error.message, 'error');
            }
        }

        async function deletePlan(id) {
            if (!(await customConfirm('Excluir este plano? Isso não cancela assinaturas já existentes.'))) return;
            try {
                await apiFetch(`/subscriptions/plans/${id}`, { method: 'DELETE' });
                showNotification('Plano excluído.', 'info');
                loadSubscriptionsSection();
            } catch (error) {
                showNotification('Erro ao excluir plano: ' + error.message, 'error');
            }
        }

        async function subscribeClient() {
            const user_id = document.getElementById('subscribeClientSelect').value;
            const plan_id = document.getElementById('subscribePlanSelect').value;

            if (!user_id) { showNotification('Cadastre um cliente primeiro!', 'error'); return; }
            if (!plan_id) { showNotification('Crie um plano primeiro!', 'error'); return; }

            try {
                await apiFetch('/subscriptions', { method: 'POST', body: JSON.stringify({ user_id: parseInt(user_id), plan_id: parseInt(plan_id) }) });
                showNotification('Cliente assinado com sucesso!', 'success');
                loadSubscriptionsSection();
            } catch (error) {
                showNotification('Erro ao assinar cliente: ' + error.message, 'error');
            }
        }

        function openPaymentModal(subscriptionId, planPrice) {
            document.getElementById('paymentSubscriptionId').value = subscriptionId;
            document.getElementById('paymentAmount').value = planPrice;
            document.getElementById('paymentMethodSelect').value = 'pix';
            document.getElementById('paymentModal').classList.remove('hidden');
        }

        function closePaymentModal() {
            document.getElementById('paymentModal').classList.add('hidden');
        }

        async function submitPayment() {
            const id = document.getElementById('paymentSubscriptionId').value;
            const amount = parseFloat(document.getElementById('paymentAmount').value);
            const payment_method = document.getElementById('paymentMethodSelect').value;

            if (!amount || amount <= 0) { showNotification('Valor inválido!', 'error'); return; }

            try {
                await apiFetch(`/subscriptions/${id}/payments`, { method: 'POST', body: JSON.stringify({ amount, payment_method }) });
                showNotification('Pagamento registrado com sucesso!', 'success');
                closePaymentModal();
                loadSubscriptionsSection();
            } catch (error) {
                showNotification('Erro ao registrar pagamento: ' + error.message, 'error');
            }
        }

        async function cancelSubscription(id) {
            if (!(await customConfirm('Cancelar esta assinatura?'))) return;
            try {
                await apiFetch(`/subscriptions/${id}/cancel`, { method: 'PATCH' });
                showNotification('Assinatura cancelada.', 'info');
                loadSubscriptionsSection();
            } catch (error) {
                showNotification('Erro ao cancelar: ' + error.message, 'error');
            }
        }

        // ==================== Fidelidade ====================
        function toggleLoyaltyModeFields() {
            const mode = document.getElementById('loyaltyMode').value;
            document.getElementById('pointsPerCurrencyGroup').style.display = mode === 'points' ? 'block' : 'none';
            document.getElementById('loyaltyThresholdLabel').textContent = mode === 'points' ? 'Quantos pontos até a recompensa' : 'Quantas visitas até a recompensa';

            const rewardType = document.getElementById('loyaltyRewardType').value;
            const valueGroup = document.getElementById('rewardValueGroup');
            const valueLabel = document.getElementById('rewardValueLabel');
            if (rewardType === 'free_service') {
                valueGroup.style.display = 'none';
            } else {
                valueGroup.style.display = 'block';
                valueLabel.textContent = rewardType === 'discount_percent' ? 'Porcentagem de desconto (%)' : 'Valor do desconto (R$)';
            }
        }

        async function loadLoyaltyConfig() {
            try {
                const config = await apiFetch('/settings/loyalty');
                document.getElementById('loyaltyEnabled').checked = !!config.enabled;
                document.getElementById('loyaltyMode').value = config.mode || 'stamps';
                document.getElementById('loyaltyPointsPerCurrency').value = config.points_per_currency || 1;
                document.getElementById('loyaltyThreshold').value = config.threshold || 10;
                document.getElementById('loyaltyRewardType').value = config.reward_type || 'free_service';
                document.getElementById('loyaltyRewardValue').value = config.reward_value || '';
                document.getElementById('loyaltyRewardDescription').value = config.reward_description || '';
                toggleLoyaltyModeFields();
            } catch (error) {
                console.error('Erro ao carregar fidelidade:', error);
            }
        }

        async function saveLoyaltyConfig() {
            const body = {
                enabled: document.getElementById('loyaltyEnabled').checked,
                mode: document.getElementById('loyaltyMode').value,
                points_per_currency: parseFloat(document.getElementById('loyaltyPointsPerCurrency').value) || 1,
                threshold: parseFloat(document.getElementById('loyaltyThreshold').value),
                reward_type: document.getElementById('loyaltyRewardType').value,
                reward_value: parseFloat(document.getElementById('loyaltyRewardValue').value) || 0,
                reward_description: document.getElementById('loyaltyRewardDescription').value.trim()
            };

            if (!body.threshold || body.threshold <= 0) {
                showNotification('Informe uma meta válida (maior que zero)!', 'error');
                return;
            }
            if (body.reward_type !== 'free_service' && body.reward_value <= 0) {
                showNotification('Informe o valor do desconto!', 'error');
                return;
            }

            try {
                await apiFetch('/settings/loyalty', { method: 'PUT', body: JSON.stringify(body) });
                showNotification('Programa de fidelidade salvo com sucesso!', 'success');
            } catch (error) {
                showNotification('Erro ao salvar fidelidade: ' + error.message, 'error');
            }
        }

        async function loadReviews() {
            try {
                const data = await apiFetch('/reviews');
                document.getElementById('reviewsAverage').textContent = data.total ? data.average.toFixed(1) : '–';
                document.getElementById('reviewsStars').innerHTML = data.total ? starsHtml(Math.round(data.average)) : '';
                document.getElementById('reviewsTotal').textContent = data.total
                    ? `${data.total} avaliação${data.total > 1 ? 'ões' : ''}`
                    : 'Nenhuma avaliação ainda';

                const listEl = document.getElementById('reviewsList');
                if (!data.reviews.length) {
                    listEl.innerHTML = '';
                    return;
                }

                listEl.innerHTML = data.reviews.map(r => `
                    <div class="client-item" style="display:block;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <strong>${r.customer_full_name || 'Cliente'}</strong>
                            <span style="color:var(--lime); font-size:14px;">${starsHtml(r.rating)}</span>
                        </div>
                        <div style="font-size:12px; color:var(--text-muted); margin-bottom:6px;">
                            ${r.service_name || ''} ${r.barber_name ? '• ' + r.barber_name : ''} • ${r.booking_date.split('-').reverse().join('/')}
                        </div>
                        ${r.comment ? `<p style="font-size:13.5px;">"${r.comment}"</p>` : ''}
                    </div>
                `).join('');
            } catch (error) {
                console.error('Erro ao carregar avaliações:', error);
            }
        }

        async function loadStats(customStart = null, customEnd = null) {
            try {
                const { startDate, endDate } = customStart && customEnd ? 
                    { startDate: customStart, endDate: customEnd } : getPeriodDates();
                
                const periodData = await apiFetch(`/bookings?start=${startDate}&end=${endDate}`);
                
                const confirmed = periodData?.filter(b => b.status === 'confirmed').length || 0;
                const completed = periodData?.filter(b => b.status === 'completed').length || 0;
                const cancelled = periodData?.filter(b => b.status === 'cancelled').length || 0;
                
                animateCountUp('periodBookings', periodData?.length || 0);
                document.getElementById('bookingsDetails').innerHTML = `
                    <div class="detail-item"><span>Confirmados</span><span>${confirmed}</span></div>
                    <div class="detail-item"><span>Concluídos</span><span>${completed}</span></div>
                    <div class="detail-item"><span>Cancelados</span><span>${cancelled}</span></div>
                `;
                
                const completedBookings = periodData?.filter(b => b.status === 'completed') || [];
                const revenue = completedBookings.reduce((sum, booking) => sum + Math.max(0, (booking.services?.price || 0) - (booking.discount_applied || 0)), 0);
                const avgTicket = completedBookings.length ? (revenue / completedBookings.length) : 0;
                
                animateCountUp('periodRevenue', revenue, 'R$ ', '', 2);
                document.getElementById('revenueDetails').innerHTML = `
                    <div class="detail-item"><span>Ticket Médio</span><span>R$ ${avgTicket.toFixed(2)}</span></div>
                    <div class="detail-item"><span>Agendamentos Concluídos</span><span>${completed}</span></div>
                    <div class="detail-item"><span>Cancelados (Sem Faturamento)</span><span>${cancelled}</span></div>
                `;
                
                const clientIdentifiers = new Set();
                periodData?.forEach(booking => {
                    if (booking.user_id) {
                        clientIdentifiers.add(booking.user_id);
                    } else if (booking.customer_phone) {
                        clientIdentifiers.add('anon:' + booking.customer_phone);
                    }
                });

                const uniqueClients = clientIdentifiers.size;
                animateCountUp('periodClients', uniqueClients);
                document.getElementById('clientsDetails').innerHTML = `
                    <div class="detail-item"><span>Total de Agendamentos</span><span>${periodData?.length || 0}</span></div>
                    <div class="detail-item"><span>Clientes Únicos</span><span>${uniqueClients}</span></div>
                    <div class="detail-item"><span>Média por Cliente</span><span>${uniqueClients ? (periodData.length / uniqueClients).toFixed(1) : 0}</span></div>
                `;
                
                const serviceCount = {};
                periodData?.forEach(booking => {
                    const serviceName = booking.services?.name || 'Desconhecido';
                    serviceCount[serviceName] = (serviceCount[serviceName] || 0) + 1;
                });
                
                const topServices = Object.entries(serviceCount).sort((a, b) => b[1] - a[1]);
                document.getElementById('topService').textContent = topServices[0]?.[0] || '-';
                document.getElementById('servicesDetails').innerHTML = topServices.slice(0, 5).map(([name, count]) => 
                    `<div class="detail-item"><span>${name}</span><span>${count}x</span></div>`
                ).join('') || '<div class="detail-item"><span>Sem dados</span><span>-</span></div>';
                
            } catch (error) {
                console.error('Erro ao carregar estatísticas:', error);
                showNotification('Erro ao carregar estatísticas', 'error');
            }
        }

        function initializeCharts() {
            if (chartsInitialized) return;

            const textColor = '#f2ede3';
            const gridColor = 'rgba(198, 161, 91, 0.12)';
            const mutedColor = '#a69c8c';

            const defaultOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: {
                            color: textColor
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: mutedColor },
                        grid: { color: gridColor }
                    },
                    y: {
                        ticks: { color: mutedColor },
                        grid: { color: gridColor },
                        beginAtZero: true
                    }
                }
            };

            const daysCtx = document.getElementById('daysChart').getContext('2d');
            charts.daysChart = new Chart(daysCtx, {
                type: 'bar',
                data: {
                    labels: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'],
                    datasets: [{
                        label: 'Agendamentos',
                        data: [0, 0, 0, 0, 0, 0, 0],
                        backgroundColor: 'rgba(198, 161, 91, 0.8)',
                        borderColor: 'rgba(198, 161, 91, 1)',
                        borderWidth: 2
                    }]
                },
                options: defaultOptions
            });

            const hoursCtx = document.getElementById('hoursChart').getContext('2d');
            charts.hoursChart = new Chart(hoursCtx, {
                type: 'line',
                data: {
                    labels: ['08:00', '09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00', '18:00'],
                    datasets: [{
                        label: 'Agendamentos por Horário',
                        data: [0, 0, 0, 0, 0, 0, 0, 0, 0],
                        backgroundColor: 'rgba(111, 174, 122, 0.2)',
                        borderColor: 'rgba(111, 174, 122, 1)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: defaultOptions
            });

            const servicesCtx = document.getElementById('servicesChart').getContext('2d');
            charts.servicesChart = new Chart(servicesCtx, {
                type: 'doughnut',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        backgroundColor: [
                            'rgba(198, 161, 91, 0.8)',
                            'rgba(111, 174, 122, 0.8)',
                            'rgba(212, 146, 46, 0.8)',
                            'rgba(193, 92, 92, 0.8)',
                            'rgba(122, 47, 63, 0.8)'
                        ],
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: textColor
                            }
                        }
                    }
                }
            });

            const revenueCtx = document.getElementById('revenueChart').getContext('2d');
            charts.revenueChart = new Chart(revenueCtx, {
                type: 'line',
                data: {
                    labels: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
                    datasets: [{
                        label: 'Faturamento (R$) - Apenas Concluídos',
                        data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                        backgroundColor: 'rgba(212, 146, 46, 0.2)',
                        borderColor: 'rgba(212, 146, 46, 1)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: defaultOptions
            });

            const barbersCtx = document.getElementById('barbersChart').getContext('2d');
            charts.barbersChart = new Chart(barbersCtx, {
                type: 'bar',
                data: {
                    labels: ['BarberSync'],
                    datasets: [{
                        label: 'Agendamentos',
                        data: [0],
                        backgroundColor: 'rgba(122, 47, 63, 0.8)',
                        borderColor: 'rgba(122, 47, 63, 1)',
                        borderWidth: 2
                    }]
                },
                options: defaultOptions
            });

            const cancellationCtx = document.getElementById('cancellationChart').getContext('2d');
            charts.cancellationChart = new Chart(cancellationCtx, {
                type: 'bar',
                data: {
                    labels: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun'],
                    datasets: [{
                        label: 'Taxa de Cancelamento (%)',
                        data: [0, 0, 0, 0, 0, 0],
                        backgroundColor: 'rgba(193, 92, 92, 0.8)',
                        borderColor: 'rgba(193, 92, 92, 1)',
                        borderWidth: 2
                    }]
                },
                options: defaultOptions
            });

            chartsInitialized = true;
            updateCharts();
        }

        async function updateCharts(customStart = null, customEnd = null) {
            if (!chartsInitialized) return;

            try {
                const { startDate, endDate } = customStart && customEnd ? 
                    { startDate: customStart, endDate: customEnd } : getPeriodDates();

                const bookingsData = await apiFetch(`/bookings?start=${startDate}&end=${endDate}`);

                if (!bookingsData) return;

                const daysCounts = [0, 0, 0, 0, 0, 0, 0];
                bookingsData.forEach(booking => {
                    const dayOfWeek = new Date(booking.booking_date + 'T12:00:00').getDay();
                    daysCounts[dayOfWeek]++;
                });
                charts.daysChart.data.datasets[0].data = daysCounts;
                charts.daysChart.update();

                const hoursCounts = {};
                bookingsData.forEach(booking => {
                    const hour = booking.booking_time.substring(0, 2) + ':00';
                    hoursCounts[hour] = (hoursCounts[hour] || 0) + 1;
                });
                const hoursData = ['08:00', '09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00', '18:00']
                    .map(hour => hoursCounts[hour] || 0);
                charts.hoursChart.data.datasets[0].data = hoursData;
                charts.hoursChart.update();

                const servicesCounts = {};
                bookingsData.forEach(booking => {
                    const serviceName = booking.services?.name || 'Desconhecido';
                    servicesCounts[serviceName] = (servicesCounts[serviceName] || 0) + 1;
                });
                const topServices = Object.entries(servicesCounts).slice(0, 5);
                charts.servicesChart.data.labels = topServices.map(([name]) => name);
                charts.servicesChart.data.datasets[0].data = topServices.map(([, count]) => count);
                charts.servicesChart.update();

                const monthlyRevenue = {};
                bookingsData.forEach(booking => {
                    if (booking.status === 'completed') {
                        const month = booking.booking_date.substring(0, 7);
                        const paid = Math.max(0, (booking.services?.price || 0) - (booking.discount_applied || 0));
                        monthlyRevenue[month] = (monthlyRevenue[month] || 0) + paid;
                    }
                });
                
                const currentYear = new Date().getFullYear();
                const revenueData = [];
                for (let i = 0; i < 12; i++) {
                    const month = `${currentYear}-${(i + 1).toString().padStart(2, '0')}`;
                    revenueData.push(monthlyRevenue[month] || 0);
                }
                charts.revenueChart.data.datasets[0].data = revenueData;
                charts.revenueChart.update();

                charts.barbersChart.data.datasets[0].data = [bookingsData.length];
                charts.barbersChart.update();

                const cancellationData = {};
                bookingsData.forEach(booking => {
                    const month = booking.booking_date.substring(0, 7);
                    if (!cancellationData[month]) {
                        cancellationData[month] = { total: 0, cancelled: 0 };
                    }
                    cancellationData[month].total++;
                    if (booking.status === 'cancelled') {
                        cancellationData[month].cancelled++;
                    }
                });

                const cancellationRates = [];
                for (let i = 0; i < 6; i++) {
                    const month = `${currentYear}-${(i + 1).toString().padStart(2, '0')}`;
                    const data = cancellationData[month];
                    const rate = data ? (data.cancelled / data.total * 100) : 0;
                    cancellationRates.push(rate);
                }
                charts.cancellationChart.data.datasets[0].data = cancellationRates;
                charts.cancellationChart.update();

            } catch (error) {
                console.error('Erro ao atualizar gráficos:', error);
            }
        }

        async function loadBookings() {
            const container = document.getElementById('bookingsTable');
            container.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i><p>Carregando...</p></div>';
            
            try {
                const filterStatus = document.getElementById('filterStatus').value;
                let filterDate = document.getElementById('filterDate').value;
                
                if (!filterDate) {
                    const today = todayBR();
                    filterDate = today;
                    document.getElementById('filterDate').value = today;
                }
                
                const data = await apiFetch(`/bookings?date=${filterDate}&status=${filterStatus}`);
                
                if (!data || data.length === 0) {
                    const dateFormatted = new Date(filterDate + 'T12:00:00').toLocaleDateString('pt-BR');
                    container.innerHTML = `<div class="empty-state"><i class="fas fa-calendar" aria-hidden="true"></i><p>Nenhum agendamento encontrado para ${dateFormatted}</p></div>`;
                    return;
                }
                
                container.innerHTML = data.map(booking => {
                    const date = new Date(booking.booking_date + 'T12:00:00');
                    const dateDayMonth = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
                    const timeFormatted = booking.booking_time.substring(0, 5);
                    
                    const clientName = booking.users?.full_name || booking.customer_full_name || 'Cliente Anônimo';
                    const clientPhone = booking.users?.phone || booking.customer_phone || 'Sem telefone';
                    
                    const phoneNumberClean = clientPhone.replace(/\D/g, '');
                    const whatsappLink = phoneNumberClean ? 
                        `https://wa.me/55${phoneNumberClean}?text=Olá ${clientName.split(' ')[0]}, aqui é da Barbearia BarberSync! Entrando em contato sobre seu agendamento de ${dateDayMonth} às ${timeFormatted}.` : 
                        '#';
                    
                    const itemClass = `booking-item`; 

                    return `
                        <div class="${itemClass}">
                            <div class="booking-main">
                                <div class="booking-client">
                                    <h4><i class="fas fa-user" aria-hidden="true"></i> ${clientName}</h4>
                                    <p><i class="fas fa-cut" aria-hidden="true"></i> ${booking.services?.name}</p>
                                    <p><i class="fas fa-user-tie" aria-hidden="true"></i> Barbeiro: ${booking.barbers?.name || 'Não especificado'}</p>
                                    <p><i class="fas fa-phone" aria-hidden="true"></i> ${clientPhone}</p>
                                    <p><i class="fas fa-dollar-sign" aria-hidden="true"></i> R$ ${booking.services?.price?.toFixed(2) || '0.00'} • <i class="fas fa-hourglass-half" aria-hidden="true"></i> ${booking.services?.duration || 0}min</p>
                                    ${booking.reward_label ? `<p style="color:var(--lime);"><i class="fas fa-gift" aria-hidden="true"></i> ${booking.reward_label} (-R$ ${booking.discount_applied.toFixed(2)})</p>` : ''}
                                    ${booking.source === 'whatsapp_ia' ? `<p style="color:#25d366;"><i class="fas fa-robot" aria-hidden="true"></i> Agendado pela IA no WhatsApp</p>` : ''}
                                    ${booking.client_confirmed_at && booking.status === 'confirmed' ? `<p style="color:#25d366;"><i class="fas fa-check-double" aria-hidden="true"></i> Cliente confirmou presença</p>` : ''}
                                    ${booking.rescheduled_at && booking.status === 'confirmed' ? `<p style="color:var(--text-muted);"><i class="fas fa-rotate" aria-hidden="true"></i> Reagendado pelo cliente no WhatsApp</p>` : ''}
                                    ${booking.cancelled_by === 'cliente_whatsapp' && booking.status === 'cancelled' ? `<p style="color:#e57373;"><i class="fas fa-ban" aria-hidden="true"></i> Cancelado pelo cliente no WhatsApp</p>` : ''}
                                </div>
                                <span class="booking-status status-${booking.status}">
                                    ${booking.status === 'confirmed' ? 'Confirmado' : 
                                      booking.status === 'completed' ? 'Concluído' : 
                                      booking.status === 'pending' ? 'Pendente' : 'Cancelado'}
                                </span>
                            </div>
                            
                            <div class="booking-datetime-highlight">
                                <div class="datetime-box">
                                    <div class="datetime-label">Data</div>
                                    <div class="datetime-value">${dateDayMonth.toUpperCase()}</div>
                                </div>
                                <div class="datetime-separator">•</div>
                                <div class="datetime-box">
                                    <div class="datetime-label">Horário</div>
                                    <div class="datetime-value">${timeFormatted}</div>
                                </div>
                            </div>
                            
                            <div class="booking-footer">
                                <div class="booking-actions">
                                    ${booking.status === 'confirmed' ? `
                                        <button class="btn-cancel" onclick="cancelAndDeleteBooking('${booking.id}')" aria-label="Excluir agendamento">
                                            <i class="fas fa-times-circle" aria-hidden="true"></i> Cancelar
                                        </button>
                                        <button class="btn-complete" onclick="updateBookingStatus('${booking.id}', 'completed')" aria-label="Concluir agendamento">
                                            <i class="fas fa-check" aria-hidden="true"></i> Concluir
                                        </button>
                                    ` : booking.status === 'completed' || booking.status === 'cancelled' ? `
                                        <button class="btn-delete" onclick="deleteBooking('${booking.id}')" aria-label="Excluir agendamento">
                                            <i class="fas fa-trash" aria-hidden="true"></i> Excluir
                                        </button>
                                    ` : ''}
                                    ${phoneNumberClean ? `
                                        <a href="${whatsappLink}" class="btn-whatsapp" target="_blank" aria-label="Conversar no WhatsApp">
                                            <i class="fab fa-whatsapp" aria-hidden="true"></i> Chat
                                        </a>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (error) {
                console.error('Erro ao carregar agendamentos:', error);
                container.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i><p>Erro ao carregar agendamentos</p></div>';
                showNotification('Erro ao carregar agendamentos', 'error');
            }
        }

        async function cancelAndDeleteBooking(bookingId) {
             if (!bookingId) { 
                showNotification('ID inválido', 'error'); 
                return; 
            }
            if (!(await customConfirm('Tem certeza que deseja CANCELAR e EXCLUIR este agendamento? Esta ação não pode ser desfeita.'))) return;

            try {
                await apiFetch(`/bookings/${bookingId}`, { method: 'DELETE' });
                
                showNotification(`Agendamento cancelado e excluído com sucesso!`, 'success');
                loadBookings();
                if (document.getElementById('dashboardContainer').classList.contains('active')) {
                    loadStats();
                    updateCharts();
                }
            } catch (error) {
                showNotification('Erro ao cancelar e excluir: ' + error.message, 'error');
            }
        }
        
        async function updateBookingStatus(bookingId, status) {
            if (!bookingId) { 
                showNotification('ID inválido', 'error'); 
                return; 
            }
            
            const actionText = status === 'completed' ? 'concluir' : status === 'cancelled' ? 'cancelar' : 'confirmar';
            if (!(await customConfirm(`Tem certeza que deseja ${actionText} este agendamento?`))) return;
            
            try {
                await apiFetch(`/bookings/${bookingId}/status`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status })
                });
                
                showNotification(`Agendamento ${actionText} com sucesso!`, 'success');
                loadBookings();
                if (document.getElementById('dashboardContainer').classList.contains('active')) {
                    loadStats();
                    updateCharts();
                }
            } catch (error) {
                showNotification('Erro ao atualizar status: ' + error.message, 'error');
            }
        }

        async function deleteBooking(bookingId) {
            if (!bookingId) { 
                showNotification('ID inválido', 'error'); 
                return; 
            }
            
            if (!(await customConfirm('Tem certeza que deseja EXCLUIR este agendamento? Esta ação não pode ser desfeita!'))) return;
            
            try {
                await apiFetch(`/bookings/${bookingId}`, { method: 'DELETE' });
                
                showNotification('Agendamento excluído com sucesso!', 'success');
                loadBookings();
                if (document.getElementById('dashboardContainer').classList.contains('active')) {
                    loadStats();
                    updateCharts();
                }
            } catch (error) {
                showNotification('Erro ao excluir agendamento: ' + error.message, 'error');
            }
        }

        // ... existing code for services, barbers, clients, schedule management ...

        async function loadServices() {
            try {
                const data = await apiFetch('/services');
                
                const container = document.getElementById('servicesList');
                if (!data || data.length === 0) {
                    container.innerHTML = '<div class="empty-state" style="padding: 20px;"><i class="fas fa-cut" aria-hidden="true"></i><p>Nenhum serviço cadastrado</p></div>';
                    renderPackageServiceChecklist([]);
                    return;
                }
                
                container.innerHTML = `<h3 style="margin: 20px 0 15px; color: var(--lime); font-size: 16px;">Serviços Cadastrados</h3>` + 
                    data.map(service => 
                        `<div class="service-item">
                            <div class="service-info" style="display:flex; align-items:center; gap:12px;">
                                ${service.photo_url
                                    ? `<img src="${service.photo_url}" alt="" style="width:40px; height:40px; border-radius:50%; object-fit:cover; flex-shrink:0;">`
                                    : `<div style="width:40px; height:40px; border-radius:50%; background:var(--dark-bg); display:flex; align-items:center; justify-content:center; flex-shrink:0;"><i class="fas fa-cut" style="color:var(--text-muted); font-size:14px;"></i></div>`}
                                <div>
                                    <h4>${service.name}</h4>
                                    <p>R$ ${service.price.toFixed(2)} • ${service.duration} minutos</p>
                                </div>
                            </div>
                            <div class="service-actions">
                                <button class="btn-edit" onclick="editService(${service.id})" aria-label="Editar serviço ${service.name}">
                                    <i class="fas fa-edit" aria-hidden="true"></i> Editar
                                </button>
                                <button class="btn-delete" onclick="deleteService(${service.id})" aria-label="Excluir serviço ${service.name}">
                                    <i class="fas fa-trash" aria-hidden="true"></i> Excluir
                                </button>
                            </div>
                        </div>`
                    ).join('');

                renderPackageServiceChecklist(data);
            } catch (error) {
                console.error('Erro ao carregar serviços:', error);
                showNotification('Erro ao carregar serviços', 'error');
            }
        }

        // ==================== Pacotes ====================
        function renderPackageServiceChecklist(services) {
            const box = document.getElementById('packageServiceChecklist');
            if (!services.length) {
                box.innerHTML = '<span style="color:var(--text-muted); font-size:13px;">Cadastre serviços primeiro para poder formar um pacote.</span>';
                return;
            }
            box.innerHTML = services.map(s => `
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13.5px;">
                    <input type="checkbox" class="package-service-checkbox" value="${s.id}"> ${s.name} (R$ ${s.price.toFixed(2)})
                </label>
            `).join('');
        }

        async function loadPackages() {
            try {
                const data = await apiFetch('/packages');
                const container = document.getElementById('packagesList');

                if (!data || !data.length) {
                    container.innerHTML = '<div class="empty-state" style="padding: 20px;"><i class="fas fa-box-open" aria-hidden="true"></i><p>Nenhum pacote cadastrado</p></div>';
                    return;
                }

                container.innerHTML = data.map(pkg => `
                    <div class="service-item">
                        <div class="service-info">
                            <h4>${pkg.name} ${!pkg.active ? '<span style="color:var(--red); font-size:11px;">(inativo)</span>' : ''}</h4>
                            <p>R$ ${pkg.price.toFixed(2)} • ${pkg.total_duration} minutos • ${pkg.services.map(s => s.name).join(' + ')}</p>
                        </div>
                        <div class="service-actions">
                            <button class="btn-edit" onclick="openEditPackageModal(${pkg.id})" aria-label="Editar pacote ${pkg.name}">
                                <i class="fas fa-edit" aria-hidden="true"></i> Editar
                            </button>
                            <button class="btn-delete" onclick="deletePackage(${pkg.id})" aria-label="Excluir pacote ${pkg.name}">
                                <i class="fas fa-trash" aria-hidden="true"></i> Excluir
                            </button>
                        </div>
                    </div>
                `).join('');
            } catch (error) {
                console.error('Erro ao carregar pacotes:', error);
            }
        }

        async function addPackage() {
            const name = document.getElementById('packageName').value.trim();
            const price = parseFloat(document.getElementById('packagePrice').value);
            const service_ids = [...document.querySelectorAll('.package-service-checkbox:checked')].map(cb => parseInt(cb.value));

            if (!name || name.length < 3) { showNotification('Nome do pacote inválido!', 'error'); return; }
            if (!price || price <= 0) { showNotification('Preço inválido!', 'error'); return; }
            if (service_ids.length < 2) { showNotification('Selecione pelo menos 2 serviços!', 'error'); return; }

            try {
                await apiFetch('/packages', { method: 'POST', body: JSON.stringify({ name, price, service_ids }) });
                showNotification('Pacote adicionado com sucesso!', 'success');
                document.getElementById('packageName').value = '';
                document.getElementById('packagePrice').value = '';
                document.querySelectorAll('.package-service-checkbox').forEach(cb => cb.checked = false);
                loadPackages();
            } catch (error) {
                showNotification('Erro ao adicionar pacote: ' + error.message, 'error');
            }
        }

        async function openEditPackageModal(id) {
            try {
                const packages = await apiFetch('/packages');
                const pkg = packages.find(p => p.id === id);
                if (!pkg) return;

                const services = await apiFetch('/services');

                document.getElementById('editPackageId').value = pkg.id;
                document.getElementById('editPackageName').value = pkg.name;
                document.getElementById('editPackagePrice').value = pkg.price;
                document.getElementById('editPackageActive').checked = pkg.active;

                const includedIds = pkg.services.map(s => s.id);
                document.getElementById('editPackageServiceChecklist').innerHTML = services.map(s => `
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13.5px;">
                        <input type="checkbox" class="edit-package-service-checkbox" value="${s.id}" ${includedIds.includes(s.id) ? 'checked' : ''}> ${s.name} (R$ ${s.price.toFixed(2)})
                    </label>
                `).join('');

                document.getElementById('editPackageModal').classList.remove('hidden');
            } catch (error) {
                showNotification('Erro ao carregar pacote: ' + error.message, 'error');
            }
        }

        function closeEditPackageModal() {
            document.getElementById('editPackageModal').classList.add('hidden');
        }

        document.getElementById('editPackageForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('editPackageId').value;
            const name = document.getElementById('editPackageName').value.trim();
            const price = parseFloat(document.getElementById('editPackagePrice').value);
            const active = document.getElementById('editPackageActive').checked;
            const service_ids = [...document.querySelectorAll('.edit-package-service-checkbox:checked')].map(cb => parseInt(cb.value));

            if (!name || name.length < 3) { showNotification('Nome do pacote inválido!', 'error'); return; }
            if (!price || price <= 0) { showNotification('Preço inválido!', 'error'); return; }
            if (service_ids.length < 2) { showNotification('Selecione pelo menos 2 serviços!', 'error'); return; }

            try {
                await apiFetch(`/packages/${id}`, { method: 'PUT', body: JSON.stringify({ name, price, active, service_ids }) });
                showNotification('Pacote atualizado com sucesso!', 'success');
                closeEditPackageModal();
                loadPackages();
            } catch (error) {
                showNotification('Erro ao atualizar pacote: ' + error.message, 'error');
            }
        });

        async function deletePackage(id) {
            if (!(await customConfirm('Tem certeza que deseja excluir este pacote?'))) return;
            try {
                await apiFetch(`/packages/${id}`, { method: 'DELETE' });
                showNotification('Pacote excluído com sucesso!', 'success');
                loadPackages();
            } catch (error) {
                showNotification('Erro ao excluir pacote: ' + error.message, 'error');
            }
        }

        async function addService() {
            const name = document.getElementById('serviceName').value.trim();
            const price = parseFloat(document.getElementById('servicePrice').value);
            const duration = parseInt(document.getElementById('serviceDuration').value);
            
            if (!name || name.length < 3) { 
                showNotification('Nome do serviço inválido!', 'error'); 
                return; 
            }
            if (!price || price <= 0) { 
                showNotification('Preço inválido!', 'error'); 
                return; 
            }
            if (!duration || duration < 15) { 
                showNotification('Duração mínima: 15 minutos!', 'error'); 
                return; 
            }
            
            const photoInput = document.getElementById('servicePhoto');
            const photoFile = photoInput.files[0];
            if (photoFile && photoFile.size > 15 * 1024 * 1024) {
                showNotification('Foto muito grande! Máximo 15MB.', 'error');
                return;
            }

            try {
                const service = await apiFetch('/services', { method: 'POST', body: JSON.stringify({ name, price, duration }) });

                if (photoFile) {
                    const formData = new FormData();
                    formData.append('photo', photoFile);
                    await apiFetch(`/services/${service.id}/photo`, { method: 'POST', body: formData });
                }
                
                showNotification('Serviço adicionado com sucesso!', 'success');
                document.getElementById('serviceName').value = '';
                document.getElementById('servicePrice').value = '';
                document.getElementById('serviceDuration').value = '';
                photoInput.value = '';
                loadServices();
            } catch (error) {
                showNotification('Erro ao adicionar serviço: ' + error.message, 'error');
            }
        }

        async function editService(id) {
            try {
                const data = await apiFetch(`/services/${id}`);
                document.getElementById('editServiceId').value = data.id;
                document.getElementById('editServiceName').value = data.name;
                document.getElementById('editServicePrice').value = data.price;
                document.getElementById('editServiceDuration').value = data.duration;

                const preview = document.getElementById('editServicePhotoPreview');
                const removeBtn = document.getElementById('removeServicePhotoBtn');
                if (data.photo_url) {
                    preview.src = data.photo_url;
                    preview.style.display = 'block';
                    removeBtn.classList.remove('hidden');
                } else {
                    preview.style.display = 'none';
                    removeBtn.classList.add('hidden');
                }
                document.getElementById('editServicePhotoInput').value = '';

                document.getElementById('editServiceModal').classList.remove('hidden');
            } catch (error) {
                showNotification('Erro ao carregar serviço: ' + error.message, 'error');
            }
        }

        function closeEditServiceModal() {
            document.getElementById('editServiceModal').classList.add('hidden');
        }

        document.getElementById('editServicePhotoInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            const id = document.getElementById('editServiceId').value;
            if (!file || !id) return;

            if (file.size > 15 * 1024 * 1024) {
                showNotification('Foto muito grande! Máximo 15MB.', 'error');
                e.target.value = '';
                return;
            }

            try {
                const formData = new FormData();
                formData.append('photo', file);
                const result = await apiFetch(`/services/${id}/photo`, { method: 'POST', body: formData });

                const preview = document.getElementById('editServicePhotoPreview');
                preview.src = result.photo_url;
                preview.style.display = 'block';
                document.getElementById('removeServicePhotoBtn').classList.remove('hidden');
                showNotification('Foto do serviço atualizada!', 'success');
                loadServices();
            } catch (error) {
                showNotification('Erro ao enviar foto: ' + error.message, 'error');
            } finally {
                e.target.value = '';
            }
        });

        async function removeServicePhoto() {
            const id = document.getElementById('editServiceId').value;
            if (!id) return;
            if (!(await customConfirm('Remover a foto deste serviço?'))) return;

            try {
                await apiFetch(`/services/${id}/photo`, { method: 'DELETE' });
                document.getElementById('editServicePhotoPreview').style.display = 'none';
                document.getElementById('removeServicePhotoBtn').classList.add('hidden');
                showNotification('Foto removida.', 'info');
                loadServices();
            } catch (error) {
                showNotification('Erro ao remover foto: ' + error.message, 'error');
            }
        }

        document.getElementById('editServiceForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('editServiceId').value;
            const newName = document.getElementById('editServiceName').value;
            const newPrice = document.getElementById('editServicePrice').value;
            const newDuration = document.getElementById('editServiceDuration').value;

            if (!newName || newName.trim().length < 3) {
                showNotification('Nome deve ter pelo menos 3 caracteres!', 'error');
                return;
            }
            if (!newPrice || parseFloat(newPrice) <= 0) {
                showNotification('Preço inválido!', 'error');
                return;
            }
            if (!newDuration || parseInt(newDuration) < 15) {
                showNotification('Duração mínima: 15 minutos!', 'error');
                return;
            }

            try {
                await apiFetch(`/services/${id}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        name: newName.trim(),
                        price: parseFloat(newPrice),
                        duration: parseInt(newDuration)
                    })
                });

                showNotification('Serviço atualizado com sucesso!', 'success');
                closeEditServiceModal();
                loadServices();
            } catch (error) {
                showNotification('Erro ao editar serviço: ' + error.message, 'error');
            }
        });

        async function deleteService(id) {
            if (!(await customConfirm('Tem certeza que deseja excluir este serviço?'))) return;
            
            try {
                await apiFetch(`/services/${id}`, { method: 'DELETE' });
                
                showNotification('Serviço excluído com sucesso!', 'success');
                loadServices();
            } catch (error) {
                showNotification('Erro ao excluir serviço: ' + error.message, 'error');
            }
        }

        async function loadBarbers() {
            try {
                const data = await apiFetch('/barbers');
                
                const container = document.getElementById('barbersList');
                if (!data || data.length === 0) {
                    container.innerHTML = '<div class="empty-state" style="padding: 20px;"><i class="fas fa-user-tie" aria-hidden="true"></i><p>Nenhum barbeiro cadastrado</p></div>';
                    return;
                }
                
                container.innerHTML = `<h3 style="margin: 20px 0 15px; color: var(--lime); font-size: 16px;">Barbeiros Cadastrados</h3>` + 
                    data.map(barber => 
                        `<div class="barber-item">
                            <div class="barber-content">
                                <div class="barber-photo-display">
                                    ${barber.photo_url ? 
                                        `<img src="${barber.photo_url}" alt="${barber.name}">` : 
                                        '<i class="fas fa-user-tie"></i>'
                                    }
                                </div>
                                <div class="barber-info">
                                    <h4>${barber.name}</h4>
                                    <p>${barber.specialty || 'Especialidade não informada'}</p>
                                </div>
                            </div>
                            <div class="barber-actions">
                                <button class="btn-edit" onclick="openEditBarberModal('${barber.id}')" aria-label="Editar barbeiro ${barber.name}">
                                    <i class="fas fa-edit" aria-hidden="true"></i> Editar
                                </button>
                                <button class="btn-delete" onclick="deleteBarber('${barber.id}')" aria-label="Excluir barbeiro ${barber.name}">
                                    <i class="fas fa-trash" aria-hidden="true"></i> Excluir
                                </button>
                            </div>
                        </div>`
                    ).join('');
            } catch (error) {
                console.error('Erro ao carregar barbeiros:', error);
                showNotification('Erro ao carregar barbeiros', 'error');
            }
        }

        async function addBarber() {
            const name = document.getElementById('barberName').value.trim();
            const specialty = document.getElementById('barberSpecialty').value.trim();
            const photoFile = document.getElementById('barberPhoto').files[0];
            
            if (!name || name.length < 3) { 
                showNotification('Nome deve ter pelo menos 3 caracteres!', 'error'); 
                return; 
            }
            
            try {
                if (photoFile && photoFile.size > 15 * 1024 * 1024) {
                    showNotification('Arquivo muito grande! Máximo 15MB.', 'error');
                    return;
                }

                const formData = new FormData();
                formData.append('name', name);
                formData.append('specialty', specialty || '');
                if (photoFile) formData.append('photo', photoFile);

                await apiFetch('/barbers', { method: 'POST', body: formData });
                
                showNotification('Barbeiro adicionado com sucesso!', 'success');
                document.getElementById('barberName').value = '';
                document.getElementById('barberSpecialty').value = '';
                document.getElementById('barberPhoto').value = '';
                loadBarbers();
            } catch (error) {
                showNotification('Erro ao adicionar barbeiro: ' + error.message, 'error');
            }
        }

        async function openEditBarberModal(barberId) {
            try {
                const barber = await apiFetch(`/barbers/${barberId}`);
                
                document.getElementById('editBarberId').value = barber.id;
                document.getElementById('editBarberName').value = barber.name || '';
                document.getElementById('editBarberSpecialty').value = barber.specialty || '';
                
                const modal = document.getElementById('editBarberModal');
                modal.classList.remove('hidden');
                
                const firstInput = modal.querySelector('input[type="text"]');
                firstInput.focus();
            } catch (error) {
                showNotification('Erro ao carregar dados do barbeiro: ' + error.message, 'error');
            }
        }

        function closeEditBarberModal() {
            document.getElementById('editBarberModal').classList.add('hidden');
            document.getElementById('editBarberForm').reset();
        }

        document.getElementById('editBarberForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const barberId = document.getElementById('editBarberId').value;
            const name = document.getElementById('editBarberName').value.trim();
            const specialty = document.getElementById('editBarberSpecialty').value.trim();
            const photoFile = document.getElementById('editBarberPhoto').files[0];
            
            if (!name || name.length < 3) { 
                showNotification('Nome deve ter pelo menos 3 caracteres!', 'error'); 
                return; 
            }
            
            try {
                if (photoFile && photoFile.size > 15 * 1024 * 1024) {
                    showNotification('Arquivo muito grande! Máximo 15MB.', 'error');
                    return;
                }

                const formData = new FormData();
                formData.append('name', name);
                formData.append('specialty', specialty || '');
                if (photoFile) formData.append('photo', photoFile);

                await apiFetch(`/barbers/${barberId}`, { method: 'PUT', body: formData });
                
                showNotification('Barbeiro atualizado com sucesso!', 'success');
                closeEditBarberModal();
                loadBarbers();
            } catch (error) {
                showNotification('Erro ao atualizar barbeiro: ' + error.message, 'error');
            }
        });

        async function deleteBarber(barberId) {
            if (!(await customConfirm('Tem certeza que deseja excluir este barbeiro?'))) return;
            
            try {
                await apiFetch(`/barbers/${barberId}`, { method: 'DELETE' });
                
                showNotification('Barbeiro excluído com sucesso!', 'success');
                loadBarbers();
            } catch (error) {
                showNotification('Erro ao excluir barbeiro: ' + error.message, 'error');
            }
        }

        async function addClient() {
            const fullName = document.getElementById('newClientName').value.trim();
            const email = document.getElementById('newClientEmail').value.trim();
            const phone = document.getElementById('newClientPhone').value.trim();

            if (!fullName || fullName.length < 3) {
                showNotification('Nome deve ter pelo menos 3 caracteres!', 'error');
                return;
            }
            if (!email || !email.includes('@')) {
                showNotification('Email inválido!', 'error');
                return;
            }
            if (!phone || phone.length < 10) {
                showNotification('Telefone inválido!', 'error');
                return;
            }

            try {
                await apiFetch('/clients', {
                    method: 'POST',
                    body: JSON.stringify({ full_name: fullName, email: email, phone: phone })
                });

                showNotification('Cliente cadastrado com sucesso!', 'success');
                document.getElementById('newClientName').value = '';
                document.getElementById('newClientEmail').value = '';
                document.getElementById('newClientPhone').value = '';
                loadClients();
            } catch (error) {
                showNotification('Erro ao cadastrar cliente: ' + error.message, 'error');
            }
        }

        async function loadClients() {
            const container = document.getElementById('clientsList');
            container.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i><p>Carregando clientes...</p></div>';
            
            try {
                const filterName = document.getElementById('filterClientName').value;
                const clientsWithStats = await apiFetch(`/clients?name=${encodeURIComponent(filterName)}`);
                
                if (!clientsWithStats || clientsWithStats.length === 0) {
                    container.innerHTML = '<div class="empty-state"><i class="fas fa-users" aria-hidden="true"></i><p>Nenhum cliente encontrado</p></div>';
                    return;
                }
                
                container.innerHTML = clientsWithStats.map(client => {
                    const memberSince = new Date(client.created_at).toLocaleDateString('pt-BR');
                    return `
                        <div class="client-item">
                            <div class="client-info">
                                <h4><i class="fas fa-user" aria-hidden="true"></i> ${client.full_name || 'Nome não informado'}</h4>
                                <p><i class="fas fa-envelope" aria-hidden="true"></i> ${client.email}</p>
                                <p><i class="fas fa-phone" aria-hidden="true"></i> ${client.phone || 'Telefone não informado'}</p>
                                <div class="client-stats">
                                    <span class="client-stat">
                                        <i class="fas fa-calendar-check" aria-hidden="true"></i> 
                                        ${client.totalBookings} agendamento${client.totalBookings !== 1 ? 's' : ''}
                                    </span>
                                    <span class="client-stat">
                                        <i class="fas fa-check-circle" aria-hidden="true"></i> 
                                        ${client.completedBookings} concluído${client.completedBookings !== 1 ? 's' : ''}
                                    </span>
                                    <span class="client-stat">
                                        <i class="fas fa-user-clock" aria-hidden="true"></i> 
                                        Cliente desde ${memberSince}
                                    </span>
                                    ${client.loyalty_progress > 0 ? `
                                    <span class="client-stat" style="color:var(--lime);">
                                        <i class="fas fa-gift" aria-hidden="true"></i> 
                                        Fidelidade: ${client.loyalty_progress}
                                    </span>` : ''}
                                </div>
                            </div>
                            <div class="client-actions">
                                <button class="btn-edit" onclick="openEditClientModal('${client.id}')" aria-label="Editar cliente ${client.full_name}">
                                    <i class="fas fa-edit" aria-hidden="true"></i> Editar
                                </button>
                                <button class="btn-delete" onclick="deleteClient('${client.id}')" aria-label="Excluir cliente ${client.full_name}">
                                    <i class="fas fa-trash" aria-hidden="true"></i> Excluir
                                </button>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (error) {
                console.error('Erro ao carregar clientes:', error);
                container.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i><p>Erro ao carregar clientes</p></div>';
                showNotification('Erro ao carregar clientes', 'error');
            }
        }

        async function openEditClientModal(clientId) {
            try {
                const client = await apiFetch(`/clients/${clientId}`);
                
                document.getElementById('editClientId').value = client.id;
                document.getElementById('editClientName').value = client.full_name || '';
                document.getElementById('editClientEmail').value = client.email || '';
                document.getElementById('editClientPhone').value = client.phone || '';
                
                const modal = document.getElementById('editClientModal');
                modal.classList.remove('hidden');
                
                const firstInput = modal.querySelector('input[type="text"]');
                firstInput.focus();
            } catch (error) {
                showNotification('Erro ao carregar dados do cliente: ' + error.message, 'error');
            }
        }

        function closeEditClientModal() {
            document.getElementById('editClientModal').classList.add('hidden');
            document.getElementById('editClientForm').reset();
        }

        document.getElementById('editClientForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const clientId = document.getElementById('editClientId').value;
            const fullName = document.getElementById('editClientName').value.trim();
            const email = document.getElementById('editClientEmail').value.trim();
            const phone = document.getElementById('editClientPhone').value.trim();
            
            if (!fullName || fullName.length < 3) { 
                showNotification('Nome deve ter pelo menos 3 caracteres!', 'error'); 
                return; 
            }
            if (!email || !email.includes('@')) { 
                showNotification('Email inválido!', 'error'); 
                return; 
            }
            if (!phone || phone.length < 10) { 
                showNotification('Telefone inválido!', 'error'); 
                return; 
            }
            
            try {
                await apiFetch(`/clients/${clientId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ full_name: fullName, email: email, phone: phone })
                });
                
                showNotification('Cliente atualizado com sucesso!', 'success');
                closeEditClientModal();
                loadClients();
                if (document.getElementById('dashboardContainer').classList.contains('active')) {
                    loadStats();
                    updateCharts();
                }
            } catch (error) {
                showNotification('Erro ao atualizar cliente: ' + error.message, 'error');
            }
        });

        async function deleteClient(clientId) {
            if (!(await customConfirm('Tem certeza que deseja excluir este cliente? Esta ação irá excluir todos os agendamentos associados e não pode ser desfeita!'))) return;
            
            try {
                await apiFetch(`/clients/${clientId}`, { method: 'DELETE' });
                
                showNotification('Cliente excluído com sucesso!', 'success');
                loadClients();
                if (document.getElementById('dashboardContainer').classList.contains('active')) {
                    loadStats();
                    updateCharts();
                }
            } catch (error) {
                showNotification('Erro ao excluir cliente: ' + error.message, 'error');
            }
        }

        async function loadScheduleSettings() {
            try {
                const data = await apiFetch('/settings');
                if (data) {
                    if (data.schedule_config) scheduleConfig = JSON.parse(data.schedule_config);
                    if (data.interval_time) document.getElementById('intervalTime').value = data.interval_time;
                }
                renderSchedule();
                loadBlockedDates();
            } catch (error) {
                console.error('Erro ao carregar configurações:', error);
                renderSchedule();
                loadBlockedDates();
            }
        }

        function renderSchedule() {
            const container = document.getElementById('dayScheduleContainer');
            container.innerHTML = Object.keys(scheduleConfig).map(day => {
                const dayNum = parseInt(day);
                const config = scheduleConfig[dayNum];
                return `
                    <div class="day-card ${config.active ? 'active' : ''}" id="day-${dayNum}">
                        <div class="day-header">
                            <h4>${dayNames[dayNum]}</h4>
                            <button class="day-toggle ${config.active ? 'active' : ''}" onclick="toggleDay(${dayNum})" aria-label="Alternar funcionamento ${dayNames[dayNum]}">
                                ${config.active ? '<i class="fas fa-check" aria-hidden="true"></i> Aberto' : '<i class="fas fa-times" aria-hidden="true"></i> Fechado'}
                            </button>
                        </div>
                        <div class="time-periods" id="periods-${dayNum}">
                            ${config.periods.map((period, index) => `
                                <div class="time-period">
                                    <input type="time" value="${period.start}" onchange="updatePeriod(${dayNum}, ${index}, 'start', this.value)" ${!config.active ? 'disabled' : ''} aria-label="Horário de início">
                                    <span style="color: var(--text-muted);">às</span>
                                    <input type="time" value="${period.end}" onchange="updatePeriod(${dayNum}, ${index}, 'end', this.value)" ${!config.active ? 'disabled' : ''}  onchange="updatePeriod(${dayNum}, ${index}, 'end', this.value)" ${!config.active ? 'disabled' : ''} aria-label="Horário de fim">
                                    <button onclick="removePeriod(${dayNum}, ${index})" ${!config.active ? 'disabled' : ''} aria-label="Remover período">
                                        <i class="fas fa-trash" aria-hidden="true"></i>
                                    </button>
                                </div>
                            `).join('')}
                        </div>
                        <button class="add-period-btn" onclick="addPeriod(${dayNum})" ${!config.active ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''} aria-label="Adicionar período ${dayNames[dayNum]}">
                            <i class="fas fa-plus" aria-hidden="true"></i> Adicionar Período
                        </button>
                    </div>
                `;
            }).join('');
        }

        function toggleDay(dayNum) {
            scheduleConfig[dayNum].active = !scheduleConfig[dayNum].active;
            if (scheduleConfig[dayNum].active && scheduleConfig[dayNum].periods.length === 0) {
                scheduleConfig[dayNum].periods.push({ start: '08:00', end: '18:00' });
            }
            renderSchedule();
        }

        function addPeriod(dayNum) {
            scheduleConfig[dayNum].periods.push({ start: '08:00', end: '18:00' });
            renderSchedule();
        }

        function removePeriod(dayNum, index) {
            if (scheduleConfig[dayNum].periods.length === 1) { 
                showNotification('Deve haver pelo menos um período de funcionamento!', 'warning'); 
                return; 
            }
            scheduleConfig[dayNum].periods.splice(index, 1);
            renderSchedule();
        }

        function updatePeriod(dayNum, index, field, value) {
            scheduleConfig[dayNum].periods[index][field] = value;
        }

        async function saveSchedule() {
            try {
                for (let day in scheduleConfig) {
                    if (scheduleConfig[day].active) {
                        for (let period of scheduleConfig[day].periods) {
                            const [startH, startM] = period.start.split(':').map(Number);
                            const [endH, endM] = period.end.split(':').map(Number);
                            const startMinutes = startH * 60 + startM;
                            const endMinutes = endH * 60 + endM;
                            
                            if (startMinutes >= endMinutes) { 
                                showNotification(`Erro no ${dayNames[day]}: O horário de início deve ser menor que o de término!`, 'error'); 
                                return; 
                            }
                            if (endMinutes - startMinutes < 30) { 
                                showNotification(`Erro no ${dayNames[day]}: Período muito curto (mínimo 30 minutos)!`, 'error'); 
                                return; 
                            }
                        }
                        
                        for (let i = 0; i < scheduleConfig[day].periods.length; i++) {
                            for (let j = i + 1; j < scheduleConfig[day].periods.length; j++) {
                                const period1 = scheduleConfig[day].periods[i];
                                const period2 = scheduleConfig[day].periods[j];
                                const [start1H, start1M] = period1.start.split(':').map(Number);
                                const [end1H, end1M] = period1.end.split(':').map(Number);
                                const [start2H, start2M] = period2.start.split(':').map(Number);
                                const [end2H, end2M] = period2.end.split(':').map(Number);
                                const start1 = start1H * 60 + start1M;
                                const end1 = end1H * 60 + end1M;
                                const start2 = start2H * 60 + start2M;
                                const end2 = end2H * 60 + end2M;
                                
                                if ((start1 < end2 && end1 > start2)) { 
                                    showNotification(`Erro no ${dayNames[day]}: Períodos com horários sobrepostos!`, 'error'); 
                                    return; 
                                }
                            }
                        }
                    }
                }
                
                const intervalTime = parseInt(document.getElementById('intervalTime').value);
                if (intervalTime < 15 || intervalTime > 120) { 
                    showNotification('Intervalo deve estar entre 15 e 120 minutos!', 'error'); 
                    return; 
                }
                
                await apiFetch('/settings', {
                    method: 'PUT',
                    body: JSON.stringify({ schedule_config: scheduleConfig, interval_time: intervalTime })
                });
                
                showNotification('Configurações salvas com sucesso!', 'success');
            } catch (error) {
                showNotification('Erro ao salvar configurações: ' + error.message, 'error');
            }
        }

        // ==================== Datas Bloqueadas (dias/turnos que a barbearia nao vai abrir) ====================
        function formatDateBR(dateStr) {
            const [y, m, d] = dateStr.split('-');
            return `${d}/${m}/${y}`;
        }

        const BLOCKED_PERIOD_LABELS = { '': 'Dia inteiro', manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };

        async function loadBlockedDates() {
            try {
                const data = await apiFetch('/settings/blocked-dates');
                const container = document.getElementById('blockedDatesList');

                if (!data || data.length === 0) {
                    container.innerHTML = '<div class="empty-state" style="padding: 20px;"><i class="fas fa-calendar-check" aria-hidden="true"></i><p>Nenhuma data bloqueada</p></div>';
                    return;
                }

                container.innerHTML = data.map(item => `
                    <div class="service-item">
                        <div class="service-info">
                            <h4>${formatDateBR(item.date)} • ${BLOCKED_PERIOD_LABELS[item.period || ''] || 'Dia inteiro'}</h4>
                            <p>${item.reason ? item.reason : 'Sem motivo informado'}</p>
                        </div>
                        <div class="service-actions">
                            <button class="btn-delete" onclick="removeBlockedDate(${item.id})" aria-label="Remover bloqueio de ${formatDateBR(item.date)}">
                                <i class="fas fa-trash" aria-hidden="true"></i> Remover
                            </button>
                        </div>
                    </div>
                `).join('');
            } catch (error) {
                console.error('Erro ao carregar datas bloqueadas:', error);
                showNotification('Erro ao carregar datas bloqueadas', 'error');
            }
        }

        async function addBlockedDate() {
            const dateInput = document.getElementById('blockedDateInput');
            const periodInput = document.getElementById('blockedDatePeriod');
            const reasonInput = document.getElementById('blockedDateReason');
            const date = dateInput.value;

            if (!date) {
                showNotification('Escolha uma data!', 'warning');
                return;
            }

            try {
                await apiFetch('/settings/blocked-dates', {
                    method: 'POST',
                    body: JSON.stringify({ date, period: periodInput.value, reason: reasonInput.value.trim() })
                });
                showNotification('Bloqueio salvo com sucesso!', 'success');
                dateInput.value = '';
                periodInput.value = '';
                reasonInput.value = '';
                loadBlockedDates();
            } catch (error) {
                showNotification('Erro ao bloquear: ' + error.message, 'error');
            }
        }

        async function removeBlockedDate(id) {
            if (!(await customConfirm('Remover esse bloqueio? O horário volta a aparecer disponível para os clientes.'))) return;
            try {
                await apiFetch(`/settings/blocked-dates/${id}`, { method: 'DELETE' });
                showNotification('Bloqueio removido.', 'info');
                loadBlockedDates();
            } catch (error) {
                showNotification('Erro ao remover bloqueio: ' + error.message, 'error');
            }
        }

        // ==================== WhatsApp (Evolution API) ====================
        let whatsappPollInterval = null;

        function setWhatsappStatusUI(status) {
            const badge = document.getElementById('whatsappStatusBadge');
            const text = document.getElementById('whatsappStatusText');
            const connectBtn = document.getElementById('whatsappConnectBtn');
            const disconnectBtn = document.getElementById('whatsappDisconnectBtn');
            const qrBox = document.getElementById('whatsappQrBox');

            if (status === 'connected') {
                badge.classList.remove('closed');
                badge.classList.add('open');
                text.textContent = 'Conectado';
                connectBtn.classList.add('hidden');
                disconnectBtn.classList.remove('hidden');
                qrBox.classList.add('hidden');
                if (whatsappPollInterval) { clearInterval(whatsappPollInterval); whatsappPollInterval = null; }
            } else if (status === 'connecting') {
                badge.classList.remove('open');
                badge.classList.add('closed');
                text.textContent = 'Aguardando leitura do QR code...';
                connectBtn.classList.add('hidden');
                disconnectBtn.classList.remove('hidden');
            } else {
                badge.classList.remove('open');
                badge.classList.add('closed');
                text.textContent = 'Desconectado';
                connectBtn.classList.remove('hidden');
                disconnectBtn.classList.add('hidden');
                qrBox.classList.add('hidden');
                if (whatsappPollInterval) { clearInterval(whatsappPollInterval); whatsappPollInterval = null; }
            }
        }

        async function refreshWhatsappStatus() {
            try {
                const data = await apiFetch('/whatsapp/status');
                setWhatsappStatusUI(data.status);
                if (data.warning) console.warn('WhatsApp:', data.warning);
                return data.status;
            } catch (error) {
                console.error('Erro ao verificar status do WhatsApp:', error);
                return 'disconnected';
            }
        }

        async function connectWhatsapp() {
            const btn = document.getElementById('whatsappConnectBtn');
            btn.disabled = true;
            try {
                const data = await apiFetch('/whatsapp/connect', { method: 'POST' });

                if (data.status === 'connected' && !data.qrcode_base64) {
                    setWhatsappStatusUI('connected');
                    showNotification('WhatsApp já está conectado!', 'success');
                    return;
                }

                if (!data.qrcode_base64) {
                    showNotification('Não recebemos o QR code da Evolution API. Tente novamente em instantes.', 'error');
                    return;
                }

                const img = document.getElementById('whatsappQrImage');
                img.src = data.qrcode_base64.startsWith('data:') ? data.qrcode_base64 : `data:image/png;base64,${data.qrcode_base64}`;
                document.getElementById('whatsappQrBox').classList.remove('hidden');
                setWhatsappStatusUI('connecting');

                if (whatsappPollInterval) clearInterval(whatsappPollInterval);
                whatsappPollInterval = setInterval(async () => {
                    const status = await refreshWhatsappStatus();
                    if (status === 'connected') {
                        showNotification('WhatsApp conectado com sucesso!', 'success');
                        return;
                    }
                    // Atualiza a imagem se o servidor gerou um QR novo (o antigo expira)
                    try {
                        const fresh = await apiFetch('/whatsapp/qr');
                        if (fresh.qrcode_base64) {
                            img.src = fresh.qrcode_base64.startsWith('data:') ? fresh.qrcode_base64 : `data:image/png;base64,${fresh.qrcode_base64}`;
                            document.getElementById('whatsappQrBox').classList.remove('hidden');
                        }
                    } catch (_) { /* segue tentando */ }
                }, 4000);
            } catch (error) {
                showNotification('Erro ao conectar WhatsApp: ' + error.message, 'error');
            } finally {
                btn.disabled = false;
            }
        }

        async function disconnectWhatsapp() {
            if (!(await customConfirm('Tem certeza que deseja desconectar o WhatsApp desta barbearia?'))) return;
            try {
                await apiFetch('/whatsapp/disconnect', { method: 'DELETE' });
                setWhatsappStatusUI('disconnected');
                showNotification('WhatsApp desconectado.', 'info');
            } catch (error) {
                showNotification('Erro ao desconectar: ' + error.message, 'error');
            }
        }

        async function loadWhatsappTemplate() {
            try {
                const data = await apiFetch('/whatsapp/template');
                document.getElementById('whatsappTemplate').value = data.template || '';
            } catch (error) {
                console.error('Erro ao carregar template do WhatsApp:', error);
            }
        }

        async function saveWhatsappTemplate() {
            const template = document.getElementById('whatsappTemplate').value.trim();
            try {
                await apiFetch('/whatsapp/template', { method: 'PUT', body: JSON.stringify({ template }) });
                showNotification('Mensagem salva com sucesso!', 'success');
            } catch (error) {
                showNotification('Erro ao salvar mensagem: ' + error.message, 'error');
            }
        }

        // ==================== Atendente IA no WhatsApp (plano PRO) ====================
        async function loadAiConfig() {
            try {
                const data = await apiFetch('/whatsapp/ai');
                const locked = document.getElementById('aiLockedBox');
                const box = document.getElementById('aiConfigBox');
                const warning = document.getElementById('aiWarning');

                if (!data.is_pro) {
                    locked.classList.remove('hidden');
                    box.classList.add('hidden');
                    return;
                }
                locked.classList.add('hidden');
                box.classList.remove('hidden');

                document.getElementById('aiEnabled').checked = !!data.config.enabled;
                document.getElementById('aiAssistantName').value = data.config.assistant_name || '';
                document.getElementById('aiExtraInstructions').value = data.config.extra_instructions || '';
                document.getElementById('aiButtonsEnabled').checked = !!data.config.buttons_enabled;
                document.getElementById('aiBackupText').checked = data.config.backup_text !== false;
                const isGo = data.provider === 'evogo';
                document.getElementById('aiChoiceFormat').value = data.config.choice_format || 'text';
                document.getElementById('aiCarouselNote').textContent = isGo
                    ? 'Botões e lista dependem do WhatsApp do cliente mostrar; enquete sempre aparece.'
                    : 'Na Evolution v2 botões e lista podem não aparecer; enquete sempre aparece.';

                const warnings = [];
                if (!data.openai_configured) warnings.push('A IA ainda não foi configurada no servidor (chave da OpenAI). Fale com o suporte.');
                if (data.whatsapp_status !== 'connected') warnings.push('Conecte o WhatsApp acima para a IA começar a atender.');
                warning.innerHTML = warnings.join('<br>');
                warning.classList.toggle('hidden', warnings.length === 0);
            } catch (error) {
                console.error('Erro ao carregar atendente IA:', error);
            }
        }

        async function saveAiConfig() {
            const body = {
                enabled: document.getElementById('aiEnabled').checked,
                assistant_name: document.getElementById('aiAssistantName').value.trim(),
                extra_instructions: document.getElementById('aiExtraInstructions').value.trim(),
                buttons_enabled: document.getElementById('aiButtonsEnabled').checked,
                choice_format: document.getElementById('aiChoiceFormat').value,
                backup_text: document.getElementById('aiBackupText').checked
            };
            try {
                const data = await apiFetch('/whatsapp/ai', { method: 'PUT', body: JSON.stringify(body) });
                if (String(data.webhook).startsWith('error')) {
                    showNotification('Salvo, mas não consegui ligar o recebimento de mensagens no WhatsApp. Reconecte o WhatsApp e salve de novo.', 'error');
                } else {
                    showNotification(body.enabled ? 'Atendente IA ativado!' : 'Atendente IA desativado.', 'success');
                }
                loadAiConfig();
            } catch (error) {
                showNotification('Erro ao salvar atendente IA: ' + error.message, 'error');
            }
        }

        // ==================== Lembrete de Agendamento (WhatsApp) ====================
        async function loadReminderConfig() {
            try {
                const config = await apiFetch('/settings/reminder');
                document.getElementById('reminderEnabled').checked = !!config.enabled;
                document.getElementById('reminderHoursBefore').value = String(config.hours_before);
                document.getElementById('reminderTemplate').value = config.template || '';
            } catch (error) {
                console.error('Erro ao carregar configuração de lembrete:', error);
            }
        }

        async function saveReminderConfig() {
            const enabled = document.getElementById('reminderEnabled').checked;
            const hours_before = document.getElementById('reminderHoursBefore').value;
            const template = document.getElementById('reminderTemplate').value.trim();

            try {
                await apiFetch('/settings/reminder', {
                    method: 'PUT',
                    body: JSON.stringify({ enabled, hours_before, template })
                });
                showNotification('Lembrete salvo com sucesso!', 'success');
            } catch (error) {
                showNotification('Erro ao salvar lembrete: ' + error.message, 'error');
            }
        }

        // Initialize Application

        if (getToken()) {
            apiFetch('/auth/me')
                .then(data => {
                    if (data.auth.role !== 'manager') {
                        clearToken();
                        return;
                    }
                    currentAdmin = { id: data.auth.sub, email: data.auth.email };
                    showAdminPanel();
                })
                .catch(() => {
                    clearToken();
                });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modal = document.querySelector('.modal:not(.hidden)');
                if (modal) {
                    modal.classList.add('hidden');
                }
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                if (e.target.classList.contains('stat-card')) {
                    e.preventDefault();
                    toggleStatCard(e.target);
                }
            }
        });
