/**
 * M9 - composer.
 *
 * Every block is a claim: "this brief produces C that runs and prints this
 * trace". The tests hold the claim to all 47 blocks, not a sample, and they
 * compute the expected lines from the block data before the C exists. A block
 * that quietly changes its output without changing its expectation fails here.
 */
import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { interpret } from '../src/runtime/interpreter.js';
import { review } from '../src/assistant/singu.js';
import {
  COMPOSER_TASKS, COMPOSER_VERSION, DEMO_INTS, FAMILIES, TEST_INTS, TEST_TEXT,
  browseComposer, compose,
} from '../src/assistant/compose.js';

const run = (code, stdin) => interpret(code, { stdin });

function checkTrace(result, item) {
  const executed = run(result.code, item.stdin);
  assert(executed.ok, `${result.id}/${item.name}: ${executed.error && executed.error.message}`);
  const lines = String(executed.output || '').split('\n').map((line) => line.trimEnd());
  let from = 0;
  for (const want of item.expect) {
    const at = lines.indexOf(want, from);
    assert(at >= from, `${result.id}/${item.name}: expected "${want}" in order after line ${from}`);
    from = at + 1;
  }
}

test('composer: the library is 47 unique blocks over four input families', () => {
  assertEquals(COMPOSER_VERSION, '1.0');
  assertEquals(COMPOSER_TASKS.length, 47, 'block count');
  assertEquals(Object.keys(FAMILIES).length, 4, 'family count');
  const ids = COMPOSER_TASKS.map((task) => task.id);
  assertEquals(new Set(ids).size, ids.length, 'ids are unique');
  for (const task of COMPOSER_TASKS) {
    assert(task.defaultPrompt && task.title && task.keywords.length && task.teaches.length && task.note,
      `${task.id} carries a brief, a title and a note`);
    assert(FAMILIES[task.family], `${task.id} names a known family`);
  }
  assertEquals(COMPOSER_TASKS.filter((task) => task.family === 'ints').length, 14);
  assertEquals(COMPOSER_TASKS.filter((task) => task.family === 'text').length, 9);
  assertEquals(COMPOSER_TASKS.filter((task) => task.family === 'matrix').length, 3);
  assertEquals(COMPOSER_TASKS.filter((task) => task.family === 'scalar').length, 21);
});

test('composer: every published example prompt selects its own block', () => {
  for (const task of COMPOSER_TASKS) {
    const result = compose(task.defaultPrompt);
    assert(result, `${task.id} matches its own example brief`);
    assertEquals(result.id, `composer:${task.id}`, `"${task.defaultPrompt}"`);
    assert(result.confidence >= 0.55, `${task.id} is a confident match`);
  }
});

test('composer: every block emits review-clean C', () => {
  for (const task of COMPOSER_TASKS) {
    const result = compose(task.defaultPrompt);
    const report = review(result.code);
    assertEquals(report.issues.length, 0,
      `${task.id}: ${report.issues.map((issue) => issue.text).join('; ')}`);
  }
});

test('composer: every block runs its own acceptance tests', () => {
  for (const task of COMPOSER_TASKS) {
    const result = compose(task.defaultPrompt);
    assert(result.tests.length >= 1, `${task.id} ships at least one test`);
    for (const item of result.tests) {
      assertEquals(typeof item.stdin, 'string', `${task.id}/${item.name} declares stdin`);
      assert(item.expect.length > 0, `${task.id}/${item.name} expects a trace`);
      checkTrace(result, item);
    }
  }
});

test('composer: two identical briefs produce identical plans', () => {
  const first = compose('the average of the numbers and the largest value');
  const second = compose('the average of the numbers and the largest value');
  assertDeepEquals(second, first);
  assertEquals(first.steps.map((step) => step.id).join('+'), 'mean+min-max');
});

test('composer: a paired brief composes both blocks with combined expectations', () => {
  const result = compose('the sum of the array and sort the numbers ascending');
  assertEquals(result.id, 'composer:sum+sort-asc');
  assertEquals(result.engine, 'composer');
  assertEquals(result.steps.length, 2);
  assertDeepEquals(result.tests[0].expect, ['sum: 201', 'ascending: 3 4 7 15 19 23 42 88']);
  assertDeepEquals(result.tests[1].expect, ['sum: 15', 'ascending: 1 2 3 4 5']);
  checkTrace(result, result.tests[0]);
  checkTrace(result, result.tests[1]);
  assert(result.notes.some((note) => /Sum of an array/.test(note)), 'both blocks are explained');
  assert(result.code.includes('sort_asc'), 'the sort helper is emitted');
});

test('composer: clause order does not change the emitted program', () => {
  const forward = compose('sum the array and sort the numbers ascending');
  const backward = compose('sort the numbers ascending and sum the array');
  assertEquals(backward.id, forward.id);
  assertEquals(backward.code, forward.code);
  assertEquals(backward.title, forward.title);
});

test('composer: a single task is not split by a stray conjunction', () => {
  const result = compose('binary search a sorted array for a value');
  assertEquals(result.id, 'composer:binary-search');
  assertEquals(result.steps.length, 1, 'sorted is context, not a second step');
});

test('composer: a brief that names two input families is reported, not merged', () => {
  const result = compose('reverse a string and reverse an array of numbers');
  assertEquals(result.family, 'text');
  assertEquals(result.id, 'composer:reverse-text');
  assertEquals(result.aside.length, 1);
  assert(result.aside.some((item) => /reverse an array/i.test(item.title)), 'the array step is set aside');
  assert(result.notes.some((note) => /Detected but not emitted/.test(note)), 'the omission is in the notes');
  assert(result.hazards.some((hazard) => /another input family/.test(hazard)), 'the hazard is stated');
  assert(!result.code.includes('MAXN'), 'no integer-array program was mixed in');
});

test('composer: an unknown brief returns nothing rather than a wrong program', () => {
  assertEquals(compose(''), null);
  assertEquals(compose('   '), null);
  assertEquals(compose('a web server in C'), null);
  for (const brief of ['a ring buffer with capacity 8', 'a hash table with string keys', 'a lock-free SPSC queue']) {
    assertEquals(compose(brief), null, `"${brief}" belongs to the systems catalogue`);
  }
});

test('composer: "from 1 to N" binds the endpoint, and oversized knobs clamp aloud', () => {
  const sum = compose('the sum of the numbers from 1 to 100');
  assertEquals(sum.id, 'composer:sum-to-n');
  assertEquals(sum.params.n, 100, '100 is the endpoint, not the lower bound');
  assertDeepEquals(sum.tests[0].expect, ['sum 1..100 = 5050']);

  const fizz = compose('fizzbuzz up to 100000');
  assertEquals(fizz.id, 'composer:fizzbuzz');
  assertEquals(fizz.params.n, 30, 'the trace limit clamps the demo');
  const clamped = run(fizz.code, '100000');
  assert(clamped.output.includes('above the trace limit'), 'the run announces the clamp');
  checkTrace(fizz, { name: 'clamped', stdin: '100000', expect: fizz.tests[0].expect.slice(0, 4) });
});

test('composer: numeric knobs reach the generated code', () => {
  const caesar = compose('a caesar cipher with a shift of 7');
  assertEquals(caesar.id, 'composer:caesar');
  assertEquals(caesar.params.shift, 7);
  checkTrace(caesar, caesar.tests[0]);

  const table = compose('the multiplication table of 7');
  assertEquals(table.id, 'composer:times-table');
  assertEquals(table.params.n, 7);
  checkTrace(table, table.tests[0]);
});

test('composer: matrix programs state their fixed shape and skip the stdin demo', () => {
  const result = compose('transpose a matrix');
  assertEquals(result.family, 'matrix');
  assertEquals(result.tests.length, 1, 'a matrix has one fixed input, so one test');
  assertEquals(result.tests[0].stdin, '');
  assert(result.hazards.some((hazard) => /fixed at 3/.test(hazard)), 'the fixed size is disclosed');
  checkTrace(result, result.tests[0]);
});

test('composer: browse filters without mutating the library', () => {
  assertEquals(browseComposer().length, COMPOSER_TASKS.length);
  const text = browseComposer({ family: 'text' });
  assertEquals(text.length, 9);
  assert(text.every((task) => task.family === 'text'));
  const advanced = browseComposer({ level: 'advanced' });
  assert(advanced.length > 0 && advanced.every((task) => task.level === 'advanced'));
  assertEquals(COMPOSER_TASKS.length, 47, 'the library is unchanged');
});

test('composer: demo constants stay consistent with the shipped expectations', () => {
  assertEquals(DEMO_INTS.reduce((total, value) => total + value, 0), 201);
  assertEquals(TEST_INTS.join(' '), '1 2 3 4 5');
  assertEquals(TEST_TEXT, 'step on no pets');
  const sum = compose(COMPOSER_TASKS.find((task) => task.id === 'sum').defaultPrompt);
  assert(sum.tests[0].expect.includes('sum: 201'));
});
