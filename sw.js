/* ─────────────────────────────────────────────────────
   Service Worker — Libertad Financiera
   Estrategia:
     • index.html / archivos locales → Network-first
       (siempre intenta la red; caché solo si offline)
     • CDN externos (Chart.js, Google Fonts) → Cache-first
       (no cambian; se sirven desde caché para velocidad)
   ───────────────────────────────────────────────────── */

// Cambia este número con cada deploy para forzar cache fresco
const VERSION = Date.now(); // se actualiza solo al re-desplegar el sw.js
const CACHE_LOCAL = `lf-local-${VERSION}`;
const CACHE_CDN   = 'lf-cdn-v2';   // sube la versión si cambias CDN

const LOCAL_FILES = ['./', './index.html', './manifest.json', './icon.svg', './icon-maskable.svg'];
const CDN_ORIGINS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// ── INSTALL: pre-cachear archivos locales ──────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_LOCAL).then(cache => cache.addAll(LOCAL_FILES))
    );
    self.skipWaiting(); // toma control inmediatamente sin esperar cierre de tabs
});

// ── ACTIVATE: eliminar todos los cachés locales viejos ─
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(k => k !== CACHE_LOCAL && k !== CACHE_CDN)
                    .map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim()) // controla todas las tabs abiertas
         .then(() =>
             // Recarga silenciosa en todas las tabs para mostrar la versión nueva
             self.clients.matchAll({ type: 'window' }).then(clients =>
                 clients.forEach(c => c.navigate(c.url))
             )
         )
    );
});

// ── FETCH: estrategia según origen ────────────────────
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    const isCDN = CDN_ORIGINS.some(o => url.hostname.includes(o));

    if (isCDN) {
        // Cache-first para CDN (no cambian; acelera carga)
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(res => {
                    if (res && res.status === 200) {
                        caches.open(CACHE_CDN).then(c => c.put(event.request, res.clone()));
                    }
                    return res;
                });
            })
        );
    } else {
        // Network-first para archivos locales (siempre la versión más nueva)
        event.respondWith(
            fetch(event.request)
                .then(res => {
                    if (res && res.status === 200 && event.request.method === 'GET') {
                        caches.open(CACHE_LOCAL).then(c => c.put(event.request, res.clone()));
                    }
                    return res;
                })
                .catch(() =>
                    // Sin red → servir desde caché (modo offline)
                    caches.match(event.request).then(c => c || caches.match('./index.html'))
                )
        );
    }
});
