require('dotenv').config();

// Tudo no fuso de Brasilia, sempre - independente de onde o container estiver hospedado
process.env.TZ = 'America/Sao_Paulo';

const path = require('path');
const express = require('express');
const cors = require('cors');

require('./db'); // garante que o banco e as tabelas existam antes de tudo
const { startReminderScheduler } = require('./reminders');

const authRoutes = require('./route-auth');
const superadminRoutes = require('./route-superadmin');
const servicesRoutes = require('./route-services');
const barbersRoutes = require('./route-barbers');
const bookingsRoutes = require('./route-bookings');
const settingsRoutes = require('./route-settings');
const clientsRoutes = require('./route-clients');
const eventsRoutes = require('./route-events');
const whatsappRoutes = require('./route-whatsapp');
const reviewsRoutes = require('./route-reviews');
const packagesRoutes = require('./route-packages');
const subscriptionsRoutes = require('./route-subscriptions');
const publicRoutes = require('./route-public');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Webhook da Evolution (atendente IA no WhatsApp) - montado ANTES do express.json global
// porque tem limite de tamanho proprio e nao usa login
app.use('/api/webhook', require('./route-webhook').router);

app.use(express.json());

// Fotos de barbeiros enviadas via upload
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/pwa', express.static(path.join(__dirname, 'pwa')));

// --- API ---
app.use('/api/auth', authRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/barbers', barbersRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/packages', packagesRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/public', publicRoutes); // /api/public/:slug/...

// --- Paginas ---
const PUBLIC_DIR = __dirname;

app.get('/superadmin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'superadmin.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// CSS/JS de cada pagina, servidos individualmente (evita expor os arquivos do backend
// que tambem estao nessa mesma pasta, como aconteceria com um express.static geral)
app.get('/admin.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.css')));
app.get('/admin.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.js')));
app.get('/client.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'client.css')));
app.get('/client.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'client.js')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'sw.js')));

app.get('/', (req, res) => {
  res.send('BarberSync no ar. Acesse o link da sua barbearia (ex: /nome-da-loja) ou /admin para entrar no painel.');
});

// Qualquer outro caminho de 1 segmento e tratado como o link publico de uma barbearia (slug)
app.get('/:slug', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'client.html'));
});

app.listen(PORT, () => {
  console.log(`BarberSync rodando em http://localhost:${PORT} (fuso: ${process.env.TZ})`);
  startReminderScheduler();
});
