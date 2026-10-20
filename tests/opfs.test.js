/**
 * M6 - OPFS durability tier.
 *
 * The pure helpers run everywhere. The filesystem behaviour (atomic replacement,
 * ordered batches, cleanup) is browser-only and declares `opfs`, so bare Node
 * reports it as a skip instead of failing on an API it does not have.
 */
import { test, assert, assertDeepEquals, assertEquals } from './harness.js';
import {
  OPFS_ROOT,
  batchFileName,
  openOpfsMirror,
  parseBatch,
  parseSnapshot,
  safeDocId,
} from '../src/storage/opfs.js';

test('M6 OPFS: document ids are reduced to an allowlist', () => {
  assertEquals(safeDocId('doc/with spaces?'), 'doc_with_spaces_');
  assertEquals(safeDocId(''), 'doc');
  assertEquals(safeDocId('../../etc/passwd'), '.._.._etc_passwd');
  assert(safeDocId('x'.repeat(200)).length <= 64, 'length is bounded');
});

test('M6 OPFS: batch names sort in sequence order to six digits', () => {
  assertEquals(batchFileName(0), '000000.json');
  assertEquals(batchFileName(42), '000042.json');
  assertDeepEquals([batchFileName(10), batchFileName(2)].sort(), ['000002.json', '000010.json']);
  let threw = false;
  try {
    batchFileName(-1);
  } catch {
    threw = true;
  }
  assert(threw, 'a negative sequence is rejected');
});

test('M6 OPFS: malformed batches and snapshots are rejected, not half-read', () => {
  assertEquals(parseBatch('not json'), null);
  assertEquals(parseBatch('{"seq":1}'), null);
  assertEquals(parseBatch('{"seq":1,"ops":[]}').seq, 1);
  assertEquals(parseSnapshot('{"text":42}'), null);
  assertEquals(parseSnapshot('{"text":"abc"}').text, 'abc');
});

test('M6 OPFS: batches are ordered, snapshots atomic, cleanup complete', async () => {
  const docId = `test-${Date.now().toString(36)}`;
  const mirror = await openOpfsMirror();
  assert(mirror.state.supported, 'the test context exposes OPFS');
  assert(!mirror.state.error, `OPFS opened: ${mirror.state.error}`);

  try {
    await mirror.appendBatch(docId, [{ t: 'ins', id: [1, 't'], o: null, c: 'a' }]);
    await mirror.appendBatch(docId, [{ t: 'ins', id: [2, 't'], o: [1, 't'], c: 'b' }]);
    const read = await mirror.readBatches(docId);
    assertEquals(read.batches, 2, 'two batch files');
    assertEquals(read.corrupt, 0, 'nothing corrupt');
    assertEquals(read.ops.length, 2, 'two ops');
    assertEquals(read.ops[1].id[0], 2, 'read in sequence order');

    assert(await mirror.writeSnapshot(docId, 'ab', 2), 'snapshot written');
    const snap = await mirror.readSnapshot(docId);
    assertEquals(snap.text, 'ab', 'snapshot text round-trips');

    // Atomicity: an abandoned replacement must not damage the committed file.
    const top = await navigator.storage.getDirectory();
    const root = await top.getDirectoryHandle(OPFS_ROOT, { create: true });
    const file = await root.getFileHandle(`doc-${safeDocId(docId)}.json`, { create: true });
    const writable = await file.createWritable();
    await writable.write('{"text":"torn');
    await writable.abort();
    assertEquals((await mirror.readSnapshot(docId)).text, 'ab', 'aborted write left the old snapshot intact');

    const status = await mirror.status(docId);
    assert(status.available && status.snapshot, 'status reports the mirror');
    assertEquals(status.batches, 2, 'status counts the batches');

    await mirror.removeDoc(docId);
    const after = await mirror.status(docId);
    assertEquals(after.batches, 0, 'cleanup removed the batches');
    assertEquals(after.snapshot, false, 'cleanup removed the snapshot');
  } finally {
    await mirror.removeDoc(docId);
  }
}, { needs: 'opfs' });
