// M2 language-surface suite.
//
// These tests are the executable form of what the compiler panel claims the
// runtime can do: ternary, switch, structs, casts, the malloc family and
// scanf. Anything advertised in src/app.js should appear here, and anything
// here should be reachable from a program a user can actually type.
import { test, assert, assertEquals } from './harness.js';
import { interpret } from '../src/runtime/interpreter.js';

const run = (src, opts) => interpret(src, opts);
const ok = (src, opts) => {
  const r = run(src, opts);
  if (!r.ok) throw new Error(`expected success but got: ${r.error.stage} ${r.error.message}`);
  return r;
};

test('M2: ternary conditional, including nested and right-associative forms', () => {
  const r = ok(`#include <stdio.h>
int max3(int a, int b, int c) { return a > b ? (a > c ? a : c) : (b > c ? b : c); }
int sign(int n) { return n < 0 ? -1 : n == 0 ? 0 : 1; }
int main() {
  printf("%d %d %d %d %d\\n", max3(3, 9, 5), sign(-4), sign(0), sign(8), 5 > 3 ? 100 : 200);
  return 0;
}`);
  assertEquals(r.output, '9 -1 0 1 100\n');
});

test('M2: switch falls through, honours break and default, and nests in loops', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int score = 87;
  switch (score / 10) {
    case 10:
    case 9: printf("A\\n"); break;
    case 8: printf("B\\n"); break;
    default: printf("F\\n"); break;
  }
  for (int i = 0; i < 4; i++) {
    switch (i) {
      case 0: printf("zero "); break;
      case 1: printf("one "); break;
      default: printf("many "); break;
    }
  }
  printf("\\n");
  switch (1) { case 1: printf("fall"); case 2: printf("through\\n"); }
  return 0;
}`);
  assertEquals(r.output, 'B\nzero one many many \nfallthrough\n');
});

test('M2: a break inside a loop inside a case leaves the loop, not the switch', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int n = 1;
  int seen = 0;
  switch (n) {
    case 1:
      for (int i = 0; i < 10; i++) {
        if (i == 3) break;
        seen++;
      }
      printf("loop broke at %d\\n", seen);
      break;
    default: printf("no\\n"); break;
  }
  printf("switch finished\\n");
  return 0;
}`);
  assertEquals(r.output, 'loop broke at 3\nswitch finished\n');
});

test('M2: do/while runs its body at least once', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int n = 5;
  do { n++; } while (n < 3);
  printf("%d\\n", n);
  int m = 0;
  do { m++; } while (m < 4);
  printf("%d\\n", m);
  return 0;
}`);
  assertEquals(r.output, '6\n4\n');
});

test('M2: struct definition, initialisation and member assignment', () => {
  const r = ok(`#include <stdio.h>
struct Point { int x; int y; };
struct Point add(struct Point a, struct Point b) {
  struct Point r;
  r.x = a.x + b.x;
  r.y = a.y + b.y;
  return r;
}
int main() {
  struct Point p = {1, 2};
  struct Point q = {10, 20};
  struct Point s = add(p, q);
  p.x = 99;
  printf("%d %d %d %d\\n", s.x, s.y, p.x, p.y);
  return 0;
}`);
  assertEquals(r.output, '11 22 99 2\n');
});

test('M2: structs nest, live in arrays, and pass by value', () => {
  const r = ok(`#include <stdio.h>
struct Inner { int v; };
struct Outer { struct Inner in; int tag; };
struct P { int x; int y; };
void mutate(struct P p) { p.x = 500; }
struct P through(struct P *p) { p->x = 42; return *p; }
int main() {
  struct Outer o;
  o.in.v = 7;
  o.tag = 1;
  printf("%d %d %d\\n", o.in.v, o.tag, sizeof(struct Outer));
  struct P pts[3] = {{1,2},{3,4},{5,6}};
  int total = 0;
  for (int i = 0; i < 3; i++) total += pts[i].x + pts[i].y;
  printf("%d %d\\n", total, sizeof(struct P));
  struct P p = {1, 2};
  mutate(p);
  struct P q = through(&p);
  printf("%d %d %d\\n", p.x, q.x, q.y);
  return 0;
}`);
  assertEquals(r.output, '7 1 8\n21 8\n42 42 2\n');
});

test('M2: struct layout counts a char field as one byte', () => {
  const r = ok(`#include <stdio.h>
struct M { char c; int n; };
int main() {
  struct M m;
  m.c = 65;
  m.n = 1000;
  printf("%c %d %d\\n", m.c, m.n, sizeof(struct M));
  return 0;
}`);
  assertEquals(r.output, 'A 1000 5\n');
});

test('M2: a struct definition inside a function is visible to the rest of it', () => {
  const r = ok(`#include <stdio.h>
int main() {
  struct Local { int a; int b; };
  struct Local l = {5, 6};
  printf("%d\\n", l.a + l.b);
  return 0;
}`);
  assertEquals(r.output, '11\n');
});

test('M2: casts narrow, truncate and retype pointers', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int x = 300;
  char narrow = (char)x;
  double d = 3.99;
  printf("%d %d\\n", narrow, (int)d);
  int *p = (int *)malloc(sizeof(int));
  *p = 5;
  void *raw = p;
  int *back = (int *)raw;
  printf("%d %d\\n", *p, *back);
  free(p);
  return 0;
}`);
  assertEquals(r.output, '44 3\n5 5\n');
});

test('M2: malloc, calloc, realloc and free behave, and blocks are recycled', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int *a = (int *)malloc(10 * sizeof(int));
  for (int i = 0; i < 10; i++) a[i] = i * i;
  int total = 0;
  for (int i = 0; i < 10; i++) total += a[i];
  printf("%d %d\\n", total, *(a + 3));
  int *b = (int *)calloc(4, sizeof(int));
  printf("calloc %d %d\\n", b[0], b[3]);
  b[0] = 7;
  b = (int *)realloc(b, 20 * sizeof(int));
  printf("realloc %d %d\\n", b[0], b[9]);
  int bad = 0;
  for (int i = 0; i < 200; i++) {
    int *p = (int *)malloc(100);
    p[0] = i;
    if (p[0] != i) bad++;
    free(p);
  }
  printf("recycled bad=%d\\n", bad);
  free(a);
  free(b);
  return 0;
}`);
  assertEquals(r.output, '285 9\ncalloc 0 0\nrealloc 7 0\nrecycled bad=0\n');
});

test('M2: memset and memcpy operate on heap memory', () => {
  const r = ok(`#include <stdio.h>
int main() {
  char *buf = (char *)calloc(16, 1);
  memset(buf, 65, 4);
  for (int i = 0; i < 4; i++) putchar(buf[i]);
  printf("\\n");
  int *src = (int *)malloc(2 * sizeof(int));
  src[0] = 7; src[1] = 8;
  int *dst = (int *)malloc(2 * sizeof(int));
  memcpy(dst, src, 2 * sizeof(int));
  printf("%d %d\\n", dst[0], dst[1]);
  free(src); free(dst); free(buf);
  return 0;
}`);
  assertEquals(r.output, 'AAAA\n7 8\n');
});

test('M2: a linked list built with malloc and -> pointers works end to end', () => {
  const r = ok(`#include <stdio.h>
struct Node { int value; struct Node *next; };
int main() {
  struct Node *head = NULL;
  for (int i = 1; i <= 5; i++) {
    struct Node *n = (struct Node *)malloc(sizeof(struct Node));
    n->value = i * i;
    n->next = head;
    head = n;
  }
  int sum = 0;
  struct Node *cur = head;
  while (cur != NULL) { sum += cur->value; cur = cur->next; }
  printf("sum=%d head=%d\\n", sum, head->value);
  return 0;
}`);
  assertEquals(r.output, 'sum=55 head=25\n');
});

test('M2: pointer arithmetic walks an allocation', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int *a = (int *)malloc(5 * sizeof(int));
  for (int i = 0; i < 5; i++) *(a + i) = i * 10;
  int *b = a + 1;
  printf("%d %d %d %d %d\\n", *a, *(a + 2), a[4], *b, b - a);
  free(a);
  return 0;
}`);
  assertEquals(r.output, '0 20 40 10 1\n');
});

test('M2: scanf reads typed values and sscanf parses a string', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int a, b;
  int n = scanf("%d %d", &a, &b);
  char word[16];
  scanf("%s", word);
  printf("n=%d a=%d b=%d w=%s len=%d\\n", n, a, b, word, strlen(word));
  int x = 0; int y = 0;
  int m = sscanf("42 7", "%d %d", &x, &y);
  printf("m=%d x=%d y=%d\\n", m, x, y);
  return 0;
}`, { stdin: '12 34 hello' });
  assertEquals(r.output, 'n=2 a=12 b=34 w=hello len=5\nm=2 x=42 y=7\n');
});

test('M2: scanf writes into a heap buffer and into a char array', () => {
  const r = ok(`#include <stdio.h>
int main() {
  char *buf = (char *)malloc(16);
  scanf("%s", buf);
  printf("heap %s\\n", buf);
  char local[16] = "overwritten";
  scanf("%s", local);
  printf("local %s\\n", local);
  free(buf);
  return 0;
}`, { stdin: 'sandbox localword' });
  assertEquals(r.output, 'heap sandbox\nlocal localword\n');
});

test('M2: scanf shares the stdin cursor with getchar', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int n = 0;
  scanf("%d", &n);
  int c;
  while ((c = getchar()) != -1) putchar(c);
  printf("\\nnum=%d\\n", n);
  return 0;
}`, { stdin: '7 rest' });
  assertEquals(r.output, ' rest\nnum=7\n');
});

test('M2: a %s conversion refuses to overflow its destination', () => {
  const r = run(`#include <stdio.h>
int main() { char small[4]; scanf("%s", small); return 0; }`, { stdin: 'much-too-long' });
  assert(!r.ok, 'an overlong %s must fail rather than smash the buffer');
  assert(/destination buffer holds/.test(r.error.message), r.error.message);
});

test('M2: char arrays initialise from strings and sizeof reports real bytes', () => {
  const r = ok(`#include <stdio.h>
int main() {
  char name[8] = "abc";
  int nums[6] = {1};
  printf("%d %d %c %d %d\\n", sizeof(name), sizeof(nums), name[1], name[3], nums[5]);
  size_t n = strlen(name);
  printf("%d\\n", n);
  return 0;
}`);
  assertEquals(r.output, '8 24 b 0 0\n3\n');
});

test('M2: an ordinary string utility written in C works on char arrays', () => {
  const r = ok(`#include <stdio.h>
void copy(char *dst, char *src) { int i = 0; while ((dst[i] = src[i]) != 0) i++; }
int count_vowels(char *s) {
  int n = 0;
  for (int i = 0; s[i] != 0; i++) {
    char c = s[i];
    if (c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u') n++;
  }
  return n;
}
int main() {
  char a[16] = "hello world";
  char b[16];
  copy(b, a);
  printf("%s %d %d\\n", b, count_vowels(b), strlen(b));
  return 0;
}`);
  assertEquals(r.output, 'hello world 3 11\n');
});

test('M2: the heap is fail-closed (null, use-after-free, overrun, exhaustion)', () => {
  const nullDeref = run('int main() { int *p = NULL; return *p; }');
  assert(!nullDeref.ok);
  assert(/null pointer dereference/.test(nullDeref.error.message), nullDeref.error.message);

  const zeroPointer = run('int main() { int *p = 0; return *p; }');
  assert(!zeroPointer.ok);
  assert(/null pointer dereference/.test(zeroPointer.error.message), zeroPointer.error.message);

  const usedAfterFree = run('int main() { int *p = (int *)malloc(16); free(p); return p[0]; }');
  assert(!usedAfterFree.ok);
  assert(/null pointer dereference/.test(usedAfterFree.error.message), usedAfterFree.error.message);

  const overrun = run('int main() { int *p = (int *)malloc(8); return p[5]; }');
  assert(!overrun.ok);
  assert(/past the end of the allocation/.test(overrun.error.message), overrun.error.message);

  const exhausted = run('int main() { int *a = (int *)malloc(1048576); int *b = (int *)malloc(1048576); return 0; }', {
    maxHeapBytes: 1048576,
  });
  assert(!exhausted.ok);
  assert(/heap exhausted/.test(exhausted.error.message), exhausted.error.message);
});

test('M2: unknown struct types, members and wrong arrows are diagnosed', () => {
  const unknown = run('int main() { struct Nope n; return 0; }');
  assert(!unknown.ok);
  assert(/unknown struct type 'Nope'/.test(unknown.error.message), unknown.error.message);

  const noMember = run('struct P { int x; };\nint main() { struct P p; p.y = 1; return 0; }');
  assert(!noMember.ok);
  assert(/has no member 'y'/.test(noMember.error.message), noMember.error.message);

  const wrongArrow = run('struct P { int x; };\nint main() { struct P p; return p->x; }');
  assert(!wrongArrow.ok, "'->' on a plain struct value must be rejected");
  assert(/'->' needs a pointer/.test(wrongArrow.error.message), wrongArrow.error.message);

  const wrongDot = run('struct P { int x; };\nint main() { struct P p; struct P *q = &p; return q.x; }');
  assert(!wrongDot.ok, "'.' on a pointer must be rejected");
  assert(/use '->'/.test(wrongDot.error.message), wrongDot.error.message);

  const wrongDotPtr = run('struct P { int x; };\nint main() { struct P *q = (struct P *)malloc(sizeof(struct P)); return q.x; }');
  assert(!wrongDotPtr.ok, "'.' on a heap pointer must be rejected too");
  assert(/use '->'/.test(wrongDotPtr.error.message), wrongDotPtr.error.message);
});
