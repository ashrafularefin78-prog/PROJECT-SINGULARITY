/**
 * End-to-end: the shipped app, under the shipped CSP, through a real relay node.
 *
 *   node tools/relay-e2e.js [--keep-open] [--no-headless]
 *                           [--app-port=5199] [--relay-port=8890]
 *
 * Why this exists, when tests/mesh.test.js already covers the carrier:
 * those tests seal frames against the node's HTTP contract with an injected
 * fetch, so they prove the client logic but say nothing about whether the
 * *shipped page* - strict CSP, Trusted Types, `connect-src 'self'` - can
 * actually reach a node. tools/load-relay.js proves the node under load, but
 * with synthetic clients, not the app. This tool closes the gap end to end:
 *
 *   1. it launches the real node (tools/relay.js) on loopback and mounts it
 *      same-origin under the project dev server (SINGULARITY_RELAY), which is
 *      the only shape the CSP permits and the shape a deployment uses;
 *   2. it drives the real app's M5 panel in a real browser: a room passphrase
 *      is typed with real input events and "Connect to the relay" is clicked;
 *   3. it asserts the carrier reports connected, the node's own counters show
 *      the app's frames (posts > 0, a peer mailbox exists), the panel reads the
 *      node's stats endpoint back, and the node's durable log holds ciphertext
 *      only - the mesh envelope's plaintext keys (`"kind"`, `"payload"`) must
 *      not appear anywhere in the node's data directory.
 *
 * Exit code 0 when every check passes.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, parseArgs, startProjectServer } from './cdp.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = parseArgs();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RELAY_PORT = Number(args['relay-port'] || 8890);
const APP_PORT = Number(args['app-port'] || 5199);
const PASSPHRASE = 'relay-e2e-room-passphrase';
const dataDir = mkdtempSync(join(tmpdir(), 'relay-e2e-'));

const checks = [];
const events = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`);
}

/** Every regular file under a directory, recursively. */
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
    if (Date.now() > deadline) throw new Error(`the relay node at ${origin} did not answer within 15s`);
    await sleep(150);
  }
}

async function main() {
  console.log(`# relay node on 127.0.0.1:${RELAY_PORT}, app on 127.0.0.1:${APP_PORT}, data in ${dataDir}`);
  const relay = spawn(
    process.execPath,
    [join(root, 'tools/relay.js'), `--port=${RELAY_PORT}`, `--data=${join(dataDir, 'node')}`],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: root },
  );
  let relayErr = '';
  relay.stderr.on('data', (chunk) => {
    relayErr += String(chunk);
  });
  const relayOrigin = `http://127.0.0.1:${RELAY_PORT}`;

  let site = null;
  let browser = null;
  try {
    await waitForRelay(relayOrigin);

    // The dev server reads this at load and mounts /relay/* to the node, so the
    // page talks to its own origin - exactly what `connect-src 'self'` allows.
    process.env.SINGULARITY_RELAY = relayOrigin;
    site = await startProjectServer({ port: APP_PORT });

    browser = await Browser.launch({ headless: !args['no-headless'], softwareGl: true });
    const page = await browser.newSession(site.origin + '/');
    // Everything the page logs or is refused: CSP violations arrive as
    // Log.entryAdded, so they are captured even when nothing is thrown.
    page.on('Log.entryAdded', (p) => events.push(`log[${p.entry?.source}/${p.entry?.level}]: ${p.entry?.text}${p.entry?.url ? ` <${p.entry.url}>` : ''}`));
    page.on('Runtime.consoleAPICalled', (p) =>
      events.push(`console.${p.type}: ${(p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`),
    );
    page.on('Runtime.exceptionThrown', (p) =>
      events.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`),
    );
    await page.waitFor('document.querySelectorAll("#tabs button").length > 0', { timeoutMs: 90000 });

    const opened = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('#tabs button')].find((x) => (x.textContent || '').includes('M5 Mesh'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('the M5 panel opens', opened);

    const fields = await page.evaluate(
      `(() => ({ urls: !!document.getElementById('relay-urls'), pass: !!document.getElementById('relay-pass') }))()`,
    );
    check('the relay fields render', fields.urls && fields.pass);

    await page.evaluate(`document.getElementById('relay-pass').focus()`);
    await page.send('Input.insertText', { text: PASSPHRASE });

    const clicked = await page.evaluate(`(() => {
      const scope = document.getElementById('main') || document.body;
      const b = [...scope.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Connect to the relay'));
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      b.click();
      return true;
    })()`);
    check('Connect to the relay is clicked', clicked);

    await page
      .waitFor(`document.body.innerText.includes('connected to')`, { timeoutMs: 20000 })
      .catch(() => {});
    const text = await page.evaluate(`document.body.innerText`);
    check('the carrier reports connected (the CSP did not block the mount)', /connected to/.test(text));

    // The carrier posts the mesh's hello as soon as it attaches, parks a drain
    // long-poll, and heartbeats after, so poll for both directions rather than
    // assuming a fixed delay. Ten seconds is generous for a cold tab under
    // load (under load is exactly when this tool runs in CI).
    let stats = { posts: 0, deliveries: 0, drains: 0, longPolls: 0 };
    for (let i = 0; i < 40; i += 1) {
      stats = await (await fetch(relayOrigin + '/relay/stats')).json();
      if (stats.posts > 0 && stats.drains > 0) break;
      await sleep(250);
    }
    check('the node accepted the app\u2019s frames', stats.posts > 0, `posts ${stats.posts}, deliveries ${stats.deliveries}`);
    // drains/longPolls prove the *receive* path also runs through the mount -
    // the carrier parks a long-poll on /relay/drain, it does not just post.
    check('the app drains from the node', stats.drains > 0, `drains ${stats.drains}, long polls ${stats.longPolls}`);

    // The panel fetches /relay/stats through the same mount; give that fetch
    // the same generous window as the frames above.
    let panel = '';
    for (let i = 0; i < 40; i += 1) {
      panel = await page.evaluate(`document.body.innerText`);
      if (panel.includes('node reports:')) break;
      await sleep(250);
    }
    check('the panel reads the node\u2019s counters back', panel.includes('node reports:'));

    // The node's durable log must hold ciphertext only. `"kind"` and
    // `"payload"` cannot occur inside base64, so this is a sound check, not a
    // keyword sniff.
    const logs = filesUnder(dataDir).map((f) => readFileSync(f, 'utf8')).join('\n');
    check('the node\u2019s log holds ciphertext only', !/"kind"|"payload"/.test(logs), `${logs.split('\n').filter(Boolean).length} log line(s)`);
    check('the passphrase never reaches the node', !logs.includes(PASSPHRASE));

    if (checks.some((c) => !c.ok)) {
      const panel = await page.evaluate(`document.getElementById('main') ? document.getElementById('main').innerText : ''`);
      const relevant = String(panel)
        .split('\n')
        .filter((line) => /relay|node|connect|seal|error|fail|refused|blocked/i.test(line))
        .slice(-25);
      console.log('\n# the M5 panel said, in the relevant lines:');
      for (const line of relevant) console.log(`  ${line}`);
      if (events.length) {
        console.log('\n# page events (first 12 and last 12):');
        const shown = events.length > 24 ? [...events.slice(0, 12), '  …', ...events.slice(-12)] : events;
        for (const line of shown) console.log(`  ${line}`);
      }
    }
  } finally {
    if (browser && !args['keep-open']) {
      await browser.close().catch(() => {});
    }
    if (site && !args['keep-open']) site.proc.kill();
    relay.kill();
    if (!args['keep-open']) rmSync(dataDir, { recursive: true, force: true });
    else console.log(`# kept: ${dataDir}, node still on ${relayOrigin}`);
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\nrelay end-to-end: ${checks.length - failed}/${checks.length} checks ok${relayErr ? `\nnode stderr: ${relayErr.slice(0, 400)}` : ''}`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('relay-e2e: fatal', err);
    process.exit(1);
  },
);
