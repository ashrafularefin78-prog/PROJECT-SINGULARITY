/**
 * The temporal core, proven without a DOM.
 *
 * Replay is the second execution path for the same data: the live replica has
 * been mutated op by op, while a replay rebuilds state from a log. These tests
 * pin down (a) that every prefix replay matches the incremental state, (b) that
 * op order cannot change the fingerprint, and (c) that the fingerprint is
 * structural - same text from different ops is not "converged".
 */
import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { RGA } from '../src/crdt/rga.js';
import { canonicalState, replayReport, replayTo, shuffleOps, stateDigest } from '../src/crdt/history.js';

function twoReplicas() {
  const a = new RGA('a');
  const b = new RGA('b');
  const opsA = a.localInsert(0, 'hello');
  const opsB = b.localInsert(0, 'HELLO');
  a.merge(opsB);
  b.merge(opsA);
  return { a, b, opsA, opsB };
}

test('temporal: identical op sets fingerprint identically regardless of merge order', () => {
  const { a, b } = twoReplicas();
  assertEquals(a.text(), b.text(), 'the two replicas converge');
  assertEquals(stateDigest(a), stateDigest(b), 'and their structural digest matches');
});

test('temporal: the same text from independent ops is not a converged state', () => {
  const a = new RGA('a');
  const b = new RGA('b');
  a.localInsert(0, 'abc');
  b.localInsert(0, 'abc');
  assertEquals(a.text(), b.text(), 'same visible text');
  assert(stateDigest(a) !== stateDigest(b), 'different character ids, so different digest');
});

test('temporal: every prefix replay equals the state the live replica held at that op', () => {
  const live = new RGA('a');
  live.localInsert(0, 'singularity');
  live.localInsert(4, 'ular');
  live.localDelete(0, 3);
  live.localInsert(live.text().length, ' core');
  const log = live.log.slice();

  const rebuilt = new RGA('replay');
  for (let k = 0; k <= log.length; k += 1) {
    const step = replayTo(log, k);
    assertEquals(step.ops, k, `prefix ${k} consumed`);
    assertEquals(step.buffered, 0, `prefix ${k} is self-contained`);
    assertEquals(step.text, rebuilt.text(), `prefix ${k} text matches the incremental state`);
    assertEquals(step.digest, stateDigest(rebuilt), `prefix ${k} digest matches`);
    if (k < log.length) {
      rebuilt.merge([log[k]]);
      assertEquals(rebuilt.text(), replayTo(log, k + 1).text, `prefix ${k + 1} matches after one more op`);
    }
  }
  assertEquals(replayTo(log).text, live.text(), 'the full replay equals the live text');
  assertEquals(replayTo(log).digest, stateDigest(live), 'and the live digest');
});

test('temporal: reversed and shuffled replays converge on the forward digest', () => {
  const live = new RGA('a');
  live.localInsert(0, 'the quick brown fox');
  live.localDelete(4, 6);
  live.localInsert(3, 'slow ');
  live.undo();
  live.redo();
  live.localInsert(live.text().length, ' jumps');
  const log = live.log.slice();

  const report = replayReport(log);
  assertEquals(report.ops, log.length, 'every retained op is replayed');
  assert(report.agree, `orders disagree: ${JSON.stringify(report.orders)}`);
  assertEquals(report.digest, stateDigest(live), 'the replay digest equals the live digest');
  assertEquals(report.buffered, 0, 'a self-contained log leaves nothing buffered');
  assertDeepEquals(Object.keys(report.orders).sort(), ['forward', 'reverse', 'shuffled']);
});

test('temporal: an out-of-order delete is buffered, then resolved exactly once', () => {
  const live = new RGA('a');
  live.localInsert(0, 'abcdef');
  live.localDelete(2, 1);
  const log = live.log.slice();
  const reversed = log.slice().reverse();
  const state = replayTo(reversed);
  assertEquals(state.text, 'abdef', 'reverse arrival still converges');
  assertEquals(state.buffered, 0, 'nothing is left waiting');
  assertEquals(state.digest, stateDigest(live), 'same structure as the forward order');
});

test('temporal: shuffleOps is deterministic, total and non-mutating', () => {
  const log = ['a', 'b', 'c', 'd', 'e'];
  const first = shuffleOps(log, 7);
  const second = shuffleOps(log, 7);
  assertDeepEquals(first, second, 'same seed, same order');
  assertDeepEquals(log, ['a', 'b', 'c', 'd', 'e'], 'the input is untouched');
  assertDeepEquals(first.slice().sort(), log.slice().sort(), 'a permutation, not a filter');
  assert(shuffleOps([], 1).length === 0, 'an empty log stays empty');
});

test('temporal: an empty log is a valid, empty state', () => {
  const report = replayReport([]);
  assert(report.agree, 'vacuously order-independent');
  assertEquals(report.buffered, 0);
  const empty = new RGA('empty');
  assertEquals(report.digest, stateDigest(empty), 'matches a fresh replica');
  assertEquals(canonicalState(empty), '', 'no visible characters');
});

test('temporal: replayTo clamps an out-of-range position instead of throwing', () => {
  const live = new RGA('a');
  live.localInsert(0, 'abc');
  const log = live.log.slice();
  assertEquals(replayTo(log, 99).text, 'abc', 'past the end clamps to the full log');
  assertEquals(replayTo(log, -3).text, '', 'before the start clamps to empty');
  assertEquals(replayTo(log, Number.NaN).text, 'abc', 'NaN falls back to the full log');
});

test('temporal: a trimmed log cannot reconstruct the document, and says so', () => {
  const live = new RGA('a');
  live.localInsert(0, 'abcdefghij');
  const dropped = live.trimLog(4);
  assertEquals(dropped, 6, 'compaction dropped the front of the log');
  const window = replayTo(live.log);
  assert(window.text !== live.text(), 'the retained window alone is not the whole document');
  assert(window.buffered > 0, 'the retained ops name trimmed origins, so they cannot resolve alone');
  assertEquals(live.stats().logTrimmed, dropped, 'the count is published, not hidden');
});
