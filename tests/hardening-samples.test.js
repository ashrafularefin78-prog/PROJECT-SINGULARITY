// Bug-pair suite.
//
// The pairs in src/runtime/hardening-samples.js each carry a `says` block: what
// the static audit, the run and the sanitizer are claimed to make of the buggy
// half. This suite measures those claims instead of reading them, so a check that
// stops firing, a sample that no longer runs, or a fix that only looks right all
// fail here rather than in front of a learner.
import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { HARDENING_SAMPLES, SAMPLES_VERSION, SAMPLE_KINDS, LAYERS } from '../src/runtime/hardening-samples.js';
import { audit, AUDIT_VERSION } from '../src/runtime/hardening.js';
import { interpret } from '../src/runtime/interpreter.js';
import { FINDING_KINDS, SANITIZER_VERSION } from '../src/runtime/sanitizer.js';

const kindsOf = (list) => [...new Set((list || []).map((f) => f.kind))].sort();
const auditKinds = (source) => {
  const report = audit(source);
  assert(report.ok, `a shipped sample must parse: ${report.error && report.error.message}`);
  return kindsOf(report.findings);
};
const runOf = (source, stdin, sanitize) => interpret(source, sanitize ? { stdin, sanitize: true } : { stdin });

test('samples: the pairs are well formed and each names one defect class', () => {
  assert(HARDENING_SAMPLES.length >= 6, `six classes is the floor, got ${HARDENING_SAMPLES.length}`);
  const ids = new Set();
  for (const s of HARDENING_SAMPLES) {
    assert(!ids.has(s.id), `duplicate sample id ${s.id}`);
    ids.add(s.id);
    const meta = FINDING_KINDS[s.kind];
    assert(meta, `${s.id}: '${s.kind}' is not in the shared vocabulary`);
    assertEquals(s.cwe, meta.cwe, `${s.id}: the pair must carry the CWE the table gives its kind`);
    assert(s.title.length > 8 && s.lesson.length > 60, `${s.id} must explain the fix, not only name the bug`);
    assert(s.shows.length > 40, `${s.id} must say which layer is doing the work`);
    assert(s.vulnerable !== s.fixed, `${s.id}: a pair whose halves are identical proves nothing`);
    assert(s.vulnerable.startsWith('#include') && s.fixed.startsWith('#include'), `${s.id} is real source, not a fragment`);
    assertDeepEquals(auditKinds(s.fixed), [], `${s.id}: the fixed half of a pair must be clean, or the pair teaches nothing`);
  }
});

test('samples: the buggy half trips exactly the kinds the pair claims', () => {
  for (const s of HARDENING_SAMPLES) {
    assertDeepEquals(auditKinds(s.vulnerable), [...s.says.bug].sort(), `${s.id}: the static audit says something else than the panel claims`);
  }
});

test('samples: both halves run in the sandbox, and the fix produces the right answer', () => {
  for (const s of HARDENING_SAMPLES) {
    const buggy = runOf(s.vulnerable, s.stdin, false);
    assertEquals(buggy.ok, s.says.run === 'ok', `${s.id}: expected the run to be ${s.says.run}, got ${buggy.ok ? 'accepted' : `refused (${buggy.error.message})`}`);
    if (buggy.ok) assertEquals(buggy.output, s.says.bugOutput, `${s.id}: the buggy half no longer prints what the pair claims`);
    const fixed = runOf(s.fixed, s.stdin, false);
    assert(fixed.ok, `${s.id}: the fixed half must run: ${fixed.error && fixed.error.message}`);
    assertEquals(fixed.output, s.says.fixOutput, `${s.id}: the fixed half no longer prints the right answer`);
  }
});

test('samples: the sanitizer is what catches the two the run answers with a shrug', () => {
  const silent = HARDENING_SAMPLES.filter((s) => s.says.sanitized.length);
  assertDeepEquals(silent.map((s) => s.id).sort(), ['double-free', 'uninitialized-read', 'use-after-free'], 'the runtime-refused and report-only classes are a closed list');
  for (const s of silent) {
    const watched = runOf(s.vulnerable, s.stdin, true);
    assert(kindsOf(watched.findings).includes(s.says.sanitized[0]), `${s.id}: no '${s.says.sanitized[0]}' finding; got ${kindsOf(watched.findings).join(',') || 'nothing'}`);
    const plain = runOf(s.vulnerable, s.stdin, false);
    assertEquals(watched.output, plain.output, `${s.id}: a finding must not move a byte of the program's output`);
    assertEquals(watched.steps, plain.steps, `${s.id}: a finding must not change how many steps the program takes`);
    assertDeepEquals(kindsOf(runOf(s.fixed, s.stdin, true).findings), [], `${s.id}: the fixed half must be clean under the sanitizer, not only under the audit`);
  }
});

test('samples: a refused run still hands back what it found', () => {
  const overflow = HARDENING_SAMPLES.find((s) => s.id === 'strcpy-overflow');
  const watched = runOf(overflow.vulnerable, overflow.stdin, true);
  assertEquals(watched.ok, false, 'strcpy into a smaller buffer is refused by the arena');
  assert(/holds 8 characters/.test(watched.error.message), watched.error.message);
  // The refusal is the arena's own verdict; the sanitizer is not asked to agree.
  assertDeepEquals(kindsOf(watched.findings), [], overflow.id);
  assert(watched.output === '', 'nothing is printed before the overflow is caught');
});

test('samples: the pairs cover six classes and say which seven they leave to the checkers', () => {
  assertDeepEquals([...SAMPLE_KINDS].sort(), [
    'double-free',
    'format-string-from-input',
    'unbounded-copy',
    'unbounded-scan',
    'uninitialized-read',
    'use-after-free',
  ], 'the shipped pairs are the overflow, format-string and heap-corruption classes the surface claims');
  const claimed = new Set(HARDENING_SAMPLES.flatMap((s) => [...s.says.bug, ...s.says.sanitized]));
  for (const kind of SAMPLE_KINDS) {
    assert(claimed.has(kind), `${kind} is named as a pair but no layer is claimed to catch it`);
  }
  // A learner should be able to tell what the samples do not show. These kinds
  // are checked by one layer only, and none of them has a pair.
  assertDeepEquals(Object.keys(FINDING_KINDS).filter((k) => !claimed.has(k)).sort(), [
    'dangerous-function',
    'invalid-free',
    'memory-leak',
    'overflowing-size-computation',
    'stack-address-escaped',
    'unchecked-allocation',
    'unterminated-string',
  ], 'the kinds outside the pairs are a stated list, not a silent gap');
});

test('samples: the layers are the modules that actually answer', () => {
  assertEquals(LAYERS.length, 3);
  const byName = Object.fromEntries(LAYERS.map((l) => [l.name, l]));
  assertEquals(byName['static audit'].version, AUDIT_VERSION);
  assertEquals(byName['runtime sanitizer'].version, SANITIZER_VERSION);
  for (const layer of LAYERS) {
    assert(layer.module.startsWith('src/runtime/'), `${layer.name} must point at a real module`);
    assert(layer.says.length > 40, `${layer.name} must say what it claims and what it does not`);
  }
  assertEquals(SAMPLES_VERSION, '1.0');
});
