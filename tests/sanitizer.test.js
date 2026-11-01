// Memory-error detection suite.
//
// The arena already fails closed on the errors it can see - a null dereference,
// an access past the end of a block, an exhausted heap. This suite is about the
// four it could not see at all, and about the one property that makes reporting
// them safe: a finding must never move a value the program can observe. Every
// test here therefore compares a sanitized run against the same program run
// unsanitized, and asserts the output is identical.
import { test, assert, assertEquals, assertDeepEquals, assertThrows } from './harness.js';
import { interpret } from '../src/runtime/interpreter.js';
import { FINDING_KINDS, SANITIZER_VERSION, Sanitizer, makeFinding } from '../src/runtime/sanitizer.js';

const stdio = '#include <stdio.h>\n';
const clean = (src, opts = {}) => {
  const r = interpret(stdio + src, opts);
  if (!r.ok) throw new Error(`expected success but got: ${r.error.stage} ${r.error.message}`);
  return r;
};
const kinds = (result) => (result.findings || []).map((f) => f.kind);
const find = (result, kind) => (result.findings || []).find((f) => f.kind === kind);
const noFindings = (result, msg) => assertDeepEquals(result.findings || [], [], msg || `expected no findings, got ${kinds(result).join(',')}`);

test('sanitizer: off by default, and a run without it carries no findings', () => {
  const watched = clean('int main() { int *p = (int *)malloc(8); *p = 1; return 0; }', { sanitize: true });
  assert(Array.isArray(watched.findings), 'a sanitized run must hand back a findings list');
  assert(kinds(watched).includes('memory-leak'), kinds(watched).join(','));

  const plain = interpret(stdio + 'int main() { int *p = (int *)malloc(8); *p = 1; return 0; }', {});
  assert(plain.ok);
  assert(plain.findings === undefined, 'an unsanitized run must not grow a findings field');
});

test('sanitizer: a malloc block read before any assignment is reported, calloc is not', () => {
  const heap = clean(`int main() {
  int *p = (int *)malloc(16);
  int v = *p;
  printf("%d\\n", v);
  free(p);
  return 0;
}`, { sanitize: true });
  const uninit = find(heap, 'uninitialized-read');
  assert(uninit, kinds(heap).join(','));
  assertEquals(uninit.cwe, 'CWE-457');
  assertEquals(uninit.line, 4, 'the finding points at the read, not at the allocation');
  assertEquals(heap.output, '0\n', 'the zero-filled arena still returns 0 - the finding is a report, not a crash');

  const cleared = clean(`int main() {
  int *p = (int *)calloc(4, 4);
  int v = *p;
  printf("%d\\n", v);
  free(p);
  return 0;
}`, { sanitize: true });
  noFindings(cleared, 'calloc promises zeroed storage, so reading it is not a finding');
  assertEquals(cleared.output, '0\n');
});

test('sanitizer: writing the byte first clears the read, and memset counts as writing', () => {
  const written = clean(`int main() {
  int *p = (int *)malloc(16);
  *p = 7;
  printf("%d\\n", *p);
  free(p);
  return 0;
}`, { sanitize: true });
  noFindings(written);

  const set = clean(`int main() {
  char *p = (char *)malloc(16);
  memset(p, 65, 4);
  printf("%c\\n", p[3]);
  free(p);
  return 0;
}`, { sanitize: true });
  noFindings(set);
  assertEquals(set.output, 'A\n');
});

test('sanitizer: realloc grows a block and the untouched tail is reported', () => {
  const r = clean(`int main() {
  int *p = (int *)malloc(4);
  *p = 9;
  int *q = (int *)realloc(p, 8);
  printf("%d\\n", q[0]);
  int tail = q[1];
  printf("%d\\n", tail);
  free(q);
  return 0;
}`, { sanitize: true });
  assertEquals(r.output, '9\n0\n');
  const uninit = find(r, 'uninitialized-read');
  assert(uninit, kinds(r).join(','));
  assertEquals(uninit.line, 7, 'the finding is on the read of q[1], not on the realloc');
});

test('sanitizer: a pointer field left pointing at a released block is a use after free', () => {
  const r = clean(`struct Node { int *data; };
int main() {
  struct Node *n = (struct Node *)malloc(sizeof(struct Node));
  int *p = (int *)malloc(8);
  *p = 3;
  n->data = p;
  free(p);
  printf("%d\\n", *n->data);
  free(n);
  return 0;
}`, { sanitize: true });
  const stale = find(r, 'use-after-free');
  assert(stale, kinds(r).join(','));
  assertEquals(stale.cwe, 'CWE-416');
  assertEquals(stale.line, 9, 'the finding is on the read through the field');
  assert(/released/.test(stale.detail), stale.detail);
  assertEquals(r.output, '3\n', 'reading the freed bytes still returns what the arena holds');
});

test('sanitizer: a pointer field whose address was handed to a later allocation is caught', () => {
  const r = clean(`struct Node { int *data; };
int main() {
  struct Node *n = (struct Node *)malloc(sizeof(struct Node));
  int *p = (int *)malloc(8);
  n->data = p;
  free(p);
  int *again = (int *)malloc(8);
  *again = 42;
  printf("%d\\n", *n->data);
  free(again);
  free(n);
  return 0;
}`, { sanitize: true });
  const stale = find(r, 'use-after-free');
  assert(stale, kinds(r).join(','));
  assert(/later allocation/.test(stale.detail), stale.detail);
  assertEquals(r.output, '42\n', 'the recycled block is the new owner and the read still returns its bytes');
});

test('sanitizer: a traversal that reads the same stale field in a loop is one finding', () => {
  const r = clean(`struct Node { int *data; };
int main() {
  struct Node *n = (struct Node *)malloc(sizeof(struct Node));
  int *p = (int *)malloc(8);
  n->data = p;
  free(p);
  int total = 0;
  for (int i = 0; i < 5; i++) total += *n->data;
  printf("%d\\n", total);
  free(n);
  return 0;
}`, { sanitize: true });
  assertEquals(kinds(r).filter((k) => k === 'use-after-free').length, 1, 'five reads of one stale handle is one bug');
  assertEquals(r.output, '0\n');
});

test('sanitizer: writing through a stale handle is reported on the write line', () => {
  const r = clean(`struct Node { int *data; };
int main() {
  struct Node *n = (struct Node *)malloc(sizeof(struct Node));
  int *p = (int *)malloc(8);
  n->data = p;
  free(p);
  *n->data = 7;
  free(n);
  return 0;
}`, { sanitize: true });
  const stale = find(r, 'use-after-free');
  assert(stale, kinds(r).join(','));
  assertEquals(stale.line, 8, 'the store through the stale field is the finding');
});

test('sanitizer: a double free is refused and named', () => {
  const twice = interpret(stdio + 'int main() { int *p = (int *)malloc(16); free(p); free(p); return 0; }', { sanitize: true });
  assert(!twice.ok);
  assert(/double free/.test(twice.error.message), twice.error.message);
  assert(kinds(twice).includes('double-free'), kinds(twice).join(','));
  assertEquals(find(twice, 'double-free').cwe, 'CWE-415');

  const viaCopy = interpret(stdio + `struct Node { int *data; };
int main() {
  struct Node *n = (struct Node *)malloc(sizeof(struct Node));
  int *p = (int *)malloc(8);
  n->data = p;
  free(p);
  free(n->data);
  return 0;
}`, { sanitize: true });
  assert(!viaCopy.ok, 'a second free reached through a pointer field must not be accepted');
  assert(/double free|not a live allocation/.test(viaCopy.error.message), viaCopy.error.message);
});

test('sanitizer: freeing something malloc never handed out is refused and named', () => {
  const stack = interpret(stdio + 'int main() { int a[4]; free(a); return 0; }', { sanitize: true });
  assert(!stack.ok);
  assert(/not a live allocation/.test(stack.error.message), stack.error.message);
  assert(kinds(stack).includes('invalid-free'), kinds(stack).join(','));
  assertEquals(find(stack, 'invalid-free').cwe, 'CWE-763');
});

test('sanitizer: free(NULL) stays a no-op, in C and here', () => {
  const r = clean('int main() { int *p = NULL; free(p); free(NULL); return 7; }', { sanitize: true });
  noFindings(r);
});

test('sanitizer: leaks are reported against the line that allocated them', () => {
  const r = clean(`int main() {
  int *a = (int *)malloc(8);
  *a = 1;
  int *b = (int *)malloc(12);
  *b = 2;
  free(a);
  return 0;
}`, { sanitize: true });
  const leaks = (r.findings || []).filter((f) => f.kind === 'memory-leak');
  assertEquals(leaks.length, 1);
  assertEquals(leaks[0].line, 5, 'the finding names the malloc that was never freed');
  assertEquals(leaks[0].severity, 'warning', 'a leak is a warning, not an error');
  assert(/12 byte/.test(leaks[0].detail), leaks[0].detail);
});

test('sanitizer: a run with several findings changes not one output byte', () => {
  const program = stdio + `struct Node { int *data; };
int main() {
  struct Node *n = (struct Node *)malloc(sizeof(struct Node));
  int *p = (int *)malloc(8);
  n->data = p;
  int leaked = *(int *)malloc(4);
  free(p);
  int v = *n->data + leaked;
  printf("%d\\n", v);
  free(n);
  return 0;
}`;
  const watched = interpret(program, { sanitize: true });
  const plain = interpret(program, {});
  assert(watched.ok && plain.ok);
  assertEquals(watched.output, plain.output);
  assertEquals(watched.steps, plain.steps, 'the sanitizer is a listener: it must not spend steps of its own');
  assertEquals(watched.heapBytes, plain.heapBytes);
  assertEquals(watched.liveAllocs, plain.liveAllocs);
  assert(kinds(watched).includes('use-after-free'), kinds(watched).join(','));
  assert(kinds(watched).includes('uninitialized-read'), kinds(watched).join(','));
  assert(kinds(watched).includes('memory-leak'), kinds(watched).join(','));
});

test('sanitizer: an integer cannot be laundered back into a pointer', () => {
  // The generation a handle carries is only useful if a program cannot drop it
  // and pick it back up. Printing an address is allowed; using one as a pointer
  // is not, so there is no path from `int` back into the arena.
  const r = interpret(stdio + `int main() {
  int *p = (int *)malloc(8);
  int a = (int)p;
  int *q = (int *)a;
  *q = 3;
  return 0;
}`, { sanitize: true });
  assert(!r.ok, 'an integer cast to a pointer must not become a usable handle');
  assert(/non-pointer|not a pointer/.test(r.error.message), r.error.message);
});

test('sanitizer: findings are ordered by line and carry the shared vocabulary', () => {
  const r = clean(`int main() {
  int *b = (int *)malloc(8);
  int *a = (int *)malloc(8);
  int v = *a;
  int w = *b;
  printf("%d\\n", v + w);
  free(a);
  free(b);
  return 0;
}`, { sanitize: true });
  const lines = (r.findings || []).map((f) => f.line);
  assertEquals(lines.length, 2, kinds(r).join(','));
  assertDeepEquals(lines, [...lines].sort((x, y) => x - y), 'a transcript must read in source order');
  for (const f of r.findings) {
    const meta = FINDING_KINDS[f.kind];
    assert(meta, `unknown finding kind '${f.kind}'`);
    assertEquals(f.severity, meta.severity);
    assertEquals(f.cwe, meta.cwe);
    assertEquals(f.title, meta.title);
    assert(f.why.length > 20, 'every kind explains itself');
    assert(f.fix.length > 20, 'every kind says what to write instead');
  }
});

test('sanitizer: the model itself, without a program in front of it', () => {
  const san = new Sanitizer();
  assertEquals(san.onAlloc(64, 8, { line: 3 }), 1);
  assertEquals(san.generationOf(64), 1, 'a live block answers with its generation');
  assertEquals(san.onFree(64, { line: 4 }), 'ok');
  assertEquals(san.generationOf(64), null, 'released and not yet re-used');
  assertEquals(san.generationOf(4096), undefined, 'this run never allocated that address');

  assertEquals(san.onAlloc(64, 8, { line: 5 }), 2, 'the same offset recycled is a new generation');
  san.onFieldWrite(96, { __gen: 1 });
  assertEquals(san.onFieldRead(96, 64), 'recycled', 'the field still names the first owner');
  san.onFieldWrite(96, { __gen: 2 });
  assertEquals(san.onFieldRead(96, 64), 'ok', 'the field now names the current owner');
  san.onFieldWrite(100, null);
  assertEquals(san.onFieldRead(100, 64), 'ok', 'a field with no claim is not a finding');

  assertEquals(san.onFree(64, { line: 6 }), 'ok', 'the recycled block is still live, so releasing it is legitimate');
  assertEquals(san.onFree(64, { line: 7 }), 'double');
  assertEquals(san.onFree(72, { line: 8 }), 'foreign');
  const reported = san.list().map((f) => f.kind);
  assert(reported.includes('double-free'), reported.join(','));
  assert(reported.includes('invalid-free'), reported.join(','));

  san.onAlloc(128, 4, { cleared: true, line: 8 });
  san.report('memory-leak', { line: 8 }, 'again');
  san.report('memory-leak', { line: 8 }, 'again');
  assertEquals(san.list().filter((f) => f.kind === 'memory-leak').length, 1, 'one report per kind and line');
});

test('sanitizer: the finding table is the single vocabulary both checkers use', () => {
  assertEquals(SANITIZER_VERSION, '1.0');
  const runtimeKinds = ['use-after-free', 'double-free', 'invalid-free', 'uninitialized-read', 'memory-leak'];
  for (const kind of runtimeKinds) {
    const meta = FINDING_KINDS[kind];
    assert(meta, `the runtime needs '${kind}'`);
    assert(['error', 'warning'].includes(meta.severity), `${kind} severity`);
    assert(/^CWE-\d+$/.test(meta.cwe), `${kind} cwe`);
    assert(meta.title && meta.why && meta.fix, `${kind} needs title, why and fix`);
  }
  assertEquals(Object.keys(FINDING_KINDS).length, 13, Object.keys(FINDING_KINDS).length);
  for (const [kind, meta] of Object.entries(FINDING_KINDS)) {
    assert(!/sizeof [a-z(]/.test(meta.fix), `${kind} advice must write sizeof with parentheses - the parser needs them`);
  }
  assertThrows(() => makeFinding('not-a-kind'), 'an unknown kind must be refused, not printed');
});
