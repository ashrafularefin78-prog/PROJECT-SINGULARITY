import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, parseArgs, startProjectServer } from './cdp.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = parseArgs();
const APP_PORT = Number(args['app-port'] || 5231);
const RELAY_PORT = Number(args['relay-port'] || 8891);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];

function check(id, area, attempt, expected, observed, ok) {
  const entry = { id, area, attempt, expected, observed, ok: Boolean(ok) };
  checks.push(entry);
  console.log(`  ${entry.ok ? 'PASS' : 'FAIL'} ${id}  ${area}: ${attempt}`);
  if (!entry.ok) console.log(`       observed: ${JSON.stringify(observed)}`);
}

function gitValue(command) {
  try {
    return execSync(command, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (statSync(full).isFile()) out.push(full);
  }
  return out;
}

async function waitForRelay(origin) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(origin + '/relay/stats');
      if (res.ok) return await res.json();
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`relay at ${origin} did not answer within 15s`);
    await sleep(150);
  }
}

async function post(origin, body) {
  const res = await fetch(origin + '/relay/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* response was not JSON */
  }
  return { status: res.status, json };
}

async function relayChecks(relayOrigin, dataDir) {
  const valid = await post(relayOrigin, {
    to: 'rt-peer',
    from: 'rt-sender',
    ct: 'Q0lQSEVSVEVYVA==',
    header: { kind: 'probe' },
    plaintext: 'REDTEAM_CANARY_PLAINTEXT',
    message: 'REDTEAM_CANARY_MESSAGE',
  });
  check(
    'RT-R1',
    'relay contract',
    'post an envelope with extra plaintext fields',
    'accepted, but extras dropped',
    valid,
    valid.status === 200 && valid.json?.ok === true,
  );

  const drained = await fetch(relayOrigin + '/relay/drain?peer=rt-peer').then((r) => r.json());
  const envelope = drained.envelopes?.[0];
  const keys = envelope ? Object.keys(envelope).sort() : [];
  check(
    'RT-R2',
    'relay contract',
    'drain the envelope and list the fields the relay returns',
    'to, from, ct, relayedAt, header only',
    { keys, envelope },
    keys.join(',') === 'ct,from,header,relayedAt,to',
  );

  const stored = filesUnder(dataDir).map((file) => readFileSync(file, 'utf8')).join('\n');
  check(
    'RT-R3',
    'relay contract',
    'search the durable log for the canary and the extra fields',
    'no plaintext canary or extra-field names stored',
    {
      canary: stored.includes('REDTEAM_CANARY'),
      plaintextField: stored.includes('plaintext'),
      messageField: stored.includes('message'),
      bytes: stored.length,
    },
    !stored.includes('REDTEAM_CANARY') && !stored.includes('plaintext') && !stored.includes('message'),
  );

  const traversal = await post(relayOrigin, { to: '../etc', from: 'rt-sender', ct: 'QQ==' });
  check('RT-R4', 'relay validation', 'route id with a path traversal', '400', traversal, traversal.status === 400);
  const empty = await post(relayOrigin, { to: 'rt-peer', from: 'rt-sender', ct: '' });
  check('RT-R5', 'relay validation', 'empty ciphertext', '400', empty, empty.status === 400);
  const huge = await post(relayOrigin, { to: 'rt-peer', from: 'rt-sender', ct: 'A'.repeat(70000) });
  check('RT-R6', 'relay validation', '70,000-byte ciphertext over the 65,536 cap', '413', huge, huge.status === 413);
  const malformed = await post(relayOrigin, '{not json');
  check('RT-R7', 'relay validation', 'malformed JSON', '400', malformed, malformed.status === 400);

  const longId = await post(relayOrigin, { to: 'a'.repeat(65), from: 'rt-sender', ct: 'QQ==' });
  check('RT-R8', 'relay validation', '65-character routing id', '400', longId, longId.status === 400);
}

async function main() {
  const outPath = args.out || join(root, 'docs/reports/red-team-session.json');
  const dataDir = mkdtempSync(join(tmpdir(), 'singularity-red-team-'));
  let site = null;
  let relay = null;
  let browser = null;
  let session = null;
  const environment = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    appPort: APP_PORT,
    relayPort: RELAY_PORT,
  };

  try {
    site = await startProjectServer({ port: APP_PORT });
    relay = spawn(
      process.execPath,
      [join(root, 'tools/relay.js'), `--port=${RELAY_PORT}`, `--data=${join(dataDir, 'relay')}`],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: root },
    );
    let relayErr = '';
    relay.stderr.on('data', (chunk) => {
      relayErr += String(chunk);
    });
    const relayOrigin = `http://127.0.0.1:${RELAY_PORT}`;
    await waitForRelay(relayOrigin);

    browser = await Browser.launch({ headless: !args['no-headless'] });
    const version = await browser.send('Browser.getVersion');
    environment.browser = version.product;
    environment.userAgent = version.userAgent;
    session = await browser.newSession(site.origin + '/');
    await session.waitFor('document.querySelectorAll(\'[role="tab"]\').length >= 8', { timeoutMs: 60000 });

    const headers = await session.evaluate(`(async () => {
      const r = await fetch('/', { cache: 'no-store' });
      return {
        csp: r.headers.get('content-security-policy'),
        xfo: r.headers.get('x-frame-options'),
        coop: r.headers.get('cross-origin-opener-policy'),
        coep: r.headers.get('cross-origin-embedder-policy'),
      };
    })()`);
    const csp = headers.csp || '';
    check(
      'RT-H1',
      'transport policy',
      'served CSP has a Trusted Types policy allowlist',
      'trusted-types singularity-script-url',
      headers.csp,
      csp.includes('trusted-types singularity-script-url'),
    );
    check(
      'RT-H2',
      'transport policy',
      'served CSP has no unsafe-inline or unsafe-eval',
      'neither token present',
      csp,
      !/unsafe-inline|unsafe-eval/.test(csp),
    );
    check(
      'RT-H3',
      'transport policy',
      'clickjacking headers on the header-capable server',
      "frame-ancestors 'none' and X-Frame-Options DENY",
      { frameAncestors: csp.includes("frame-ancestors 'none'"), xfo: headers.xfo },
      csp.includes("frame-ancestors 'none'") && headers.xfo === 'DENY',
    );

    const xss = await session.evaluate(`(async () => {
      const result = { violations: [] };
      document.addEventListener('securitypolicyviolation', (event) => {
        result.violations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
      });
      try {
        trustedTypes.createPolicy('red-team-xss', { createHTML: (s) => s });
        result.roguePolicy = 'created';
      } catch (error) {
        result.roguePolicy = error.name + ': ' + error.message;
      }
      try {
        const div = document.createElement('div');
        div.innerHTML = '<img src=x>';
        result.plainInnerHTML = 'accepted';
      } catch (error) {
        result.plainInnerHTML = error.name + ': ' + error.message;
      }
      try {
        const script = document.createElement('script');
        script.textContent = 'window.__rtScript = true';
        document.head.appendChild(script);
        result.scriptText = 'assigned';
      } catch (error) {
        result.scriptText = error.name + ': ' + error.message;
      }
      window.__rtInline = false;
      const image = document.createElement('img');
      image.setAttribute('data-rt', 'inline');
      try {
        image.setAttribute('onerror', 'window.__rtInline = true');
        result.inlineHandlerAssignment = 'assigned';
      } catch (error) {
        result.inlineHandlerAssignment = error.name + ': ' + error.message;
      }
      image.src = '/__red-team-missing__.png';
      document.body.appendChild(image);
      await new Promise((resolve) => setTimeout(resolve, 400));
      image.remove();
      window.__rtJsUrl = false;
      const link = document.createElement('a');
      link.href = 'javascript:window.__rtJsUrl = true';
      link.textContent = 'probe';
      document.body.appendChild(link);
      link.click();
      link.remove();
      await new Promise((resolve) => setTimeout(resolve, 300));
      result.inlineHandlerRan = Boolean(window.__rtInline);
      result.javascriptUrlRan = Boolean(window.__rtJsUrl);
      result.scriptTextRan = Boolean(window.__rtScript);
      return result;
    })()`);
    check(
      'RT-X1',
      'XSS',
      'create a second Trusted Types policy from page script',
      'rejected by the CSP allowlist',
      xss.roguePolicy,
      /disallowed/.test(xss.roguePolicy),
    );
    check(
      'RT-X2',
      'XSS',
      'assign a plain string to innerHTML',
      'TypeError, TrustedHTML required',
      xss.plainInnerHTML,
      /TrustedHTML/.test(xss.plainInnerHTML),
    );
    check(
      'RT-X3',
      'XSS',
      'assign a script element body',
      'TypeError, TrustedScript required',
      xss.scriptText,
      /TrustedScript/.test(xss.scriptText),
    );
    check(
      'RT-X4',
      'XSS',
      'trigger an inline onerror handler and a javascript: URL',
      'neither executes',
      { inline: xss.inlineHandlerRan, javascriptUrl: xss.javascriptUrlRan, violations: xss.violations },
      !xss.inlineHandlerRan && !xss.javascriptUrlRan,
    );
    check(
      'RT-X5',
      'XSS',
      'run a script body inserted with appendChild',
      'does not execute',
      xss.scriptTextRan,
      !xss.scriptTextRan,
    );

    await session.evaluate("document.getElementById('tab-editor').click()");
    await session.waitFor("document.querySelector('textarea.editor.tall.mono')", { timeoutMs: 30000 });
    const editor = await session.evaluate(`(() => {
      const textarea = document.querySelector('textarea.editor.tall.mono');
      const payload = '<img src=x data-rt="editor" onerror="window.__rtEditor = true">';
      textarea.value = payload;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        value: textarea.value,
        injectedImages: document.querySelectorAll('img[data-rt="editor"]').length,
        markupInValue: textarea.value === payload,
      };
    })()`);
    check(
      'RT-X6',
      'XSS',
      'put markup through the M1 editor input',
      'stays text; no element created',
      editor,
      editor.markupInValue && editor.injectedImages === 0,
    );

    const frame = await session.evaluate(`(async () => {
      const iframe = document.createElement('iframe');
      iframe.src = '/?red-team-frame=1';
      document.body.appendChild(iframe);
      await new Promise((resolve) => setTimeout(resolve, 1800));
      let readable = false;
      let title = null;
      let error = null;
      try {
        readable = Boolean(iframe.contentDocument);
        title = iframe.contentDocument && iframe.contentDocument.title;
      } catch (caught) {
        error = caught.name + ': ' + caught.message;
      }
      iframe.remove();
      return { readable, title, error };
    })()`);
    check(
      'RT-C1',
      'clickjacking',
      'frame the app from a same-origin page',
      'frame document not readable (blocked)',
      frame,
      !frame.readable,
    );

    await session.waitFor('navigator.serviceWorker && navigator.serviceWorker.controller', { timeoutMs: 60000 });
    const poisoned = await session.evaluate(`(async () => {
      const keys = await caches.keys();
      const key = keys.find((name) => name.startsWith('singularity-v'));
      const cache = await caches.open(key);
      await cache.put(new Request('/src/app.js'), new Response('window.__rtPoisoned = true;', {
        headers: { 'content-type': 'text/javascript' },
      }));
      const hit = await cache.match('/src/app.js');
      return { key, text: await hit.text(), marker: Boolean(window.__rtPoisoned) };
    })()`);
    check(
      'RT-S1',
      'service worker',
      'write a poisoned response for the app shell into the live cache',
      'cache accepts the write (same-origin code already controls the cache)',
      { key: poisoned.key, marker: poisoned.marker },
      poisoned.text.includes('__rtPoisoned'),
    );

    await session.navigate(site.origin + '/');
    await session.waitFor('document.querySelectorAll(\'[role="tab"]\').length >= 8', { timeoutMs: 60000 });
    await sleep(800);
    const repaired = await session.evaluate(`(async () => {
      const keys = await caches.keys();
      const key = keys.find((name) => name.startsWith('singularity-v'));
      const cache = await caches.open(key);
      const hit = await cache.match('/src/app.js');
      const text = await hit.text();
      return { marker: Boolean(window.__rtPoisoned), hasPoison: text.includes('__rtPoisoned'), length: text.length };
    })()`);
    check(
      'RT-S2',
      'service worker',
      'reload online after the cache poison',
      'network-first refresh replaces the poison and the page boots',
      repaired,
      !repaired.marker && !repaired.hasPoison,
    );

    await session.evaluate("document.getElementById('tab-compiler').click()");
    await session.waitFor("document.querySelector('textarea.no-gutter')", { timeoutMs: 30000 });
    await sleep(1200);
    const started = await session.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.includes('Compile'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    check('RT-W1', 'worker policy', 'find the M2 Compile button', 'present', started, started);
    await session.waitFor("document.querySelector('.terminal')?.textContent.includes('done.')", { timeoutMs: 30000 });
    const terminal = await session.evaluate("document.querySelector('.terminal').textContent");
    check(
      'RT-W2',
      'worker policy',
      'compile and run the built-in C sample in a worker',
      'exit 0 and the sample output ends with done.',
      terminal.slice(-200),
      terminal.includes('fib(20) = 6765') && terminal.includes('done.'),
    );

    await relayChecks(relayOrigin, join(dataDir, 'relay'));
    if (relayErr.trim()) console.log(`# relay stderr: ${relayErr.trim()}`);
  } finally {
    try {
      if (session) await session.closeTab();
    } catch {
      /* the tab is already gone */
    }
    if (browser) await browser.close();
    if (site) site.proc.kill();
    if (relay) relay.kill();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* a locked temp directory is not worth failing the run over */
    }
  }

  const failed = checks.filter((entry) => !entry.ok);
  const generated = new Date();
  const localDate = `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, '0')}-${String(generated.getDate()).padStart(2, '0')}`;
  const report = {
    schema: 1,
    kind: 'internal-adversarial-review',
    independent: false,
    date: localDate,
    generatedAt: generated.toISOString(),
    target: {
      commit: gitValue('git rev-parse HEAD'),
      dirty: Boolean(gitValue('git status --porcelain')),
    },
    environment,
    scope: [
      'Trusted Types policy names and DOM XSS sinks',
      'CSP enforcement in the shipped page',
      'clickjacking on the local header-capable server',
      'service-worker cache poisoning and recovery',
      'M2 worker under the shipped Trusted Types policy',
      'ciphertext relay contract and input validation',
    ],
    limitations: [
      'This is an internal, model-assisted adversarial review, not a third-party audit.',
      'The GitHub Pages origin cannot send frame-ancestors or X-Frame-Options; that accepted risk is not fixed by this review.',
      'A live cross-network WebRTC tamper test was not possible on one machine; signaling validation is covered by tests/webrtc.test.js.',
      'No penetration test of a hardened browser profile, native code, or the hosting provider was performed.',
    ],
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks,
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${report.summary.passed}/${report.summary.total} checks passed, ${report.summary.failed} failed`);
  console.log(`# report: ${outPath}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
