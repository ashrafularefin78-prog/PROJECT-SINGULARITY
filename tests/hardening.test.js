// Static hardening audit suite.
//
// Every check is written twice: a program that commits the bug and the same
// program with the bug fixed. The first half proves the audit says something;
// the second half proves it stays quiet when the source already does the right
// thing, which is the half an audit usually gets wrong. The last test runs the
// audit over the whole shipped catalogue, because a checker that accuses the
// programs this project generates itself is a checker nobody will keep enabled.
import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { audit, AUDIT_VERSION, NOT_CHECKED } from '../src/runtime/hardening.js';
import { FINDING_KINDS } from '../src/runtime/sanitizer.js';
import { RECIPES, generate } from '../src/assistant/singu.js';

const lines = (src) => src.split('\n');
const at = (src, needle) => lines(src).findIndex((l) => l.includes(needle)) + 1;

const bugs = {
  gets: `#include <stdio.h>
int main() {
  char buf[16];
  gets(buf);
  printf("%s\\n", buf);
  return 0;
}`,
  getsFixed: `#include <stdio.h>
int main() {
  char buf[16];
  fgets(buf, sizeof(buf), stdin);
  printf("%s", buf);
  return 0;
}`,
  strcpyUnknown: `#include <stdio.h>
int main() {
  char dst[16];
  char src[64];
  fgets(src, 64, stdin);
  strcpy(dst, src);
  printf("%s\\n", dst);
  return 0;
}`,
  strcpyFixed: `#include <stdio.h>
int main() {
  char dst[16];
  char src[64];
  fgets(src, 64, stdin);
  snprintf(dst, sizeof(dst), "%s", src);
  printf("%s\\n", dst);
  return 0;
}`,
  strcpyLiteralFits: `#include <stdio.h>
int main() {
  char dst[16];
  strcpy(dst, "abc");
  printf("%s\\n", dst);
  return 0;
}`,
  strcpyArrayFits: `#include <stdio.h>
int main() {
  char dst[64];
  char src[16];
  fgets(src, 16, stdin);
  strcpy(dst, src);
  printf("%s\\n", dst);
  return 0;
}`,
  strcpyPointerFits: `#include <stdio.h>
int main() {
  char *tag = (char *)malloc(32);
  if (tag == NULL) return 1;
  strcpy(tag, "SINGU AI");
  printf("%s\\n", tag);
  free(tag);
  return 0;
}`,
  strcpyIntoSmallBlock: `#include <stdio.h>
int main() {
  char *tag = (char *)malloc(16);
  char src[64];
  if (tag == NULL) return 1;
  fgets(src, 64, stdin);
  strcpy(tag, src);
  printf("%s\\n", tag);
  free(tag);
  return 0;
}`,
  strcpyIntoUnsizedBlock: `#include <stdio.h>
int main() {
  int n = 8;
  char *tag = (char *)malloc(n);
  char src[64];
  if (tag == NULL) return 1;
  fgets(src, 64, stdin);
  strcpy(tag, src);
  printf("%s\\n", tag);
  free(tag);
  return 0;
}`,
  strcatUnbounded: `#include <stdio.h>
int main() {
  char dst[16];
  char src[8];
  strcpy(dst, "hi");
  strcat(dst, src);
  printf("%s\\n", dst);
  return 0;
}`,
  strcatLiteral: `#include <stdio.h>
int main() {
  char dst[64];
  strcpy(dst, "hi");
  strcat(dst, " there");
  printf("%s\\n", dst);
  return 0;
}`,
  sprintfUnbounded: `#include <stdio.h>
int main() {
  char dst[16];
  char src[64];
  fgets(src, 64, stdin);
  sprintf(dst, "%s!", src);
  printf("%s\\n", dst);
  return 0;
}`,
  sprintfBoundedNumber: `#include <stdio.h>
int main() {
  char dst[16];
  int n = 5;
  sprintf(dst, "n=%d", n);
  printf("%s\\n", dst);
  return 0;
}`,
  sprintfNumberTooSmall: `#include <stdio.h>
int main() {
  char dst[4];
  int n = 5;
  sprintf(dst, "n=%d", n);
  printf("%s\\n", dst);
  return 0;
}`,
  snprintfWrongSize: `#include <stdio.h>
int main() {
  char dst[16];
  snprintf(dst, 64, "%d", 5);
  printf("%s\\n", dst);
  return 0;
}`,
  snprintfGood: `#include <stdio.h>
int main() {
  char dst[16];
  int n = 5;
  snprintf(dst, sizeof(dst), "n=%d", n);
  printf("%s\\n", dst);
  return 0;
}`,
  strncpyNoNul: `#include <stdio.h>
int main() {
  char dst[16];
  char src[16];
  fgets(src, 16, stdin);
  strncpy(dst, src, 16);
  printf("%s\\n", dst);
  return 0;
}`,
  strncpyOverruns: `#include <stdio.h>
int main() {
  char dst[16];
  char src[64];
  fgets(src, 64, stdin);
  strncpy(dst, src, 32);
  printf("%s\\n", dst);
  return 0;
}`,
  memcpyOverruns: `#include <stdio.h>
int main() {
  char dst[16];
  char src[64];
  fgets(src, 64, stdin);
  memcpy(dst, src, 64);
  printf("%s\\n", dst);
  return 0;
}`,
  memcpySizeofSource: `#include <stdio.h>
int main() {
  char dst[16];
  char src[64];
  fgets(src, 64, stdin);
  memcpy(dst, src, sizeof(src));
  printf("%s\\n", dst);
  return 0;
}`,
  memcpyFits: `#include <stdio.h>
int main() {
  char dst[16];
  char src[16];
  fgets(src, 16, stdin);
  memcpy(dst, src, sizeof(dst));
  memset(dst, 0, sizeof(dst));
  printf("%s\\n", dst);
  return 0;
}`,
  memcpyUnknownCount: `#include <stdio.h>
int main() {
  char dst[16];
  char src[64];
  int n = 64;
  fgets(src, 64, stdin);
  memcpy(dst, src, n);
  printf("%s\\n", dst);
  return 0;
}`,
  strncpyReservesNul: `#include <stdio.h>
int main() {
  char dst[16];
  char src[16];
  fgets(src, 16, stdin);
  strncpy(dst, src, 15);
  dst[15] = 0;
  printf("%s\\n", dst);
  return 0;
}`,
  scanfNoWidth: `#include <stdio.h>
int main() {
  char buf[16];
  scanf("%s", buf);
  printf("%s\\n", buf);
  return 0;
}`,
  scanfWidthOverRuns: `#include <stdio.h>
int main() {
  char buf[16];
  scanf("%16s", buf);
  printf("%s\\n", buf);
  return 0;
}`,
  scanfWidthFits: `#include <stdio.h>
int main() {
  char buf[16];
  int n;
  scanf("%d %15s", &n, buf);
  printf("%d %s\\n", n, buf);
  return 0;
}`,
  formatFromInput: `#include <stdio.h>
int main() {
  char buf[32];
  fgets(buf, 32, stdin);
  printf(buf);
  return 0;
}`,
  formatIsLiteral: `#include <stdio.h>
int main() {
  char buf[32];
  fgets(buf, 32, stdin);
  printf("%s", buf);
  return 0;
}`,
  escapeArray: `#include <stdio.h>
char *pick(void) {
  char buf[8];
  buf[0] = 1;
  return buf;
}
int main() {
  printf("%d\\n", 0);
  return 0;
}`,
  escapeAddressOfLocal: `#include <stdio.h>
int *cell(void) {
  int v = 1;
  return &v;
}
int main() {
  printf("%d\\n", 0);
  return 0;
}`,
  escapeGlobalIsFine: `#include <stdio.h>
char shared[8];
char *pick(void) {
  return shared;
}
int main() {
  printf("%d\\n", pick()[0]);
  return 0;
}`,
  escapeParamIsFine: `#include <stdio.h>
char *echo(char *s) {
  return s;
}
int main() {
  char buf[8];
  printf("%d\\n", echo(buf)[0]);
  return 0;
}`,
  mallocUnchecked: `#include <stdio.h>
int main() {
  int *p = (int *)malloc(64);
  p[0] = 1;
  printf("%d\\n", p[0]);
  free(p);
  return 0;
}`,
  mallocChecked: `#include <stdio.h>
int main() {
  int *p = (int *)malloc(64);
  if (p == NULL) return 1;
  p[0] = 1;
  printf("%d\\n", p[0]);
  free(p);
  return 0;
}`,
  mallocGuardedUse: `#include <stdio.h>
int main() {
  int *p = (int *)malloc(64);
  if (p != NULL) {
    p[0] = 1;
    free(p);
  }
  printf("%d\\n", 0);
  return 0;
}`,
  doubleFree: `#include <stdio.h>
int main() {
  int *p = (int *)malloc(8);
  if (p == NULL) return 1;
  *p = 1;
  free(p);
  free(p);
  return 0;
}`,
  freeAfterUse: `#include <stdio.h>
int main() {
  char *p = (char *)malloc(8);
  if (p == NULL) return 1;
  p[0] = 65;
  free(p);
  puts(p);
  return 0;
}`,
  rebindingIsFine: `#include <stdio.h>
int main() {
  char *p = (char *)malloc(8);
  p = (char *)realloc(p, 16);
  if (p == NULL) return 1;
  p[0] = 1;
  free(p);
  return 0;
}`,
  conditionalFreeIsFine: `#include <stdio.h>
int main() {
  int *p = (int *)malloc(8);
  int flag = 1;
  if (flag) free(p);
  free(p);
  return 0;
}`,
};

const auditOf = (key) => {
  const report = audit(bugs[key]);
  assert(report.ok, `${key} must parse: ${report.error && report.error.message}`);
  return report;
};
const kindsFor = (key) => auditOf(key).findings.map((f) => f.kind);

test('hardening: gets() is named, and fgets() with a size is not', () => {
  const found = auditOf('gets').findings;
  assertEquals(found.length, 1);
  assertEquals(found[0].kind, 'dangerous-function');
  assertEquals(found[0].cwe, 'CWE-676');
  assertEquals(found[0].line, at(bugs.gets, 'gets(buf)'));
  assertDeepEquals(kindsFor('getsFixed'), []);
});

test('hardening: strcpy is judged on what the source proves about the length', () => {
  assertDeepEquals(kindsFor('strcpyUnknown'), ['unbounded-copy']);
  assertDeepEquals(kindsFor('strcatUnbounded'), ['unbounded-copy']);
  assertDeepEquals(kindsFor('strcatLiteral'), ['unbounded-copy'], 'strcat() adds to a length this source does not state');
  // these are provably roomy, or provably short into a destination this pass
  // cannot size - and an audit that flags them teaches the learner to ignore it
  assertDeepEquals(kindsFor('strcpyLiteralFits'), []);
  assertDeepEquals(kindsFor('strcpyArrayFits'), []);
  assertDeepEquals(kindsFor('strcpyPointerFits'), []);
  assertDeepEquals(kindsFor('strcpyFixed'), []);
  assertDeepEquals(kindsFor('strcpyIntoSmallBlock'), ['unbounded-copy'], 'malloc(16) states the room the block has, and a 64-byte source does not fit in it');
  assertDeepEquals(kindsFor('strcpyIntoUnsizedBlock'), [], 'malloc(n) states nothing about the room, so the audit cannot prove the copy overruns');
  const smallBlock = auditOf('strcpyIntoSmallBlock').findings[0];
  assert(/64 byte/.test(smallBlock.detail), smallBlock.detail);
  assert(/holds 16 byte/.test(smallBlock.detail), smallBlock.detail);
  const detail = auditOf('strcpyUnknown').findings[0].detail;
  assert(/dst\[16\]/.test(detail), detail);
  assert(/src \(a pointer\)|src\[64\]/.test(detail), detail);
});

test('hardening: sprintf is bounded by what its conversions can actually print', () => {
  assertDeepEquals(kindsFor('sprintfUnbounded'), ['unbounded-copy'], '%s has no bound');
  assertDeepEquals(kindsFor('sprintfNumberTooSmall'), ['unbounded-copy'], '"n=%d" prints 13 characters plus a NUL into a 4-byte buffer');
  assertDeepEquals(kindsFor('sprintfBoundedNumber'), [], 'the same call into 16 bytes is provably roomy');
  assertDeepEquals(kindsFor('snprintfWrongSize'), ['unbounded-copy'], 'a size bigger than the buffer is not a bound');
  assertDeepEquals(kindsFor('snprintfGood'), []);
  assert(/13 character/.test(auditOf('sprintfNumberTooSmall').findings[0].detail), auditOf('sprintfNumberTooSmall').findings[0].detail);
});

test('hardening: the bounded copies are checked for the trap they still carry', () => {
  assertDeepEquals(kindsFor('strncpyNoNul'), ['unterminated-string']);
  assertDeepEquals(kindsFor('strncpyReservesNul'), []);
  const detail = auditOf('strncpyNoNul').findings[0].detail;
  assert(/NUL/.test(detail), detail);
});

test('hardening: a count is compared with the destination it writes into', () => {
  assertDeepEquals(kindsFor('strncpyOverruns'), ['unbounded-copy'], 'n of 32 into a 16-byte destination is an overflow, not only a missing NUL');
  assertDeepEquals(kindsFor('memcpyOverruns'), ['unbounded-copy']);
  assertDeepEquals(kindsFor('memcpySizeofSource'), ['unbounded-copy'], 'sizeof(src) is a number this pass can read');
  assertDeepEquals(kindsFor('memcpyFits'), [], 'memcpy(dst, src, sizeof(dst)) is the idiom that gets it right');
  assertDeepEquals(kindsFor('memcpyUnknownCount'), [], 'a count held in a variable is a count this pass does not guess');
  const over = auditOf('memcpyOverruns').findings[0];
  assert(/told 64 byte/.test(over.detail), over.detail);
  assert(/dst\[16\] holds 16/.test(over.detail), over.detail);
});

test('hardening: scanf is measured against the buffer it fills', () => {
  assertDeepEquals(kindsFor('scanfNoWidth'), ['unbounded-scan']);
  assertDeepEquals(kindsFor('scanfWidthOverRuns'), ['unbounded-scan'], '%16s needs 17 bytes');
  assertDeepEquals(kindsFor('scanfWidthFits'), [], 'a width of 15 in a 16-byte buffer leaves the NUL its room');
  const noWidth = auditOf('scanfNoWidth').findings[0];
  assertEquals(noWidth.cwe, 'CWE-120');
  assert(/16 byte/.test(noWidth.detail), noWidth.detail);
});

test('hardening: a format string that is not a literal is the finding, in either direction', () => {
  assertDeepEquals(kindsFor('formatFromInput'), ['format-string-from-input']);
  assertDeepEquals(kindsFor('formatIsLiteral'), []);
  assert(/buf/.test(auditOf('formatFromInput').findings[0].detail), 'the finding names what it is worried about');
});

test('hardening: a pointer out of a local frame is named, a global or a parameter is not', () => {
  assertDeepEquals(kindsFor('escapeArray'), ['stack-address-escaped']);
  assertDeepEquals(kindsFor('escapeAddressOfLocal'), ['stack-address-escaped']);
  assertDeepEquals(kindsFor('escapeGlobalIsFine'), []);
  assertDeepEquals(kindsFor('escapeParamIsFine'), []);
  assertEquals(auditOf('escapeArray').findings[0].cwe, 'CWE-562');
});

test('hardening: an allocation used without a NULL test is named, in either order', () => {
  const unchecked = auditOf('mallocUnchecked').findings;
  assertDeepEquals(unchecked.map((f) => f.kind), ['unchecked-allocation']);
  assertEquals(unchecked[0].line, at(bugs.mallocUnchecked, 'p[0] = 1'), 'the finding sits on the dereference');
  assert(new RegExp(`line ${at(bugs.mallocUnchecked, 'int *p =')}`).test(unchecked[0].detail), unchecked[0].detail);
  assertDeepEquals(kindsFor('mallocChecked'), []);
  assertDeepEquals(kindsFor('mallocGuardedUse'), [], 'a use guarded by if (p != NULL) is a checked allocation');
});

test('hardening: straight-line frees are followed, guarded ones are not guessed', () => {
  assertDeepEquals(kindsFor('doubleFree'), ['double-free']);
  assertDeepEquals(kindsFor('freeAfterUse'), ['use-after-free']);
  assertDeepEquals(kindsFor('rebindingIsFine'), [], 'realloc hands the block back, so the new handle is live');
  assertDeepEquals(kindsFor('conditionalFreeIsFine'), [], 'a free inside an if says nothing about the line after it');
  const stale = auditOf('freeAfterUse').findings[0];
  assertEquals(stale.line, at(bugs.freeAfterUse, 'puts(p)'));
  assert(new RegExp(`line ${at(bugs.freeAfterUse, 'free(p)')}`).test(stale.detail), stale.detail);
});

test('hardening: a program that does not parse gets no accusations', () => {
  const report = audit('int main() { char buf[8]; gets(buf');
  assertEquals(report.ok, false);
  assertDeepEquals(report.findings, [], 'an unreadable program is not a clean program, but it is not a guilty one either');
  assert(report.error.message, 'the parse failure is still reported');
  assertEquals(report.notChecked, NOT_CHECKED);
});

test('hardening: every finding the audit can raise is in the shared table', () => {
  const raised = new Set();
  for (const key of Object.keys(bugs)) {
    for (const finding of auditOf(key).findings) {
      raised.add(finding.kind);
      const meta = FINDING_KINDS[finding.kind];
      assert(meta, `${key}: '${finding.kind}' is not in the shared vocabulary`);
      assertEquals(finding.severity, meta.severity);
      assertEquals(finding.cwe, meta.cwe);
      assertEquals(finding.fix, meta.fix);
      assert(finding.detail.length > 8, `${key}: a finding must say what it saw, not only what it calls it`);
    }
  }
  // The audit's own reach, stated as a set so a check that stops firing shows up
  // as a missing kind here rather than as a quiet green run.
  assertDeepEquals([...raised].sort(), [
    'dangerous-function',
    'double-free',
    'format-string-from-input',
    'stack-address-escaped',
    'unbounded-copy',
    'unbounded-scan',
    'unchecked-allocation',
    'unterminated-string',
    'use-after-free',
  ], 'the static pass covers nine of the thirteen kinds');
});

test('hardening: the shipped catalogue audits clean', () => {
  const accused = [];
  for (const recipe of RECIPES) {
    const generated = generate(recipe.defaultPrompt);
    const report = audit(generated.code);
    if (!report.ok) {
      accused.push(`${recipe.id}: does not parse (${report.error.message})`);
      continue;
    }
    if (report.findings.length) {
      accused.push(`${recipe.id}: ${report.findings.map((f) => `${f.kind}@${f.line}`).join(', ')}`);
    }
  }
  assertDeepEquals(accused, [], `SINGU generates ${RECIPES.length} patterns and none of them may trip the audit`);
  assert(RECIPES.length >= 15, `the catalogue is ${RECIPES.length} patterns wide`);
  assertEquals(AUDIT_VERSION, '1.0');
});

test('hardening: what the audit does not claim is written down', () => {
  assert(NOT_CHECKED.length >= 4, 'a checker with no declared limits is a checker with no honesty');
  for (const entry of NOT_CHECKED) {
    assert(entry.length > 30, entry);
    assert(/ - | - /.test(entry) || /instead|there|either|here/.test(entry), `${entry} must say who checks it instead`);
  }
  assert(NOT_CHECKED.some((e) => /runtime/.test(e)), 'the memory errors the runtime owns must be listed as not static');
});
