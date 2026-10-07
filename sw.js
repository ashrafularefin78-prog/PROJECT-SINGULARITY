/**
 * M6 - Service worker: the offline shell.
 *
 * Strategy:
 *   - install : precache the whole app shell (there are no dependencies to
 *               fetch, so the shell is small and known at build time)
 *   - activate: drop previous versions, take control of open pages
 *   - fetch   : same-origin GETs only, in two modes. Documents, scripts and
 *               styles are NETWORK-FIRST with a cache fallback, so a deploy is
 *               picked up on the next load instead of being pinned behind a
 *               stale cache. Everything else is cache-first for speed. Either
 *               way, a reload with no network still boots the whole app.
 *
 * All user data lives in IndexedDB and is never touched here, so a cache
 * eviction can never cost anyone a character.
 */
const VERSION = 'singularity-v4';
const SHELL = [
  '/',
  '/index.html',
  '/styles/app.css',
  '/manifest.webmanifest',
  '/assets/icon.svg',
  '/src/app.js',
  '/src/boot-note.js',
  '/src/security/policy.js',
  '/src/crdt/rga.js',
  '/src/collab/mesh.js',
  '/src/storage/db.js',
  '/src/crypto/e2ee.js',
  '/src/runtime/sandbox.js',
  '/src/runtime/worker.js',
  '/src/runtime/interpreter.js',
  '/src/runtime/parser.js',
  '/src/runtime/lexer.js',
  '/src/graphics/renderer.js',
  '/src/graphics/math.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // addAll is atomic: if one asset fails, the install fails loudly rather
      // than shipping a half-cached shell that breaks offline later.
      await cache.addAll(SHELL);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

const NETWORK_FIRST = new Set(['document', 'script', 'style', 'manifest', 'worker']);

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && fresh.type === 'basic') cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (request.mode === 'navigate') {
      return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
    }
    return new Response('offline and not cached', { status: 504, statusText: 'Offline' });
  }
}

async function cacheFirst(event, request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) {
    // Refresh in the background; never block a render on the network.
    event.waitUntil(
      fetch(request)
        .then((res) => (res && res.ok && res.type === 'basic' ? cache.put(request, res.clone()) : null))
        .catch(() => null),
    );
    return hit;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
    return res;
  } catch {
    return new Response('offline and not cached', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const networkFirstMode = NETWORK_FIRST.has(request.destination) || request.mode === 'navigate';
  event.respondWith(networkFirstMode ? networkFirst(request) : cacheFirst(event, request));
});
