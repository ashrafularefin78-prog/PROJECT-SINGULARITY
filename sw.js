/**
 * M6 - Service worker: the offline shell.
 *
 * Every path in this file is RELATIVE to the worker's own location. That
 * matters: the app is deployed under a subpath (https://host/PROJECT-SINGULARITY/),
 * and absolute paths like '/index.html' would resolve to the host root, where
 * nothing exists - the install would reject and offline would silently never
 * work. Relative paths make the same worker correct at '/', at
 * '/PROJECT-SINGULARITY/' and at any other mount point, with no build step.
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
const VERSION = 'singularity-v9';

/** Resolve a shell path against this worker's directory, so subpaths work. */
const here = (path) => new URL(path, self.location.href).href;

const SHELL = [
  './',
  './index.html',
  './styles/app.css',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/models/singularity-core.glb',
  './assets/probes/singularity-sky.hdr',
  './src/app.js',
  './src/boot-note.js',
  './src/security/policy.js',
  './src/ui/hud.js',
  './src/ui/motion.js',
  './src/ui/substrate.js',
  './src/ui/a11y-contract.js',
  './src/ui/constellation.js',
  './src/crdt/rga.js',
  './src/crdt/history.js',
  './src/collab/mesh.js',
  './src/collab/topology.js',
  './src/collab/webrtc.js',
  './src/collab/relay.js',
  './src/storage/db.js',
  './src/storage/opfs.js',
  './src/crypto/e2ee.js',
  './src/runtime/sandbox.js',
  './src/runtime/worker.js',
  './src/runtime/interpreter.js',
  './src/runtime/parser.js',
  './src/runtime/lexer.js',
  './src/runtime/preprocess.js',
  './src/graphics/renderer.js',
  './src/graphics/math.js',
  './src/graphics/gltf.js',
  './src/graphics/hdr.js',
  './src/graphics/env.js',
].map(here);

const SHELL_INDEX = here('./index.html');
const SHELL_ROOT = here('./');

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

/**
 * Cache keys are always the worker's own absolute URL. Requests that differ
 * only in irrelevant parts (a cache-busting query, the hash) still hit, which
 * is what keeps a `?v=2` deep link offline-capable.
 */
function cacheKey(request) {
  const url = new URL(request.url);
  url.hash = '';
  return url.href;
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && fresh.type === 'basic') cache.put(cacheKey(request), fresh.clone());
    return fresh;
  } catch {
    const hit = await cache.match(cacheKey(request));
    if (hit) return hit;
    if (request.mode === 'navigate') {
      // Navigation fallback: the shell, whatever the router-style path was.
      return (await cache.match(SHELL_INDEX)) || (await cache.match(SHELL_ROOT)) || Response.error();
    }
    return new Response('offline and not cached', { status: 504, statusText: 'Offline' });
  }
}

async function cacheFirst(event, request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(cacheKey(request));
  if (hit) {
    // Refresh in the background; never block a render on the network.
    event.waitUntil(
      fetch(request)
        .then((res) => (res && res.ok && res.type === 'basic' ? cache.put(cacheKey(request), res.clone()) : null))
        .catch(() => null),
    );
    return hit;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') cache.put(cacheKey(request), res.clone());
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
  // Never intercept the worker itself or Range requests; streaming media and
  // partial reads must go straight to the network.
  if (request.headers.has('range')) return;
  if (url.pathname === new URL(self.location.href).pathname) return;

  const networkFirstMode = NETWORK_FIRST.has(request.destination) || request.mode === 'navigate';
  event.respondWith(networkFirstMode ? networkFirst(request) : cacheFirst(event, request));
});
