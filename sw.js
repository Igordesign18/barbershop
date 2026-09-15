// Service worker minimo do PWA - so o necessario pra permitir "Instalar app" e
// funcionar de forma basica offline. Nao faz cache agressivo porque os dados
// (horarios, servicos, etc) mudam o tempo todo e precisam vir sempre da rede.
const CACHE_NAME = 'barbershop-shell-v1';
const SHELL_ASSETS = ['/client.css', '/client.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Network-first: tenta sempre a rede primeiro (dados atualizados) e cai pro
// cache do shell (client.css/client.js) so se estiver offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
