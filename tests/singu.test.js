/**
 * M9 - SINGU AI.
 *
 * The engine's contract is narrow enough to test exhaustively without a model:
 * every pattern must emit deterministic C that the M2 interpreter actually
 * runs, the brief matcher must pick the pattern a reader would pick, and the
 * reviewer/diagnoser must name the problem instead of shrugging.
 *
 * These tests run in bare Node as well as the browser: the interpreter is pure
 * JavaScript and the engine touches no DOM.
 */
import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { interpret } from '../src/runtime/interpreter.js';
import {
  EXAMPLES, LEVELS, RECIPES, browse, classifyLevel, diagnose, generate, review,
} from '../src/assistant/singu.js';

const recipe = (id) => RECIPES.find((r) => r.id === id);

test('SINGU: the catalogue declares unique ids across all three levels', () => {
  assertEquals(RECIPES.length, 15, 'catalogue size');
  assertEquals(LEVELS.length, 3, 'level count');
  const ids = RECIPES.map((r) => r.id);
  assertEquals(new Set(ids).size, ids.length, 'ids are unique');
  for (const level of LEVELS) {
    const count = RECIPES.filter((r) => r.level === level.id).length;
    assert(count >= 4, `${level.id} has at least 4 patterns (has ${count})`);
  }
  for (const r of RECIPES) {
    assert(r.defaultPrompt && r.summary && r.teaches.length && r.hazards.length,
      `${r.id} carries a brief, summary and notes`);
  }
});

test('SINGU: generation is deterministic', () => {
  const first = generate('a hash table with string keys and chained buckets');
  const second = generate('a hash table with string keys and chained buckets');
  assertDeepEquals(second, first, 'two identical briefs produce identical results');
  assertEquals(first.code, recipe('hash-table').build(first.params), 'code comes from the pattern build');
});

test('SINGU: every generated pattern is review-clean', () => {
  for (const r of RECIPES) {
    const report = review(generate(r.defaultPrompt).code);
    assertEquals(report.issues.length, 0, `${r.id} has no structural issues: ${report.issues.map((i) => i.text).join('; ')}`);
  }
});

test('SINGU: every generated pattern compiles and runs in the M2 interpreter', () => {
  for (const r of RECIPES) {
    const result = interpret(generate(r.defaultPrompt).code, {});
    assert(result.ok, `${r.id} compiles and runs: ${result.error && result.error.stage} ${result.error && result.error.message}`);
    assert(result.output && result.output.length > 0, `${r.id} prints a deterministic trace`);
  }
});

test('SINGU: every level is reachable from its own example brief', () => {
  for (const example of EXAMPLES) {
    const result = generate(example.prompt, { level: example.level });
    assertEquals(result.level, example.level, `example "${example.prompt}" stays in ${example.level}`);
  }
});

test('SINGU: the level hint in a brief is read out of the prose', () => {
  assertEquals(classifyLevel('a system level allocator'), 'expert');
  assertEquals(classifyLevel('low-level bit masks'), 'low');
  assertEquals(classifyLevel('an advanced data structure'), 'advanced');
  assertEquals(classifyLevel('a program that says hello'), null);
});

test('SINGU: a size in the brief binds the pattern knob', () => {
  const ring = generate('a ring buffer of 16 ints');
  assertEquals(ring.recipe.id, 'ring-buffer');
  assertEquals(ring.params.cap, 16);
  assert(ring.code.includes('#define CAP 16'), 'the capacity reaches the C');

  const bitset = generate('a bitset of 100 bits');
  assertEquals(bitset.recipe.id, 'bitset');
  assertEquals(bitset.params.bits, 128, 'bits round up to a whole 32-bit word');
  assert(bitset.code.includes('#define BIT_COUNT 128'), 'the word count follows the knob');
});

test('SINGU: out-of-range knobs clamp instead of emitting unusable C', () => {
  assertEquals(generate('a ring buffer of 9999').params.cap, 64);
  assertEquals(generate('a slab pool of 9999 blocks').params.blocks, 32);
  assertEquals(generate('an arena of 999999 bytes').params.bytes, 2048);
  const huge = generate('a bitset of 99999 bits');
  assertEquals(huge.params.bits, 512);
  const run = interpret(huge.code, {});
  assert(run.ok, 'the clamped program still compiles');
});

test('SINGU: the chosen level breaks a keyword tie', () => {
  assertEquals(generate('queue').recipe.id, 'ring-buffer', 'no level: the low-level FIFO');
  assertEquals(generate('queue', { level: 'low' }).recipe.id, 'ring-buffer');
  assertEquals(generate('queue', { level: 'expert' }).recipe.id, 'spsc-ring');
  assertEquals(generate('a system level ring buffer for a producer and consumer').recipe.id, 'spsc-ring');
});

test('SINGU: the matcher finds the pattern a reader would pick', () => {
  const cases = {
    'write a linked list in C': 'linked-list',
    'reverse a linked list and detect a cycle': 'linked-list',
    'a dynamic array that grows with realloc': 'dynamic-array',
    'a hash table with string keys': 'hash-table',
    'a binary search tree with in-order traversal': 'binary-tree',
    'qsort with a comparator function pointer': 'sorting',
    'split a string in place on a delimiter': 'string-split',
    'an arena bump allocator with alignment': 'arena-allocator',
    'a fixed-size slab pool with a free list': 'slab-pool',
    'serialize a record into bytes little-endian': 'wire-format',
    'a lock-free single-producer single-consumer queue': 'spsc-ring',
    'an mmio register driver for a peripheral': 'mmio-registers',
    'bit hacks for popcount and rotate': 'bit-toolkit',
    'a hex dump and checksum of a packet': 'hexdump-checksum',
  };
  for (const [brief, id] of Object.entries(cases)) {
    const result = generate(brief);
    assertEquals(result.recipe.id, id, `brief "${brief}"`);
    assert(result.confidence >= 0.5, `brief "${brief}" has confidence ${result.confidence.toFixed(2)}`);
  }
});

test('SINGU: an unmatched brief falls back honestly and offers alternatives', () => {
  const result = generate('a web server in C');
  assertEquals(result.levelOnly, false);
  assert(result.confidence <= 0.35, `low confidence, got ${result.confidence}`);
  assert(result.plan[0].includes('No pattern keyword matched'), 'the plan says the match is weak');
  assertEquals(result.alternatives.length, 3);
  assert(!result.alternatives.some((a) => a.id === result.recipe.id), 'the chosen pattern is not its own alternative');
  const run = interpret(result.code, {});
  assert(run.ok, 'the fallback still runs');
});

test('SINGU: browse filters by level without mutating the catalogue', () => {
  const before = RECIPES.length;
  const expert = browse('expert');
  assert(expert.length >= 4, 'expert has patterns');
  assert(expert.every((r) => r.level === 'expert'), 'only expert patterns');
  assertEquals(browse().length, before, 'no level returns the whole catalogue');
  assertEquals(RECIPES.length, before, 'browse does not mutate');
});

test('SINGU: review names unsafe calls, imbalance and ownership problems', () => {
  const bad = `#include <stdio.h>
int main(void) {
  char buf[8];
  gets(buf);
  char *p = malloc(4);
  printf("%s\\n", buf);
  return 0;
}`;
  const report = review(bad);
  assert(report.issues.some((i) => /gets/.test(i.text)), 'gets is an issue');
  assert(!report.issues.some((i) => /brace/.test(i.text)), 'balanced braces are not reported');
  assert(report.hints.some((i) => /strcpy|Allocation balance/.test(i.text)), 'allocation balance is a hint');

  const unbalanced = 'int main(void) { if (1) { return 0; }';
  assert(review(unbalanced).issues.some((i) => /brace/.test(i.text)), 'unbalanced braces are an issue');
  assert(review('int f(void) { return 0; }').issues.some((i) => /main/.test(i.text)), 'no main() is an issue');
});

test('SINGU: review does not count braces inside strings or comments', () => {
  const code = `#include <stdio.h>
int main(void) {
  /* a comment with { and } and ( */
  printf("a { brace } and a ) paren\\n");
  char c = '{';
  printf("%c\\n", c);
  return 0;
}`;
  const report = review(code);
  assertEquals(report.issues.length, 0, `no false imbalance: ${report.issues.map((i) => i.text).join('; ')}`);
});

test('SINGU: diagnose turns sandbox errors into an explanation', () => {
  const oob = interpret('int main(void) { int a[3]; a[5] = 1; return 0; }', {});
  assert(!oob.ok, 'the probe really fails');
  const notes = diagnose(oob.error);
  assert(notes.some((n) => /outside the array/.test(n.text)), 'the bounds note is present');
  assert(notes[0].line >= 1, 'the first entry carries the source line');

  const noMain = interpret('int f(void) { return 1; }', {});
  assert(diagnose(noMain.error).some((n) => /int main/.test(n.text)), 'the missing-entry-point note is present');

  const heap = interpret('int main(void) { char *p = malloc(4); p[9] = 1; free(p); return 0; }', {});
  assert(diagnose(heap.error).some((n) => /heap block/.test(n.text)), 'the heap note is present');
});
