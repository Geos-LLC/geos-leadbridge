// LeadBridge Mobile — minimal service worker. Exists so the PWA install
// prompt fires (Chrome's installability heuristic requires a registered
// SW with a fetch handler) and so basic offline navigation falls back to
// the cached app shell.
//
// Intentionally NOT a full caching solution — we want every API call to
// hit the network so users always see fresh leads / settings / messages.
// Static assets get cached at install; everything else is network-first
// with a navigation-fallback only.

const VERSION = 'lb-mobile-v1';
const APP_SHELL = ['/', '/m', '/m/today'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(APP_SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GETs; let everything else pass through unchanged so the
  // browser does its normal POST handling for leadsApi.sendMessage etc.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin API calls are always network-first with no cache fallback —
  // we never want to serve stale lead/message data from the SW.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  // Navigation requests (top-level HTML loads) — network first, fall back
  // to the cached shell so the app still opens when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/m').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Static assets (JS, CSS, fonts, images): try cache first, then network,
  // then populate cache. Skip cross-origin fonts (Google Fonts handles its
  // own caching headers).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        }).catch(() => cached);
      }),
    );
  }
});
