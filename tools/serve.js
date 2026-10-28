// Dependency-free static server used only for local development / verification.
// It mirrors the production security headers (M8) so the app is tested under the
// same policy it ships with, and it compresses text the way the hosts do, so a
// local Lighthouse run measures the bytes a visitor actually downloads instead
// of the uncompressed ones on disk. Zero runtime dependencies - Node built-ins
// only.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersFor, loadHeaderRules } from './headers.js';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
// Explicit argument beats the environment (an inherited PORT=0 would otherwise
// silently bind an ephemeral port), and 0 means "any free port" on purpose.
const ARG = process.argv[2];
const PORT = ARG !== undefined && ARG !== '' ? Number(ARG) : Number(process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// M8: the policy lives in `_headers`, the same file Cloudflare Pages and
// Netlify serve. Reading it here (rather than keeping a second copy in this
// file) means the local server, the tests and the deployed site cannot drift
// apart - and a header added for production is exercised locally first.
const HEADER_RULES = loadHeaderRules();
if (!HEADER_RULES.length) {
  console.warn('warning: no _headers rules found; serving without the security policy');
} else {
  console.log(`policy: ${HEADER_RULES.length} rule sets from _headers`);
}

// Optional relay mount for local development, mirroring tools/serve.py: with
// SINGULARITY_RELAY=http://127.0.0.1:8890 the node's routes are reachable at
// this origin's /relay/*, which is how a deployment mounts them and the only
// thing the browser can reach under the app's `connect-src 'self'`. Loopback
// only: this is a development convenience, not a forward proxy.
let RELAY = (process.env.SINGULARITY_RELAY || '').replace(/\/+$/, '');
if (RELAY && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(RELAY)) {
  console.warn(`warning: SINGULARITY_RELAY must be a loopback origin; ignoring ${RELAY}`);
  RELAY = '';
}
if (RELAY) console.log(`relay: /relay/* proxies to ${RELAY}`);

// Brotli/gzip for the text types, mirroring what Cloudflare Pages and Netlify
// do at the edge. Without this, `uses-text-compression` in Lighthouse would be
// failing for the dev server alone and every byte-inflated metric (LCP above
// all) would measure the local rig rather than the deployed site. Binary types
// and responses under 1 KiB are passed through untouched; the cache is keyed by
// path, size and mtime so an edited file is never served from a stale entry.
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 1024;
const compressed = new Map();

function chooseEncoding(req) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

function compress(path, info, encoding, body) {
  const key = `${path}:${info.size}:${info.mtimeMs}:${encoding}`;
  const hit = compressed.get(key);
  if (hit) return hit;
  const out = encoding === 'br' ? brotliCompressSync(body) : gzipSync(body, { level: 9 });
  compressed.set(key, out);
  return out;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    // WHATWG URL parsing normalizes literal backslashes; decoded ones would
    // become separators on Windows. Deny both before proxying or path mapping.
    if (req.url.split(/[?#]/, 1)[0].includes('\\') || pathname.includes('\\')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    if (RELAY && (pathname === '/relay' || pathname.startsWith('/relay/'))) {
      const res2 = await new Promise((resolvePromise) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolvePromise(chunks));
      });
      const body = res2.length ? Buffer.concat(res2) : undefined;
      try {
        const upstream = await fetch(RELAY + pathname + url.search, {
          method: req.method,
          headers: body ? { 'content-type': String(req.headers['content-type'] || 'application/json') } : undefined,
          body,
        });
        const payload = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
        });
        res.end(payload);
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `relay node unreachable: ${err.message}` }));
      }
      return;
    }
    // M8 (OWASP ZAP finding 40035): the repository root is served in
    // development, so dot-files such as `.git/config` must not be readable.
    // A hosted deployment does not publish them; the dev server should not
    // either. Reject any dot segment and the two generated directories.
    const segments = pathname.split('/').filter(Boolean);
    if (segments.some((s) => s.startsWith('.') || s === 'node_modules' || s === '__pycache__')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = join(ROOT, normalize(pathname).replace(/^([/\\])+/, ''));
    const fromRoot = relative(ROOT, target);
    // A string prefix also accepts ROOT-sibling directories. A relative path
    // detects those escapes, including Windows drive/UNC changes.
    if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let info;
    try {
      info = await stat(target);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    const contentType = TYPES[extname(file)] || 'application/octet-stream';
    const headers = {
      'content-type': contentType,
      // Development keeps everything fresh; the host honours the Cache-Control
      // rules in _headers, which would otherwise pin edited files for 300s.
      'cache-control': 'no-store',
    };
    let payload = body;
    const encoding = COMPRESSIBLE.test(contentType) && body.length >= MIN_COMPRESS_BYTES ? chooseEncoding(req) : null;
    if (encoding) {
      payload = compress(file, info, encoding, body);
      headers['content-encoding'] = encoding;
      headers.vary = 'accept-encoding';
    }
    headers['content-length'] = payload.length;
    for (const { name, value } of headersFor(HEADER_RULES, pathname)) {
      if (name.toLowerCase() === 'cache-control') continue;
      headers[name.toLowerCase()] = value;
    }
    res.writeHead(200, headers);
    res.end(payload);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Server error: ' + err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // Report the port actually bound, which matters when PORT was 0.
  const bound = server.address().port;
  console.log(`Project Singularity dev server: http://127.0.0.1:${bound}/`);
});
