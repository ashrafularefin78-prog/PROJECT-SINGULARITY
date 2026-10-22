/**
 * Drive the real interface with NVDA and record what it actually says.
 *
 *   node tools/nvda-session.js --nvda="C:\Program Files\NVDA\nvda_noUIAccess.exe"
 *   npm run test:nvda
 *
 * This is not a DOM audit with a screen-reader costume on. It starts NVDA with
 * debug logging, launches a windowed browser, sends real key presses through
 * CDP, and reads the `Speaking [...]` lines NVDA writes to its own log. The
 * steps below fail if NVDA does not announce the panel heading after an
 * Alt+1..8 jump: the previous build left focus on <body> and announced nothing.
 *
 * Windows only. NVDA must not already be running (two copies fight over the
 * keyboard hook); close it, or run a portable copy and pass `--nvda=...`.
 *
 * The raw NVDA log is a debug log for the whole desktop, so it is not written
 * to the repository. The JSON artifact keeps the speech lines, browser/NVDA
 * versions and the DOM state at each step; `--keep-log` prints its path.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Browser, parseArgs, startProjectServer } from './cdp.js';

const args = parseArgs();
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Turn one `Speaking [...]` line into text and the language switches it used. */
export function parseSpeechLine(line) {
  const langs = [...line.matchAll(/LangChangeCommand \('([^']+)'\)/g)].map((m) => m[1]);
  const quoted = [...line.matchAll(/'((?:\\.|[^'\\])*)'/g)]
    .map((m) => m[1])
    .map((raw) => raw.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, ' ').replace(/\\t/g, ' '))
    .map((value) => value.replace(/\uFFFC/g, '').trim())
    .filter((value) => value && !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(value));
  return { text: quoted.join(' ').replace(/\s+/g, ' ').trim(), langs, raw: line };
}

function selfTest() {
  const line =
    "Speaking [LangChangeCommand ('en_US'), '1. M1 Editor', 'property page', LangChangeCommand ('bn'), 'বাংলা ভাষা']";
  const parsed = parseSpeechLine(line);
  const checks = [
    ['text', parsed.text.includes('বাংলা ভাষা') && parsed.text.includes('M1 Editor')],
    ['langs', parsed.langs.includes('bn') && parsed.langs.includes('en_US')],
    ['no locale in text', !parsed.text.includes('en_US')],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}

if (args['self-test']) selfTest();

const outPath = resolve(String(args.out || 'docs/reports/nvda-session.json'));
const logPath = resolve(String(args.log || join(tmpdir(), `singularity-nvda-${process.pid}.log`)));
const port = Number(args.port || 5215);
const settleMs = Number(args.settle || 2600);

function findNvda() {
  if (typeof args.nvda === 'string' && args.nvda) return resolve(args.nvda);
  if (process.env.NVDA_PATH) return resolve(process.env.NVDA_PATH);
  const candidates = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'NVDA', 'nvda_noUIAccess.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'NVDA', 'nvda.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NVDA', 'nvda.exe'),
    join(process.env.LOCALAPPDATA || '', 'NVDA', 'nvda.exe'),
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}

function nvdaIsRunning() {
  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "Get-Process nvda,nvda_noUIAccess -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"],
    { encoding: 'utf8', timeout: 10000 },
  );
  return Boolean((res.stdout || '').trim());
}

function sendKeys(keys) {
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$w = New-Object -ComObject WScript.Shell; $w.AppActivate('NVDA') | Out-Null; Start-Sleep -Milliseconds 250; $w.SendKeys('${keys}')`,
    ],
    { encoding: 'utf8', timeout: 10000, stdio: 'ignore' },
  );
}

function readLog() {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

/** Bring the browser window to the foreground so NVDA follows the page, not the terminal. */
function activateBrowserWindow(title = 'M0 Dashboard') {
  if (process.platform !== 'win32') return false;
  const script = `$w = New-Object -ComObject WScript.Shell; if (-not $w.AppActivate('${title.replace(/'/g, "''")}')) { exit 1 }`;
  const res = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: 'ignore',
  });
  return res.status === 0;
}

const nvdaExe = findNvda();
if (!nvdaExe) {
  console.error('NVDA not found. Pass --nvda=C:\\path\\to\\nvda_noUIAccess.exe or set NVDA_PATH.');
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.error('This harness needs Windows: it reads NVDA\'s own debug log and sends Windows key events.');
  process.exit(2);
}
if (nvdaIsRunning() && !args['replace-nvda']) {
  console.error('NVDA is already running. Close it first, or pass --replace-nvda to let this tool own the session.');
  process.exit(2);
}
if (args['replace-nvda']) {
  spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Process nvda,nvda_noUIAccess -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue'], {
    timeout: 10000,
    stdio: 'ignore',
  });
}

rmSync(logPath, { force: true });
mkdirSync(dirname(outPath), { recursive: true });

console.log(`# NVDA: ${nvdaExe}`);
console.log(`# log:  ${logPath}`);
const nvda = spawn(nvdaExe, ['--debug-logging', '-f', logPath], { detached: true, stdio: 'ignore' });
nvda.unref();

let server;
let browser;
let session;
let cursor = 0;
let page = null;
let browserInfo = null;
let rawLogText = "";
let logBytes = null;
const transcript = [];
const failures = [];

function speechSinceCursor() {
  const text = readLog();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const complete = text.endsWith('\n') ? lines.slice(0, -1) : lines.slice(0, -1);
  const fresh = complete.slice(cursor);
  cursor = complete.length;
  return fresh.filter((line) => line.startsWith('Speaking ')).map(parseSpeechLine).filter((s) => s.text || s.langs.length);
}

async function snapshot() {
  if (!session) return null;
  try {
    return await session.evaluate(`(() => {
      const a = document.activeElement;
      const who = a && a !== document.body ? {
        tag: a.tagName,
        id: a.id || null,
        role: a.getAttribute('role') || null,
        name: (a.getAttribute('aria-label') || a.textContent || a.value || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
      } : null;
      const panel = document.querySelector('[role="tabpanel"]');
      return {
        title: document.title,
        panel: panel ? panel.id : null,
        heading: panel ? (panel.querySelector('.mod-title')?.textContent || '') : '',
        active: who,
        lang: document.documentElement.lang,
        dir: document.documentElement.dir || null,
      };
    })()`);
  } catch {
    return null;
  }
}

async function step(id, action, { settle = settleMs, expect = null, check = null, details = null } = {}) {
  // Drain anything that arrived between steps so a slow sentence is not
  // credited to the step after the one that caused it.
  speechSinceCursor();
  const started = Date.now();
  const result = await action();
  await sleep(settle);
  const speech = speechSinceCursor();
  const spoken = speech.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  const langs = [...new Set(speech.flatMap((s) => s.langs))];
  const dom = await snapshot();
  const entry = {
    id,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    speech,
    spoken,
    langs,
    dom,
    ...(result !== undefined ? { result } : {}),
    ...(details || {}),
  };
  if (expect) {
    entry.expect = expect;
    entry.pass = spoken.toLowerCase().includes(expect.toLowerCase());
    if (!entry.pass) failures.push(`${id}: NVDA never said "${expect}" (heard: ${spoken || 'nothing'})`);
  }
  if (check) {
    const verdict = await check(entry);
    entry.check = verdict;
    if (!verdict.pass) failures.push(`${id}: ${verdict.message}`);
  }
  transcript.push(entry);
  const summary = entry.pass === false || entry.check?.pass === false ? 'FAIL' : 'ok  ';
  console.log(`  ${summary} ${id.padEnd(20)} ${(entry.dom?.heading || entry.dom?.active?.name || '').slice(0, 72)}`);
  return entry;
}

async function press(key, code, vk, modifiers = 0, text) {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  };
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const alt = (n) => press(String(n), `Digit${n}`, 48 + n, 1);

async function setSelect(id, value) {
  await session.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return false;
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function focusEditorAndReplace(text) {
  return session.evaluate(`(() => {
    const el = document.querySelector('textarea[aria-label^="Collaborative"]');
    if (!el) return null;
    el.focus();
    el.select();
    document.execCommand('delete');
    return el.value;
  })()`).then(async (before) => {
    await session.send('Input.insertText', { text });
    return { before, after: await session.evaluate(`document.querySelector('textarea[aria-label^="Collaborative"]')?.value || ''`) };
  });
}

try {
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    if (/NVDA initialized/.test(readLog())) {
      ready = true;
      break;
    }
    await sleep(250);
  }
  if (!ready) throw new Error(`NVDA did not initialise; see ${logPath}`);
  // A first-run install shows a Welcome dialog or a usage-statistics prompt.
  // The portable copy the evidence run used suppresses both in userConfig.
  // For a stock install, dismiss them only if their speech is in the log.
  const startupSpeech = readLog();
  if (/Welcome to NVDA|usage statistics|Usage Data/i.test(startupSpeech)) {
    sendKeys('{ESC}');
    await sleep(600);
    sendKeys('%l');
    await sleep(600);
  }
  const version = /Starting NVDA version (\S+)/.exec(readLog())?.[1] || 'unknown';

  server = await startProjectServer({ port });
  browser = await Browser.launchOnce({
    headless: false,
    width: 1280,
    height: 900,
    extraArgs: ['--force-renderer-accessibility', '--window-position=80,80'],
  });
  session = await browser.newSession('about:blank');
  // Everything before this line is the desktop, not the page. Start recording
  // at the point the app is navigated so OpenCode's own chatter is excluded.
  await session.send('Page.bringToFront');
  await session.navigate(server.origin + '/');
  await session.send('Page.bringToFront');
  await session.waitFor('!!document.querySelector("#tabs")', { timeoutMs: 60000 });
  // A terminal can keep OS focus after the browser launches; NVDA then reads
  // the terminal even though CDP is driving the page. Explicitly raise the
  // browser window before the measured speech window starts.
  activateBrowserWindow('M0 Dashboard');
  await session.send('Page.bringToFront');
  await sleep(5000);
  speechSinceCursor();

  page = {
    url: server.origin + '/',
    title: await session.evaluate('document.title'),
    userAgent: await session.evaluate('navigator.userAgent'),
  };
  browserInfo = await browser.send('Browser.getVersion');

  await step(
    'boot',
    async () => {
      const initial = await session.evaluate('document.activeElement?.tagName || null');
      // NVDA only attaches to the page after the first key event on some
      // windowed launches; Tab focuses the skip link and makes it speak.
      await press('Tab', 'Tab', 9);
      return { initial };
    },
    {
      settle: 3500,
      expect: 'Skip to main content',
      check: (e) => ({
        pass: e.result?.initial === 'BODY',
        message: `initial focus before the first Tab: ${e.result?.initial}`,
      }),
    },
  );

  await step(
    'skip-link',
    async () => {
      const focused = await session.evaluate(`document.activeElement?.textContent?.trim() || ''`);
      if (/Skip to main content/i.test(focused)) await press('Enter', 'Enter', 13);
      return { focused };
    },
    {
      settle: 1800,
      expect: 'Project Singularity',
      check: async (e) => {
        const hash = await session.evaluate('location.hash');
        const active = await session.evaluate('document.activeElement?.tagName + "#" + (document.activeElement?.id || "")');
        return {
          pass: /Skip to main content/i.test(e.result?.focused || '') && (hash === '#main' || /MAIN|tablist|tab-dashboard/.test(active)),
          message: `first Tab focused ${JSON.stringify(e.result?.focused)}; hash ${hash}, active ${active}`,
        };
      },
    },
  );

  const panelNames = [
    [1, 'editor', 'Real-time collaborative editor'],
    [2, 'compiler', 'In-browser C compiler and runtime'],
    [3, 'engine', 'Custom 3D engine on WebGL2'],
    [4, 'crypto', 'End-to-end encrypted layer'],
    [5, 'mesh', 'Peer mesh: WebRTC data channels + ciphertext-only relay'],
    [6, 'offline', 'Offline-first sync and storage'],
    [7, 'a11y', 'Accessibility and internationalisation'],
    [8, 'security', 'Hostile-environment hardening'],
  ];
  for (const [n, id, title] of panelNames) {
    await step(
      `panel-${n}`,
      async () => {
        await press('Escape', 'Escape', 27);
        await alt(n);
        await session.waitFor(`document.querySelector('[role="tabpanel"]')?.id === 'panel-${id}'`, { timeoutMs: 20000 });
        if (id === 'engine') await session.waitFor('!!document.querySelector("#scene")', { timeoutMs: 45000 });
      },
      {
        settle: id === 'engine' ? 6500 : settleMs,
        expect: title,
        check: (e) => ({
          pass: e.dom?.panel === `panel-${id}` && e.dom?.active?.tag === 'H1',
          message: `panel ${e.dom?.panel}, focus ${JSON.stringify(e.dom?.active)}`,
        }),
      },
    );
  }

  await step('m1-editor', async () => {
    await press('Escape', 'Escape', 27);
    await alt(1);
    await sleep(1200);
    return focusEditorAndReplace('Hello from the NVDA session.');
  }, {
    settle: 1800,
    check: async (e) => ({
      pass: e.result?.after === 'Hello from the NVDA session.',
      message: `editor value: ${JSON.stringify(e.result?.after)}`,
    }),
  });

  await step('m3-canvas', async () => {
    await press('Escape', 'Escape', 27);
    await alt(3);
    await session.waitFor('!!document.querySelector("#scene")', { timeoutMs: 45000 });
    await sleep(4500);
    await session.evaluate('document.querySelector("#scene").focus()');
  }, {
    settle: 2200,
    expect: '3D scene',
    check: async (e) => {
      const label = await session.evaluate('document.querySelector("#scene").getAttribute("aria-label")');
      const describedby = await session.evaluate('document.querySelector("#scene").getAttribute("aria-describedby")');
      return {
        pass: /graphic/i.test(e.spoken) && describedby === 'scene-alt' && (label || '').length > 40,
        message: `announced ${JSON.stringify(e.spoken.slice(0, 100))}; label/describedby ${label} / ${describedby}`,
      };
    },
  });

  await step('m7-language-bn', async () => {
    await press('Escape', 'Escape', 27);
    await alt(7);
    await sleep(1200);
    await setSelect('f-content-language', 'bn');
  }, {
    settle: 2000,
    check: async () => {
      const lang = await session.evaluate('document.documentElement.lang');
      return { pass: lang === 'bn', message: `document language: ${lang}` };
    },
  });

  await step('m7-editor-bn', async () => {
    await alt(1);
    await sleep(1200);
    const value = await focusEditorAndReplace('বাংলা ভাষা পরীক্ষা');
    await session.evaluate('document.activeElement.blur()');
    await session.evaluate('document.querySelector("textarea[aria-label^=Collaborative]").focus()');
    return value;
  }, {
    settle: 2200,
    check: (e) => ({
      pass: e.langs.includes('bn') && e.spoken.includes('বাংলা'),
      message: `langs ${e.langs.join(',') || '-'}; heard ${e.spoken || 'nothing'}`,
    }),
  });

  await step('m7-language-ar', async () => {
    await press('Escape', 'Escape', 27);
    await alt(7);
    await sleep(1200);
    await setSelect('f-content-language', 'ar');
  }, {
    settle: 2000,
    check: async () => {
      const lang = await session.evaluate('document.documentElement.lang');
      return { pass: lang === 'ar', message: `document language: ${lang}` };
    },
  });

  await step('m7-editor-ar', async () => {
    await alt(1);
    await sleep(1200);
    const value = await focusEditorAndReplace('اختبار اللغة العربية');
    await session.evaluate('document.activeElement.blur()');
    await session.evaluate('document.querySelector("textarea[aria-label^=Collaborative]").focus()');
    return value;
  }, {
    settle: 2200,
    check: (e) => ({
      pass: e.langs.includes('ar') && e.spoken.includes('اختبار'),
      message: `langs ${e.langs.join(',') || '-'}; heard ${e.spoken || 'nothing'}`,
    }),
  });

  await step('m7-direction-rtl', async () => {
    await press('Escape', 'Escape', 27);
    await alt(7);
    await sleep(1200);
    await setSelect('f-writing-direction', 'rtl');
  }, {
    settle: 2000,
    check: async () => {
      const dir = await session.evaluate('document.documentElement.dir');
      return { pass: dir === 'rtl', message: `document direction: ${dir}` };
    },
  });

} catch (err) {
  console.error(`# failed: ${err && err.stack ? err.stack : err}`);
  failures.push(String(err && err.message ? err.message : err));
} finally {
  rawLogText = readLog();
  try {
    logBytes = statSync(logPath).size;
  } catch {
    logBytes = null;
  }
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  try {
    server?.proc.kill();
  } catch {
    /* ignore */
  }
  try {
    process.kill(nvda.pid);
  } catch {
    /* the launcher may already be gone */
  }
  spawnSync('taskkill', ['/PID', String(nvda.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
  await sleep(500);
  if (!args['keep-log']) {
    try {
      rmSync(logPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

const speechLines = (rawLogText.match(/^Speaking /gm) || []).length;
const result = {
  tool: 'tools/nvda-session.js',
  measuredAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    release: (await import('node:os')).release(),
  },
  nvda: {
    version: /Starting NVDA version (\S+)/.exec(rawLogText)?.[1] || 'unknown',
    executable: nvdaExe,
    logBytes,
    speechLines,
  },
  browser: {
    product: browserInfo?.product || null,
    userAgent: page?.userAgent || null,
  },
  page: page || null,
  steps: transcript,
  summary: {
    steps: transcript.length,
    speechLines: transcript.reduce((n, s) => n + s.speech.length, 0),
    checks: transcript.filter((s) => s.pass !== undefined || s.check).length,
    passed: transcript.filter((s) => s.pass !== false && s.check?.pass !== false).length,
    failed: failures.length,
    failures,
  },
};
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`# wrote ${outPath}`);
console.log(`# ${result.summary.passed}/${result.summary.steps} steps passed, ${failures.length} failure(s)`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
}
