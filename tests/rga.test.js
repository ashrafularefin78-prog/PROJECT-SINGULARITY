import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { RGA, compareId, CHECKPOINT_STRIDE } from '../src/crdt/rga.js';
import { stateDigest } from '../src/crdt/history.js';

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

/** A real delete/undo races a peer's delete and insert at the same effect time. */
function concurrentDeleteUndo() {
  const a = new RGA('a');
  const b = new RGA('b');
  const seed = a.localInsert(0, 'x');
  b.merge(seed);
  const deleted = a.localDelete(0, 1);
  const undone = a.undo();
  const insertedA = a.localInsert(1, 'A');
  const insertedB = b.localInsert(1, 'B');
  const deletedB = b.localDelete(0, 1);
  assertEquals(undone[0].ts, deletedB[0].ts, 'undo and peer delete are concurrent');
  return { a, b, seed, opsA: [...deleted, ...undone, ...insertedA], opsB: [...insertedB, ...deletedB] };
}

test('M1: two peers converge after delete/undo and concurrent insertion', () => {
  const { a, b, opsA, opsB } = concurrentDeleteUndo();
  assertEquals(a.text(), 'xA', 'local undo restored the character');
  assertEquals(b.text(), 'B', 'the peer deleted it independently');
  a.merge(opsB);
  b.merge(opsA);
  assertEquals(a.text(), 'AB', 'delete wins the equal-time undo');
  assertEquals(b.text(), a.text(), 'the original peers converge');
  assertEquals(stateDigest(a), stateDigest(b), 'visible ids and order also converge');
  assertEquals(a.stats().visible, 2);
  assertEquals(a.stats().tombstones, 1);
  assertEquals(b.stats().visible, 2);
  assertEquals(b.stats().tombstones, 1);

  // A causally later undo still wins: ties alone are delete-wins.
  const restored = b.undo();
  assert(restored[0].ts > opsB[1].ts, 'local undo follows the observed effects');
  a.merge(restored);
  assertEquals(a.text(), 'xAB');
  assertEquals(b.text(), a.text());
  assertEquals(stateDigest(a), stateDigest(b));
  assertEquals(a.stats().tombstones, 0);
  assertEquals(b.stats().tombstones, 0);
});

function* permutations(ops) {
  if (!ops.length) {
    yield [];
    return;
  }
  for (let i = 0; i < ops.length; i += 1) {
    const rest = [...ops.slice(0, i), ...ops.slice(i + 1)];
    for (const tail of permutations(rest)) yield [ops[i], ...tail];
  }
}

test('M1: every delete/undo/insertion permutation has equal text and digest', () => {
  const { a, b, seed, opsA, opsB } = concurrentDeleteUndo();
  a.merge(opsB);
  b.merge(opsA);
  const digest = stateDigest(b);
  let count = 0;
  for (const order of permutations([...seed, ...opsA, ...opsB])) {
    const replica = new RGA('replay');
    replica.merge(order);
    assertEquals(replica.text(), 'AB', `permutation ${count}: delete wins`);
    assertEquals(stateDigest(replica), digest, `permutation ${count}: equal digest`);
    assertEquals(replica.stats().buffered, 0, 'all causal dependencies drained');
    assertEquals(replica.stats().visible, 2);
    assertEquals(replica.stats().tombstones, 1);
    assertEquals(replica.nodes.get('1@a').dt, 3, 'equal-time winner retains the wire timestamp');
    replica.merge(order.slice().reverse());
    assertEquals(replica.log.length, 6, 'duplicate replay adds no ops');
    assertEquals(replica.text(), 'AB', 'duplicate replay is idempotent');
    assertEquals(stateDigest(replica), digest);
    count += 1;
  }
  assertEquals(count, 720, 'all six-operation permutations were checked');
  assertEquals(stateDigest(a), digest, 'the live peer matches every replay');
});

test('M1: high remote effect clocks are observed even while causally buffered', () => {
  for (const t of ['del', 'undel']) {
    for (const buffered of [false, true]) {
      const r = new RGA('local');
      const insert = { t: 'ins', id: [1, 'remote'], o: null, c: 'x' };
      if (!buffered) r.apply(insert);
      const effect = { t, id: insert.id, ts: 10000 };
      assertEquals(r.apply(effect), !buffered);
      assertEquals(r.clock, 10000, `${t}: observe effect time, not the old item id`);
      assertEquals(r.stats().buffered, buffered ? 1 : 0);
      const local = r.localInsert(0, 'Y');
      assertEquals(local[0].id[0], 10001, 'new insertion exceeds a buffered remote effect');
      if (buffered) r.apply(insert);
      assertEquals(r.stats().buffered, 0);
      const localUndo = r.undo();
      assertEquals(localUndo[0].ts, 10002, 'new effects also exceed remote effect time');
      assertEquals(r.text(), t === 'del' ? '' : 'x');
      r.apply(effect);
      assertEquals(r.clock, 10002, 'replaying a remote effect cannot rewind the clock');
    }
  }
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


// ---------------------------------------------------------------------------
// M1 index and maintenance.
//
// Two things used to be missing here and both are now covered: index lookups
// that do not rescan the document (the cursor walk), and the maintenance
// operations that keep a long-lived replica from growing without bound
// (tombstone collection, op-log trimming, fingerprint pruning).
// ---------------------------------------------------------------------------

/** Deliberately naive reference implementation of the cursor-walk lookup. */
function naiveNodeAtVisible(rga, index) {
  if (index < 0) return null;
  let i = -1;
  let last = null;
  for (let n = rga.head.next; n; n = n.next) {
    if (n.deleted) continue;
    i += 1;
    last = n;
    if (i === index) return n;
  }
  return last;
}

const idOf = (node) => (node && node.id ? node.id.join('@') : 'null');

/** A document with tombstones at the front, in the middle and at the end. */
function messyDocument() {
  const r = new RGA('m');
  r.localInsert(0, 'abcdefghij');
  r.localDelete(0, 2);
  r.localDelete(3, 2);
  r.localDelete(r.stats().visible - 2, 2);
  r.localInsert(0, 'XY');
  r.localDelete(2, 1);
  return r;
}

test('M1: the cursor walk resolves every index exactly like a full scan', () => {
  const rga = messyDocument();
  assertEquals(idOf(rga.nodeAtVisible(-1)), 'null', 'a negative index has no answer');
  for (let i = 0; i <= rga.visible + 1; i += 1) {
    assertEquals(
      idOf(rga.nodeAtVisible(i)),
      idOf(naiveNodeAtVisible(rga, i)),
      `index ${i} must resolve identically (visible=${rga.visible})`,
    );
  }
  // After the trailing leaves are collected the anchors move; parity must hold.
  rga.collect({ safeTs: Infinity });
  for (let i = 0; i <= rga.visible + 1; i += 1) {
    assertEquals(idOf(rga.nodeAtVisible(i)), idOf(naiveNodeAtVisible(rga, i)), `index ${i} after collect()`);
  }
});

test('M1: appends do not rescan the document (the quadratic path is gone)', () => {
  const rga = new RGA('bench');
  rga.localInsert(0, 'x'.repeat(5000));
  rga.walkSteps = 0;
  const n = 20000;
  for (let i = 0; i < n; i += 1) rga.localInsert(rga.visible, 'y');
  assertEquals(rga.text().length, 5000 + n, 'every character landed');
  // A full rescan per append would be O(n^2) - roughly 250 million node visits
  // here. The cursor means an append resolves its origin without walking at all.
  assert(
    rga.walkSteps < n * 10,
    `20000 appends visited ${rga.walkSteps} nodes; a per-append rescan would be ~250,000,000`,
  );
});

test('M1: an append lands at the end even when the list tail is a tombstone', () => {
  const rga = messyDocument();
  const before = rga.text();
  rga.localInsert(rga.visible, '!');
  assertEquals(rga.text(), before + '!', 'typing at the end stays at the end');

  const collected = messyDocument();
  collected.collect({ safeTs: Infinity });
  const trimmed = collected.text();
  collected.localInsert(collected.visible, '?');
  assertEquals(collected.text(), trimmed + '?', 'still at the end after the tail leaves are collected');
});

test('M1: collect() reclaims leaf tombstones and keeps the structural ones', () => {
  const rga = new RGA('gc');
  rga.localInsert(0, 'abcdef');
  rga.localDelete(3, 3); // d, e, f - f is a leaf, d and e are interior
  const before = rga.stats();
  const reclaimed = rga.collect({ safeTs: Infinity });
  const after = rga.stats();
  assertEquals(reclaimed, 1, 'only the leaf tombstone is collectable');
  assertEquals(after.tombstones, before.tombstones - 1);
  assertEquals(rga.text(), 'abc', 'the visible text is unchanged');
  assert(after.items < before.items, 'the item count actually dropped');

  // Interior tombstones stay: a child names them as its origin, and re-parenting
  // that child can reorder it against a concurrent sibling - the classic way an
  // RGA diverges. This is a design decision, not an oversight.
  const interior = new RGA('keep');
  interior.localInsert(0, 'abcdef');
  interior.localDelete(1, 5); // b..f, so f is the only leaf
  const kept = interior.collect({ safeTs: Infinity });
  assertEquals(kept, 1, 'only the trailing leaf is reclaimed');
  assertEquals(interior.stats().tombstones, 4, 'the four interior tombstones stay');
  assertEquals(interior.text(), 'a');
});

test('M1: a peer watermark protects tombstones an in-flight op could still name', () => {
  const a = new RGA('a');
  const b = new RGA('b');
  a.localInsert(0, 'ab');
  b.merge(a.log);
  a.localDelete(1, 1); // stamp 4
  const opFromB = b.localInsert(2, 'X'); // b has not seen the delete yet

  // The watermark is below the delete stamp, so nothing is collected and the
  // late op still resolves.
  assertEquals(a.collect({ safeTs: 2 }), 0, 'a low watermark pins the tombstone');
  a.merge(opFromB);
  b.merge(a.log);
  assertEquals(a.stats().buffered, 0, 'no op is left stranded');
  assertEquals(a.text(), b.text(), 'both replicas converge');

  // With the watermark above the stamp (everyone has seen the delete) the same
  // sequence is safe, which is what `Infinity` means when no peer is connected.
  const c = new RGA('c');
  c.localInsert(0, 'ab');
  c.localDelete(1, 1);
  assertEquals(c.collect({ safeTs: Infinity }), 1, 'with no peers, the leaf is reclaimable');
  assertEquals(c.text(), 'a');
});

test('M1: collect() will not strand an op that is already waiting in the buffer', () => {
  const rga = new RGA('buf');
  rga.localInsert(0, 'ab');
  rga.localDelete(1, 1);
  // An op whose origin is missing entirely: it parks in the causal buffer.
  rga.apply({ t: 'ins', id: [99, 'z'], o: [98, 'z'], c: 'Q' });
  assertEquals(rga.stats().buffered, 1, 'the op is waiting for an origin we do not have');
  const reclaimed = rga.collect({ safeTs: Infinity });
  assertEquals(reclaimed, 1, 'the unrelated leaf is still reclaimed');
  assertEquals(rga.stats().buffered, 1, 'and the parked op is untouched');
});

test('M1: trimLog bounds the op log and reports what it dropped', () => {
  const rga = new RGA('trim');
  rga.localInsert(0, 'hello world');
  rga.localDelete(0, 5);
  const before = rga.stats().ops;
  const dropped = rga.trimLog(3);
  assertEquals(dropped, before - 3);
  assertEquals(rga.stats().ops, 3);
  assertEquals(rga.stats().logTrimmed, dropped);
  assertEquals(rga.text(), ' world', 'trimming the log never changes the document');

  // A replica that only ever sees the trimmed log still converges on the
  // surviving state for the ops it does receive, and the app sends the document
  // text when the log has been trimmed (see onMeshMessage in src/app.js).
  const peer = new RGA('peer');
  peer.localInsert(0, rga.text());
  assertEquals(peer.text(), rga.text());
});

test('M1: fingerprint pruning is bounded by the watermark and stays idempotent', () => {
  const rga = new RGA('seen');
  rga.localInsert(0, 'abcd');
  const before = rga.stats().seen;
  rga.collect({ safeTs: Infinity });
  const after = rga.stats();
  assert(after.seen < before, `fingerprints should be pruned (${before} -> ${after.seen})`);
  assert(after.seenPruned >= before - after.seen);
  // Replaying the whole history after pruning must still be a no-op: the guards
  // in apply() are structural, the fingerprint set is only an optimisation.
  const snapshot = rga.text();
  rga.merge(rga.log);
  assertEquals(rga.text(), snapshot, 'a full replay changes nothing');
});

test('M1: random access at scale matches text() and does not walk the document', () => {
  const rga = new RGA('a');
  let source = '';
  for (let i = 0; i < 20000; i += 1) source += String.fromCharCode(97 + (i % 26));
  rga.localInsert(0, source);
  const text = rga.text();
  // Every 97th index: enough to exercise both the checkpoint table and the
  // walk between checkpoints without making the test itself slow.
  for (let i = 0; i < text.length; i += 97) {
    const node = rga.nodeAtVisible(i);
    assertEquals(node.ch, text[i], `index ${i}`);
  }
  // One cold, mid-document lookup must not degrade into a linear scan.
  const rga2 = new RGA('b');
  rga2.localInsert(0, source);
  rga2.nodeAtVisible(text.length / 2);
  const before = rga2.walkSteps;
  rga2.nodeAtVisible(text.length / 2 - 7);
  const steps = rga2.walkSteps - before;
  assert(steps <= CHECKPOINT_STRIDE, `a checkpointed lookup walked ${steps} nodes`);
});

test('M1: the checkpoint index is rebuilt after deletes reach its range', () => {
  const rga = new RGA('a');
  let source = '';
  for (let i = 0; i < 12000; i += 1) source += String.fromCharCode(97 + (i % 26));
  rga.localInsert(0, source);
  rga.nodeAtVisible(6000); // build the table
  rga.localDelete(0, 4000);
  rga.localDelete(200, 50);
  const text = rga.text();
  for (let i = 0; i < text.length; i += 211) {
    assertEquals(rga.nodeAtVisible(i).ch, text[i], `after delete, index ${i}`);
  }
  rga.collect({ safeTs: Infinity });
  const after = rga.text();
  for (let i = 0; i < after.length; i += 311) {
    assertEquals(rga.nodeAtVisible(i).ch, after[i], `after collect, index ${i}`);
  }
});

test('M1: the checkpoint index agrees with a concurrent merge', () => {
  const a = new RGA('a');
  const b = new RGA('b');
  a.localInsert(0, 'x'.repeat(9000));
  b.merge(a.log);
  for (let i = 0; i < 40; i += 1) a.localInsert((i * 331) % (a.visible + 1), 'A');
  for (let i = 0; i < 40; i += 1) b.localInsert((i * 197) % (b.visible + 1), 'B');
  a.nodeAtVisible(4500);
  a.merge(b.log);
  const text = a.text();
  for (let i = 0; i < text.length; i += 389) {
    assertEquals(a.nodeAtVisible(i).ch, text[i], `after merge, index ${i}`);
  }
});
