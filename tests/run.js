// Test runner: discovers tests/*.test.js and runs every suite.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, runTests } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let pass = 0;
let fail = 0;
let skip = 0;
for (const file of files) {
  console.log(`\n# ${file}`);
  try {
    await import('./' + file);
  } catch (err) {
    fail += 1;
    console.error('  \u001b[31mFAIL\u001b[0m suite failed to load');
    console.error('       ' + (err && err.stack ? err.stack : err));
    continue;
  }
  const result = await runTests(collect());
  pass += result.pass;
  fail += result.fail;
  skip += result.skip;
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped (need a browser: run npm run test:browser)` : ''}`);
process.exit(fail > 0 ? 1 : 0);
