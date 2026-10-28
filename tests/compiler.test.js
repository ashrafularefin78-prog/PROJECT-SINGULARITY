import { test, assert, assertEquals } from './harness.js';
import { tokenize } from '../src/runtime/lexer.js';
import { interpret } from '../src/runtime/interpreter.js';
import { validateProject } from '../src/runtime/clang.js';
import { assertThrows } from './harness.js';

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

const wasmRun = async (source, options = {}) => {
  if (typeof document === 'undefined') {
    const { readFile } = await import('node:fs/promises');
    const { compileAndRun } = await import('../src/runtime/clang.js');
    return compileAndRun(source, { ...options, fetchAsset: async url => new Response(await readFile(url)) });
  }
  const { Sandbox } = await import('../src/runtime/sandbox.js');
  return new Sandbox({ backend: 'clang', timeLimitMs: 4000 }).run(source, options);
};

test('M2: intercepted empty toolchain assets fail with an actionable diagnostic', async () => {
  const { compileAndRun } = await import('../src/runtime/clang.js');
  const phases = [];
  const result = await compileAndRun('int main(void) { return 0; }', {
    fetchAsset: async url => url.pathname.endsWith('/manifest.json')
      ? new Response(JSON.stringify({ files: {} }))
      : new Response(null, { status: 204, statusText: 'Intercepted by the IDM Advanced Integration' }),
    onStatus: status => phases.push(status.phase),
  });
  assert(!result.ok);
  assertEquals(result.error.stage, 'Toolchain');
  assert(/toolchain asset (?:memfs\.wasm|clang\.wasm|lld\.wasm|sysroot\.tar) unavailable/.test(result.error.message), result.error.message);
  assert(/HTTP 204: Intercepted by the IDM Advanced Integration; empty body/.test(result.error.message), result.error.message);
  assertEquals(result.output, '');
  assertEquals(phases.join(','), 'loading');
});

test('M2: WebAssembly C compiles real headers, variadic functions and goto', async () => {
  const r = await wasmRun(`#include <stdio.h>
#include <stdarg.h>
int sum(int count, ...) {
  va_list args; va_start(args, count);
  int result = 0;
  for (int i = 0; i < count; ++i) result += va_arg(args, int);
  va_end(args); return result;
}
int main(void) {
  int a, b;
  if (scanf("%d %d", &a, &b) != 2) goto fail;
  printf("%d\\n", sum(3, a, b, 5));
  return 0;
fail: return 2;
}`, { stdin: '12\n34\n', standard: 'c11' });
  assert(r.ok, r.error?.message);
  assertEquals(r.output, '51\n');
  assertEquals(r.exitCode, 0);
});

test('M2: WebAssembly C++ supports templates, classes, STL and cin/cout', async () => {
  const r = await wasmRun(`#include <iostream>
#include <vector>
#include <algorithm>
template<class T> class Box { public: T value; Box(T v) : value(v) {} };
int main() {
  std::vector<int> v{3, 1, 2};
  std::sort(v.begin(), v.end());
  int n = 0; std::cin >> n;
  Box<int> box(n);
  for (auto x : v) std::cout << x << ' ';
  std::cout << box.value << '\\n';
}`, { language: 'cpp', standard: 'c++17', stdin: '9\n' });
  assert(r.ok, r.error?.message);
  assertEquals(r.output, '1 2 3 9\n');
});

test('M2: WebAssembly links extra source files and custom headers', async () => {
  const r = await wasmRun('#include "helper.h"\n#include <stdio.h>\nint main(void) { printf("%d\\n", twice(21)); }', {
    files: { 'helper.h': 'int twice(int);', 'helper.c': '#include "helper.h"\nint twice(int n) { return n * 2; }' },
  });
  assert(r.ok, r.error?.message);
  assertEquals(r.output, '42\n');
});

test('M2: WebAssembly reports compiler positions and unresolved symbols', async () => {
  const syntax = await wasmRun('int main(void) {\n  int x = ;\n  return 0;\n}');
  assert(!syntax.ok);
  assertEquals(syntax.error.stage, 'Compile');
  assertEquals(syntax.error.line, 2);
  assertEquals(syntax.error.col, 11);
  const link = await wasmRun('int missing(void); int main(void) { return missing(); }');
  assert(!link.ok);
  assertEquals(link.error.stage, 'Link');
  assert(/missing/.test(link.error.message), link.error.message);
});

test('M2: WebAssembly preserves nonzero exits and traps', async () => {
  const exit = await wasmRun('int main(void) { return 7; }');
  assert(!exit.ok);
  assertEquals(exit.exitCode, 7);
  const trap = await wasmRun('int main(void) { __builtin_trap(); }');
  assert(!trap.ok);
  assertEquals(trap.error.stage, 'Runtime');
});

test('M2: WebAssembly termination preserves explicitly flushed stdout', async () => {
  const r = await wasmRun('#include <stdio.h>\nint main(void) { printf("before"); fflush(stdout); for (;;) {} }', { timeLimitMs: 150 });
  assert(r.killed);
  assert(/Execution stopped/.test(r.error.message), r.error.message);
  assertEquals(r.output, 'before');
}, { needs: 'dom' });

test('M2: sandbox restart and stale kill handles cannot stop a later run', async () => {
  const { Sandbox } = await import('../src/runtime/sandbox.js');
  const sandbox = new Sandbox({ timeLimitMs: 4000 });
  const first = sandbox.start('int main(void) { while(1) {} }');
  const second = sandbox.start('int main(void) { printf("second"); return 0; }');
  first.kill();
  const [a, b] = await Promise.all([first.promise, second.promise]);
  assert(a.killed);
  assert(b.ok, b.error?.message);
  assertEquals(b.output, 'second');
}, { needs: 'dom' });

test('M2: project boundaries reject unsafe names, sizes and standards', () => {
  const source = 'int main(void) { return 0; }';
  for (const language of ['constructor', '__proto__', 'javascript']) assertThrows(() => validateProject(source, { language }));
  for (const name of ['../escape.h', '/absolute.c', 'folder\\\\file.h', 'main.c', 'main.cpp', '.hidden.h']) {
    assertThrows(() => validateProject(source, { files: { [name]: '' } }));
  }
  assertThrows(() => validateProject(source, { standard: 'c++23' }));
  assertThrows(() => validateProject('x'.repeat(1024 * 1024 + 1)));
  assertThrows(() => validateProject(source, { stdin: 'x'.repeat(1024 * 1024 + 1) }));
  assertThrows(() => validateProject(source, { files: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}.h`, ''])) }));
  assertThrows(() => validateProject(source, { maxHeapBytes: 1 }));
  assertEquals(validateProject(source, { files: { 'valid.h': '' } }).language, 'c');
});

test('M2: generated WebAssembly cannot open even its compiler input files', async () => {
  const result = await wasmRun('#include <stdio.h>\nint main(void) { FILE *f = fopen("/project/main.c", "r"); puts(f ? "unexpected" : "denied"); return f ? 1 : 0; }');
  assert(result.ok, result.error?.message);
  assertEquals(result.output, 'denied\n');
});

test('M2: WebAssembly output is bounded without losing streamed text', async () => {
  const result = await wasmRun('#include <stdio.h>\nint main(void) { for (int i = 0; i < 1100000; ++i) putchar(65); }');
  assert(!result.ok);
  assertEquals(result.error.stage, 'Runtime');
  assert(/output limit exceeded/.test(result.error.message), result.error.message);
  assert(result.output.length > 0 && result.output.length <= 1024 * 1024);
  const writes = await wasmRun('#include <stdio.h>\nint main(void) { setbuf(stdout, NULL); for (int i = 0; i < 5000; ++i) putchar(65); }');
  assert(!writes.ok);
  assert(/4096 writes/.test(writes.error.message), writes.error.message);
  assertEquals(writes.output.length, 4096);
});
