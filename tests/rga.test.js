import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { RGA, compareId } from '../src/crdt/rga.js';

test('M1: sequential typing reproduces the input exactly', () => {
  const r = new RGA('a');
  r.localInsert(0, 'hello');
  r.localInsert(5, ' world');
  r.localInsert(0, '>> ');
  r.localInsert(14, '!');
  assertEquals(r.text(), '>> hello world!');
});

test('M1: delete/undo/redo keep counts consistent', () => {
  const r = new RGA('a');
  r.localInsert(0, 'abcdef');
  r.localDelete(2, 3);
  assertEquals(r.text(), 'abf');
  assertEquals(r.stats().visible, 3);
  assertEquals(r.stats().tombstones, 3);
  r.undo(); // restore cde
  assertEquals(r.text(), 'abcdef');
  assertEquals(r.stats().tombstones, 0);
  r.redo();
  assertEquals(r.text(), 'abf');
});

test('M1: same-position concurrent inserts converge on both replicas', () => {
  const a = new RGA('a');
  const b = new RGA('b');
  const opsA = a.localInsert(0, 'X');
  const opsB = b.localInsert(0, 'Y');
  a.merge(opsB);
  b.merge(opsA);
  assertEquals(a.text(), b.text(), 'replicas diverged');
  assertEquals(a.text().length, 2);
});

test('M1: op application is idempotent', () => {
  const a = new RGA('a');
  const b = new RGA('b');
  const ops = a.localInsert(0, 'abc');
  b.merge(ops);
  b.merge(ops);
  b.merge(ops);
  assertEquals(b.text(), 'abc');
  assertEquals(b.stats().items, 3);
});

test('M1: out-of-order (offline) delivery still merges with zero lost chars', () => {
  const a = new RGA('a');
  const ops = a.localInsert(0, 'offline edit');
  const shuffled = [...ops].reverse(); // reverse = maximally out of order
  const b = new RGA('b');
  // Feed the very last character first: every op is causally blocked at first.
  b.merge(shuffled);
  assertEquals(b.text(), 'offline edit');
  assertEquals(b.stats().buffered, 0, 'causal buffer should have drained');
});

test('M1: merges are commutative (order of batches does not matter)', () => {
  const src = new RGA('a');
  const batch1 = src.localInsert(0, 'aaa');
  const batch2 = src.localInsert(3, 'bbb');
  const batch3 = src.localDelete(0, 2);
  const b1 = new RGA('b');
  b1.merge(batch3);
  b1.merge(batch1);
  b1.merge(batch2);
  const b2 = new RGA('c');
  b2.merge(batch2);
  b2.merge(batch3);
  b2.merge(batch1);
  assertEquals(b1.text(), src.text());
  assertEquals(b2.text(), src.text());
});

test('M1: property - 300 randomized concurrent trials converge', () => {
  const CHARS = 'abcdefg ';
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let trial = 0; trial < 300; trial += 1) {
    const replicas = [new RGA('r1'), new RGA('r2'), new RGA('r3')];
    const allOps = [];
    for (let step = 0; step < 25; step += 1) {
      const r = replicas[Math.floor(rnd() * replicas.length)];
      if (rnd() < 0.7 || r.stats().visible === 0) {
        const n = 1 + Math.floor(rnd() * 4);
        let text = '';
        for (let i = 0; i < n; i += 1) text += CHARS[Math.floor(rnd() * CHARS.length)];
        const at = Math.floor(rnd() * (r.stats().visible + 1));
        allOps.push(...r.localInsert(at, text));
      } else {
        const at = Math.floor(rnd() * r.stats().visible);
        const n = 1 + Math.floor(rnd() * Math.min(3, r.stats().visible - at));
        allOps.push(...r.localDelete(at, n));
      }
    }

    // Deliver the full op set to every replica in an independent random order.
    for (const r of replicas) {
      const shuffled = [...allOps];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      r.merge(shuffled);
    }

    const texts = replicas.map((r) => r.text());
    assertEquals(texts[0], texts[1], `trial ${trial}: r1 != r2`);
    assertEquals(texts[1], texts[2], `trial ${trial}: r2 != r3`);
    assertEquals(replicas[0].stats().buffered, 0, `trial ${trial}: ops stuck in buffer`);
  }
});

test('M1: undo never rewrites a peer characters', () => {
  const a = new RGA('a');
  const b = new RGA('b');
  a.localInsert(0, 'mine');
  b.merge(a.log);
  // b adds characters, then a undoes its own edit.
  const opsB = b.localInsert(4, 'theirs');
  a.merge(opsB);
  const before = a.text();
  a.undo(); // removes 'mine' only
  assertEquals(before, 'minetheirs');
  assertEquals(a.text(), 'theirs');
});

test('M1: undo/redo ops replicate so peers converge (LWW delete flag)', () => {
  const a = new RGA('a');
  const b = new RGA('b');
  a.localInsert(0, 'abcdef');
  b.merge(a.log);
  assertEquals(b.text(), 'abcdef');

  const deleted = a.localDelete(2, 3);
  b.merge(deleted);
  assertEquals(b.text(), 'abf');

  const undone = a.undo();
  b.merge(undone); // peers must see the undo
  assertEquals(a.text(), 'abcdef');
  assertEquals(b.text(), 'abcdef');

  const redone = a.redo();
  b.merge(redone);
  assertEquals(a.text(), 'abf');
  assertEquals(b.text(), 'abf');
});

test('M1: concurrent deletes converge regardless of delivery order', () => {
  const a = new RGA('a');
  const b = new RGA('b');
  a.localInsert(0, 'hello world');
  b.merge(a.log);
  const delA = a.localDelete(0, 5); // "hello"
  const delB = b.localDelete(6, 5); // "world"
  a.merge(delB);
  b.merge(delA);
  assertEquals(a.text(), ' ');
  assertEquals(a.text(), b.text());
  assertEquals(a.stats().tombstones, 10);
});

test('M1: a replica observes remote Lamport timestamps (causality)', () => {
  const a = new RGA('a');
  a.localInsert(0, 'x'.repeat(10));
  assertEquals(a.clock, 10);
  const b = new RGA('b');
  b.merge(a.log);
  assertEquals(b.clock, 10, 'b must adopt the remote clock');
  b.localInsert(0, 'y');
  const last = b.log[b.log.length - 1];
  assert(last.id[0] > 10, 'new local id must exceed every observed timestamp');
  // ...and the merged result still converges back on a.
  a.merge(b.log);
  assertEquals(a.text(), b.text());
});

test('M1: id ordering is a total order with clock tie-break', () => {
  assert(compareId([1, 'a'], [2, 'a']) < 0);
  assert(compareId([2, 'a'], [2, 'b']) < 0);
  assertEquals(compareId([5, 'z'], [5, 'z']), 0);
});
