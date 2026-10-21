/**
 * A dependency-free Chrome DevTools Protocol client (M0 verification tooling).
 *
 * The challenge forbids npm libraries, and the measurement work needs a real
 * browser: headless WebGL2 tests, a Slow-4G LCP run, a memory soak and an
 * accessibility-tree audit. So this is a small CDP client built on Node's own
 * `fetch` and `WebSocket` globals - no packages, nothing to install.
 *
 * It launches the browser that is already on the machine (Edge or Chrome),
 * attaches to a page target in flattened session mode, and exposes:
 *   session.evaluate(expr)      run JS in the page, awaiting promises
 *   session.send(method, args)  any raw CDP command
 *   session.waitFor(predicate)  poll a page expression until it is truthy
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Candidate browser binaries, in preference order (env override wins). */
const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

export function findBrowser() {
  for (const path of CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  throw new Error(
    'no Chromium-based browser found. Set BROWSER_PATH to the executable ' +
      '(Edge or Chrome), e.g. BROWSER_PATH="/usr/bin/chromium" npm run test:browser',
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A page target attached in flattened session mode. */
export class Session {
  constructor(ws, sessionId, browser) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.browser = browser;
    this.listeners = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
  }

  send(method, params = {}, { timeoutMs = 30000 } = {}) {
    // Requests and responses share one id space on one socket, so the pending
    // table lives on the browser connection, not on the session.
    return this.browser.request(method, params, this.sessionId, timeoutMs);
  }

  on(method, handler) {
    const list = this.listeners.get(method) || [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  /** Run an expression in the page and return its value (promises awaited). */
  async evaluate(expression, { awaitPromise = true, timeoutMs } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
        userGesture: true,
      },
      // A long-lived soak drives an app whose main thread is genuinely busy
      // (software-GL 3D frames, module teardown), so the default 30 s is not
      // enough headroom. Callers can raise it per call.
      timeoutMs ? { timeoutMs } : undefined,
    );
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`page exception: ${text}`);
    }
    return res.result ? res.result.value : undefined;
  }

  /** Poll a page expression until it returns a truthy value. */
  async waitFor(expression, { timeoutMs = 30000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression} (last: ${last})`);
      await sleep(intervalMs);
    }
  }

  async navigate(url) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', { timeoutMs: 60000 });
  }

  /** Close the tab this session is attached to. */
  async closeTab() {
    try {
      await this.browser.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      /* the browser is going away anyway */
    }
  }
}

export class Browser {
  constructor(proc, port, userDataDir) {
    this.proc = proc;
    this.port = port;
    this.userDataDir = userDataDir;
    this.ws = null;
    this.pending = new Map();
    this.listener = null;
    this.nextId = 1;
    this.sessions = new Map();
  }

  /**
   * Launch the browser, preferring headless.
   *
   * If the headless launch fails - and on this machine it does fail in a
   * specific way: `msedge --headless=new` exits 0 immediately without printing
   * "DevTools listening on ...", so the wait below rejects - fall back to a
   * real window pushed off the visible desktop. Every measurement tool here is
   * run through this one function, so a headless-only failure would otherwise
   * take the whole test suite and the soak with it. The retry is logged rather
   * than silent, because the knob it changes is visible to the user.
   */
  static async launch(options = {}) {
    const { allowWindowed = true, ...rest } = options;
    try {
      return await Browser.launchOnce({ ...rest, headless: true });
    } catch (err) {
      if (!allowWindowed) throw err;
      console.warn(
        `# headless launch failed (${err && err.message ? err.message.split('\n')[0] : err}); retrying in a window`,
      );
      return Browser.launchOnce({
        ...rest,
        headless: false,
        extraArgs: [...(rest.extraArgs || []), '--window-position=-2400,-1600'],
      });

    }
  }

  static async launchOnce({
    headless = true,
    width = 412,
    height = 915,
    scale = 2,
    extraArgs = [],
    softwareGl = false,
    env = {},
  } = {}) {
    const exe = findBrowser();
    // The profile is a throwaway browser user-data-dir, so it belongs in the
    // system temp directory and never in the working tree: a profile created
    // here is a full Chrome profile (cookies, history, Login Data, crash dumps)
    // and a `git add -A` from that tree would publish it. See .gitignore.
    const profile = mkdtempSync(join(tmpdir(), 'singularity-cdp-'));
    const args = [
      '--remote-debugging-port=0',
      // Chrome 111+ refuses WebSocket handshakes to the debug port unless the
      // client's Origin is allowed; node's WebSocket sends none, so allow all.
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // This host runs the browser under a restricted token: the renderer
      // sandbox cannot create its process ("Failed to create IAppCapability:
      // Access is denied"), so every page target gets pid 0 and Page.enable
      // never answers. Disabling the browser's own sandbox is a test-harness
      // concession, not an app one - this launches a throwaway profile against
      // localhost, and the page under test still ships its own CSP and Trusted
      // Types. Without the flag, every browser-driven tool times out here.
      '--no-sandbox',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
      `--window-size=${width},${height}`,
      // Software WebGL2 is opt-in. It is what makes the 3D tests and the
      // recorded demo run in a headless browser, but forcing it makes *every*
      // paint a software rasterisation: measured first contentful paint on the
      // same page was 286 ms with SwiftShader and 118 ms without, which is the
      // difference between a performance number about this app and a
      // performance number about the rasteriser. So the WebGL callers ask for
      // it (see tools/browser-run.js, tools/demo.js) and the measurement tools
      // get the browser's default raster path, as a stock Lighthouse does.
      ...(softwareGl
        ? ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
        : []),
      'about:blank',
    ];
    if (headless) args.unshift('--headless=new');
    args.push(...extraArgs);

    const proc = spawn(exe, args, {
      // stdio is ignored, not piped: the endpoint is discovered from the
      // DevToolsActivePort file below, and piping the child's stdio fails on
      // hosts where a sandbox forbids named pipes. The child is detached so
      // the browser survives even where a sandbox job object would otherwise
      // terminate GUI children launched straight from CreateProcess (the
      // launcher exits with STATUS_BREAKPOINT and no port file on such
      // hosts); the caller still owns the handle and kills it in close().
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, ...env },
    });

    // The endpoint arrives through the DevToolsActivePort file inside the
    // profile. This is the mechanism that matters, because current Edge on
    // Windows launches a stub that writes the file and then exits 0
    // immediately (no stderr line at all, in headless and windowed mode
    // alike). Treating that exit as a failed launch is what broke every
    // browser-driven tool on this machine until it was measured with
    // .tools/scratch/launch-probe.mjs: the browser was alive the whole time.
    const portFile = join(profile, 'DevToolsActivePort');
    const readPortFile = () => {
      try {
        const [port, path] = readFileSync(portFile, 'utf8').split('\n');
        if (port && path) return `ws://127.0.0.1:${Number(port)}${path.trim()}`;
      } catch {
        /* the file is not written yet */
      }
      return null;
    };
    const wsUrl = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(reject, new Error('browser did not start: no DevToolsActivePort file appeared')), 30000);
      const poll = setInterval(() => {
        const url = readPortFile();
        if (url) finish(resolve, url);
      }, 200);
      function finish(settle, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        settle(value);
      }
      proc.on('exit', (code) => {
        // The launcher exiting is not the browser exiting: give the profile a
        // moment to publish its port before calling this a failure. A browser
        // that really failed never writes the file, so the retry still happens.
        setTimeout(() => {
          const url = readPortFile();
          if (url) finish(resolve, url);
          else finish(reject, new Error(`browser exited with code ${code} and published no DevToolsActivePort`));
        }, 3000);
      });
    });

    const port = Number(new URL(wsUrl).port);
    const browser = new Browser(proc, port, profile);
    await browser.connect(wsUrl, scale);
    return browser;
  }

  async connect(wsUrl, scale = 2) {
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    this.ws.addEventListener('message', (event) => this._dispatch(String(event.data)));
    this.scale = scale;
  }

  /**
   * Kill anything still running against this run's profile directory.
   *
   * The profile is a unique temp directory created for this launch, so a match
   * on that path can only be a browser this object started - never the user's
   * own Edge window. `Browser.close` usually does the job; this is the belt for
   * the cases where it does not answer, and it is what keeps repeated tool runs
   * from stacking dozens of orphaned renderer processes on the machine.
   */
  sweepProfile() {
    if (process.platform !== 'win32' || !this.userDataDir) return;
    try {
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\' or Name=\'chrome.exe\'" | ' +
            'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:SINGULARITY_PROFILE) } | ' +
            'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
        ],
        { env: { ...process.env, SINGULARITY_PROFILE: this.userDataDir }, timeout: 20000, stdio: 'ignore' },
      );
    } catch {
      /* a swept profile is best effort: the temp directory is removed next */
    }
  }

  _dispatch(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
      else entry.resolve(msg.result);
      return;
    }
    const session = this.sessions.get(msg.sessionId);
    if (session && session.listener) session.listener(msg);
  }

  request(method, params = {}, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  send(method, params = {}, options) {
    return this.request(method, params, undefined, options?.timeoutMs);
  }

  /** Open a tab and attach to it in flattened session mode. */
  async newSession(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const session = new Session(this.ws, sessionId, this);
    session.targetId = targetId;
    session.listener = (msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        session.consoleErrors.push(
          msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
        );
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        session.pageErrors.push(
          msg.params.exceptionDetails.exception?.description ||
            msg.params.exceptionDetails.text ||
            'unknown page error',
        );
      }
      for (const handler of session.listeners.get(msg.method) || []) {
        handler(msg.params);
      }
    };
    this.sessions.set(sessionId, session);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Log.enable');
    if (session.scale == null) session.scale = this.scale;
    return session;
  }

  async close() {
    // Ask the browser to shut itself down before tearing the socket down. With
    // the launcher-stub behaviour above, the process we spawned is already gone
    // and `proc.kill()` would hit nothing, leaving a browser and its renderers
    // on the machine (32 of them survived one killed run before this existed).
    try {
      await this.send('Browser.close', {}, { timeoutMs: 5000 });
    } catch {
      /* already gone, or too old to answer */
    }
    this.sweepProfile();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    // The child's stdio pipes keep the Node event loop alive after the process
    // is gone, which would make every driver script hang at exit (and lose its
    // piped stdout). Tear them down explicitly.
    for (const stream of [this.proc.stdin, this.proc.stdout, this.proc.stderr]) {
      try {
        stream?.destroy();
      } catch {
        /* ignore */
      }
    }
    this.proc.unref?.();
    await sleep(600);
    this.sweepProfile();
    try {
      rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a locked profile directory is not worth failing a test run over */
    }
  }
}

/** A static file server for the project, on a free port. */
export async function serveProject({ port = 0 } = {}) {
  const { createServer } = await import('node:http');
  const { readFile, stat } = await import('node:fs/promises');
  const { extname, join, normalize, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const target = join(ROOT, normalize(pathname).replace(/^([/\\])+/, ''));
      if (!target.startsWith(ROOT)) return void res.writeHead(403).end('Forbidden');
      let info;
      try {
        info = await stat(target);
      } catch {
        return void res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      }
      const file = info.isDirectory() ? join(target, 'index.html') : target;
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('Server error: ' + err.message);
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return { server, port: actual, origin: `http://127.0.0.1:${actual}` };
}

/**
 * Start the project's own dev server (tools/serve.js) and wait until it answers.
 * Measurement tools use this rather than an ad-hoc server so they measure the
 * headers and CSP the app actually ships with. PORT from the environment is
 * overridden deliberately: the host sets PORT=0, which would bind an ephemeral
 * port the caller cannot predict.
 */
export async function startProjectServer({ port = 5199 } = {}) {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const proc = spawn(process.execPath, [resolve(root, 'tools/serve.js'), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: root,
    env: { ...process.env, PORT: String(port) },
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(origin + '/', { redirect: 'manual' });
      if (res.status < 500) return { proc, origin };
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`the project server at ${origin} did not answer within 20s`);
    }
    await sleep(200);
  }
}

/** `--flag=value` style argument parsing, shared by the tools/*.js drivers. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(arg);
  }
  return out;
}
