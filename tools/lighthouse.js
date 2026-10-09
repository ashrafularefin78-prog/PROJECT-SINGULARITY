/**
 * Run Lighthouse against the local build.
 *
 *   node tools/lighthouse.js [--form-factor=mobile|desktop]
 *
 * Lighthouse is not a project dependency: the app ships with zero runtime
 * dependencies and the test suite runs without any, and that stays true. This
 * wrapper drives a *dev-only* copy installed under .tools/ and points it at the
 * Edge binary that is already on the machine, so nothing is added to
 * package.json:
 *
 *   npm install --prefix .tools/lighthouse lighthouse
 *
 * It also owns the server: Lighthouse expects a URL that is already serving, so
 * the wrapper starts tools/serve.js (with the real headers) and shuts it down
 * afterwards.
 *
 * And it owns the browser. Lighthouse's own launcher discovers the debug port by
 * grepping the browser's stderr for "DevTools listening on ws://...", and
 * current Edge no longer writes that line to the redirected stderr - the run
 * dies with "waiting for dynamic debugging port in chrome-err.log" on every
 * attempt while a perfectly good DevToolsActivePort file sits in the profile
 * directory. So the browser is launched here with the project's own CDP client
 * (tools/cdp.js) and Lighthouse is pointed at it with `--port`, which skips the
 * launcher altogether. `--debug-port` reuses an already-running browser.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, findBrowser, parseArgs, startProjectServer } from './cdp.js';

const args = parseArgs();
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const CLI = resolve(root, '.tools/lighthouse/node_modules/lighthouse/cli/index.js');
const PORT = Number(args.port || 5207);
const formFactor = args['form-factor'] || 'mobile';
const outFile = resolve(root, (args.out || `docs/reports/lighthouse-${formFactor}.json`));
const DEBUG_PORT = args['debug-port'] ? Number(args['debug-port']) : 0;

if (!existsSync(CLI)) {
  console.error(
    'Lighthouse is not installed in .tools.\n' +
      'Install it there (it is deliberately not a project dependency):\n' +
      '  npm install --prefix .tools/lighthouse lighthouse',
  );
  process.exit(2);
}

const { proc, origin } = await startProjectServer({ port: PORT });
const target = `${origin}/`;
const outDir = outFile.replace(/[/\\][^/\\]+$/, '');
mkdirSync(outDir, { recursive: true });
console.log(`# Lighthouse (${formFactor}) against ${target}`);
console.log(`# browser: ${findBrowser()}`);

// Launch the browser ourselves so that Lighthouse never runs its own launcher.
let browser = null;
let chromePort = DEBUG_PORT;
if (!chromePort) {
  browser = await Browser.launch({ width: 412, height: 915, scale: 2 });
  chromePort = browser.port;
}
console.log(`# devtools port: ${chromePort}${DEBUG_PORT ? ' (reused)' : ' (launched by tools/cdp.js)'}`);

/** One Lighthouse run against the already-serving target. Returns its exit code. */
function runOnce() {
  const lighthouse = spawn(
    process.execPath,
    [
      CLI,
      target,
      `--output=json`,
      `--output-path=${outFile}`,
      '--quiet',
      '--only-categories=performance,accessibility,best-practices,seo',
      // Lighthouse's only presets are `desktop`, `perf` and `experimental`;
      // mobile is the default, so there is no flag to pass and passing
      // `default` is an argument error in the current CLI.
      ...(formFactor === 'desktop' ? ['--preset=desktop'] : []),
      // --port attaches to the browser launched above; chrome-launcher is not
      // involved, which is what makes this run at all on the current Edge.
      `--port=${chromePort}`,
      '--max-wait-for-load=45000',
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, CHROME_PATH: findBrowser() },
      cwd: root,
    },
  );
  return new Promise((resolve) => lighthouse.on('exit', resolve));
}

const { readFileSync, rmSync } = await import('node:fs');
const ATTEMPTS = Number(args.attempts || 3);

// The mobile profile throttles the CPU 4x, and its trace recorder can miss
// navigation start when the machine is busy with something else. That produces
// NO_NAVSTART and a report full of nulls: an instrumentation failure, not a
// measurement of the page, so it is retried and never published as a result.
let report = null;
let exitCode = 0;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const code = await runOnce();
  if (code !== 0) {
    if (attempt === ATTEMPTS) {
      console.error(`lighthouse exited with code ${code} after ${attempt} attempt(s)`);
      exitCode = code || 1;
      break;
    }
    console.log(`# attempt ${attempt} exited ${code}; retrying (${attempt + 1}/${ATTEMPTS})`);
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch (err) {
    console.error(`lighthouse wrote no readable report: ${err.message}`);
    exitCode = 1;
    break;
  }
  const failure = parsed.runtimeError && parsed.runtimeError.code;
  if (failure && attempt < ATTEMPTS) {
    console.log(`# attempt ${attempt}: ${failure} (the trace missed navigation start); retrying (${attempt + 1}/${ATTEMPTS})`);
    continue;
  }
  if (failure) {
    // Fail closed: a runtime error is not a score, so the file must not stay on
    // disk where a later reader could mistake it for one.
    rmSync(outFile, { force: true });
    console.error(`lighthouse failed with ${failure} on all ${ATTEMPTS} attempt(s); no report kept`);
    exitCode = 1;
    break;
  }
  report = parsed;
  break;
}
proc.kill();
// The browser is ours, so it is closed on every path: a failed run must not
// leave an Edge profile and its renderer processes behind (which is also what
// makes the next run slow and flaky).
if (browser) await browser.close();
if (exitCode) process.exit(exitCode);
for (const [key, category] of Object.entries(report.categories || {})) {
  const score = category.score === null ? 'n/a' : Math.round(category.score * 100);
  console.log(`  ${key.padEnd(14)} ${String(score).padStart(3)}`);
}
const audits = report.audits || {};
const show = (id) => {
  const audit = audits[id];
  if (!audit) return;
  const value = audit.numericValue === undefined ? (audit.displayValue ?? '') : Math.round(audit.numericValue);
  console.log(`  ${id.padEnd(28)} ${value}  ${audit.displayValue && audit.numericValue !== undefined ? audit.displayValue : ''}`);
};
console.log('# key metrics');
for (const id of ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index', 'interactive', 'total-byte-weight']) {
  show(id);
}
console.log(`# written to ${outFile}`);
process.exit(0);
