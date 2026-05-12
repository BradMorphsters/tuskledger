/**
 * Tusk Ledger service worker — minimal app-shell cache for the
 * iPhone home-screen install case.
 *
 * Why a service worker at all: Vite ships a pile of hashed JS/CSS
 * chunks. On every cold launch, the phone re-fetches them across the
 * LAN. With a SW, we cache the shell on first hit so subsequent
 * launches paint immediately even if the laptop's Vite dev server is
 * mid-restart. (For prod builds the same principle holds.)
 *
 * What we DO cache:
 *   - The hashed JS/CSS chunks under /assets/ (immutable by hash)
 *   - The icon set under /icons/
 *   - The manifest itself
 *
 * What we DO NOT cache:
 *   - /api/* — always go to network. Stale financial data is worse
 *     than a network error; the user needs to know if their balance
 *     view is from yesterday.
 *   - / (the HTML entry) — network-first with cache fallback. We want
 *     the latest index.html (which references the latest hashed
 *     bundles) when online; only fall back to cached HTML if offline.
 *   - POST/PUT/DELETE — never. SW spec lets you, but caching mutations
 *     is a footgun.
 *   - /api/auth/* and anything with an Authorization header — also
 *     never cached, just to be paranoid even though the /api/ rule
 *     above already covers it.
 *
 * Cache versioning: bump CACHE_VERSION when changing this file's
 * caching behavior. The activate handler sweeps any cache that
 * doesn't match. Hashed asset URLs handle bundle invalidation on
 * their own.
 */

const CACHE_VERSION = 'tuskledger-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;

// Resources to prefetch on install. Keep this list short — it blocks
// the install handler. Hashed bundles get cached lazily on first
// fetch instead of being prefetched.
const SHELL_URLS = [
  '/manifest.webmanifest',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // skipWaiting so the new SW activates immediately on first install
  // and on each version bump. Without it the user has to close every
  // tab to pick up updates — fine for big apps with reload prompts,
  // overkill here.
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Sweep any caches from prior versions
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      );
      // Take control of any open clients (tabs) without waiting for
      // them to navigate.
      await self.clients.claim();
    })(),
  );
});

/**
 * Returns true if a request is safe to serve from cache.
 * Restrictive on purpose — when in doubt, go to network.
 */
function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  // Same-origin only — never cache cross-origin (Plaid CDN, fonts, etc.)
  if (url.origin !== self.location.origin) return false;
  // Never cache API responses
  if (url.pathname.startsWith('/api/')) return false;
  // Never cache requests with auth headers
  if (request.headers.get('Authorization')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheableRequest(request)) return; // pass through to default

  const url = new URL(request.url);

  // Hashed assets (Vite emits /assets/*.hash.{js,css}) — cache-first.
  // The filename hash means a content change is a URL change; safe to
  // cache forever and let Vite's hash bust it.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // HTML entry / navigation requests — network-first so the latest
  // index.html (with the latest bundle hash refs) wins when online.
  // Only fall back to cache if the network actually fails.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(networkFirst(request));
    return;
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const resp = await fetch(request);
    // Only cache OK responses; don't poison cache with 404s.
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch (err) {
    // Network failed and nothing cached — surface the error.
    throw err;
  }
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}
