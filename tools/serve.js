// Dependency-free static server used only for local development / verification.
// It mirrors the production security headers (M8) so the app is tested under the
// same policy it ships with. Zero runtime dependencies - Node built-ins only.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = join(ROOT, normalize(pathname).replace(/^([/\\])+/, ''));
    if (!target.startsWith(ROOT)) {
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
    const headers = {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      // Development keeps everything fresh; the host honours the Cache-Control
      // rules in _headers, which would otherwise pin edited files for 300s.
      'cache-control': 'no-store',
    };
    for (const { name, value } of headersFor(HEADER_RULES, pathname)) {
      if (name.toLowerCase() === 'cache-control') continue;
      headers[name.toLowerCase()] = value;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Server error: ' + err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // Report the port actually bound, which matters when PORT was 0.
  const bound = server.address().port;
  console.log(`Project Singularity dev server: http://127.0.0.1:${bound}/`);
});
