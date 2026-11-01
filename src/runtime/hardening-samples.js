/**
 * Bug pairs for the M2 hardening surface.
 *
 * Each entry is one defect class shown twice: a program that commits it and the
 * same program written the way the check wants it. Both halves are ordinary C
 * that runs in the existing sandbox - not pseudocode next to a screenshot -
 * because a sample the learner cannot run teaches the name of a bug rather than
 * the shape of one.
 *
 * Every pair also declares what each layer says about it: the static audit
 * (src/runtime/hardening.js), the run itself, and the runtime sanitizer
 * (src/runtime/sanitizer.js). Those declarations are asserted by
 * tests/hardening-samples.test.js against the real checkers, so a check that
 * stops firing fails a test instead of leaving a confident-looking sentence in
 * the panel. Where a layer says nothing, that is recorded too: the pairs are
 * chosen so the gaps are visible, because the interesting question about a
 * checker is which of them is doing the work.
 */
import { AUDIT_VERSION } from './hardening.js';
import { SANITIZER_VERSION } from './sanitizer.js';

export const SAMPLES_VERSION = '1.0';

/**
 * @typedef {{
 *   id: string, title: string, cwe: string, kind: string,
 *   lesson: string, shows: string, stdin: string,
 *   vulnerable: string, fixed: string,
 *   says: { bug: string[], fix: string[], run: 'ok'|'refused',
 *           bugOutput: string|null, fixOutput: string, sanitized: string[] }
 * }} HardeningSample
 */

export const HARDENING_SAMPLES = /** @type {ReadonlyArray<HardeningSample>} */ (Object.freeze([
  {
    id: 'unbounded-scan',
    title: 'scanf("%s") with no field width',
    cwe: 'CWE-120',
    kind: 'unbounded-scan',
    lesson: 'A %s conversion writes until it runs out of input, and the input is not yours. The fix is a width one smaller than the buffer, because the last byte belongs to the terminator.',
    shows: 'the audit measures the width against the buffer. This input is short, so the run looks fine - the shape of the source is the evidence, not the output.',
    stdin: 'root\n',
    vulnerable: `#include <stdio.h>

int main(void) {
  char name[16];
  scanf("%s", name);
  printf("hello %s\\n", name);
  return 0;
}`,
    fixed: `#include <stdio.h>

int main(void) {
  char name[16];
  scanf("%15s", name);
  printf("hello %s\\n", name);
  return 0;
}`,
    says: { bug: ['unbounded-scan'], fix: [], run: 'ok', bugOutput: 'hello root\n', fixOutput: 'hello root\n', sanitized: [] },
  },
  {
    id: 'strcpy-overflow',
    title: 'strcpy from a wider buffer',
    cwe: 'CWE-119',
    kind: 'unbounded-copy',
    lesson: 'The destination is 8 bytes and the source can be 64. strncpy of sizeof(dst) - 1, then an explicit terminator, keeps the copy inside the block that owns it.',
    shows: 'the write is refused by the arena before it can land on a neighbouring allocation, so the run stops with a named error instead of corrupting the heap.',
    stdin: '0123456789\n',
    vulnerable: `#include <stdio.h>
#include <string.h>

int main(void) {
  char tag[8];
  char line[64];
  fgets(line, 64, stdin);
  strcpy(tag, line);
  printf("tag %s\\n", tag);
  return 0;
}`,
    fixed: `#include <stdio.h>
#include <string.h>

int main(void) {
  char tag[8];
  char line[64];
  fgets(line, 64, stdin);
  strncpy(tag, line, sizeof(tag) - 1);
  tag[sizeof(tag) - 1] = 0;
  printf("tag %s\\n", tag);
  return 0;
}`,
    says: { bug: ['unbounded-copy'], fix: [], run: 'refused', bugOutput: null, fixOutput: 'tag 0123456\n', sanitized: [] },
  },
  {
    id: 'format-string',
    title: 'printing input as the format',
    cwe: 'CWE-134',
    kind: 'format-string-from-input',
    lesson: 'printf(buf) hands the conversions to whatever buf holds. printf("%s", buf) keeps the data as data.',
    shows: 'both halves print the same thing for this input. The defect is what a different input would do, so only the source can be the evidence.',
    stdin: 'hello\n',
    vulnerable: `#include <stdio.h>

int main(void) {
  char label[64];
  fgets(label, 64, stdin);
  printf(label);
  return 0;
}`,
    fixed: `#include <stdio.h>

int main(void) {
  char label[64];
  fgets(label, 64, stdin);
  printf("%s", label);
  return 0;
}`,
    says: { bug: ['format-string-from-input'], fix: [], run: 'ok', bugOutput: 'hello\n', fixOutput: 'hello\n', sanitized: [] },
  },
  {
    id: 'use-after-free',
    title: 'reading a block after free()',
    cwe: 'CWE-416',
    kind: 'use-after-free',
    lesson: 'A released block may be handed to the next malloc. Do the reading before the release, and put the pointer away with the block it named.',
    shows: 'the run prints (null) and looks unharmed: a released handle reads as NULL, and puts() accepts NULL. Only the sanitizer says the block is gone.',
    stdin: '',
    vulnerable: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
  char *tag = (char *)malloc(8);
  if (tag == NULL) return 1;
  tag[0] = 'A';
  tag[1] = 0;
  free(tag);
  puts(tag);
  return 0;
}`,
    fixed: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
  char *tag = (char *)malloc(8);
  if (tag == NULL) return 1;
  tag[0] = 'A';
  tag[1] = 0;
  puts(tag);
  free(tag);
  tag = NULL;
  return 0;
}`,
    says: { bug: ['use-after-free'], fix: [], run: 'ok', bugOutput: '(null)\n', fixOutput: 'A\n', sanitized: ['use-after-free'] },
  },
  {
    id: 'double-free',
    title: 'freeing the same block twice',
    cwe: 'CWE-415',
    kind: 'double-free',
    lesson: 'The second free puts the same range in the free list twice, and one address then belongs to two owners. Null the pointer as you release it, so a later free is a no-op on NULL.',
    shows: 'both halves release the block once. The buggy half releases the same handle twice, which the free list refuses before it can alias.',
    stdin: '',
    vulnerable: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
  int *cell = (int *)malloc(sizeof(int));
  if (cell == NULL) return 1;
  *cell = 7;
  printf("%d\\n", *cell);
  free(cell);
  free(cell);
  return 0;
}`,
    fixed: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
  int *cell = (int *)malloc(sizeof(int));
  if (cell == NULL) return 1;
  *cell = 7;
  printf("%d\\n", *cell);
  free(cell);
  cell = NULL;
  free(cell);
  return 0;
}`,
    says: { bug: ['double-free'], fix: [], run: 'refused', bugOutput: null, fixOutput: '7\n', sanitized: ['double-free'] },
  },
  {
    id: 'uninitialized-read',
    title: 'printing a heap byte that was never written',
    cwe: 'CWE-457',
    kind: 'uninitialized-read',
    lesson: 'malloc() gives room, not values. calloc() - or an assignment for every element read - decides what the read returns.',
    shows: 'the pair where the static pass says nothing: the audit does not track which bytes were written, and only a run with the sanitizer over it reports this one.',
    stdin: '',
    vulnerable: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
  int *scores = (int *)malloc(4 * sizeof(int));
  if (scores == NULL) return 1;
  scores[0] = 10;
  printf("%d %d\\n", scores[0], scores[1]);
  free(scores);
  return 0;
}`,
    fixed: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
  int *scores = (int *)calloc(4, sizeof(int));
  if (scores == NULL) return 1;
  scores[0] = 10;
  printf("%d %d\\n", scores[0], scores[1]);
  free(scores);
  return 0;
}`,
    says: { bug: [], fix: [], run: 'ok', bugOutput: '10 0\n', fixOutput: '10 0\n', sanitized: ['uninitialized-read'] },
  },
]));

/** Every kind the pairs claim, for the panel legend and the coverage test. */
export const SAMPLE_KINDS = Object.freeze(HARDENING_SAMPLES.map((s) => s.kind));

/**
 * The layers the pairs exercise, named in the order a learner meets them. The
 * wording is what the panels say out loud, so it lives here once.
 */
export const LAYERS = Object.freeze([
  {
    name: 'static audit',
    module: 'src/runtime/hardening.js',
    version: AUDIT_VERSION,
    says: 'reads the program without running it and reports only what the source proves',
  },
  {
    name: 'arena bounds',
    module: 'src/runtime/interpreter.js',
    version: '1.0',
    says: 'refuses a read or write that leaves the block it names, so an overflow stops the run instead of corrupting a neighbour',
  },
  {
    name: 'runtime sanitizer',
    module: 'src/runtime/sanitizer.js',
    version: SANITIZER_VERSION,
    says: 'watches the bytes one execution touches - a released block, a recycled one, a heap byte never written - and reports them without changing what the program prints',
  },
]);
