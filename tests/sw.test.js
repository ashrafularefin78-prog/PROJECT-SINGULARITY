/**
 * M6 - Service worker shell completeness.
 *
 * The worker precaches the whole application shell, because there is no build
 * step that could generate that list for us. That makes the list a hand-kept
 * inventory, and an inventory drifts: a module added to src/ but not to SHELL
 * ships fine online and then fails offline, which is the one moment the
 * offline tier is supposed to work. These checks walk the real import graph and
 * compare it with sw.js, in Node (readFileSync) and in the browser (fetch), so
 * the drift fails a test instead of a demo.
 */
import { test, assert, assertEquals } from './harness.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

async function readText(relative) {
  if (isNode) {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
  }
  const response = await fetch(new URL('../' + relative, import.meta.url));
  assert(response.ok, `${relative} is served: ${response.status}`);
  return response.text();
}

async function exists(relative) {
  if (isNode) {
    const { existsSync } = await import('node:fs');
    return existsSync(new URL('../' + relative, import.meta.url));
  }
  const response = await fetch(new URL('../' + relative, import.meta.url), { method: 'HEAD' });
  return response.ok;
}

const resolveRelative = (from, spec) => new URL(spec, 'https://x.invalid/' + from).pathname.slice(1);
const importSpecifiers = (source) => {
  const out = [];
  const stat = /(?:^|[\s;{(])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [stat, dyn]) {
    let m;
    while ((m = re.exec(source))) if (m[1].startsWith('.')) out.push(m[1]);
  }
  return out;
};

async function shell() {
  const source = await readText('sw.js');
  const block = source.match(/const SHELL = \[([\s\S]*?)\]\.map\(here\)/);
  assert(block, 'sw.js declares a SHELL array');
  const paths = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\.\//, ''));
  return { source, paths: new Set(paths) };
}

test('M6 service worker: every precached path exists', async () => {
  const { paths } = await shell();
  assert(paths.size > 20, 'the shell inventory is not empty');
  const missing = [];
  for (const path of paths) {
    if (path === '' || path === './') continue;
    if (!(await exists(path))) missing.push(path);
  }
  assert(missing.length === 0, `precache paths that do not exist: ${missing.join(', ')}`);
});

test('M6 service worker: the shell covers the whole import graph', async () => {
  const { paths } = await shell();
  const seen = new Set();
  const queue = ['src/boot-note.js', 'src/app.js'];
  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const source = await readText(relative);
    for (const spec of importSpecifiers(source)) queue.push(resolveRelative(relative, spec));
  }
  const missing = [...seen].filter((path) => !paths.has(path));
  assert(missing.length === 0, `modules reachable but not precached: ${missing.join(', ')}`);
  // The sandbox worker is spawned, not imported, so the graph walk cannot see
  // it; it must still be in the shell or M2 cannot run offline.
  assert(paths.has('src/runtime/worker.js'), 'the spawned worker is precached');
});

test('M6 service worker: the cache version supports source and built artifacts', async () => {
  const { source } = await shell();
  const version = source.match(/const VERSION = '([^']+)'/);
  const supported = /^singularity-(?:v\d+|[a-f0-9]{16})$/;
  assert(version, 'sw.js names a cache version');
  assert(supported.test(version[1]), `supported version: ${version[1]}`);
  assert(supported.test('singularity-v11'), 'source version is accepted');
  assert(supported.test('singularity-0123456789abcdef'), 'build content hash is accepted');
  for (const bad of ['singularity-', 'singularity-0123456789abcde', 'singularity-0123456789abcdef0', 'other-v11']) {
    assert(!supported.test(bad), `unsupported version: ${bad}`);
  }
});

test('M6 service worker: toolchain archives remain lazy, with their loaders in the shell', async () => {
  const { paths } = await shell();
  for (const path of ['src/runtime/clang-worker.js', 'src/runtime/clang.js', 'src/runtime/wasm-host.js', 'assets/toolchain/manifest.json']) {
    assert(paths.has(path), `${path} stays precached`);
  }
  assert(![...paths].some((path) => /^assets\/toolchain\/.*\.gz$/.test(path)), 'large archives are not precached');
});

// Exercise the real worker in an isolated Node VM, never the browser's live
// origin-wide CacheStorage. Server regressions belong here with delivery tests.
{
  const testNode = (name, fn) => test(name, fn, { needs: 'node' });
  const { runInNewContext } = isNode ? await import('node:vm') : {};
  const { spawn } = isNode ? await import('node:child_process') : {};
  const { createServer, request: httpRequest } = isNode ? await import('node:http') : {};
  const { createServer: createTCPServer } = isNode ? await import('node:net') : {};
  const { fileURLToPath } = isNode ? await import('node:url') : {};

  function memoryCaches() {
    const stores = new Map();
    const opened = [];
    const deleted = [];
    return {
      stores, opened, deleted,
      async open(name) {
        opened.push(name);
        if (!stores.has(name)) {
          const entries = new Map();
          stores.set(name, {
            entries,
            async addAll(urls) {
              for (const url of urls) entries.set(url, new Response('shell: ' + url));
            },
            async put(key, response) { entries.set(key, response.clone()); },
            async match(key) { return entries.get(key)?.clone(); },
          });
        }
        return stores.get(name);
      },
      async keys() { return [...stores.keys()]; },
      async delete(name) { deleted.push(name); return stores.delete(name); },
    };
  }

  async function worker(storage, directory, scope = directory, version) {
    let source = await readText('sw.js');
    if (version) source = source.replace(/const VERSION = '[^']+';/, `const VERSION = '${version}';`);
    const handlers = new Map();
    const location = new URL('sw.js', 'https://app.invalid' + directory);
    const network = { offline: false, requests: [] };
    let claims = 0;
    runInNewContext(source, {
      URL, Response, caches: storage,
      self: {
        location,
        registration: { scope: 'https://app.invalid' + scope },
        addEventListener: (type, handler) => handlers.set(type, handler),
        skipWaiting: async () => {},
        clients: { claim: async () => { claims += 1; } },
      },
      fetch: async (request) => {
        network.requests.push(request.url);
        if (network.offline) throw new Error('offline');
        const response = new Response('network: ' + directory + ' ' + request.url);
        Object.defineProperty(response, 'type', { value: 'basic' });
        return response;
      },
    });
    async function lifecycle(type) {
      let pending;
      handlers.get(type)({ waitUntil: (promise) => { pending = promise; } });
      assert(pending, `${type} extends its lifetime`);
      await pending;
    }
    return {
      network,
      async install() { await lifecycle('install'); return storage.opened.at(-1); },
      async activate() { await lifecycle('activate'); assertEquals(claims, 1, 'activation claims clients'); },
      async request(path, options = {}) {
        let response;
        const pending = [];
        handlers.get('fetch')({
          request: {
            url: new URL(path, location).href, method: 'GET', destination: '', mode: 'cors',
            headers: new Headers(), ...options,
          },
          respondWith: (promise) => { response = promise; },
          waitUntil: (promise) => pending.push(promise),
        });
        const result = await response;
        await Promise.all(pending);
        return result;
      },
    };
  }

  testNode('M6 service worker: activation deletes only proven predecessors in its own namespace', async () => {
    const storage = memoryCaches();
    const old = await worker(storage, '/app/', '/app/', 'singularity-v10');
    const oldKey = await old.install();
    const built = await worker(storage, '/app/', '/app/', 'singularity-0123456789abcdef');
    const builtKey = await built.install();
    const current = await worker(storage, '/app/', '/app/', 'singularity-v12');
    const currentKey = await current.install();
    const keep = [currentKey];
    for (const [directory, scope] of [['/', '/'], ['/sibling/', '/sibling/'], ['/app/', '/app/narrow/'], ['/app/nested/', '/app/']]) {
      keep.push(await (await worker(storage, directory, scope, 'singularity-v10')).install());
    }
    for (const name of ['unrelated-cache', 'singularity-v10', 'singularity-0123456789abcdef', currentKey.replace(/singularity-v12$/, 'unknown-owner')]) {
      await storage.open(name);
      keep.push(name);
    }
    assertEquals(new Set([oldKey, builtKey, ...keep]).size, keep.length + 2, 'directory, scope and version each qualify the cache');
    await current.activate();
    assertEquals(storage.deleted.sort().join('\n'), [oldKey, builtKey].sort().join('\n'), 'only this scope\'s source and built predecessors are removed');
    assertEquals((await storage.keys()).sort().join('\n'), keep.sort().join('\n'), 'siblings, other apps and legacy caches survive');

    const nextBuild = await worker(storage, '/app/', '/app/', 'singularity-fedcba9876543210');
    const nextKey = await nextBuild.install();
    await nextBuild.activate();
    assert(storage.deleted.includes(currentKey), 'built version retires the source predecessor');
    assert(storage.stores.has(nextKey), 'built version keeps its own cache');
    for (const key of keep.filter((key) => key !== currentKey)) assert(storage.stores.has(key), `${key} remains untouched`);
  });

  testNode('M6 service worker: runtime caches and navigation fallbacks are scope-isolated', async () => {
    const storage = memoryCaches();
    const a = await worker(storage, '/a/');
    const b = await worker(storage, '/b/');
    const aKey = await a.install();
    const bKey = await b.install();
    assert(aKey !== bKey, 'same version in sibling scopes has separate caches');
    for (const [app, directory, key] of [[a, '/a/', aKey], [b, '/b/', bKey]]) {
      const path = directory + 'src/app.js';
      const online = await app.request(path, { destination: 'script' });
      const text = await online.text();
      app.network.offline = true;
      assertEquals(await (await app.request(path, { destination: 'script' })).text(), text, 'network-first falls back to its own runtime cache');
      const navigation = await app.request(directory + 'deep/link?v=2', { mode: 'navigate', destination: 'document' });
      assertEquals(await navigation.text(), 'shell: https://app.invalid' + directory + 'index.html', 'offline navigation uses its own shell');
      assert(storage.stores.get(key).entries.has('https://app.invalid' + path), 'runtime write uses the install cache');
    }
    const opened = storage.opened.length;
    const requests = a.network.requests.length;
    for (const path of ['/b/src/app.js', '/a-sibling/index.html', '/src/app.js', 'https://other.invalid/a/index.html']) {
      assertEquals(await a.request(path, { destination: 'script' }), undefined, `${path} is not intercepted`);
    }
    assertEquals(storage.opened.length, opened, 'out-of-scope fetches never open a cache');
    assertEquals(a.network.requests.length, requests, 'out-of-scope fetches are left to the browser');

    const narrow = await worker(storage, '/a/', '/a/narrow/');
    await narrow.install();
    assertEquals(await narrow.request('/a/src/app.js'), undefined, 'registration scope is enforced even inside the worker directory');
    assert((await narrow.request('/a/narrow/file.txt')).ok, 'requests inside both boundaries work');
  });

  testNode('M6 service worker: root deployment lazily caches toolchain archives and preserves bypasses', async () => {
    const storage = memoryCaches();
    const app = await worker(storage, '/');
    const key = await app.install();
    const archive = 'https://app.invalid/assets/toolchain/clang.wasm.gz';
    assert(!storage.stores.get(key).entries.has(archive), 'install does not fetch the archive');
    const online = await app.request(archive);
    const bytes = await online.text();
    assert(storage.stores.get(key).entries.has(archive), 'first use caches the archive at runtime');
    app.network.offline = true;
    assertEquals(await (await app.request(archive)).text(), bytes, 'archive remains available offline');
    assert((await app.request('/src/app.js', { destination: 'script' })).ok, 'root shell fallback still works');
    const opened = storage.opened.length;
    for (const [path, options] of [['/sw.js', {}], [archive, { method: 'HEAD' }], [archive, { method: 'POST' }], [archive, { headers: new Headers({ range: 'bytes=0-31' }) }]]) {
      assertEquals(await app.request(path, options), undefined, 'worker, non-GET and Range requests bypass caching');
    }
    assertEquals(storage.opened.length, opened, 'bypasses do not open caches');
  });

  async function listen(server) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
  }

  async function startDeliveryServer(kind, prefix, relay) {
    let port = 0;
    if (kind === 'Python') {
      // The Python CLI reports its argument rather than an ephemeral bound port.
      const reservation = createTCPServer();
      port = await listen(reservation);
      await new Promise((resolve) => reservation.close(resolve));
    }
    const script = fileURLToPath(new URL(kind === 'Node' ? '../tools/serve.js' : '../tools/serve.py', import.meta.url));
    const command = kind === 'Node' ? process.execPath : (process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
    const args = [script, String(port)];
    if (kind === 'Python') args.push('--prefix', prefix, '--relay', relay);
    const proc = spawn(command, args, {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, SINGULARITY_RELAY: relay, SINGULARITY_PREFIX: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    proc.stderr.on('data', (chunk) => { errors += chunk; });
    try {
      port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`${kind} server did not start: ${errors}`)); }, 10000);
        const fail = (error) => { clearTimeout(timer); reject(error); };
        proc.once('error', fail);
        proc.once('exit', (code) => fail(new Error(`${kind} server exited (${code}): ${errors}`)));
        proc.stdout.on('data', (chunk) => {
          output += chunk;
          const match = output.match(/dev server: http:\/\/127\.0\.0\.1:(\d+)/);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
      });
    } catch (error) {
      proc.kill();
      throw error;
    }
    return {
      port,
      async stop() {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        const closed = new Promise((resolve) => proc.once('close', resolve));
        proc.kill();
        await closed;
      },
    };
  }

  function requestServer(port, path, method) {
    // http.request preserves literal backslashes and encoded traversal; fetch's
    // WHATWG URL normalization would hide the request we need to regress.
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error(`${method} ${path} timed out`)));
      req.end();
    });
  }

  async function serverRegressions(kind, prefix = '') {
    const relayed = [];
    const relay = createServer((req, res) => {
      relayed.push({ method: req.method, path: req.url });
      const payload = 'relay response';
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(payload) });
      res.end(req.method === 'HEAD' ? undefined : payload);
    });
    const relayPort = await listen(relay);
    let server;
    try {
      server = await startDeliveryServer(kind, prefix, `http://127.0.0.1:${relayPort}`);
      const mounts = prefix ? [prefix, prefix.replace('PROJECT', '%50ROJECT')] : [''];
      for (const mount of mounts) {
        for (const path of ['/.git/config', '/%2egit/config', '/.git%2fconfig', '/%2Egit%2Fconfig', '/.env', '/%2eenv', '/node_modules/package.json', '/src/__pycache__/serve.pyc', '/src%2f..%2f.git%2fconfig', '/src%5c..%5c.git%5cconfig', '/src%5C..%5C.git%5Cconfig', '/src\\..\\.git\\config', '/src%5csecurity%5cpolicy.js', '/src\\security\\policy.js']) {
          for (const method of ['GET', 'HEAD']) {
            const response = await requestServer(server.port, mount + path, method);
            assertEquals(response.status, 404, `${kind} ${method} ${mount + path} denies sensitive/ambiguous paths`);
            if (method === 'HEAD') assertEquals(response.body.length, 0, 'denied HEAD has no body');
          }
        }
        for (const path of ['/', '/index.html', '/src/security/policy.js', '/src/%73ecurity/policy.js', '/styles/app.css', '/assets/icon.svg']) {
          const get = await requestServer(server.port, mount + path, 'GET');
          const head = await requestServer(server.port, mount + path, 'HEAD');
          assertEquals(get.status, 200, `${kind} GET ${mount + path} still serves normal files`);
          assertEquals(head.status, 200, `${kind} HEAD ${mount + path} still serves normal files`);
          assertEquals(head.body.length, 0, 'normal HEAD has no body');
          assertEquals(head.headers['content-type'], get.headers['content-type'], 'GET/HEAD agree on MIME type');
          assertEquals(Number(get.headers['content-length']), get.body.length, 'static responses advertise the exact body length');
          assertEquals(head.headers['content-length'], get.headers['content-length'], 'HEAD advertises the GET body length');
          const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
          assertEquals(get.body.toString(), await readText(relative), 'normal GET returns the unchanged file');
        }
        const archive = await requestServer(server.port, mount + '/assets/toolchain/memfs.wasm.gz', 'GET');
        const manifest = JSON.parse(await readText('assets/toolchain/manifest.json'));
        assertEquals(archive.status, 200, 'compressed compiler assets are served');
        assertEquals(archive.body.length, manifest.files['memfs.wasm'].gzipBytes, 'compressed asset size matches its manifest');
        assertEquals(Number(archive.headers['content-length']), archive.body.length, 'compiler asset length is explicit');
        assertEquals(archive.body[0], 0x1f, 'compiler assets remain gzip bytes');
        assertEquals(archive.body[1], 0x8b, 'compiler assets are not transparently decompressed');
        if (kind === 'Node') assertEquals(archive.headers['content-type'], 'application/gzip', 'Node declares the archive MIME type');
        for (const method of ['GET', 'HEAD']) {
          const response = await requestServer(server.port, mount + '/relay/ping', method);
          assertEquals(response.status, 200, 'normal relay requests still work');
          assertEquals(relayed.at(-1).method, method, 'relay receives the original method');
          assertEquals(response.body.toString(), method === 'HEAD' ? '' : 'relay response', 'relay HEAD is bodyless');
        }
        const before = relayed.length;
        for (const path of ['/relay/%5c../ping', '/relay/\\../ping']) {
          for (const method of ['GET', 'HEAD', 'POST']) {
            assertEquals((await requestServer(server.port, mount + path, method)).status, 404, 'backslash is denied before relay proxying');
          }
        }
        assertEquals(relayed.length, before, 'ambiguous paths never reach the relay');
        if (prefix) {
          for (const method of ['GET', 'HEAD']) {
            const response = await requestServer(server.port, mount + '?v=2', method);
            assertEquals(response.status, 301, 'bare Python prefix redirects for GET and HEAD');
            assertEquals(response.headers.location, prefix + '/', 'GET/HEAD use the same prefix redirect');
          }
        }
      }
      if (prefix) {
        const before = relayed.length;
        for (const method of ['GET', 'HEAD']) {
          for (const path of ['/index.html', prefix + '-sibling/index.html', prefix + '-sibling/relay/ping']) {
            assertEquals((await requestServer(server.port, path, method)).status, 404, 'Python does not map routes outside its prefix');
          }
        }
        assertEquals(relayed.length, before, 'prefix lookalikes never reach the relay');
      }
    } finally {
      if (server) await server.stop();
      await new Promise((resolve) => relay.close(resolve));
    }
  }

  testNode('delivery server: Node denies plain/encoded GET/HEAD paths before mapping or proxying', () => serverRegressions('Node'));
  testNode('delivery server: Python root denies plain/encoded GET/HEAD paths and preserves normal files', () => serverRegressions('Python'));
  testNode('delivery server: Python prefix shares GET/HEAD denial, mapping and redirect behavior', () => serverRegressions('Python', '/PROJECT-SINGULARITY'));
}
