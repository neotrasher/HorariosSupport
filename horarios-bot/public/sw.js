/**
 * Service worker for Horarios Support PWA.
 *
 * Strategy:
 *  - Static assets (manifest, icons, fonts CDN, tailwind, htmx): cache-first.
 *  - HTML / API: network-first with offline fallback (no stale data).
 *  - Auth/login flow is bypassed (always network) to avoid stale sessions.
 *  - Bump CACHE_VERSION when shipping breaking changes; old caches get pruned.
 */
const CACHE_VERSION = 'v1';
const STATIC_CACHE = `horarios-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `horarios-runtime-${CACHE_VERSION}`;

const STATIC_PRECACHE = [
  '/static/manifest.webmanifest',
  '/static/icon.svg',
  '/static/icon-maskable.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(c => c.addAll(STATIC_PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Bypass auth flow + ICS feed + healthcheck (always network)
  if (
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/cal/') ||
    url.pathname === '/health'
  ) {
    return;
  }

  // CDN assets (Inter font, Tailwind, htmx) → cache-first
  if (
    url.origin !== self.location.origin &&
    (url.host.includes('googleapis.com') ||
     url.host.includes('gstatic.com') ||
     url.host.includes('cdn.tailwindcss.com') ||
     url.host.includes('unpkg.com'))
  ) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Same-origin static assets → cache-first
  if (url.origin === self.location.origin && url.pathname.startsWith('/static/')) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // HTML pages → network-first with cache fallback
  if (req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE));
    return;
  }

  // Default: network-first
  event.respondWith(networkFirst(req, RUNTIME_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    return cached || new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Final offline fallback for HTML
    if (req.headers.get('accept')?.includes('text/html')) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
        '<div style="font-family:system-ui;padding:2rem;text-align:center">' +
        '<h1>Sin conexión</h1><p>No se pudo cargar esta página.</p>' +
        '<p><button onclick="location.reload()">Reintentar</button></p></div>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
    return new Response('Offline', { status: 503 });
  }
}
