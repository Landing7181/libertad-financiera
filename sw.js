const CACHE = 'credito-v1';

// Archivos locales siempre cacheados
const LOCAL = ['./', './index.html', './manifest.json', './icon.svg', './icon-maskable.svg'];

// CDN externos — se cachean la primera vez que se descargan
const CDN = [
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

// Instalar: pre-cachear archivos locales (y CDN si hay red)
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE).then(cache =>
            cache.addAll(LOCAL)
                .then(() => cache.addAll(CDN).catch(() => {})) // CDN opcional
        )
    );
    self.skipWaiting();
});

// Activar: eliminar cachés viejos
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch: caché primero, red de respaldo, luego index.html si todo falla
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (response && response.status === 200 && response.type !== 'opaque') {
                    caches.open(CACHE).then(c => c.put(event.request, response.clone()));
                }
                return response;
            }).catch(() => caches.match('./index.html'));
        })
    );
});
