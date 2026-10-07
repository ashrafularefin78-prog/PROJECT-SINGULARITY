import { test, assert, assertEquals } from './harness.js';
import { tokenize } from '../src/runtime/lexer.js';
import { interpret } from '../src/runtime/interpreter.js';

const run = (src, opts) => interpret(src, opts);
const ok = (src, opts) => {
  const r = run(src, opts);
  if (!r.ok) throw new Error(`expected success but got: ${r.error.stage} ${r.error.message}`);
  return r;
};

test('M2: lexer tracks line and column and strips the preprocessor', () => {
  const toks = tokenize('#include <stdio.h>\nint main() {\n  return 0;\n}\n');
  const kw = toks.find((t) => t.value === 'int');
  assertEquals(kw.line, 2, 'token line');
  assertEquals(kw.col, 1, 'token column');
  const ret = toks.find((t) => t.value === 'return');
  assertEquals(ret.line, 3);
  assertEquals(ret.col, 3);
});

test('M2: hello world compiles and runs with printf', () => {
  const r = ok('#include <stdio.h>\nint main(void) {\n  printf("Hello, World!\\n");\n  return 0;\n}\n');
  assertEquals(r.output, 'Hello, World!\n');
});

test('M2: arithmetic, integer division and modulo behave like C', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int a = 17, b = 5;
  printf("%d %d %d %d\\n", a + b, a - b, a * b, a / b);
  printf("%d %d\\n", a % b, -17 / 5);
  return 0;
}`);
  assertEquals(r.output, '22 12 85 3\n2 -3\n');
});

test('M2: loops, break and continue work', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int sum = 0;
  for (int i = 1; i <= 100; i++) {
    if (i % 2 == 0) continue;
    if (i > 50) break;
    sum = sum + i;
  }
  printf("%d\\n", sum);
  int n = 0;
  while (n < 3) { n++; }
  printf("%d\\n", n);
  return 0;
}`);
  assertEquals(r.output, '625\n3\n');
});

test('M2: recursion works (fib(20))', () => {
  const r = ok(`#include <stdio.h>
int fib(int n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
int main() {
  printf("%d\\n", fib(20));
  return 0;
}`);
  assertEquals(r.output, '6765\n');
});

test('M2: arrays with sizes and initialiser lists', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int primes[5] = {2, 3, 5, 7, 11};
  int total = 0;
  for (int i = 0; i < 5; i++) total += primes[i];
  int zeroes[4];
  printf("%d %d\\n", total, zeroes[3]);
  return 0;
}`);
  assertEquals(r.output, '28 0\n');
});

test('M2: char arrays, strings and stdin via getchar', () => {
  const r = ok(`#include <stdio.h>
int main() {
  char *msg = "abc";
  printf("%s %d %c\\n", msg, strlen(msg), msg[1]);
  int c;
  int count = 0;
  while ((c = getchar()) != -1) {
    putchar(c);
    count++;
  }
  printf("\\nread %d\\n", count);
  return 0;
}`, { stdin: 'hi!' });
  assertEquals(r.output, 'abc 3 b\nhi!\nread 3\n');
});

test('M2: pointers address and dereference, including through a call', () => {
  const r = ok(`#include <stdio.h>
void bump(int *p) {
  *p = *p + 10;
}
void swap(int *a, int *b) {
  int t = *a;
  *a = *b;
  *b = t;
}
int main() {
  int x = 1, y = 2;
  bump(&x);
  swap(&x, &y);
  printf("%d %d\\n", x, y);
  return 0;
}`);
  assertEquals(r.output, '2 11\n');
});

test('M2: printf supports flags, width and precision', () => {
  const r = ok(`#include <stdio.h>
int main() {
  printf("[%5d][%-5d][%03d][%.3s][%x][%c]\\n", 42, 42, 7, "abcdef", 255, 65);
  return 0;
}`);
  assertEquals(r.output, '[   42][42   ][007][abc][ff][A]\n');
});

test('M2: diagnose a syntax error with an exact line and column', () => {
  const r = run('int main() {\n  int x = ;\n  return 0;\n}\n');
  assert(!r.ok, 'expected a compile failure');
  assertEquals(r.error.stage, 'Parse');
  assertEquals(r.error.line, 2, 'error line');
  assertEquals(r.error.col, 11, 'error column');
});

test('M2: diagnose an undeclared identifier at the right line', () => {
  const r = run('int main() {\n  return missing + 1;\n}\n');
  assert(!r.ok);
  assertEquals(r.error.stage, 'Runtime');
  assert(/undeclared identifier 'missing'/.test(r.error.message), r.error.message);
  assertEquals(r.error.line, 2);
});

test('M2: undeclared function and missing entry point are reported', () => {
  const a = run('int main() { nope(1); return 0; }');
  assert(!a.ok);
  assert(/undefined function 'nope'/.test(a.error.message), a.error.message);

  const b = run('int helper() { return 1; }');
  assert(!b.ok);
  assertEquals(b.error.stage, 'Link');
});

test('M2: division by zero and out-of-bounds access fail closed', () => {
  const a = run('int main() { int z = 0; return 1 / z; }');
  assert(!a.ok);
  assert(/division by zero/.test(a.error.message), a.error.message);

  const b = run('int main() { int a[3] = {1,2,3}; return a[5]; }');
  assert(!b.ok);
  assert(/out of bounds/.test(b.error.message), b.error.message);
});

test('M2: an infinite loop is stopped by the deterministic step budget', () => {
  const r = run('int main() { while (1) { } return 0; }', { maxSteps: 100000 });
  assert(!r.ok, 'infinite loop must not run forever');
  assert(/step limit exceeded/.test(r.error.message), r.error.message);
  assert(r.steps > 100000, 'budget should be consumed');
});

test('M2: runaway recursion hits the depth limit instead of crashing', () => {
  const r = run('int f(int n) { return f(n + 1); }\nint main() { return f(0); }');
  assert(!r.ok);
  assert(/stack depth limit exceeded/.test(r.error.message), r.error.message);
});

test('M2: the heap budget refuses an oversized allocation', () => {
  const r = run('int main() { int big[20000]; big[0] = 1; return 0; }', { maxHeapBytes: 100000 });
  assert(!r.ok);
  assert(/heap limit exceeded/.test(r.error.message), r.error.message);
});

test('M2: globals, if/else and logical operators', () => {
  const r = ok(`#include <stdio.h>
int counter = 5;
int classify(int n) {
  if (n > 0 && n < 10) return 1;
  else if (n == 0 || n == 10) return 2;
  else return 3;
}
int main() {
  counter++;
  printf("%d %d %d %d\\n", classify(4), classify(0), classify(99), counter);
  printf("%d %d\\n", !0, !5);
  return 0;
}`);
  assertEquals(r.output, '1 2 3 6\n1 0\n');
});

test('M2: bitwise operators and compound assignment', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int x = 12;
  x += 4; x *= 2; x -= 8;
  printf("%d %d %d %d\\n", x, 12 & 10, 12 | 3, 1 << 4);
  return 0;
}`);
  assertEquals(r.output, '24 8 15 16\n');
});

test('M2: exit() stops the program immediately', () => {
  const r = ok(`#include <stdio.h>
int main() {
  printf("before\\n");
  exit(0);
  printf("after\\n");
  return 0;
}`);
  assertEquals(r.output, 'before\n');
});
