/**
 * Run the full test suite in a real browser, headless, from the command line.
 *
 * This is the authoritative run: it has document, WebGL2 and IndexedDB, so the
 * tests that bare Node has to skip (`npm test` reports them as skips) actually
 * execute here. It is also what the CI workflow calls, so a green build means
 * "the suite passed in a browser", not "the parts that need no browser passed".
 *
 * Usage: node tools/browser-run.js [--keep-open] [--no-headless] [--url=<page>]
 *
 * `--url` may be a path (served from this working tree) or an absolute http(s)
 * URL, in which case no local server is started. The absolute form is how a
 * *deployed artifact* is verified - the build in `dist/`, or the live site:
 *
 *   node tools/browser-run.js --url=http://127.0.0.1:5223/tests/browser.html
 */
import { Browser, parseArgs, serveProject } from './cdp.js';

const args = parseArgs();
const absolute = /^https?:\/\//.test(args.url || '');
const target = args.url || '/tests/browser.html';

async function main() {
  const site = absolute ? null : await serveProject();
  // softwareGl: headless has no GPU, and Chrome refuses software WebGL unless
  // it is asked for by name - without it the WebGL2 tests would report
  // "skipped" instead of running. See Browser.launchOnce for the cost.
  const browser = await Browser.launch({ headless: !args['no-headless'], softwareGl: true });
  const version = await browser.send('Browser.getVersion');
  console.log(`# ${version.product} (${version.jsVersion})`);
  console.log(`# ${absolute ? target : site.origin + target}\n`);

  const session = await browser.newSession(absolute ? target : site.origin + target);
  let results;
  try {
    await session.waitFor('window.__DONE__ === true', { timeoutMs: 240000 });
    results = await session.evaluate('window.__RESULTS__');
  } finally {
    if (!args['keep-open']) {
      await session.closeTab();
      await browser.close();
      site?.server.close();
    }
  }

  if (results.fatal) {
    console.error(results.fatal);
    process.exit(1);
  }

  for (const suite of results.suites) {
    const pass = suite.tests.filter((t) => t.ok).length;
    const failed = suite.tests.filter((t) => !t.ok && !t.skip).length;
    const skipped = suite.tests.filter((t) => t.skip).length;
    const marks = `${pass} pass${failed ? `, ${failed} FAIL` : ''}${skipped ? `, ${skipped} skip` : ''}`;
    console.log(`# ${suite.file}  (${marks})`);
    if (suite.loadError) console.error(`  suite failed to load:\n${suite.loadError}`);
    for (const t of suite.tests) {
      if (t.skip) console.log(`  \u001b[33mskip\u001b[0m ${t.name} (${t.skip})`);
      else if (t.ok) console.log(`  \u001b[32mok\u001b[0m   ${t.name} (${t.ms}ms)`);
      else {
        console.error(`  \u001b[31mFAIL\u001b[0m ${t.name} (${t.ms}ms)`);
        console.error(`       ${t.error}`);
      }
    }
  }

  const caps = results.caps || {};
  console.log(
    `\n${results.pass} passed, ${results.fail} failed, ${results.skip} skipped in ${results.ms} ms` +
      `  [dom=${!!caps.dom} webgl2=${!!caps.webgl2} indexeddb=${!!caps.indexeddb}]`,
  );
  const noisy = [...session.consoleErrors, ...session.pageErrors];
  if (noisy.length) {
    console.error(`\npage errors during the run (${noisy.length}):`);
    for (const line of noisy.slice(0, 10)) console.error('  ' + line.split('\n')[0]);
  }
  // Explicit exit: this process owns a browser child, and a stray handle must
  // not keep CI hanging after the results are already printed.
  process.exit(results.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
