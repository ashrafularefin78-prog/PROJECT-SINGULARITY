/**
 * M9 - explainer.
 *
 * Explaining is a parse plus a walk, so the tests assert the walk's findings
 * against code whose shape is known by inspection: recursion, heap calls,
 * nesting, globals and a prototype. Code that does not parse must say so and
 * return no invented structure.
 */
import { test, assert, assertEquals } from './harness.js';
import { EXPLAIN_VERSION, explain } from '../src/assistant/explain.js';
import { plan } from '../src/assistant/planner.js';

const RECURSIVE = String.raw`#include <stdio.h>
#include <stdlib.h>
int fact(int n) {
  if (n <= 1) return 1;
  return n * fact(n - 1);
}
int main(void) {
  int i;
  int total = 0;
  for (i = 0; i < 4; i++) {
    total += fact(i);
  }
  char *p = malloc(8);
  free(p);
  printf("%d\n", total);
  return 0;
}
`;

test('explainer: an empty source is refused, not guessed', () => {
  assertEquals(EXPLAIN_VERSION, '1.0');
  const out = explain('   ');
  assertEquals(out.ok, false);
  assertEquals(out.error.stage, 'Explain');
  assertEquals(out.functions.length, 0);
  assert(out.summary[0].startsWith('There is no C source to explain'));
});

test('explainer: a parse error keeps the parser line and column', () => {
  const out = explain('int main( {');
  assertEquals(out.ok, false);
  assertEquals(out.error.stage, 'Parse');
  assertEquals(out.error.line, 1);
  assert(out.error.col > 0);
  assert(out.error.message.length > 0);
  assert(out.summary[0].startsWith('This C does not parse'));
  assertEquals(out.stats.functions, 0);
});

test('explainer: recursion and heap use are reported per function', () => {
  const out = explain(RECURSIVE);
  assert(out.ok, JSON.stringify(out.error));
  assertEquals(out.stats.functions, 2);
  assertEquals(out.stats.loops, 1);
  assertEquals(out.stats.maxLoopDepth, 1);
  assertEquals(out.stats.allocs, 1);
  assertEquals(out.stats.frees, 1);
  assertEquals(out.stats.recursion.join(), 'fact');
  assertEquals(out.stats.io.join(), 'printf');

  const fact = out.functions.find((fn) => fn.name === 'fact');
  assertEquals(fact.signature, 'int fact(int n)');
  assertEquals(fact.recursive, true);
  assertEquals(fact.branches, 1);
  assertEquals(fact.valueReturns, 2);
  assertEquals(fact.calls.join(), 'fact');

  const main = out.functions.find((fn) => fn.name === 'main');
  assertEquals(main.signature, 'int main(void)');
  assertEquals(main.loops, 1);
  assertEquals(main.allocs.join(), 'malloc');
  assertEquals(main.frees, true);
  assertEquals(main.io.join(), 'printf');

  assert(out.summary.includes('Recursion: fact calls itself.'), 'recursion is named');
  assert(out.summary.some((line) => /Heap: 1 allocation/.test(line)), 'the heap is named');
  assert(out.summary.some((line) => /free is called/.test(line)), 'the release is named');
});

test('explainer: nested loops and local arrays reach the summary', () => {
  const code = String.raw`int main(void) {
  int a[3][4];
  int i;
  int j;
  for (i = 0; i < 3; i++) {
    for (j = 0; j < 4; j++) {
      a[i][j] = i * j;
    }
  }
  return 0;
}
`;
  const out = explain(code);
  assert(out.ok, JSON.stringify(out.error));
  assertEquals(out.stats.loops, 2);
  assertEquals(out.stats.maxLoopDepth, 2);
  assertEquals(out.functions[0].arrays.length, 1);
  assertEquals(out.functions[0].arrays[0].name, 'a');
  assertEquals(out.functions[0].arrays[0].multi, true);
  assert(out.summary.some((line) => /O\(n\^2\)/.test(line)), 'the growth hint is stated');
  assert(out.summary.some((line) => /Local arrays: int a\[3\]/.test(line)), 'the array is named');
  assert(out.summary.some((line) => /No I\/O calls/.test(line)), 'silence is reported as such');
});

test('explainer: globals, structs, enums and prototypes are listed', () => {
  const code = String.raw`struct point {
  int x;
  int y;
};
enum mode { MODE_A, MODE_B };
int g[4];
int helper(int x);
int main(void) {
  struct point p;
  p.x = 1;
  p.y = 2;
  return helper(g[0]) + p.x + p.y;
}
int helper(int x) {
  return x * 2;
}
`;
  const out = explain(code);
  assert(out.ok, JSON.stringify(out.error));
  assertEquals(out.globals.length, 1);
  assertEquals(out.globals[0].name, 'g');
  assertEquals(out.globals[0].array, true);
  assertEquals(out.structs[0].name, 'point');
  assertEquals(out.structs[0].fields, 2);
  assertEquals(out.enums[0].name, 'mode');
  assertEquals(out.protos.join(), 'helper');
  assert(out.summary.some((line) => /Globals: int g\[4\]/.test(line)), 'the global is named');
  assert(out.summary.some((line) => /Structs: point \(2 field\(s\)\)/.test(line)), 'the struct is named');
  assert(out.summary.some((line) => /2 function\(s\), 1 global\(s\), 1 struct\(s\), 1 enum\(s\), 1 prototype\(s\)/.test(line)),
    'the inventory counts everything');
});

test('explainer: a void helper is not accused of a missing return', () => {
  const code = String.raw`#include <stdio.h>
void hello(void) {
  puts("hi");
}
int main(void) {
  hello();
  return 0;
}
`;
  const out = explain(code);
  assert(out.ok, JSON.stringify(out.error));
  const line = out.summary.find((item) => item.startsWith('void hello(void)'));
  assert(line && !/no return statement/.test(line), 'void functions are allowed to fall off the end');
});

test('explainer: gets() keeps its safety warning', () => {
  const code = String.raw`#include <stdio.h>
int main(void) {
  char buf[8];
  gets(buf);
  puts(buf);
  return 0;
}
`;
  const out = explain(code);
  assert(out.ok);
  assert(out.summary.some((line) => /gets\(\) at line 4 cannot be bounded/.test(line)), 'the line is exact');
});

test('explainer: generated composer and catalogue programs can be read back', () => {
  const composed = plan('the sum of the numbers and sort ascending');
  const sum = explain(composed.code);
  assert(sum.ok, JSON.stringify(sum.error));
  assertEquals(sum.stats.functions, 3);
  assert(sum.stats.loops > 0);
  assertEquals(sum.stats.maxLoopDepth, 2, 'the nested sort loops are visible');
  assert(sum.summary.some((line) => /O\(n\^2\)/.test(line)));

  const catalogue = plan('a hash table with string keys');
  const hash = explain(catalogue.code);
  assert(hash.ok, JSON.stringify(hash.error));
  assertEquals(hash.stats.functions, 6);
  assertEquals(hash.structs.length, 2);
  assertEquals(hash.stats.allocs, 1);
  assertEquals(hash.stats.frees, 1);
  assert(hash.summary[0].startsWith('Entry point: int main(void)'), 'the entry point is found');
});
