/* ══════════════════════════════════════════════════════
   Service Worker — Libertad Financiera
   • Network-first para archivos locales (siempre la versión más nueva)
   • Cache-first para CDN (Chart.js, Google Fonts)
   • Periodic Background Sync para notificaciones inteligentes
   ══════════════════════════════════════════════════════ */

const VERSION     = Date.now();
const CACHE_LOCAL = `lf-local-${VERSION}`;
const CACHE_CDN   = 'lf-cdn-v2';
const CACHE_NOTIF = 'lf-notif-v1';

const LOCAL_FILES = ['./', './index.html', './manifest.json', './icon.svg', './icon-maskable.svg'];
const CDN_ORIGINS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// ── INSTALL ─────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_LOCAL).then(c => c.addAll(LOCAL_FILES))
    );
    self.skipWaiting();
});

// ── ACTIVATE ────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_LOCAL && k !== CACHE_CDN && k !== CACHE_NOTIF)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
            .then(() => self.clients.matchAll({ type: 'window' })
                .then(cs => cs.forEach(c => c.navigate(c.url)))
            )
    );
});

// ── FETCH: estrategia según origen ──────────────────
self.addEventListener('fetch', event => {
    const url   = new URL(event.request.url);
    const isCDN = CDN_ORIGINS.some(o => url.hostname.includes(o));

    if (isCDN) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(res => {
                    if (res && res.status === 200)
                        caches.open(CACHE_CDN).then(c => c.put(event.request, res.clone()));
                    return res;
                });
            })
        );
    } else {
        event.respondWith(
            fetch(event.request)
                .then(res => {
                    if (res && res.status === 200 && event.request.method === 'GET')
                        caches.open(CACHE_LOCAL).then(c => c.put(event.request, res.clone()));
                    return res;
                })
                .catch(() =>
                    caches.match(event.request).then(c => c || caches.match('./index.html'))
                )
        );
    }
});

// ── NOTIFICATION CLICK: abre / enfoca la app ────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    let targetUrl = (event.notification.data && event.notification.data.url) || './';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
            let open = cs.find(c => c.url.includes(self.location.origin));
            return open ? open.focus() : clients.openWindow(targetUrl);
        })
    );
});

// ── PERIODIC BACKGROUND SYNC ────────────────────────
self.addEventListener('periodicsync', event => {
    if (event.tag === 'smart-notif') {
        event.waitUntil(runSmartNotifications());
    }
});

// ── NOTIFICACIONES INTELIGENTES ──────────────────────
async function runSmartNotifications() {
    try {
        let cache = await caches.open(CACHE_NOTIF);
        let resp  = await cache.match('/notif-state');
        if (!resp) return;

        let state = await resp.json();
        let prefs = state.prefs || {};
        let data  = state.data  || {};
        let shown = state.shown || {};

        // Hora local (enviada desde la página cuando se guardó el estado)
        let now      = new Date();
        let todayStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
        let hour     = now.getHours();
        let weekDay  = now.getDay(); // 0=Dom, 5=Vie

        // ── Horario silencioso ──────────────────────
        let qStart = parseInt((prefs.quietStart || '22:00').split(':')[0]);
        let qEnd   = parseInt((prefs.quietEnd   || '07:00').split(':')[0]);
        let inQuiet = qStart > qEnd
            ? (hour >= qStart || hour < qEnd)
            : (hour >= qStart && hour < qEnd);
        if (inQuiet) return;

        let changed = false;

        // ── 1. RECORDATORIO DE PAGO ─────────────────
        if (prefs.payment && data.nextPaymentDate) {
            let nd       = new Date(data.nextPaymentDate + 'T12:00:00');
            let daysLeft = Math.ceil((nd - now) / 86400000);
            let key      = 'pay_' + todayStr;
            if (daysLeft > 0 && daysLeft <= (prefs.paymentDays || 3) && !shown[key]) {
                let pct    = data.monthGoal > 0 ? Math.min(100, Math.round((data.monthSaved || 0) / data.monthGoal * 100)) : 0;
                let alc    = pct >= 100
                    ? '🐖 ¡Alcancía lista para el abono!'
                    : (data.monthGoal > 0 ? `🐖 Alcancía al ${pct}% — faltan ${fCOP(Math.max(0, data.monthGoal - (data.monthSaved || 0)))}` : '');
                let body   = [alc, `Cuota de ${fCOP(data.installment || 0)} el ${data.nextPaymentDate}`].filter(Boolean).join('\n');
                await notif(`💳 Cuota en ${daysLeft} día${daysLeft > 1 ? 's' : ''}`, body, 'pay');
                shown[key] = true; changed = true;
            }
        }

        // ── 2. META DE ALCANCÍA ALCANZADA ───────────
        if (prefs.saver && data.monthGoal > 0 && (data.monthSaved || 0) >= data.monthGoal) {
            let key = 'saver_' + todayStr;
            if (!shown[key]) {
                await notif('🐖 ¡Alcancía llena!',
                    `Tienes ${fCOP(data.monthSaved)} ahorrados. ¡Hora de abonar al crédito!`,
                    'saver-full', { requireInteraction: true });
                shown[key] = true; changed = true;
            }
        }

        // ── 3. NUDGE DIARIO DE AHORRO ───────────────
        if (prefs.daily && !data.savedToday) {
            let dH  = parseInt((prefs.dailyHour || '08:00').split(':')[0]);
            let key = 'daily_' + todayStr;
            if (hour >= dH && hour < 20 && !shown[key]) {
                let dailyT = data.monthGoal > 0 ? Math.ceil(data.monthGoal / 30) : 0;
                if (dailyT > 0) {
                    let streak = data.currentStreak || 0;
                    await notif('☀️ Meta de hoy: ' + fCOP(dailyT),
                        `Llevas ${fCOP(data.monthSaved || 0)} este mes${streak > 0 ? ' · 🔥 ' + streak + ' días de racha' : ''}. ¡Guarda algo hoy!`,
                        'daily');
                    shown[key] = true; changed = true;
                }
            }
        }

        // ── 4. RACHA EN RIESGO ──────────────────────
        if (prefs.streak && (data.currentStreak || 0) >= 3 && !data.savedToday && hour >= 19) {
            let key = 'streak_' + todayStr;
            if (!shown[key]) {
                await notif(`🔥 Racha de ${data.currentStreak} días en riesgo`,
                    'Aún no guardaste nada hoy. ¡Guarda algo antes de medianoche!',
                    'streak', { requireInteraction: true });
                shown[key] = true; changed = true;
            }
        }

        // ── 5. RESUMEN SEMANAL (viernes) ────────────
        if (prefs.weekly && weekDay === 5) {
            let key = 'weekly_' + todayStr;
            if (!shown[key]) {
                let saved  = data.monthSaved || 0;
                let goal   = data.monthGoal  || 0;
                let capPct = (data.capPct || 0).toFixed(1);
                await notif('📊 Resumen semanal',
                    `Este mes: ${fCOP(saved)}${goal > 0 ? ' de ' + fCOP(goal) : ''}.\nCapital amortizado: ${capPct}%`,
                    'weekly');
                shown[key] = true; changed = true;
            }
        }

        // ── 6. HITO DE CRÉDITO ──────────────────────
        if (prefs.milestone && data.capPct) {
            for (let pct of [25, 50, 75]) {
                let key = 'ms_' + pct;
                if (data.capPct >= pct && !shown[key]) {
                    await notif(`🎉 ¡${pct}% del crédito pagado!`,
                        `Has amortizado el ${pct}% del capital original. ¡Sigue así!`,
                        'milestone-' + pct);
                    shown[key] = true; changed = true;
                }
            }
        }

        if (changed) {
            state.shown = shown;
            await cache.put('/notif-state', new Response(JSON.stringify(state), {
                headers: { 'Content-Type': 'application/json' }
            }));
        }
    } catch(e) {
        console.warn('[SW] Smart notif error:', e);
    }
}

async function notif(title, body, tag, opts = {}) {
    return self.registration.showNotification(title, {
        body, tag,
        icon:    './icon.svg',
        badge:   './icon.svg',
        vibrate: [200, 100, 200],
        data:    { url: './' },
        ...opts
    });
}

function fCOP(v) {
    return '$ ' + Math.round(v).toLocaleString('es-CO');
}
