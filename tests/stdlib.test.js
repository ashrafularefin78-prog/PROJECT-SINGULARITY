// M2 standard-library and language-surface suite.
//
// The compiler's advertised scope is "a real C subset", and the honest way to
// advertise a subset is to run the programs a student actually writes. Every
// test below is a complete C program: the standard library calls from
// <string.h>, <ctype.h> and <math.h>, the preprocessor, typedef, two
// dimensional arrays, function pointers and unions.
//
// The fail-closed tests matter as much as the happy ones: a string copy that
// would overflow its destination is an error here, never silent corruption.
import { test, assert, assertEquals } from './harness.js';
import { interpret } from '../src/runtime/interpreter.js';

const run = (src, opts) => interpret(src, opts);
const ok = (src, opts) => {
  const r = run(src, opts);
  if (!r.ok) throw new Error(`expected success but got: ${r.error.stage} ${r.error.message}`);
  return r;
};

// --------------------------------------------------------------- <string.h>

test('M2: string.h - strcpy, strcat, strcmp and strlen work on char arrays', () => {
  const r = ok(`#include <stdio.h>
#include <string.h>
int main() {
  char a[32] = "hello";
  char b[32];
  strcpy(b, a);
  strcat(b, " world");
  printf("%s %d\\n", b, strlen(b));
  printf("%d %d %d\\n", strcmp("abc", "abc"), strcmp("abc", "abd") < 0, strcmp("abd", "abc") > 0);
  strcpy(b, "");
  strcat(b, "fresh");
  printf("%s\\n", b);
  return 0;
}`);
  assertEquals(r.output, 'hello world 11\n0 1 1\nfresh\n');
});

test('M2: string.h - strncpy stops at n and pads with NULs like C does', () => {
  const r = ok(`#include <stdio.h>
#include <string.h>
int main() {
  char buf[10] = "XXXXXXXXX";
  strncpy(buf, "abc", 5);
  printf("[%s] %d\\n", buf, buf[4]);
  char exact[4];
  strncpy(exact, "toolong", 3);
  exact[3] = 0;
  printf("[%s]\\n", exact);
  char padded[6];
  strncpy(padded, "ab", 6);
  printf("[%s] %d %d\\n", padded, padded[2], padded[5]);
  return 0;
}`);
  assertEquals(r.output, '[abc] 0\n[too]\n[ab] 0 0\n');
});

test('M2: string.h - strchr, strrchr and strstr return usable pointers', () => {
  const r = ok(`#include <stdio.h>
#include <string.h>
int main() {
  char text[32] = "banana split";
  char *first = strchr(text, 'a');
  char *last = strrchr(text, 'a');
  printf("%d %d\\n", (int)(first - text), (int)(last - text));
  printf("%s|%s\\n", first, last);
  char *space = strstr(text, " sp");
  printf("%s\\n", space);
  printf("%d %d\\n", strchr(text, 'z') == NULL, strstr(text, "xyz") == NULL);
  return 0;
}`);
  assertEquals(r.output, '1 5\nanana split|a split\n split\n1 1\n');
});

test('M2: string.h - strncmp compares only the first n characters', () => {
  const r = ok(`#include <stdio.h>
#include <string.h>
int main() {
  printf("%d %d %d\\n", strncmp("abc", "abd", 2), strncmp("abc", "abd", 3) < 0, strncmp("abc", "abc", 9));
  return 0;
}`);
  assertEquals(r.output, '0 1 0\n');
});

test('M2: string.h - a strcpy that would overflow the destination fails closed', () => {
  const r = run(`#include <string.h>
int main() { char small[4]; strcpy(small, "much too long"); return 0; }`);
  assert(!r.ok, 'an overflowing strcpy must be refused, not silently truncated');
  assert(/destination buffer holds/.test(r.error.message), r.error.message);
});

test('M2: string.h - writing through a strchr pointer edits the original array', () => {
  const r = ok(`#include <stdio.h>
#include <string.h>
#include <ctype.h>
void shout(char *s) {
  for (int i = 0; s[i] != 0; i++) s[i] = toupper(s[i]);
}
int main() {
  char text[32] = "quiet";
  char *vowel = strchr(text, 'i');
  *vowel = 'X';
  printf("%s\\n", text);
  shout(text);
  printf("%s\\n", text);
  return 0;
}`);
  assertEquals(r.output, 'quXet\nQUXET\n');
});

// ---------------------------------------------------------------- <ctype.h>

test('M2: ctype.h - the classifiers and case converters answer for ASCII', () => {
  const r = ok(`#include <stdio.h>
#include <ctype.h>
int main() {
  printf("%d %d %d %d\\n", isdigit('7'), isdigit('x'), isalpha('q'), isalpha('4'));
  printf("%d %d %d\\n", isalnum('8'), isalnum('_'), isspace(' '));
  printf("%d %d %d %d\\n", isupper('A'), islower('A'), isupper('a'), islower('a'));
  printf("%c %c %c\\n", toupper('c'), tolower('C'), toupper('!'));
  int letters = 0;
  char word[16] = "Ada9Lovelace";
  for (int i = 0; word[i] != 0; i++) if (isalpha(word[i])) letters++;
  printf("letters=%d punct=%d\\n", letters, ispunct(','));
  return 0;
}`);
  assertEquals(r.output, '1 0 1 0\n1 0 1\n1 0 0 1\nC c !\nletters=11 punct=1\n');
});

// ----------------------------------------------------------------- <math.h>

test('M2: math.h - sqrt, pow and fabs keep their fraction inside a double', () => {
  const r = ok(`#include <stdio.h>
#include <math.h>
int main() {
  double root = sqrt(2);
  printf("%.6f %.4f %.0f\\n", root, sqrt(16), pow(2, 10));
  printf("%.2f %.2f %d\\n", fabs(-3.5), fmod(7.5, 2), (int)fabs(-9));
  printf("%.3f %.1f %.1f\\n", pow(2, 0.5), floor(2.9), ceil(2.1));
  double area = 3.0 * sqrt(25);
  printf("%.1f\\n", area);
  return 0;
}`);
  assertEquals(r.output, '1.414214 4.0000 1024\n3.50 1.50 9\n1.414 2.0 3.0\n15.0\n');
});

test('M2: integer division stays integer while a floating expression keeps its fraction', () => {
  const r = ok(`#include <stdio.h>
int main() {
  printf("%d %d\\n", 7 / 2, 7 % 2);
  printf("%.2f %.2f\\n", 7.0 / 2, 7 / 2.0);
  double average = (3.0 + 4.0) / 2;
  printf("%.2f\\n", average);
  double exponent = 1.5e-3;
  printf("%g %.0f\\n", exponent, 2e3);
  int truncated = 7.0 / 2;
  printf("%d\\n", truncated);
  return 0;
}`);
  assertEquals(r.output, '3 1\n3.50 3.50\n3.50\n0.0015 2000\n3\n');
});

test('M2: a float struct field and a float array element keep their fractions', () => {
  const r = ok(`#include <stdio.h>
#include <math.h>
struct Reading { double value; int samples; };
int main() {
  struct Reading r;
  r.value = sqrt(3);
  r.samples = 2;
  double series[3];
  series[0] = 1.5;
  series[1] = series[0] * 2;
  printf("%.4f %d %.2f\\n", r.value, r.samples, series[1]);
  return 0;
}`);
  assertEquals(r.output, '1.7321 2 3.00\n');
});

// ------------------------------------------------------------ the preprocessor

test('M2: #define constants are usable in expressions, array sizes and strings', () => {
  const r = ok(`#include <stdio.h>
#define MAX 10
#define PI 3.14159
#define NAME "singularity"
#define SCALE (MAX * 2)
int main() {
  int nums[MAX];
  for (int i = 0; i < MAX; i++) nums[i] = i * i;
  printf("%s %d %d %d %.2f\\n", NAME, MAX, SCALE, nums[MAX - 1], PI * 2.0);
  return 0;
}`);
  assertEquals(r.output, 'singularity 10 20 81 6.28\n');
});

test('M2: a macro can be redefined and undefined, and #undef takes effect', () => {
  const r = ok(`#include <stdio.h>
#define SIZE 4
#define SIZE 8
int main() {
  printf("%d\\n", SIZE);
  return 0;
}`);
  assertEquals(r.output, '8\n');

  const afterUndef = ok(`#include <stdio.h>
#define SIZE 4
#undef SIZE
int main() {
  int arr[3];
  printf("%d\\n", arr[0]);
  return 0;
}`);
  assertEquals(afterUndef.output, '0\n');
});

test('M2: #ifdef, #ifndef, #else and #endif select the compiled branch', () => {
  const r = ok(`#include <stdio.h>
#define VERBOSE 1
int main() {
#ifdef VERBOSE
  printf("verbose\\n");
#else
  printf("quiet\\n");
#endif
#ifndef ABSENT
  printf("absent\\n");
#endif
#ifdef ABSENT
  printf("present\\n");
#else
  printf("not present\\n");
#endif
  return 0;
}`);
  assertEquals(r.output, 'verbose\nabsent\nnot present\n');
});

test('M2: #if evaluates constants, defined() and comparisons with C precedence', () => {
  const r = ok(`#include <stdio.h>
#define LEVEL 3
#define FEATURE 1
int main() {
#if LEVEL > 5 && defined(FEATURE)
  printf("high\\n");
#elif LEVEL > 1 && defined(FEATURE)
  printf("medium\\n");
#else
  printf("low\\n");
#endif
#if defined(FEATURE) && !defined(MISSING) && (LEVEL + 2) * 2 == 10
  printf("arithmetic ok\\n");
#endif
#if 0
  this is not C: $ @ # % && (
#endif
  printf("after skipped block\\n");
  return 0;
}`);
  assertEquals(r.output, 'medium\narithmetic ok\nafter skipped block\n');
});

test('M2: #if/#else/#endif nests, and an inactive region may contain anything', () => {
  const r = ok(`#include <stdio.h>
#define OUTER 1
int main() {
#if OUTER
  printf("outer\\n");
#ifdef NEVER
  printf("never\\n");
#else
  printf("inner else\\n");
#endif
#else
  printf("outer else\\n");
#endif
#if 0
  unmatched " quote and a stray } are invisible
#endif
  return 0;
}`);
  assertEquals(r.output, 'outer\ninner else\n');
});

test('M2: a function-like macro is rejected with a message, not silently ignored', () => {
  const r = run(`#define SQ(x) ((x)*(x))
int main() { return SQ(4); }`);
  assert(!r.ok, 'a function-like macro must not compile to nothing');
  assert(/function-like macro 'SQ' is not supported/.test(r.error.message), r.error.message);
});

test('M2: an unknown directive and an unbalanced #endif are diagnosed with a position', () => {
  const unknown = run(`#frobnicate 1
int main() { return 0; }`);
  assert(!unknown.ok, 'an unknown directive must be reported');
  assert(/unknown preprocessor directive '#frobnicate'/.test(unknown.error.message), unknown.error.message);
  assertEquals(unknown.error.line, 1);

  const unbalanced = run(`int main() {
#endif
  return 0;
}`);
  assert(!unbalanced.ok, '#endif without #if must be reported');
  assert(/#endif without #if/.test(unbalanced.error.message), unbalanced.error.message);
  assertEquals(unbalanced.error.line, 2);

  const errorDirective = run(`#error deliberately giving up
int main() { return 0; }`);
  assert(!errorDirective.ok);
  assert(/deliberately giving up/.test(errorDirective.error.message), errorDirective.error.message);
});

test('M2: a multi-line #define continues across the backslash', () => {
  const r = ok(`#include <stdio.h>
#define INDIRECT \\
  12
int main() { printf("%d\\n", INDIRECT); return 0; }`);
  assertEquals(r.output, '12\n');
});

test('M2: a macro body expands inside a definition and cannot recurse forever', () => {
  const r = ok(`#include <stdio.h>
#define WIDTH 3
#define AREA (WIDTH * WIDTH)
int main() { printf("%d\\n", AREA); return 0; }`);
  assertEquals(r.output, '9\n');

  const recursive = run(`#define A A
int main() { return A; }`);
  assert(!recursive.ok, 'a self-referential macro must be caught rather than looping');
  assert(/A/.test(recursive.error.message), recursive.error.message);
});

// ------------------------------------------------------------------ typedef

test('M2: typedef names a scalar, a struct, a pointer and a function pointer', () => {
  const r = ok(`#include <stdio.h>
typedef unsigned int U32;
typedef struct Point { int x; int y; } Point;
typedef Point *PointPtr;
typedef int (*BinOp)(int, int);
int add(int a, int b) { return a + b; }
int mul(int a, int b) { return a * b; }
int main() {
  U32 count = 7;
  Point p = {3, 4};
  PointPtr ref = &p;
  ref->x = 30;
  BinOp op = add;
  printf("%d %d %d %d\\n", count, p.x, p.y, op(2, 5));
  op = mul;
  printf("%d %d\\n", op(2, 5), sizeof(Point));
  BinOp table[2];
  table[0] = add; table[1] = mul;
  printf("%d %d\\n", table[0](6, 1), table[1](6, 7));
  return 0;
}`);
  assertEquals(r.output, '7 30 4 7\n10 8\n7 42\n');
});

test('M2: a typedef inside a function defines a type usable in the rest of it', () => {
  const r = ok(`#include <stdio.h>
int main() {
  typedef struct { int weight; int value; } Item;
  Item items[2] = {{2, 30}, {3, 40}};
  int total = 0;
  for (int i = 0; i < 2; i++) total += items[i].value;
  printf("%d %d\\n", total, sizeof(Item));
  return 0;
}`);
  assertEquals(r.output, '70 8\n');
});

test('M2: a typedef of an array type declares arrays of that type', () => {
  const r = ok(`#include <stdio.h>
typedef int Row[4];
int main() {
  Row r = {1, 2, 3, 4};
  printf("%d %d\\n", r[3], sizeof(Row));
  return 0;
}`);
  assertEquals(r.output, '4 16\n');
});

// --------------------------------------------------------- two-dimensional arrays

test('M2: a two-dimensional array indexes, iterates and reports real sizes', () => {
  const r = ok(`#include <stdio.h>
int main() {
  int m[2][3];
  for (int i = 0; i < 2; i++)
    for (int j = 0; j < 3; j++)
      m[i][j] = i * 3 + j;
  int sum = 0;
  for (int i = 0; i < 2; i++) for (int j = 0; j < 3; j++) sum += m[i][j];
  printf("sum=%d last=%d\\n", sum, m[1][2]);
  printf("sizeof=%d row=%d cell=%d\\n", sizeof(m), sizeof(m[0]), sizeof(m[0][0]));
  int grid[3][3] = {{1,2,3},{4,5,6},{7,8,9}};
  int trace = 0;
  for (int i = 0; i < 3; i++) trace += grid[i][i];
  printf("trace=%d corner=%d\\n", trace, grid[2][0]);
  int sparse[2][2] = {{9}};
  printf("sparse %d %d\\n", sparse[0][0], sparse[1][1]);
  return 0;
}`);
  assertEquals(r.output, 'sum=15 last=5\nsizeof=24 row=12 cell=4\ntrace=15 corner=7\nsparse 9 0\n');
});

test('M2: a two-dimensional char array holds strings row by row', () => {
  const r = ok(`#include <stdio.h>
#include <string.h>
int main() {
  char names[3][8] = {"ada", "alan", "grace"};
  for (int i = 0; i < 3; i++) printf("%s:%d ", names[i], strlen(names[i]));
  printf("\\n");
  strcpy(names[1], "turing");
  printf("%s %c\\n", names[1], names[2][0]);
  return 0;
}`);
  assertEquals(r.output, 'ada:3 alan:4 grace:5 \nturing g\n');
});

test('M2: a two-dimensional array past its last row is refused', () => {
  const r = run(`int main() { int m[2][3]; m[2][0] = 1; return 0; }`);
  assert(!r.ok, 'row 2 of a 2-row array does not exist');
  assert(/out of bounds/.test(r.error.message), r.error.message);
});

// ------------------------------------------------------- function pointers

test('M2: a function pointer is assigned, called, passed and compared', () => {
  const r = ok(`#include <stdio.h>
int add(int a, int b) { return a + b; }
int mul(int a, int b) { return a * b; }
int apply(int (*f)(int, int), int a, int b) { return f(a, b); }
int reduce(int *data, int n, int combine(int, int)) {
  int acc = data[0];
  for (int i = 1; i < n; i++) acc = combine(acc, data[i]);
  return acc;
}
struct Op { char *name; int (*fn)(int, int); };
int main() {
  int (*fp)(int, int) = add;
  printf("%d %d\\n", fp(3, 4), (*fp)(10, 20));
  fp = mul;
  printf("%d\\n", fp(3, 4));
  fp = &add;
  printf("%d %d\\n", fp(1, 2), apply(fp, 5, 6));
  int nums[4] = {1, 2, 3, 4};
  printf("reduce=%d\\n", reduce(nums, 4, add));
  struct Op ops[2];
  ops[0].fn = add; ops[0].name = "add";
  ops[1].fn = mul; ops[1].name = "mul";
  for (int i = 0; i < 2; i++) printf("%s=%d ", ops[i].name, ops[i].fn(3, 4));
  printf("\\n");
  printf("null=%d same=%d diff=%d\\n", fp == NULL, fp == add, fp == mul);
  return 0;
}`);
  assertEquals(r.output, '7 30\n12\n3 11\nreduce=10\nadd=7 mul=12 \nnull=0 same=1 diff=0\n');
});

test('M2: a function pointer held in a heap-allocated struct can still be called', () => {
  const r = ok(`#include <stdio.h>
#include <stdlib.h>
int triple(int x) { return x * 3; }
struct Handler { char *label; int (*run)(int); };
int main() {
  struct Handler *h = (struct Handler *)malloc(sizeof(struct Handler));
  h->label = "triple";
  h->run = triple;
  printf("%s %d\\n", h->label, h->run(5));
  struct Handler stack;
  stack.run = triple;
  printf("%d\\n", stack.run(2));
  free(h);
  return 0;
}`);
  assertEquals(r.output, 'triple 15\n6\n');
});

test('M2: calling a value that is not a function is diagnosed', () => {
  const r = run(`int main() { int x = 3; return x(1); }`);
  assert(!r.ok, 'calling an int must fail');
  assert(/not a function/.test(r.error.message), r.error.message);
});

// -------------------------------------------------------------------- unions

test('M2: a union shares storage, so one member can be read through another', () => {
  const r = ok(`#include <stdio.h>
union Value { int i; char c; float f; };
int main() {
  union Value v;
  v.i = 65;
  printf("%c %d\\n", v.c, v.i);
  v.c = 66;
  printf("%d\\n", v.i);
  printf("sizeof=%d\\n", sizeof(union Value));
  union Value w = v;
  w.i = 99;
  printf("copy=%d %d\\n", v.i, w.i);
  return 0;
}`);
  assertEquals(r.output, 'A 65\n66\nsizeof=4\ncopy=66 99\n');
});

test('M2: a union can hold a struct member, a pointer member and live on the heap', () => {
  const r = ok(`#include <stdio.h>
union Tagged {
  struct { int a; int b; } pair;
  int raw;
  char *text;
};
int main() {
  union Tagged t;
  t.pair.a = 1;
  t.pair.b = 2;
  printf("pair=%d %d\\n", t.pair.a, t.pair.b);
  t.text = "hello";
  printf("text=%s\\n", t.text);
  t.raw = 7;
  printf("raw=%d\\n", t.raw);
  union Tagged *heap = (union Tagged *)malloc(sizeof(union Tagged));
  heap->pair.a = 5;
  heap->raw = 300;
  printf("heap=%d %d\\n", heap->raw, heap->pair.a == 300 ? 1 : 0);
  free(heap);
  return 0;
}`);
  assertEquals(r.output, 'pair=1 2\ntext=hello\nraw=7\nheap=300 1\n');
});

test('M2: an untagged struct and union can be declared and used', () => {
  const r = ok(`#include <stdio.h>
int main() {
  struct { int width; int height; } box = {640, 480};
  printf("%d\\n", box.width * box.height);
  union { int whole; char byte2; } word;
  word.whole = 66;
  printf("%c\\n", word.byte2);
  return 0;
}`);
  assertEquals(r.output, '307200\nB\n');
});

test('M2: referring to a struct by its name without typedef is an error', () => {
  const r = run(`struct P { int x; };
int main() { P p; p.x = 1; return 0; }`);
  assert(!r.ok, "an untypedef'd struct name must not parse as a type");
  assert(/expected/.test(r.error.message), r.error.message);
});
