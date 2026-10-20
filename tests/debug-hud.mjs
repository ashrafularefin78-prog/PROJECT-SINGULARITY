// Mirror the runner lifecycle: import the suite, then collect, then run.
import { collect, runTests, capabilities } from './harness.js';

const hud = await import('./hud.test.js');
console.log('hud exports:', Object.keys(hud));
const tests = collect();
console.log('collect() returned', tests.length, 'test(s)');
for (let i = 0; i < tests.length; i++) {
  const t = tests[i];
  console.log(' ', i, 'raw entry:', JSON.stringify(t));
  console.log(' ', i, 'typeof t.fn:', typeof t.fn);
  console.log(' ', i, 't.fn === hud.test?', t.fn === hud.test);
}
const r = await runTests(tests, capabilities());
console.log('runTests result:', r);
