        // Cada barbearia tem seu proprio link: seudominio.com/<slug-da-loja>
        const TENANT_SLUG = window.location.pathname.split('/').filter(Boolean)[0] || '';

        // Temas visuais disponiveis - o gestor escolhe qual usar no painel admin
        const THEMES = {
            ouro_negro: { vars: { '--ebony':'#0e0c0a', '--surface':'#18140f', '--surface-raised':'#211b14', '--hairline':'rgba(198,161,91,0.16)', '--brass':'#c6a15b', '--brass-light':'#e8c978', '--oxblood':'#7a2f3f', '--ivory':'#f2ede3', '--ivory-muted':'#a69c8c', '--green':'#6fae7a', '--red':'#c15c5c' } },
            meia_noite: { vars: { '--ebony':'#0a0e14', '--surface':'#121a24', '--surface-raised':'#1a2530', '--hairline':'rgba(148,180,209,0.16)', '--brass':'#6f9bc7', '--brass-light':'#a3c4e8', '--oxblood':'#35506b', '--ivory':'#eef2f6', '--ivory-muted':'#8b98a8', '--green':'#6fae8a', '--red':'#c1685c' } },
            esmeralda: { vars: { '--ebony':'#0a120e', '--surface':'#121c16', '--surface-raised':'#1a2921', '--hairline':'rgba(163,201,164,0.16)', '--brass':'#4f9d6e', '--brass-light':'#7ec49a', '--oxblood':'#8a6a2e', '--ivory':'#eef5ee', '--ivory-muted':'#93a898', '--green':'#6fae7a', '--red':'#c15c5c' } },
            grafite: { vars: { '--ebony':'#121212', '--surface':'#1c1c1c', '--surface-raised':'#262626', '--hairline':'rgba(200,150,110,0.16)', '--brass':'#c17d4f', '--brass-light':'#e0a877', '--oxblood':'#5c4a3a', '--ivory':'#f0ede8', '--ivory-muted':'#a3998e', '--green':'#6fae7a', '--red':'#c15c5c' } },
            marfim: { vars: { '--ebony':'#f5f0e6', '--surface':'#ffffff', '--surface-raised':'#ede6d8', '--hairline':'rgba(90,60,40,0.16)', '--brass':'#8a5a3a', '--brass-light':'#a97a52', '--oxblood':'#7a2f3f', '--ivory':'#2a2018', '--ivory-muted':'#6b5d4e', '--green':'#4a8a5a', '--red':'#a13f3f' } }
        };

        function applyTheme(themeKey) {
            const theme = THEMES[themeKey] || THEMES.ouro_negro;
            const root = document.documentElement;
            Object.entries(theme.vars).forEach(([key, value]) => root.style.setProperty(key, value));
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

        const mainApp = document.getElementById('mainApp');

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
            const statusBadge = document.getElementById('statusBadge');
            const statusText = document.getElementById('statusText');
            const now = nowBR();
            const currentDay = now.getDay();
            
            if (!scheduleConfig[currentDay] || !scheduleConfig[currentDay].active) {
                statusBadge.classList.remove('open');
                statusBadge.classList.add('closed');
                statusText.textContent = 'Fechado • Não abre hoje';
                return;
            }

            const currentTime = now.getHours() * 60 + now.getMinutes();
            let isOpen = false;
            let nextPeriod = null;

            for (let period of scheduleConfig[currentDay].periods) {
                const [startHour, startMin] = period.start.split(':').map(Number);
                const [endHour, endMin] = period.end.split(':').map(Number);
                const startMinutes = startHour * 60 + startMin;
                const endMinutes = endHour * 60 + endMin;

                if (currentTime >= startMinutes && currentTime < endMinutes) {
                    isOpen = true;
                    statusBadge.classList.remove('closed');
                    statusBadge.classList.add('open');
                    statusText.textContent = `Aberto • ${period.start} - ${period.end}`;
                    return;
                }

                if (currentTime < startMinutes && !nextPeriod) {
                    nextPeriod = period;
                }
            }

            if (!isOpen) {
                statusBadge.classList.remove('open');
                statusBadge.classList.add('closed');
                if (nextPeriod) {
                    statusText.textContent = `Fechado • Abre às ${nextPeriod.start}`;
                } else {
                    statusText.textContent = 'Fechado • Abre amanhã';
                }
            }
        }

        function closeModal() {
            document.getElementById('confirmationModal').classList.add('hidden');
            window.scrollTo(0, 0);
        }

        async function initializeApp() {
            if (!TENANT_SLUG) {
                showTenantError('Link inválido. Peça o link correto da sua barbearia.');
                return;
            }

            try {
                const infoResponse = await fetch(`${API_URL}/info`);
                if (!infoResponse.ok) {
                    const err = await infoResponse.json().catch(() => ({}));
                    showTenantError(err.error || 'Não foi possível carregar esta barbearia.');
                    return;
                }
                const info = await infoResponse.json();
                document.title = `${info.name} - Agendamento`;
                const nameEl = document.querySelector('.hero h1');
                if (nameEl) nameEl.textContent = info.name;
            } catch (error) {
                showTenantError('Não foi possível conectar ao servidor. Tente novamente em instantes.');
                return;
            }

            mainApp.style.display = 'block';
            
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
        
        async function loadSettings() {
            try {
                const response = await fetch(`${API_URL}/settings`);
                const data = await response.json();

                if (data.schedule_config) scheduleConfig = JSON.parse(data.schedule_config);
                if (data.interval_time) intervalTime = parseInt(data.interval_time);

                applyTheme(data.theme);

                if (data.banner_url) {
                    const banner = document.getElementById('heroBanner');
                    banner.style.backgroundImage = `url('${data.banner_url}')`;
                    banner.classList.add('loaded');
                }
                if (data.logo_url) {
                    document.getElementById('barberPhoto').innerHTML = `<img src="${data.logo_url}" alt="Logo da barbearia">`;
                }
                if (data.tagline) {
                    document.getElementById('heroTagline').textContent = data.tagline;
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
            } catch (error) {
                console.error('Erro ao carregar barbeiros:', error);
            }
        }

        function renderServices() {
            const container = document.getElementById('servicesList');
            
            if (services.length === 0 && packages.length === 0) {
                container.innerHTML = '<p style="color: var(--ivory-muted); text-align: center;">Nenhum serviço disponível</p>';
                return;
            }

            const packagesHtml = packages.map(pkg => `
                <div class="service-item" onclick="selectPackage(${pkg.id})" style="border-color: rgba(198,161,91,0.35);">
                    <div class="service-info">
                        <h4><i class="fas fa-box-open"></i> ${pkg.name} <span style="font-size:10px; background:var(--brass); color:var(--ebony); padding:2px 8px; border-radius:100px; font-weight:700; margin-left:6px;">PACOTE</span></h4>
                        <p><i class="fas fa-clock"></i> ${pkg.total_duration} minutos • ${pkg.services.map(s => s.name).join(' + ')}</p>
                    </div>
                    <div class="service-price">R$ ${pkg.price.toFixed(2)}</div>
                </div>
            `).join('');

            // Cada serviço aparece em círculo (com foto do corte, se o gestor tiver enviado)
            const servicesHtml = services.length ? `<div class="barbers-grid" style="margin-top: ${packages.length ? '14px' : '0'};">` + services.map(service => `
                <div class="barber-item" onclick="selectService(${service.id})">
                    <div class="barber-photo-circle">
                        ${service.photo_url ? `<img src="${service.photo_url}" alt="${service.name}">` : '<i class="fas fa-scissors"></i>'}
                    </div>
                    <div class="barber-name">${service.name}</div>
                    <div class="barber-specialty">R$ ${service.price.toFixed(2)} · ${service.duration}min</div>
                </div>
            `).join('') + `</div>` : '';

            container.innerHTML = packagesHtml + servicesHtml;
        }

        function selectPackage(id) {
            const pkg = packages.find(p => p.id === id);
            if (!pkg) return;
            selectService(id, { ...pkg, duration: pkg.total_duration, isPackage: true });
        }

        function renderBarbers() {
            const container = document.getElementById('barbersList');
            
            if (barbers.length === 0) {
                container.innerHTML = '<p style="color: var(--ivory-muted); text-align: center;">Nenhum barbeiro disponível. Cadastre um barbeiro no painel Admin.</p>';
                return;
            }

            container.innerHTML = barbers.map(barber => {
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
            document.querySelectorAll('#servicesList .service-item, #servicesList .barber-item').forEach(el => el.classList.remove('selected'));
            event.currentTarget.classList.add('selected');
            
            selectedBarber = null;
            selectedDate = null;
            selectedTime = null;
            
            // Marca o card de serviço como completo
            const serviceCard = document.getElementById('serviceCard');
            serviceCard.classList.add('completed');
            
            // Ativa e exibe o card do barbeiro
            const barberCard = document.getElementById('barberCard');
            const barberSelection = document.getElementById('barberSelection');
            barberSelection.style.display = 'block';
            barberCard.classList.add('active');
            renderBarbers();
            
            // Scroll suave para o próximo passo
            setTimeout(() => {
                barberCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
            
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
            
            // Marca o card do barbeiro como completo
            const barberCard = document.getElementById('barberCard');
            barberCard.classList.add('completed');
            barberCard.classList.remove('active');
            
            // Ativa o card de agendamento
            const scheduleCard = document.getElementById('scheduleCard');
            scheduleCard.classList.add('active');
            
            // Scroll suave para o calendário
            setTimeout(() => {
                scheduleCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
            
            renderCalendar();
            document.getElementById('confirmBooking').classList.add('hidden');
        }

        function renderCalendar() {
            const monthYear = document.getElementById('currentMonth');
            const grid = document.getElementById('calendarGrid');

            const today = nowBR();
            today.setHours(0, 0, 0, 0);

            // Mostra uma faixa de 7 dias a partir de "currentDate" (nunca antes de hoje)
            if (currentDate < today) currentDate = new Date(today);
            const startDate = new Date(currentDate);

            monthYear.textContent = startDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

            let html = '';

            for (let i = 0; i < 7; i++) {
                const date = new Date(startDate);
                date.setDate(startDate.getDate() + i);
                date.setHours(12, 0, 0, 0);

                const dayOfWeek = date.getDay();
                const isPast = date < today;
                const isWorkingDay = scheduleConfig[dayOfWeek]?.active || false;
                const isToday = date.getDate() === today.getDate() &&
                               date.getMonth() === today.getMonth() &&
                               date.getFullYear() === today.getFullYear();

                const isSelected = selectedDate &&
                                 selectedDate.getDate() === date.getDate() &&
                                 selectedDate.getMonth() === date.getMonth() &&
                                 selectedDate.getFullYear() === date.getFullYear();

                const isDisabled = isPast || !isWorkingDay;

                html += `
                    <div class="calendar-day ${isDisabled ? 'disabled' : ''} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}"
                         onclick="${!isDisabled ? `selectDate(${date.getFullYear()}, ${date.getMonth()}, ${date.getDate()})` : ''}">
                        <small>${date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</small>
                        <div>${date.getDate()}</div>
                    </div>
                `;
            }

            grid.innerHTML = html;
        }

        async function selectDate(year, month, day) {
            if (!selectedService) {
                alert('Selecione um serviço primeiro!');
                return;
            }
            
            if (!selectedBarber) {
                alert('Selecione um barbeiro primeiro!');
                return;
            }
            
            selectedDate = new Date(year, month, day, 12, 0, 0);
            selectedTime = null;
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

            if (!dayConfig || !dayConfig.active) return slots;

            const selectedDateStr = formatDateToYYYYMMDD(selectedDate);
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
                
                document.querySelectorAll('.service-item').forEach(el => el.classList.remove('selected'));
                document.querySelectorAll('.barber-item').forEach(el => el.classList.remove('selected'));
                document.getElementById('confirmBooking').classList.add('hidden');
                document.getElementById('barberSelection').style.display = 'none';
                document.getElementById('timeSlotsContainer').innerHTML = '';
                renderCalendar();
                
                // Scroll para o topo
                window.scrollTo({ top: 0, behavior: 'smooth' });
                
            } catch (error) {
                alert('Erro ao confirmar agendamento: ' + error.message);
                console.error('Erro completo:', error);
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<span>Confirmar Agendamento</span>';
            }
        });

        document.getElementById('prevMonth').addEventListener('click', () => {
            currentDate.setDate(currentDate.getDate() - 7);
            renderCalendar();
        });

        document.getElementById('nextMonth').addEventListener('click', () => {
            currentDate.setDate(currentDate.getDate() + 7);
            renderCalendar();
        });

        initializeApp();
