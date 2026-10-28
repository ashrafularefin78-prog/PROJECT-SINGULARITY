// Test runner: discovers tests/*.test.js and runs every suite.
//
// `--json` prints one machine-readable summary line and nothing else, which is
// what tools/test-count.js uses to keep every published test count honest:
//
//   node tests/run.js --json
//   { "pass": 209, "fail": 0, "skip": 12, "total": 221, "suites": 14, "files": 14 }
//
// The total is pass + fail + skip, i.e. tests that exist, not tests that this
// particular context can execute. A browser-only test is still part of the
// suite; it is skipped in bare Node, not deleted.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, runTests } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.js'))
  .sort();
const jsonMode = process.argv.includes('--json');
const quiet = jsonMode || process.argv.includes('--quiet');
const out = console.log;
const err = console.error;
if (quiet) {
  console.log = () => {};
  console.error = () => {};
}

let pass = 0;
let fail = 0;
let skip = 0;
let suites = 0;
let nodeOnly = 0;
const suiteTotals = {};
for (const file of files) {
  suites += 1;
  console.log(`\n# ${file}`);
  try {
    await import('./' + file);
  } catch (error) {
    fail += 1;
    console.error('  \u001b[31mFAIL\u001b[0m suite failed to load');
    console.error('       ' + (error && error.stack ? error.stack : error));
    continue;
  }
  const tests = collect();
  suiteTotals[file] = tests.length;
  nodeOnly += tests.filter((t) => t.needs.includes('node')).length;
  const result = await runTests(tests);
  pass += result.pass;
  fail += result.fail;
  skip += result.skip;
}

console.log = out;
console.error = err;
const summary = { pass, fail, skip, total: pass + fail + skip, suites, files: files.length, nodeOnly, suiteTotals };
if (jsonMode) {
  console.log(JSON.stringify(summary));
} else {
  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped (need a browser: run npm run test:browser)` : ''}`);
}
process.exit(fail > 0 ? 1 : 0);
