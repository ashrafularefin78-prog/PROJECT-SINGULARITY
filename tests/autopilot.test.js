/**
 * M9 - autopilot.
 *
 * The repair list is deliberately short, so each rule gets its own proof: a
 * broken program, the exact repair that should be chosen, and a re-run that
 * passes. Failures prove the other half of the contract - unsafe or unprovable
 * code stops with a diagnosis instead of a guess.
 */
import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { autopilot } from '../src/assistant/autopilot.js';
import { plan } from '../src/assistant/planner.js';

const runPlan = (code, tests, maxRepairs = 3) => autopilot({ code, engine: 'test', title: 'test', tests }, { maxRepairs });

test('autopilot: a composed program passes every check without repairs', () => {
  const planResult = plan('the sum of the numbers and sort ascending');
  const out = autopilot(planResult);
  assert(out.ok, out.transcript.join(' '));
  assertEquals(out.engine, 'composer');
  assertEquals(out.title, planResult.title);
  assertEquals(out.attempts.length, 1);
  assertEquals(out.repairLog.length, 0);
  assertEquals(out.checks.map((check) => check.id).join(' '),
    'review run:demo (no stdin) expect:demo (no stdin) run:stdin expect:stdin memory');
  assert(out.checks.every((check) => check.ok));
  assert(out.output.includes('sum: 201'), 'the captured output is the demo run');
  assert(out.transcript[0].startsWith('Attempt 1: 6/6 checks passed.'));
  assert(out.transcript.some((line) => line.startsWith('PASS:')), 'the transcript ends with a verdict');
});

test('autopilot: a catalogued program gets a real smoke run', () => {
  const out = autopilot(plan('a hash table with string keys'));
  assert(out.ok, out.transcript.join(' '));
  assertEquals(out.engine, 'catalogue');
  assertEquals(out.runs.length, 1);
  assertEquals(out.runs[0].name, 'smoke run');
  assert(out.checks.some((check) => check.id === 'run:smoke run' && check.ok));
  assert(out.output.length > 0, 'the catalogue trace is captured');
});

test('autopilot: a missing include is added and the program re-run', () => {
  const code = String.raw`int main(void) {
  printf("hello\n");
  return 0;
}
`;
  const out = runPlan(code, [{ name: 'run', stdin: '', expect: ['hello'] }]);
  assert(out.ok, out.transcript.join(' '));
  assertEquals(out.attempts.length, 2);
  assertDeepEquals(out.repairLog.map((repair) => repair.rule), ['include']);
  assert(out.code.includes('#include <stdio.h>'), 'the header is present after the repair');
  assertEquals(out.output.trim(), 'hello');
});

test('autopilot: a missing semicolon is repaired where the parser points', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  int x = 1
  printf("%d\n", x);
  return 0;
}
`;
  const out = runPlan(code, [{ name: 'run', stdin: '', expect: ['1'] }]);
  assert(out.ok, out.transcript.join(' '));
  assertDeepEquals(out.repairLog.map((repair) => repair.rule), ['semicolon']);
  assert(out.code.includes('int x = 1;'), 'the statement is terminated');
});

test('autopilot: one unmatched block brace at EOF is closed', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  printf("hi\n");
  return 0;
`;
  const out = runPlan(code, [{ name: 'run', stdin: '', expect: ['hi'] }]);
  assert(out.ok, out.transcript.join(' '));
  assertDeepEquals(out.repairLog.map((repair) => repair.rule), ['brace']);
  assert(/}\s*$/.test(out.code), 'the file now ends with a closing brace');
});

test('autopilot: a first use of an undeclared name inside main is declared', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  count = 3;
  printf("%d\n", count);
  return 0;
}
`;
  const out = runPlan(code, [{ name: 'run', stdin: '', expect: ['3'] }]);
  assert(out.ok, out.transcript.join(' '));
  assertDeepEquals(out.repairLog.map((repair) => repair.rule), ['declare']);
  assert(out.code.includes('int count = 0;'), 'the missing declaration is inserted');
});

test('autopilot: a one-edit call typo is renamed only when the candidate is unique', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  prinf("hello\n");
  return 0;
}
`;
  const out = runPlan(code, [{ name: 'run', stdin: '', expect: ['hello'] }]);
  assert(out.ok, out.transcript.join(' '));
  assertDeepEquals(out.repairLog.map((repair) => repair.rule), ['typo']);
  assert(out.code.includes('printf("hello'), 'the call is renamed');
});

test('autopilot: gets() is refused as a typo and reported with its diagnosis', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  char buf[8];
  gets(buf);
  puts(buf);
  return 0;
}
`;
  const out = runPlan(code, [{ name: 'run', stdin: 'abc', expect: ['abc'] }]);
  assertEquals(out.ok, false);
  assertEquals(out.repairLog.length, 0);
  assertEquals(out.failure.id, 'review');
  assert(/gets/.test(out.failure.detail), 'the unsafe call names the failure');
  assertEquals(out.error.stage, 'Runtime');
  assert(out.diagnostics.some((entry) => /gets/.test(entry.text)), 'the diagnosis is carried through');
  assert(out.code.includes('gets(buf)'), 'the source is untouched');
});

test('autopilot: an unfreed heap block fails the memory check', () => {
  const code = String.raw`#include <stdio.h>
#include <stdlib.h>
int main(void) {
  char *p = malloc(4);
  p[0] = 'a';
  printf("%d\n", (int)p[0]);
  return 0;
}
`;
  const out = runPlan(code, [{ name: 'run', stdin: '', expect: ['97'] }]);
  assertEquals(out.ok, false);
  assertEquals(out.failure.id, 'memory');
  assert(/1 allocation/.test(out.failure.detail));
  assertEquals(out.repairLog.length, 0);
});

test('autopilot: a wrong expectation stops without inventing a repair', () => {
  const planResult = plan('the sum of numbers and sort ascending');
  const out = autopilot({
    ...planResult,
    tests: [{ name: 'stdin', stdin: '1 2 3', expect: ['sum: 999'] }],
  });
  assertEquals(out.ok, false);
  assertEquals(out.failure.id, 'expect:stdin');
  assert(out.failure.detail.includes('sum: 999'));
  assertEquals(out.repairLog.length, 0);
  assert(out.transcript.some((line) => line.startsWith('STOP:')), 'the transcript says it stopped');
});

test('autopilot: maxRepairs = 0 reports the broken run on the first attempt', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  int x = 1
  printf("%d\n", x);
  return 0;
}
`;
  const out = runPlan(code, [{ name: 'run', stdin: '', expect: ['1'] }], 0);
  assertEquals(out.ok, false);
  assertEquals(out.attempts.length, 1);
  assertEquals(out.repairLog.length, 0);
  assertEquals(out.failure.id, 'run:run');
});

test('autopilot: review hints are reported without blocking a passing run', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  char buf[8];
  scanf("%s", buf);
  printf("%s\n", buf);
  return 0;
}
`;
  const out = runPlan(code, [{ name: 'run', stdin: 'abc', expect: ['abc'] }]);
  assert(out.ok, out.transcript.join(' '));
  assert(out.warnings.some((hint) => /Unbounded %s/.test(hint.text)), 'the scanf hint survives');
  assertEquals(out.repairLog.length, 0);
});

test('autopilot: the same input produces the same transcript', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  int x = 1
  printf("%d\n", x);
  return 0;
}
`;
  const first = runPlan(code, [{ name: 'run', stdin: '', expect: ['1'] }]);
  const second = runPlan(code, [{ name: 'run', stdin: '', expect: ['1'] }]);
  assertDeepEquals(second, first);
  assert(first.attempts[0].repairs.some((repair) => repair.rule === 'semicolon'));
});
