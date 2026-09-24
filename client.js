        // Cada barbearia tem seu proprio link: seudominio.com/<slug-da-loja>
        const TENANT_SLUG = window.location.pathname.split('/').filter(Boolean)[0] || '';

        // Temas visuais disponiveis - o gestor escolhe qual usar no painel admin
        const THEMES = {
            ouro_negro: { vars: { '--ebony':'#0e0c0a', '--surface':'#18140f', '--surface-raised':'#211b14', '--hairline':'rgba(198,161,91,0.16)', '--brass':'#c6a15b', '--brass-light':'#e8c978', '--oxblood':'#7a2f3f', '--ivory':'#f2ede3', '--ivory-muted':'#a69c8c', '--green':'#6fae7a', '--red':'#c15c5c' } },
            meia_noite: { vars: { '--ebony':'#0a0e14', '--surface':'#121a24', '--surface-raised':'#1a2530', '--hairline':'rgba(148,180,209,0.16)', '--brass':'#6f9bc7', '--brass-light':'#a3c4e8', '--oxblood':'#35506b', '--ivory':'#eef2f6', '--ivory-muted':'#8b98a8', '--green':'#6fae8a', '--red':'#c1685c' } },
            esmeralda: { vars: { '--ebony':'#0a120e', '--surface':'#121c16', '--surface-raised':'#1a2921', '--hairline':'rgba(163,201,164,0.16)', '--brass':'#4f9d6e', '--brass-light':'#7ec49a', '--oxblood':'#8a6a2e', '--ivory':'#eef5ee', '--ivory-muted':'#93a898', '--green':'#6fae7a', '--red':'#c15c5c' } },
            grafite: { vars: { '--ebony':'#121212', '--surface':'#1c1c1c', '--surface-raised':'#262626', '--hairline':'rgba(200,150,110,0.16)', '--brass':'#c17d4f', '--brass-light':'#e0a877', '--oxblood':'#5c4a3a', '--ivory':'#f0ede8', '--ivory-muted':'#a3998e', '--green':'#6fae7a', '--red':'#c15c5c' } },
            marfim: { vars: { '--ebony':'#f5f0e6', '--surface':'#ffffff', '--surface-raised':'#ede6d8', '--hairline':'rgba(90,60,40,0.16)', '--brass':'#8a5a3a', '--brass-light':'#a97a52', '--oxblood':'#7a2f3f', '--ivory':'#2a2018', '--ivory-muted':'#6b5d4e', '--green':'#4a8a5a', '--red':'#a13f3f' } },
            vinho_tinto: { vars: { '--ebony':'#170a0c', '--surface':'#211116', '--surface-raised':'#2c161c', '--hairline':'rgba(200,140,140,0.16)', '--brass':'#c9a15c', '--brass-light':'#e8c978', '--oxblood':'#5c1a26', '--ivory':'#f5e9e6', '--ivory-muted':'#af9691', '--green':'#6fae7a', '--red':'#c15c5c' } },
            petroleo: { vars: { '--ebony':'#07141a', '--surface':'#0e232b', '--surface-raised':'#153039', '--hairline':'rgba(120,200,190,0.16)', '--brass':'#c97a4d', '--brass-light':'#e8a374', '--oxblood':'#1f4d54', '--ivory':'#eaf3f2', '--ivory-muted':'#89a3a2', '--green':'#6fae8a', '--red':'#c1685c' } },
            roxo_real: { vars: { '--ebony':'#120a18', '--surface':'#1c1024', '--surface-raised':'#28162f', '--hairline':'rgba(196,150,220,0.16)', '--brass':'#caa06a', '--brass-light':'#e8c48f', '--oxblood':'#4a2352', '--ivory':'#f3ecf6', '--ivory-muted':'#a595ab', '--green':'#6fae7a', '--red':'#c15c5c' } },
            preto_neon: { vars: { '--ebony':'#0a0a0a', '--surface':'#141414', '--surface-raised':'#1e1e1e', '--hairline':'rgba(80,255,170,0.18)', '--brass':'#39e6a0', '--brass-light':'#7dffc4', '--oxblood':'#2a2a2a', '--ivory':'#f0f0f0', '--ivory-muted':'#8f8f8f', '--green':'#39e6a0', '--red':'#ff5c7a' } },
            areia_dourada: { vars: { '--ebony':'#faf6ee', '--surface':'#ffffff', '--surface-raised':'#f2ead9', '--hairline':'rgba(150,110,50,0.18)', '--brass':'#b8863a', '--brass-light':'#d9a95c', '--oxblood':'#8a4a2e', '--ivory':'#2b2115', '--ivory-muted':'#7a6b54', '--green':'#4a8a5a', '--red':'#a13f3f' } },
            cinza_urbano: { vars: { '--ebony':'#f4f4f4', '--surface':'#ffffff', '--surface-raised':'#e9e9e9', '--hairline':'rgba(20,20,20,0.14)', '--brass':'#1c1c1c', '--brass-light':'#3a3a3a', '--oxblood':'#555555', '--ivory':'#1a1a1a', '--ivory-muted':'#6e6e6e', '--green':'#3f8f5a', '--red':'#b23a3a' } },
            azul_nautico: { vars: { '--ebony':'#f2f6fa', '--surface':'#ffffff', '--surface-raised':'#e4ecf4', '--hairline':'rgba(30,60,100,0.16)', '--brass':'#2f5d8a', '--brass-light':'#4f7fac', '--oxblood':'#1c3652', '--ivory':'#182430', '--ivory-muted':'#5c6e80', '--green':'#3f8f6a', '--red':'#b0474f' } },
            verde_salvia: { vars: { '--ebony':'#f4f7f1', '--surface':'#ffffff', '--surface-raised':'#e7eee2', '--hairline':'rgba(60,90,50,0.16)', '--brass':'#5c8a52', '--brass-light':'#7fab72', '--oxblood':'#3d5c38', '--ivory':'#22301f', '--ivory-muted':'#66765f', '--green':'#4a8a5a', '--red':'#a24a45' } },
            aurora: { vars: { '--ebony':'#120a1c', '--surface':'#181227', '--surface-raised':'#221a34', '--hairline':'rgba(140,200,190,0.16)', '--brass':'#6fd8c9', '--brass-light':'#9df0e0', '--oxblood':'#2a3d5c', '--ivory':'#eef6f4', '--ivory-muted':'#93a8a3', '--green':'#6fae8a', '--red':'#c1685c' }, bodyGradient: 'linear-gradient(165deg, #150a24 0%, #0d1f2e 50%, #0a231d 100%)' },
            por_do_sol: { vars: { '--ebony':'#1a0e10', '--surface':'#241318', '--surface-raised':'#301a20', '--hairline':'rgba(230,150,110,0.18)', '--brass':'#e8935a', '--brass-light':'#f5b47e', '--oxblood':'#7a2f3f', '--ivory':'#f7ece4', '--ivory-muted':'#b39a8e', '--green':'#6fae7a', '--red':'#e8615a' }, bodyGradient: 'linear-gradient(160deg, #23101c 0%, #4a1a1f 50%, #331206 100%)' },
            oceano_profundo: { vars: { '--ebony':'#04121c', '--surface':'#0a1e2c', '--surface-raised':'#102c3e', '--hairline':'rgba(110,180,220,0.18)', '--brass':'#4fa8d8', '--brass-light':'#7ecdf0', '--oxblood':'#123049', '--ivory':'#e8f4fb', '--ivory-muted':'#7d9aad', '--green':'#4fae8a', '--red':'#c1685c' }, bodyGradient: 'linear-gradient(165deg, #030d16 0%, #082234 50%, #04121c 100%)' },
            neon_cyber: { vars: { '--ebony':'#0c0616', '--surface':'#150a22', '--surface-raised':'#1e0f2e', '--hairline':'rgba(255,100,220,0.2)', '--brass':'#ff5fd1', '--brass-light':'#ff9fe4', '--oxblood':'#3a1a52', '--ivory':'#f5eefc', '--ivory-muted':'#9c8ab0', '--green':'#39e6a0', '--red':'#ff5c7a' }, bodyGradient: 'linear-gradient(165deg, #0c0616 0%, #1a0a2e 40%, #061224 75%, #0c0616 100%)' }
        };

        function applyTheme(themeKey) {
            const theme = THEMES[themeKey] || THEMES.ouro_negro;
            const root = document.documentElement;
            Object.entries(theme.vars).forEach(([key, value]) => root.style.setProperty(key, value));
            root.style.setProperty('--body-gradient', theme.bodyGradient || theme.vars['--ebony']);
        }
        const API_URL = `/api/public/${TENANT_SLUG}`;

        let currentUser = null; 
        let currentDate = new Date();
        let selectedService = null;
        let selectedBarber = null;
        let selectedDate = null;
        let selectedTime = null;
        let services = [];
        let packages = [];
        let barbers = [];
        let bookedSlots = {}; 
        let scheduleConfig = {};
        let intervalTime = 30;
        let blockedDates = new Map(); // data (YYYY-MM-DD) -> Set de turnos bloqueados ('' = dia inteiro, 'manha'|'tarde'|'noite')

        function getPeriodKey(hour) {
            if (hour < 12) return 'manha';
            if (hour < 18) return 'tarde';
            return 'noite';
        }

        // ==================== Tela de abertura (splash) ====================
        function enterApp() {
            document.getElementById('bottomNav').classList.remove('hidden');
            showScreen('home');
        }

        function enterAppAndOpenLookup() {
            enterApp();
            openLookup();
        }

        // ==================== Navegação entre telas (estilo app) ====================
        function showScreen(name) {
            document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
            const target = document.getElementById(`screen-${name}`);
            if (target) target.classList.remove('hidden');
            document.querySelectorAll('.nav-item').forEach(el => {
                el.classList.toggle('active', el.dataset.screen === name);
            });
            window.scrollTo({ top: 0, behavior: 'auto' });
        }

        function currentStep() {
            if (!selectedBarber) return 'barber';
            if (!selectedService) return 'service';
            return selectedDate ? 'time' : 'date';
        }

        function goToBookScreen() {
            showScreen('book');
            renderBarbers();
            renderServicesWizard();
            updateStepProgress(currentStep());
        }

        function updateStepProgress(activeStep) {
            const order = ['barber', 'service', 'date', 'time'];
            const activeIndex = order.indexOf(activeStep);
            document.querySelectorAll('#stepProgress .step-node').forEach(node => {
                const idx = order.indexOf(node.dataset.step);
                node.classList.remove('active', 'done');
                if (idx < activeIndex) node.classList.add('done');
                else if (idx === activeIndex) node.classList.add('active');
            });
        }

        // Função para formatar telefone
        function formatPhoneInput(inputElement) {
            if (!inputElement) return;
            inputElement.addEventListener('input', function(e) {
                let value = e.target.value.replace(/\D/g, '');
                
                if (value.length > 11) {
                    value = value.slice(0, 11);
                }
                
                if (value.length > 0) {
                    if (value.length <= 2) {
                        value = `(${value}`;
                    } else if (value.length <= 7) {
                        value = `(${value.slice(0, 2)}) ${value.slice(2)}`;
                    } else {
                        value = `(${value.slice(0, 2)}) ${value.slice(2, 7)}-${value.slice(7)}`;
                    }
                }
                
                e.target.value = value;
            });
        }
        
        formatPhoneInput(document.getElementById('bookingPhone'));
        
        // Funções utilitárias
        // Sempre calcula "agora" no fuso de Brasília, independente do fuso do aparelho do cliente
        function nowBR() {
            return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        }

        function isTimeSlotPassed(date, time) {
            const now = nowBR();
            const slotDateTime = new Date(date + 'T' + time);
            return slotDateTime <= now;
        }

        function formatDateToYYYYMMDD(date) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        function validatePhone(phone) {
            const cleaned = phone.replace(/\D/g, '');
            return cleaned.length === 11;
        }

        function formatPhoneToWhatsApp(phone) {
            let cleaned = phone.replace(/\D/g, '');
            
            if (cleaned.length !== 11) {
                return '';
            }
            
            return '55' + cleaned;
        }

        function sanitizeInput(input) {
            if (typeof input !== 'string') return input;
            return input.trim().substring(0, 255);
        }

        function updateStatusBadge() {
            const badges = [
                { badge: document.getElementById('statusBadge'), text: document.getElementById('statusText') },
                { badge: document.getElementById('statusBadgeProfile'), text: document.getElementById('statusTextProfile') }
            ].filter(pair => pair.badge && pair.text);

            const setState = (cls, message) => {
                badges.forEach(({ badge, text }) => {
                    badge.classList.remove('open', 'closed');
                    badge.classList.add(cls);
                    text.textContent = message;
                });
            };

            const now = nowBR();
            const currentDay = now.getDay();

            if (!scheduleConfig[currentDay] || !scheduleConfig[currentDay].active) {
                setState('closed', 'Fechado • Não abre hoje');
                return;
            }

            const currentTime = now.getHours() * 60 + now.getMinutes();
            let nextPeriod = null;

            for (let period of scheduleConfig[currentDay].periods) {
                const [startHour, startMin] = period.start.split(':').map(Number);
                const [endHour, endMin] = period.end.split(':').map(Number);
                const startMinutes = startHour * 60 + startMin;
                const endMinutes = endHour * 60 + endMin;

                if (currentTime >= startMinutes && currentTime < endMinutes) {
                    setState('open', `Aberto • ${period.start} - ${period.end}`);
                    return;
                }

                if (currentTime < startMinutes && !nextPeriod) {
                    nextPeriod = period;
                }
            }

            setState('closed', nextPeriod ? `Fechado • Abre às ${nextPeriod.start}` : 'Fechado • Abre amanhã');
        }

        function closeModal() {
            document.getElementById('confirmationModal').classList.add('hidden');
            showScreen('home');
        }

        function closeModalAndOpenLookup() {
            document.getElementById('confirmationModal').classList.add('hidden');
            showScreen('home');
            openLookup();
        }

        // ==================== Instalar app (PWA) ====================
        let deferredInstallPrompt = null;

        function setupPWA() {
            // manifesto dinamico com nome/logo/cores da barbearia
            const manifestLink = document.createElement('link');
            manifestLink.rel = 'manifest';
            manifestLink.href = `${API_URL}/manifest.json`;
            document.head.appendChild(manifestLink);

            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/sw.js').catch(() => {});
            }

            const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
            if (isStandalone) return; // ja instalado, nao precisa oferecer de novo

            const dismissKey = 'installBannerDismissed_' + TENANT_SLUG;
            if (localStorage.getItem(dismissKey)) return;

            window.addEventListener('beforeinstallprompt', (e) => {
                e.preventDefault();
                deferredInstallPrompt = e;
                showInstallBanner(false);
            });

            window.addEventListener('appinstalled', () => {
                hideInstallBanner();
                localStorage.setItem(dismissKey, '1');
            });

            const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
            if (isIOS) {
                // iOS nao dispara beforeinstallprompt - so da pra orientar a instalar manualmente
                showInstallBanner(true);
            }
        }

        function showInstallBanner(isIOSInstructions) {
            const banner = document.getElementById('installBanner');
            if (!banner) return;
            banner.dataset.ios = isIOSInstructions ? '1' : '0';
            banner.classList.remove('hidden');
        }

        function hideInstallBanner() {
            const banner = document.getElementById('installBanner');
            if (banner) banner.classList.add('hidden');
        }

        function dismissInstallBanner() {
            hideInstallBanner();
            localStorage.setItem('installBannerDismissed_' + TENANT_SLUG, '1');
        }

        async function handleInstallClick() {
            const banner = document.getElementById('installBanner');
            if (banner && banner.dataset.ios === '1') {
                document.getElementById('iosInstallModal').classList.remove('hidden');
                return;
            }
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            const choice = await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
            hideInstallBanner();
            if (choice.outcome === 'accepted') {
                localStorage.setItem('installBannerDismissed_' + TENANT_SLUG, '1');
            }
        }

        function closeIOSInstallModal() {
            document.getElementById('iosInstallModal').classList.add('hidden');
        }

        async function initializeApp() {
            if (!TENANT_SLUG) {
                showTenantError('Link inválido. Peça o link correto da sua barbearia.');
                return;
            }

            setupPWA();

            try {
                const infoResponse = await fetch(`${API_URL}/info`);
                if (!infoResponse.ok) {
                    const err = await infoResponse.json().catch(() => ({}));
                    showTenantError(err.error || 'Não foi possível carregar esta barbearia.');
                    return;
                }
                const info = await infoResponse.json();
                document.title = `${info.name} - Agendamento`;
                const nameEl = document.getElementById('shopNameHeading');
                if (nameEl) nameEl.textContent = info.name;
                const profileNameEl = document.getElementById('profileShopName');
                if (profileNameEl) profileNameEl.textContent = info.name;
                const splashNameEl = document.getElementById('splashShopName');
                if (splashNameEl) splashNameEl.textContent = info.name;
            } catch (error) {
                showTenantError('Não foi possível conectar ao servidor. Tente novamente em instantes.');
                return;
            }

            await loadSettings();
            await loadServices();
            await loadPackages();
            await loadBarbers();
            renderCalendar();
            updateStatusBadge();
            setInterval(updateStatusBadge, 60000);
            
            document.getElementById('unverifiedUserFields').classList.remove('hidden'); 
        }

        function showTenantError(message) {
            document.body.innerHTML = `
                <div style="display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; text-align:center;">
                    <div>
                        <i class="fas fa-store-slash" style="font-size:48px; color:var(--brass-light); margin-bottom:16px;"></i>
                        <p style="font-size:18px; color:var(--ivory);">${message}</p>
                    </div>
                </div>
            `;
        }
        
        // Monta um carrossel de imagens de fundo (capa) que troca sozinho a cada 5 segundos.
        // Funciona tanto com 1 imagem só (sem troca) quanto com até 5 imagens.
        function setupBannerCarousel(container, images) {
            if (!container) return;
            if (container._carouselTimer) clearInterval(container._carouselTimer);
            container.innerHTML = '';
            const slides = (images || []).filter(Boolean).slice(0, 5);
            if (!slides.length) return;

            slides.forEach((url, i) => {
                const slide = document.createElement('div');
                slide.className = 'banner-slide' + (i === 0 ? ' active' : '');
                slide.style.backgroundImage = `url('${url}')`;
                container.appendChild(slide);
            });
            container.classList.add('loaded');

            if (slides.length > 1) {
                let idx = 0;
                container._carouselTimer = setInterval(() => {
                    const els = container.querySelectorAll('.banner-slide');
                    if (!els.length) return;
                    els[idx].classList.remove('active');
                    idx = (idx + 1) % els.length;
                    els[idx].classList.add('active');
                }, 5000);
            }
        }

        async function loadSettings() {
            try {
                const response = await fetch(`${API_URL}/settings`);
                const data = await response.json();

                if (data.schedule_config) scheduleConfig = JSON.parse(data.schedule_config);
                if (data.interval_time) intervalTime = parseInt(data.interval_time);
                if (Array.isArray(data.blocked_dates)) {
                    blockedDates = new Map();
                    data.blocked_dates.forEach(b => {
                        if (!blockedDates.has(b.date)) blockedDates.set(b.date, new Set());
                        blockedDates.get(b.date).add(b.period || '');
                    });
                }

                applyTheme(data.theme);

                let coverImages = [];
                if (data.cover_images) {
                    try { coverImages = JSON.parse(data.cover_images); } catch (_) { coverImages = []; }
                }
                if (!coverImages.length && data.banner_url) coverImages = [data.banner_url];
                if (coverImages.length) {
                    setupBannerCarousel(document.getElementById('heroBanner'), coverImages);
                    setupBannerCarousel(document.getElementById('splashBanner'), coverImages);
                }
                if (data.logo_url) {
                    document.getElementById('barberPhoto').innerHTML = `<img src="${data.logo_url}" alt="Logo da barbearia">`;
                    const splashCrest = document.getElementById('splashCrest');
                    if (splashCrest) splashCrest.innerHTML = `<img src="${data.logo_url}" alt="Logo da barbearia">`;
                }
                if (data.tagline) {
                    document.getElementById('heroTagline').textContent = data.tagline;
                    const splashTagline = document.getElementById('splashTagline');
                    if (splashTagline) splashTagline.textContent = data.tagline;
                }

                if (data.gallery) {
                    try { renderGallery(JSON.parse(data.gallery)); } catch (_) {}
                }

                if (data.shop_profile) {
                    try { renderShopProfile(JSON.parse(data.shop_profile)); } catch (_) {}
                }

                updateStatusBadge();
            } catch (error) {
                console.error('Erro ao carregar configurações:', error);
            }
        }

        // ==================== Galeria de fotos ====================
        function renderGallery(photos) {
            if (!photos || !photos.length) return;
            const carousel = document.getElementById('galleryCarousel');
            const track = document.getElementById('galleryTrack');
            const dots = document.getElementById('galleryDots');

            track.innerHTML = photos.map((url, i) => `<img src="${url}" alt="Foto da barbearia" style="animation-delay:${i * 0.06}s">`).join('');
            dots.innerHTML = photos.map((_, i) => `<span class="${i === 0 ? 'active' : ''}"></span>`).join('');
            carousel.classList.remove('hidden');
        }

        function galleryScroll(direction) {
            const track = document.getElementById('galleryTrack');
            track.scrollBy({ left: direction * 260, behavior: 'smooth' });
        }

        // ==================== Perfil / Sobre a barbearia ====================
        const AMENITY_LABELS = {
            wifi: { icon: 'fa-wifi', label: 'Wi-Fi' },
            parking: { icon: 'fa-car', label: 'Estacionamento' },
            accessible: { icon: 'fa-wheelchair', label: 'Acessível' },
            pets: { icon: 'fa-paw', label: 'Aceita pets' }
        };
        const PAYMENT_LABELS = {
            dinheiro: 'Dinheiro', pix: 'Pix', cartao_credito: 'Cartão de Crédito', cartao_debito: 'Cartão de Débito'
        };

        function renderShopProfile(profile) {
            const activeAmenities = Object.entries(profile.amenities || {}).filter(([, v]) => v);
            if (activeAmenities.length) {
                document.getElementById('amenitiesRow').innerHTML = activeAmenities.map(([key]) => {
                    const meta = AMENITY_LABELS[key];
                    return meta ? `<span class="amenity"><i class="fas ${meta.icon}" aria-hidden="true"></i> ${meta.label}</span>` : '';
                }).join('');
            }
            document.getElementById('amenitiesSection').classList.remove('hidden');

            let hasContactContent = false;

            if (profile.address) {
                hasContactContent = true;
                document.getElementById('addressText').textContent = profile.address;
                document.getElementById('addressBlock').classList.remove('hidden');
            }

            if (profile.payment_methods && profile.payment_methods.length) {
                hasContactContent = true;
                document.getElementById('paymentText').innerHTML = profile.payment_methods
                    .map(p => `<span class="payment-pill">${PAYMENT_LABELS[p] || p}</span>`).join('');
                document.getElementById('paymentBlock').classList.remove('hidden');
            }

            const social = profile.social || {};

            // Icones no topo (hero) - so WhatsApp e Instagram, pra acesso rapido
            const heroIcons = [];
            if (social.whatsapp) heroIcons.push(`<a href="${social.whatsapp}" target="_blank" rel="noopener" aria-label="WhatsApp"><i class="fab fa-whatsapp"></i></a>`);
            if (social.instagram) heroIcons.push(`<a href="${social.instagram}" target="_blank" rel="noopener" aria-label="Instagram"><i class="fab fa-instagram"></i></a>`);
            if (heroIcons.length) {
                document.getElementById('heroSocialRow').innerHTML = heroIcons.join('');
                document.getElementById('heroSocialRow').classList.remove('hidden');
            }

            const socialIcons = [];
            if (social.whatsapp) socialIcons.push(`<a href="${social.whatsapp}" target="_blank" rel="noopener" class="social-icon-link" aria-label="WhatsApp"><i class="fab fa-whatsapp"></i></a>`);
            if (social.instagram) socialIcons.push(`<a href="${social.instagram}" target="_blank" rel="noopener" class="social-icon-link" aria-label="Instagram"><i class="fab fa-instagram"></i></a>`);
            if (social.facebook) socialIcons.push(`<a href="${social.facebook}" target="_blank" rel="noopener" class="social-icon-link" aria-label="Facebook"><i class="fab fa-facebook"></i></a>`);
            if (socialIcons.length) {
                hasContactContent = true;
                document.getElementById('socialLinks').innerHTML = socialIcons.join('');
                document.getElementById('socialBlock').classList.remove('hidden');
            }

            if (profile.phone) {
                hasContactContent = true;
                document.getElementById('phoneText').textContent = profile.phone;
                document.getElementById('phoneBlock').classList.remove('hidden');
            }

            if (hasContactContent) document.getElementById('shopProfileSection').classList.remove('hidden');
        }

        // Consulta de agendamentos pelo telefone (sem precisar de login)
        function openLookup() {
            document.getElementById('lookupModal').classList.remove('hidden');
            document.getElementById('lookupResults').innerHTML = '';
        }
        function closeLookup() {
            document.getElementById('lookupModal').classList.add('hidden');
        }
        let lookupPhoneCache = '';

        async function fetchLoyaltyStatus(phone) {
            const box = document.getElementById('loyaltyProgressBox');
            box.innerHTML = '';
            try {
                const response = await fetch(`${API_URL}/loyalty/status?phone=${encodeURIComponent(phone)}`);
                const status = await response.json();
                if (!status.enabled) return;

                const unit = status.mode === 'points' ? 'pontos' : 'visitas';
                const pct = Math.min(100, (status.progress / status.threshold) * 100);

                box.innerHTML = `
                    <div style="border:1px solid var(--brass); border-radius:10px; padding:14px 16px; margin-bottom:14px; background:rgba(198,161,91,0.06);">
                        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12.5px; margin-bottom:8px;">
                            <span><i class="fas fa-gift" aria-hidden="true" style="color:var(--brass);"></i> Fidelidade</span>
                            <span style="color:var(--brass-light); font-weight:700;">${status.progress}/${status.threshold} ${unit}</span>
                        </div>
                        <div style="height:6px; border-radius:100px; background:var(--surface-raised); overflow:hidden;">
                            <div style="height:100%; width:${pct}%; background:linear-gradient(90deg, var(--brass), var(--brass-light)); transition: width 0.5s ease;"></div>
                        </div>
                        <p style="font-size:12px; color:var(--ivory-muted); margin-top:8px;">
                            ${status.ready ? `🎉 Você já pode resgatar: ${status.reward_description}! Vale no próximo agendamento.` : `Faltam ${status.remaining} ${unit} para: ${status.reward_description}`}
                        </p>
                    </div>
                `;
            } catch (error) {
                console.error('Erro ao carregar fidelidade:', error);
            }
        }

        async function searchMyBookings() {
            const phoneInput = document.getElementById('lookupPhone');
            const resultsEl = document.getElementById('lookupResults');
            const phone = phoneInput.value.replace(/\D/g, '');
            lookupPhoneCache = phone;

            if (phone.length < 10) {
                resultsEl.innerHTML = '<p style="color:var(--red); font-size:13px;">Digite um telefone válido (DDD + número).</p>';
                return;
            }

            resultsEl.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';

            // Progresso de fidelidade (se a barbearia tiver o programa ativado)
            fetchLoyaltyStatus(phone);

            try {
                const response = await fetch(`${API_URL}/bookings/lookup?phone=${encodeURIComponent(phone)}`);
                const bookings = await response.json();

                if (!bookings.length) {
                    resultsEl.innerHTML = '<p style="color:var(--ivory-muted); font-size:13.5px; text-align:center; padding:20px 0;">Nenhum agendamento encontrado com esse telefone.</p>';
                    return;
                }

                const statusLabel = { confirmed: 'Confirmado', completed: 'Concluído', cancelled: 'Cancelado', pending: 'Pendente' };
                const statusColor = { confirmed: 'var(--green)', completed: 'var(--brass-light)', cancelled: 'var(--red)', pending: 'var(--ivory-muted)' };

                resultsEl.innerHTML = bookings.map((b, i) => `
                    <div style="border:1px solid var(--hairline); border-radius:10px; padding:14px 16px; margin-bottom:10px; animation: cardIn 0.35s ease ${i * 0.05}s both;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <strong style="font-family:'Fraunces',serif; font-size:15px;">${b.service_name || 'Serviço'}</strong>
                            <span style="font-size:11px; font-weight:700; color:${statusColor[b.status] || 'var(--ivory-muted)'};">${statusLabel[b.status] || b.status}</span>
                        </div>
                        <p style="font-size:13px; color:var(--ivory-muted);">
                            <i class="fas fa-calendar" aria-hidden="true"></i> ${b.booking_date.split('-').reverse().join('/')}
                            &nbsp;•&nbsp; <i class="fas fa-clock" aria-hidden="true"></i> ${b.booking_time.substring(0,5)}
                            ${b.barber_name ? `&nbsp;•&nbsp; <i class="fas fa-user-tie" aria-hidden="true"></i> ${b.barber_name}` : ''}
                        </p>
                        ${b.cancel_requested ? `
                            <p style="margin-top:8px; font-size:12.5px; color:var(--red);"><i class="fas fa-hourglass-half" aria-hidden="true"></i> Cancelamento solicitado — aguardando a confirmação da barbearia</p>
                        ` : b.can_cancel ? `
                            <div id="cancelBox-${b.id}">
                                <button class="btn" style="margin-top:10px; padding:9px; background:transparent; border:1px solid var(--red); color:var(--red);" onclick="openCancelRequest(${b.id})">
                                    <i class="fas fa-ban" aria-hidden="true"></i> Solicitar cancelamento
                                </button>
                            </div>
                        ` : ''}
                        ${b.can_review ? `
                            <button class="btn" style="margin-top:10px; padding:9px;" onclick="openReviewModal(${b.id}, '${(b.service_name || '').replace(/'/g, "\\'")}')">
                                <i class="fas fa-star" aria-hidden="true"></i> Avaliar atendimento
                            </button>
                        ` : b.has_review ? `
                            <p style="margin-top:8px; font-size:12px; color:var(--brass-light);"><i class="fas fa-check" aria-hidden="true"></i> Você já avaliou este atendimento</p>
                        ` : ''}
                    </div>
                `).join('');
            } catch (error) {
                resultsEl.innerHTML = '<p style="color:var(--red); font-size:13px;">Erro ao buscar agendamentos. Tente novamente.</p>';
            }
        }

        // ==================== Pedido de cancelamento (o gestor confirma no painel) ====================
        function openCancelRequest(bookingId) {
            const box = document.getElementById(`cancelBox-${bookingId}`);
            if (!box) return;
            box.innerHTML = `
                <div style="margin-top:10px; padding:12px; border:1px solid var(--red); border-radius:10px;">
                    <p style="font-size:13px; margin-bottom:8px;">Quer mesmo cancelar? A barbearia recebe seu pedido no WhatsApp e confirma o cancelamento.</p>
                    <textarea id="cancelReason-${bookingId}" rows="2" maxlength="300" placeholder="Motivo (opcional)" style="width:100%; padding:10px; border-radius:8px; background:var(--surface-raised); color:var(--ivory); border:1px solid var(--hairline); font-family:inherit; resize:vertical;"></textarea>
                    <div style="display:flex; gap:8px; margin-top:8px;">
                        <button class="btn" style="padding:9px; background:var(--red); border-color:var(--red);" onclick="sendCancelRequest(${bookingId})">Confirmar pedido</button>
                        <button class="btn" style="padding:9px; background:transparent; border:1px solid var(--hairline); color:var(--ivory);" onclick="searchMyBookings()">Voltar</button>
                    </div>
                </div>`;
        }

        async function sendCancelRequest(bookingId) {
            const reason = (document.getElementById(`cancelReason-${bookingId}`)?.value || '').trim();
            try {
                const response = await fetch(`${API_URL}/bookings/${bookingId}/cancel-request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: lookupPhoneCache, reason })
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || 'Não foi possível enviar o pedido');
                await searchMyBookings();
                alert('Pedido de cancelamento enviado! A barbearia vai confirmar e você recebe o aviso no WhatsApp.');
            } catch (error) {
                alert(error.message);
            }
        }

        // ==================== Avaliação (só liberada após atendimento concluído) ====================
        let reviewBookingId = null;
        let reviewRating = 0;

        function openReviewModal(bookingId, serviceName) {
            reviewBookingId = bookingId;
            reviewRating = 0;
            document.getElementById('reviewServiceName').textContent = serviceName || '';
            document.getElementById('reviewComment').value = '';
            document.querySelectorAll('.star-input').forEach(s => { s.className = 'far fa-star star-input'; });
            document.getElementById('reviewModal').classList.remove('hidden');
        }

        function closeReviewModal() {
            document.getElementById('reviewModal').classList.add('hidden');
        }

        document.querySelectorAll('.star-input').forEach(star => {
            star.addEventListener('click', () => {
                reviewRating = parseInt(star.dataset.value);
                document.querySelectorAll('.star-input').forEach(s => {
                    const val = parseInt(s.dataset.value);
                    s.className = val <= reviewRating ? 'fas fa-star star-input active' : 'far fa-star star-input';
                });
            });
        });

        async function submitReview() {
            const errorEl = document.getElementById('reviewError');
            errorEl.textContent = '';

            if (!reviewRating) {
                errorEl.textContent = 'Escolha de 1 a 5 estrelas antes de enviar.';
                return;
            }

            try {
                const response = await fetch(`${API_URL}/bookings/${reviewBookingId}/review`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        phone: lookupPhoneCache,
                        rating: reviewRating,
                        comment: document.getElementById('reviewComment').value.trim()
                    })
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.error || 'Erro ao enviar avaliação');
                }

                closeReviewModal();
                searchMyBookings();
            } catch (error) {
                errorEl.textContent = error.message;
            }
        }
        
        async function loadServices() {
            try {
                const container = document.getElementById('servicesList');
                container.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

                const response = await fetch(`${API_URL}/services`);
                if (!response.ok) throw new Error('Falha ao carregar serviços');

                services = await response.json();
                renderServices();
            } catch (error) {
                console.error('Erro ao carregar serviços:', error);
            }
        }

        async function loadPackages() {
            try {
                const response = await fetch(`${API_URL}/packages`);
                if (!response.ok) return;
                packages = await response.json();
                renderServices();
            } catch (error) {
                console.error('Erro ao carregar pacotes:', error);
            }
        }

        async function loadBarbers() {
            try {
                const response = await fetch(`${API_URL}/barbers`);
                if (!response.ok) throw new Error('Falha ao carregar barbeiros');

                barbers = await response.json();
                renderBarbers(); // passo 1 do agendamento: ja mostra os profissionais
            } catch (error) {
                console.error('Erro ao carregar barbeiros:', error);
            }
        }

        function renderServices() {
            renderServicesWizard();
            renderServicesPreview();
            renderServicesFullList();
        }

        function isSelected(id, isPackage) {
            return !!(selectedService && selectedService.id === id && !!selectedService.isPackage === !!isPackage);
        }

        // Servicos (e pacotes) que o profissional escolhido faz. Sem profissional = todos.
        function barberAllowedIds() {
            return selectedBarber && Array.isArray(selectedBarber.service_ids) ? selectedBarber.service_ids.map(Number) : null;
        }
        function servicesForBarber() {
            const allowed = barberAllowedIds();
            return allowed ? services.filter(sv => allowed.includes(Number(sv.id))) : services;
        }
        function packagesForBarber() {
            const allowed = barberAllowedIds();
            return allowed ? packages.filter(pkg => (pkg.services || []).every(sv => allowed.includes(Number(sv.id)))) : packages;
        }

        function renderServicesWizard() {
            const container = document.getElementById('servicesList');
            if (!container) return;

            const hint = document.getElementById('serviceCardHint');
            if (hint) hint.textContent = selectedBarber ? `Serviços feitos por ${selectedBarber.name}` : '';

            const services = servicesForBarber();
            const packages = packagesForBarber();

            if (services.length === 0 && packages.length === 0) {
                container.innerHTML = `<p style="color: var(--ivory-muted); text-align: center;">${selectedBarber ? 'Este profissional ainda não tem serviços disponíveis.' : 'Nenhum serviço disponível'}</p>`;
                return;
            }

            const packagesHtml = packages.map(pkg => `
                <div class="service-item ${isSelected(pkg.id, true) ? 'selected' : ''}" onclick="selectPackage(${pkg.id})" style="border-color: rgba(198,161,91,0.35);">
                    <div class="service-info">
                        <h4><i class="fas fa-box-open"></i> ${pkg.name} <span style="font-size:10px; background:var(--brass); color:var(--ebony); padding:2px 8px; border-radius:100px; font-weight:700; margin-left:6px;">PACOTE</span></h4>
                        <p><i class="fas fa-clock"></i> ${pkg.total_duration} minutos • ${pkg.services.map(s => s.name).join(' + ')}</p>
                    </div>
                    <div class="service-price">R$ ${pkg.price.toFixed(2)}</div>
                </div>
            `).join('');

            // Cada serviço aparece em círculo, em carrossel horizontal (com foto do corte, se enviada)
            const servicesHtml = services.length ? `<div class="services-carousel" style="margin-top: ${packages.length ? '14px' : '0'};">` + services.map(service => `
                <div class="barber-item ${isSelected(service.id, false) ? 'selected' : ''}" onclick="selectService(${service.id})">
                    <div class="barber-photo-circle">
                        ${service.photo_url ? `<img src="${service.photo_url}" alt="${service.name}">` : '<i class="fas fa-scissors"></i>'}
                    </div>
                    <div class="barber-name">${service.name}</div>
                    <div class="barber-specialty">R$ ${service.price.toFixed(2)} · ${service.duration}min</div>
                </div>
            `).join('') + `</div>` : '';

            container.innerHTML = packagesHtml + servicesHtml;
        }

        function renderServicesPreview() {
            const strip = document.getElementById('servicesPreviewStrip');
            if (!strip) return;
            if (!services.length && !packages.length) { strip.innerHTML = ''; return; }

            const items = [...packages.map(p => ({ ...p, isPackage: true })), ...services].slice(0, 8);
            strip.innerHTML = items.map(item => `
                <div class="service-thumb-card" onclick="${item.isPackage ? `selectPackage(${item.id})` : `selectService(${item.id})`}">
                    <div class="service-thumb-photo">
                        ${item.photo_url ? `<img src="${item.photo_url}" alt="${item.name}">` : `<i class="fas ${item.isPackage ? 'fa-box-open' : 'fa-scissors'}"></i>`}
                    </div>
                    <div class="name">${item.name}</div>
                    <div class="price">A partir de R$ ${item.price.toFixed(2)}</div>
                </div>
            `).join('');
        }

        function renderServicesFullList() {
            const list = document.getElementById('servicesFullList');
            if (!list) return;
            if (!services.length && !packages.length) {
                list.innerHTML = '<p style="color: var(--ivory-muted); text-align: center; padding: 30px 0;">Nenhum serviço disponível</p>';
                return;
            }

            const packagesHtml = packages.map(pkg => `
                <div class="service-row-card" onclick="selectPackage(${pkg.id})">
                    <div class="service-row-photo"><i class="fas fa-box-open"></i></div>
                    <div class="service-row-content">
                        <h4>${pkg.name} <span class="pkg-badge">PACOTE</span></h4>
                        <p>${pkg.services.map(s => s.name).join(' + ')} · ${pkg.total_duration}min</p>
                        <div class="price">A partir de R$ ${pkg.price.toFixed(2)}</div>
                    </div>
                    <i class="fas fa-chevron-right"></i>
                </div>
            `).join('');

            const servicesHtml = services.map(service => `
                <div class="service-row-card" onclick="selectService(${service.id})">
                    <div class="service-row-photo">
                        ${service.photo_url ? `<img src="${service.photo_url}" alt="${service.name}">` : '<i class="fas fa-scissors"></i>'}
                    </div>
                    <div class="service-row-content">
                        <h4>${service.name}</h4>
                        <p>${service.duration} minutos</p>
                        <div class="price">A partir de R$ ${service.price.toFixed(2)}</div>
                    </div>
                    <i class="fas fa-chevron-right"></i>
                </div>
            `).join('');

            list.innerHTML = packagesHtml + servicesHtml;
        }

        function selectPackage(id) {
            const pkg = packages.find(p => p.id === id);
            if (!pkg) return;
            selectService(id, { ...pkg, duration: pkg.total_duration, isPackage: true });
        }

        // Ids dos servicos que o item escolhido exige (servico avulso ou todos os do pacote)
        function requiredServiceIds() {
            if (!selectedService) return [];
            if (selectedService.isPackage) return (selectedService.services || []).map(sv => Number(sv.id));
            return [Number(selectedService.id)];
        }

        // Barbeiros que fazem o servico escolhido (service_ids null = faz todos)
        function barbersForSelection() {
            const needed = requiredServiceIds();
            return barbers.filter(b => !Array.isArray(b.service_ids) || needed.every(id => b.service_ids.includes(id)));
        }

        function renderBarbers() {
            const container = document.getElementById('barbersList');
            
            if (barbers.length === 0) {
                container.innerHTML = '<p style="color: var(--ivory-muted); text-align: center;">Nenhum barbeiro disponível. Cadastre um barbeiro no painel Admin.</p>';
                return;
            }

            const available = barbersForSelection();
            if (available.length === 0) {
                container.innerHTML = '<p style="color: var(--ivory-muted); text-align: center;">Nenhum profissional faz esse serviço no momento. Escolha outro serviço.</p>';
                return;
            }

            container.innerHTML = available.map(barber => {
                const photoHtml = barber.photo_url 
                    ? `<img src="${barber.photo_url}" alt="${barber.name}">` 
                    : '<i class="fas fa-user-tie"></i>';
                
                const barberIdString = barber.id;
                
                const isSelected = selectedBarber && selectedBarber.id == barberIdString;
                
                return `
                    <div class="barber-item ${isSelected ? 'selected' : ''}" 
                         data-barber-id="${barberIdString}"
                         onclick="selectBarber('${barberIdString}')">
                        <div class="barber-photo-circle">
                            ${photoHtml}
                        </div>
                        <div class="barber-name">${barber.name}</div>
                        <div class="barber-specialty">${barber.specialty || 'Barbeiro'}</div>
                    </div>
                `;
            }).join('');
        }

        function selectService(id, overrideItem) {
            selectedService = overrideItem || services.find(s => s.id === id);

            // Se o profissional ja escolhido nao faz este servico, ele precisa escolher de novo
            if (selectedBarber && !barbersForSelection().some(b => b.id == selectedBarber.id)) selectedBarber = null;
            selectedDate = null;
            selectedTime = null;

            showScreen('book');

            const serviceCard = document.getElementById('serviceCard');
            serviceCard.classList.add('completed');
            serviceCard.classList.remove('active');
            renderServicesWizard();
            renderBarbers();

            if (selectedBarber) {
                // Profissional ja escolhido: segue para data e horario
                const scheduleCard = document.getElementById('scheduleCard');
                scheduleCard.classList.add('active');
                updateStepProgress('date');
                setTimeout(() => scheduleCard.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
            } else {
                // Veio pelo servico (tela inicial): agora escolhe quem faz esse servico
                const barberCard = document.getElementById('barberCard');
                barberCard.classList.add('active');
                barberCard.classList.remove('completed');
                updateStepProgress('barber');
                setTimeout(() => barberCard.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
            }

            renderCalendar();
            document.getElementById('confirmBooking').classList.add('hidden');
        }

        function selectBarber(id) {
            const barberId = id;
            selectedBarber = barbers.find(b => b.id == barberId);
            
            document.querySelectorAll('.barber-item').forEach(el => el.classList.remove('selected'));
            
            const targetElement = document.querySelector(`.barber-item[data-barber-id="${barberId}"]`);
            if (targetElement) {
                targetElement.classList.add('selected');
            }
            
            selectedDate = null;
            selectedTime = null;

            // Servico escolhido antes que este profissional nao faz: escolhe de novo
            if (selectedService) {
                const allowed = barberAllowedIds();
                const needed = requiredServiceIds();
                if (allowed && !needed.every(sid => allowed.includes(sid))) selectedService = null;
            }

            // Marca o card do barbeiro como completo
            const barberCard = document.getElementById('barberCard');
            barberCard.classList.add('completed');
            barberCard.classList.remove('active');

            // Mostra so os servicos que este profissional faz
            renderServicesWizard();

            if (selectedService) {
                // Servico ja escolhido: vai para data e horario
                const scheduleCard = document.getElementById('scheduleCard');
                scheduleCard.classList.add('active');
                updateStepProgress('date');
                setTimeout(() => scheduleCard.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
            } else {
                // Passo 2: servicos deste profissional
                const serviceCard = document.getElementById('serviceCard');
                serviceCard.classList.add('active');
                serviceCard.classList.remove('completed');
                updateStepProgress('service');
                setTimeout(() => serviceCard.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
            }

            renderCalendar();
            document.getElementById('confirmBooking').classList.add('hidden');
        }

        function renderCalendar() {
            const monthYear = document.getElementById('currentMonth');
            const grid = document.getElementById('calendarGrid');

            const today = nowBR();
            today.setHours(0, 0, 0, 0);

            // Nunca mostra um mês antes do atual
            const todayMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
            if (currentDate < todayMonthStart) currentDate = new Date(todayMonthStart);

            const year = currentDate.getFullYear();
            const month = currentDate.getMonth();

            monthYear.textContent = new Date(year, month, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

            const firstOfMonth = new Date(year, month, 1);
            // Semana começa na segunda-feira: getDay() 0=Dom..6=Sáb -> desloca para 0=Seg..6=Dom
            const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
            const daysInMonth = new Date(year, month + 1, 0).getDate();

            let html = '';
            for (let i = 0; i < leadingBlanks; i++) {
                html += `<div class="calendar-day other-month"></div>`;
            }

            for (let d = 1; d <= daysInMonth; d++) {
                const cmpDate = new Date(year, month, d);
                cmpDate.setHours(0, 0, 0, 0);
                const dayOfWeek = cmpDate.getDay();
                const isPast = cmpDate < today;
                const isWorkingDay = scheduleConfig[dayOfWeek]?.active || false;
                const cmpDateStr = formatDateToYYYYMMDD(cmpDate);
                const dateBlocks = blockedDates.get(cmpDateStr);
                const isFullyBlocked = dateBlocks ? dateBlocks.has('') : false;
                const isToday = cmpDate.getTime() === today.getTime();

                const isSelected = selectedDate &&
                                 selectedDate.getDate() === d &&
                                 selectedDate.getMonth() === month &&
                                 selectedDate.getFullYear() === year;

                const isDisabled = isPast || !isWorkingDay || isFullyBlocked;

                html += `
                    <div class="calendar-day ${isDisabled ? 'disabled' : ''} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}"
                         title="${isFullyBlocked ? 'Fechado nesse dia' : ''}"
                         onclick="${!isDisabled ? `selectDate(${year}, ${month}, ${d})` : ''}">
                        ${d}
                    </div>
                `;
            }

            grid.innerHTML = html;
        }

        async function selectDate(year, month, day) {
            if (!selectedBarber) {
                alert('Escolha o profissional primeiro!');
                return;
            }

            if (!selectedService) {
                alert('Escolha o serviço primeiro!');
                return;
            }
            
            selectedDate = new Date(year, month, day, 12, 0, 0);
            selectedTime = null;
            updateStepProgress('time');
            renderCalendar();
            await loadBookedSlots();
            renderTimeSlots();
        }

        async function loadBookedSlots() {
            try {
                const dateStr = formatDateToYYYYMMDD(selectedDate);

                const response = await fetch(`${API_URL}/bookings/availability?date=${dateStr}&barberId=${selectedBarber.id}`);
                if (!response.ok) throw new Error('Falha ao carregar horários');
                const data = await response.json();

                const allBookedSlots = {}; 
                
                data.forEach(booking => {
                    const startTime = booking.booking_time.substring(0, 5);
                    const duration = booking.duration || 30;
                    const barberId = selectedBarber.id;
                    
                    for(let time of generateBlockedTimes(startTime, duration, intervalTime)) {
                        if(!allBookedSlots[time]) {
                            allBookedSlots[time] = [];
                        }
                        if(barberId && !allBookedSlots[time].includes(barberId)) {
                            allBookedSlots[time].push(barberId);
                        }
                    }
                });
                
                bookedSlots = allBookedSlots;
                
            } catch (error) {
                console.error('Erro ao carregar horários:', error);
                bookedSlots = {};
            }
        }
        
        function generateBlockedTimes(startTime, duration, interval) {
            const slots = [];
            const [startHour, startMin] = startTime.split(':').map(Number);
            let currentMinutes = startHour * 60 + startMin;
            const endMinutes = currentMinutes + duration;
            
            while (currentMinutes < endMinutes) {
                const h = Math.floor(currentMinutes / 60);
                const m = currentMinutes % 60;
                const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                slots.push(time);
                currentMinutes += interval;
            }
            return slots;
        }

        function renderTimeSlots() {
            const container = document.getElementById('timeSlotsContainer');
            
            if (!selectedDate) {
                container.innerHTML = '';
                return;
            }

            const slots = generateTimeSlots();

            if (!slots.length) {
                container.innerHTML = `
                    <div class="time-period-header" style="margin-top: 20px;">
                        <h5><i class="fas fa-clock"></i> Horários</h5>
                    </div>
                    <p style="color: var(--ivory-muted); font-size: 13px;">Nenhum horário disponível neste dia.</p>
                `;
                return;
            }

            // Agrupa por periodo do dia, igual ao print de referencia
            const periods = [
                { key: 'manha', label: 'Manhã', test: h => h < 12 },
                { key: 'tarde', label: 'Tarde', test: h => h >= 12 && h < 18 },
                { key: 'noite', label: 'Noite', test: h => h >= 18 }
            ];

            let html = '';
            periods.forEach(period => {
                const periodSlots = slots.filter(s => period.test(parseInt(s.time.split(':')[0])));
                if (!periodSlots.length) return;

                const availableCount = periodSlots.filter(s => !s.isBooked).length;

                html += `
                    <div class="time-period-header">
                        <h5>${period.label}</h5>
                        <span>${availableCount} horário${availableCount !== 1 ? 's' : ''}</span>
                    </div>
                    <div class="time-slots">
                        ${periodSlots.map(slot => `
                            <div class="time-slot ${slot.isBooked ? 'disabled' : ''} ${selectedTime === slot.time ? 'selected' : ''}"
                                 onclick="${!slot.isBooked ? `selectTime('${slot.time}')` : ''}">
                                <span>${slot.time}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
            });

            container.innerHTML = html;
        }

        function generateTimeSlots() {
            const slots = [];
            const dayOfWeek = selectedDate.getDay();
            const dayConfig = scheduleConfig[dayOfWeek];
            const selectedDateStr = formatDateToYYYYMMDD(selectedDate);
            const dateBlocks = blockedDates.get(selectedDateStr);

            if (!dayConfig || !dayConfig.active) return slots;
            if (dateBlocks && dateBlocks.has('')) return slots;

            const serviceDuration = selectedService ? selectedService.duration : 30;

            for (let period of dayConfig.periods) {
                const [openHour, openMin] = period.start.split(':').map(Number);
                const [closeHour, closeMin] = period.end.split(':').map(Number);
                
                let currentMinutes = openHour * 60 + openMin;
                const endMinutes = closeHour * 60 + closeMin;
                
                while (currentMinutes + serviceDuration <= endMinutes) {
                    const hour = Math.floor(currentMinutes / 60);
                    const minute = currentMinutes % 60;
                    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

                    if (dateBlocks && dateBlocks.has(getPeriodKey(hour))) {
                        currentMinutes += intervalTime;
                        continue; // turno fechado nesse dia - nem aparece como opcao
                    }

                    const isTimePassed = isTimeSlotPassed(selectedDateStr, time + ':00');
                    let isBlocked = isTimePassed;

                    if (!isBlocked && selectedService) {
                        const blockTimes = generateBlockedTimes(time, serviceDuration, intervalTime);
                        
                        for (let blockTime of blockTimes) {
                            const bookingsAtBlockTime = bookedSlots[blockTime] || [];
                            
                            if (bookingsAtBlockTime.includes(selectedBarber.id)) {
                                isBlocked = true;
                                break;
                            }
                        }
                    }
                    
                    slots.push({
                        time: time,
                        isBooked: isBlocked
                    });
                    
                    currentMinutes += intervalTime;
                }
            }
            
            return slots;
        }

        function selectTime(time) {
            selectedTime = time;
            renderTimeSlots();
            
            // Marca o card de agendamento como completo
            const scheduleCard = document.getElementById('scheduleCard');
            scheduleCard.classList.add('completed');
            scheduleCard.classList.remove('active');
            
            showConfirmation();
        }

        function showConfirmation() {
            const container = document.getElementById('confirmBooking');
            const summary = document.getElementById('bookingSummary');
            
            const dateFormatted = selectedDate.toLocaleDateString('pt-BR', { 
                weekday: 'long', 
                day: 'numeric', 
                month: 'long', 
                year: 'numeric'
            });
            
            const barberName = selectedBarber.name;
            
            summary.innerHTML = `
                <p><strong><i class="fas fa-scissors"></i> Serviço:</strong> ${selectedService.name}</p>
                <p><strong><i class="fas fa-user-tie"></i> Barbeiro:</strong> ${barberName}</p>
                <p><strong><i class="fas fa-calendar"></i> Data:</strong> ${dateFormatted}</p>
                <p><strong><i class="fas fa-clock"></i> Horário:</strong> ${selectedTime}</p>
                <p><strong><i class="fas fa-money-bill-wave"></i> Valor:</strong> R$ ${selectedService.price.toFixed(2)}</p>
                <p><strong><i class="fas fa-hourglass-half"></i> Duração:</strong> ${selectedService.duration} minutos</p>
            `;
            
            document.getElementById('unverifiedUserFields').classList.remove('hidden'); 
            
            container.classList.remove('hidden');
            
            // Scroll suave para a confirmação com efeito
            setTimeout(() => {
                container.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }

        // A confirmação por WhatsApp agora é enviada automaticamente pelo servidor
        // (usando o número conectado pelo gestor da barbearia), então não precisamos
        // mais disparar nenhum webhook a partir do navegador do cliente.

        document.getElementById('confirmBtn').addEventListener('click', async (e) => {
            const btn = e.target.closest('button');
            if (btn.disabled) return;
            
            btn.disabled = true;
            btn.innerHTML = '<span><i class="fas fa-spinner fa-spin"></i> Confirmando...</span>';

            const bookingFullName = sanitizeInput(document.getElementById('bookingFullName').value);
            const bookingPhoneRaw = document.getElementById('bookingPhone').value;

            if (!bookingFullName || bookingFullName.length < 3) {
                alert('Nome completo inválido!');
                btn.disabled = false;
                btn.innerHTML = '<span>Confirmar Agendamento</span>';
                return;
            }

            if (!bookingPhoneRaw || !validatePhone(bookingPhoneRaw)) {
                alert('Telefone inválido! Digite DDD + 9 dígitos\nExemplo: (88) 99999-9999');
                btn.disabled = false;
                btn.innerHTML = '<span>Confirmar Agendamento</span>';
                return;
            }
            
            const finalPhoneFormatted = formatPhoneToWhatsApp(bookingPhoneRaw);
            const dateStr = formatDateToYYYYMMDD(selectedDate);
            const barberIdToSave = selectedBarber.id;
            
            try {
                const response = await fetch(`${API_URL}/bookings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        customer_full_name: bookingFullName,
                        customer_phone: finalPhoneFormatted,
                        ...(selectedService.isPackage ? { package_id: selectedService.id } : { service_id: selectedService.id }),
                        barber_id: barberIdToSave,
                        booking_date: dateStr,
                        booking_time: selectedTime
                    })
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.error || 'Erro ao confirmar agendamento');
                }

                const bookingData = await response.json();

                const modal = document.getElementById('confirmationModal');
                const modalDetails = document.getElementById('modalDetails');
                
                const dateFormatted = selectedDate.toLocaleDateString('pt-BR', { 
                    weekday: 'long', 
                    day: 'numeric', 
                    month: 'long', 
                    year: 'numeric'
                });

                const finalBarberName = selectedBarber.name;
                
                modalDetails.innerHTML = `
                    <p>
                        <strong><i class="fas fa-user"></i> Cliente:</strong>
                        <span>${bookingFullName}</span>
                    </p>
                    <p>
                        <strong><i class="fas fa-phone"></i> Telefone:</strong>
                        <span>${bookingPhoneRaw}</span>
                    </p>
                    <hr style="border-color: #333; margin: 10px 0;">
                    <p>
                        <strong><i class="fas fa-scissors"></i> Serviço:</strong>
                        <span>${selectedService.name}</span>
                    </p>
                    <p>
                        <strong><i class="fas fa-user-tie"></i> Barbeiro:</strong>
                        <span>${finalBarberName}</span>
                    </p>
                    <p>
                        <strong><i class="fas fa-calendar"></i> Data:</strong>
                        <span>${dateFormatted}</span>
                    </p>
                    <p>
                        <strong><i class="fas fa-clock"></i> Horário:</strong>
                        <span>${selectedTime}</span>
                    </p>
                    ${bookingData.reward_label ? `
                    <p style="background: rgba(198,161,91,0.1); border: 1px solid var(--brass); border-radius: 8px; padding: 10px; margin-top: 12px; color: var(--brass-light); font-weight: 600;">
                        <i class="fas fa-gift"></i> ${bookingData.reward_label}${bookingData.final_price === 0 ? ' — grátis!' : ` — valor final: R$ ${bookingData.final_price.toFixed(2)}`}
                    </p>` : ''}
                    <p style="color: var(--green); font-weight: bold; margin-top: 15px;">
                        <i class="fas fa-check-circle"></i> Agendamento Confirmado com Sucesso!
                    </p>
                `;
                
                modal.classList.remove('hidden');
                
                selectedService = null;
                selectedBarber = null;
                selectedDate = null;
                selectedTime = null;
                
                // Remove as classes de estado dos cards
                document.getElementById('serviceCard').classList.remove('completed', 'active');
                document.getElementById('barberCard').classList.remove('completed', 'active');
                document.getElementById('scheduleCard').classList.remove('completed', 'active');
                
                document.getElementById('confirmBooking').classList.add('hidden');
                document.getElementById('barberCard').classList.add('active');
                document.getElementById('timeSlotsContainer').innerHTML = '';
                renderBarbers();
                updateStepProgress('barber');
                renderServices();
                renderCalendar();
                updateStepProgress('service');
                
            } catch (error) {
                alert('Erro ao confirmar agendamento: ' + error.message);
                console.error('Erro completo:', error);
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<span>Confirmar Agendamento</span>';
            }
        });

        document.getElementById('prevMonth').addEventListener('click', () => {
            const candidate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
            const today = nowBR();
            const todayMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
            if (candidate < todayMonthStart) return;
            currentDate = candidate;
            renderCalendar();
        });

        document.getElementById('nextMonth').addEventListener('click', () => {
            currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
            renderCalendar();
        });

        initializeApp();
