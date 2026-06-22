// LeadBridge Mobile — minimal service worker. Exists so the PWA install
// prompt fires (Chrome's installability heuristic requires a registered
// SW with a fetch handler) and so basic offline navigation falls back to
// the cached app shell.
//
// Intentionally NOT a full caching solution — we want every API call to
// hit the network so users always see fresh leads / settings / messages.
// Static assets get cached at install; everything else is network-first
// with a navigation-fallback only.

// Bumped from v1 → v2 (2026-06-17): excludes /version.json from cache-first
// to fix a "Update available" banner that never went away.
// Bumped v2 → v3 (2026-06-22): navigation handler now falls back to the
// cached shell on 4xx (not just network failure) and always returns a
// Response so the SW never throws "Failed to convert value to 'Response'"
// when neither '/m' nor '/' is in cache. Symptom: SPA deep-links like
// /automation/respond returned 404 (Vercel routing miss) and the SW
// rejected the FetchEvent, breaking the page entirely.
const VERSION = 'lb-mobile-v3';
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

  // /version.json is the deploy-detection beacon — caching it permanently
  // pins the "Update available" banner because the SW returns the stale
  // SHA forever even after a hard reload. Pass through to network every
  // time; the hook itself uses `cache: 'no-store'` for the HTTP layer.
  if (url.origin === self.location.origin && url.pathname === '/version.json') {
    return;
  }

  // Navigation requests (top-level HTML loads) — network first, fall back
  // to the cached shell so the app still opens when offline AND so SPA
  // deep links (e.g. /automation/respond) don't surface server-side 404s
  // when the host's catch-all routing misses. The fallback chain is
  // guaranteed to return a Response (never undefined), otherwise
  // respondWith throws "Failed to convert value to 'Response'".
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const shellFallback = async () =>
          (await caches.match('/m')) ||
          (await caches.match('/')) ||
          new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title><body>Reload to continue.</body>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          );
        try {
          const res = await fetch(req);
          // Treat 4xx/5xx as a miss and fall back to the cached shell —
          // the SPA router can resolve the path client-side. Without
          // this, a server-side 404 broke navigation under the SW.
          if (!res.ok) return shellFallback();
          return res;
        } catch {
          return shellFallback();
        }
      })(),
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
