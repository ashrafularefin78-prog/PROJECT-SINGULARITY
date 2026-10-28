import { test, assert, assertEquals } from './harness.js';
import { MIGRATIONS, openDatabase, openLocalStore } from '../src/storage/db.js';
import { RGA } from '../src/crdt/rga.js';

const uniqueName = () => `singularity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function wrap(db, name) {
  // Reuse the module's Store class through the public factory: open a local
  // store, then swap in the pre-opened database handle for isolation.
  return openLocalStore(name).then((store) => {
    store.db = db;
    store.memory = null;
    return store;
  });
}

test('M6: the store reports whether it is really persistent', async () => {
  const store = await openLocalStore(uniqueName());
  assert(typeof store.persistent === 'boolean');
  store.close();
});

test('M6: ops round-trip through IndexedDB in order', async () => {
  const name = uniqueName();
  const store = await openLocalStore(name);
  const ops = [
    { t: 'ins', id: [1, 'a'], o: null, c: 'h' },
    { t: 'ins', id: [2, 'a'], o: [1, 'a'], c: 'i' },
    { t: 'del', id: [2, 'a'], ts: 3 },
  ];
  assertEquals(await store.appendOps('doc-1', ops), 3);
  await store.appendOps('doc-2', [{ t: 'ins', id: [1, 'b'], o: null, c: 'x' }]);
  assertEquals(await store.countOps('doc-1'), 3);
  assertEquals(await store.countOps('doc-2'), 1);
  const loaded = await store.loadOps('doc-1');
  assertEquals(JSON.stringify(loaded), JSON.stringify(ops), 'ops must come back verbatim');
  store.close();
});

// These two assert that data outlives the store object, which only the real
// IndexedDB backend can do; the Node run has an in-memory fallback instead, so
// they are skipped there rather than reported as failures.
test('M6: documents and meta survive reopen', async () => {
  const name = uniqueName();
  const first = await openLocalStore(name);
  await first.saveDoc('doc-1', 'persisted text');
  await first.setMeta('identity', { name: 'ada' });
  first.close();

  const second = await openLocalStore(name);
  const doc = await second.loadDoc('doc-1');
  assertEquals(doc.text, 'persisted text');
  const meta = await second.getMeta('identity');
  assertEquals(meta.name, 'ada');
  assertEquals(await second.getMeta('missing', 'fallback'), 'fallback');
  second.close();
}, { needs: 'indexeddb' });

test('M6: text snapshots preserve the causal op log', async () => {
  const name = uniqueName();
  const store = await openLocalStore(name);
  const ops = [];
  for (let i = 0; i < 50; i += 1) ops.push({ t: 'ins', id: [i + 1, 'a'], o: i ? [i, 'a'] : null, c: 'x' });
  await store.appendOps('doc', ops);
  assertEquals(await store.countOps('doc'), 50);

  await store.compact('doc', 'x'.repeat(50));
  assertEquals(await store.countOps('doc'), 50, 'text cannot replace character identities');
  const snapshot = await store.loadDoc('doc');
  assertEquals(snapshot.text.length, 50, 'snapshot must hold the full document');
  store.close();
});

test('M6: file frames are stored per stream and come back ordered', async () => {
  const name = uniqueName();
  const store = await openLocalStore(name);
  await store.putFileFrame({ streamId: 's1', n: 2, final: true, ct: 'ccc' });
  await store.putFileFrame({ streamId: 's1', n: 0, final: false, ct: 'aaa' });
  await store.putFileFrame({ streamId: 's1', n: 1, final: false, ct: 'bbb' });
  await store.putFileFrame({ streamId: 's2', n: 0, final: true, ct: 'zzz' });

  const frames = await store.listFileFrames('s1');
  assertEquals(frames.length, 3);
  assertEquals(frames.map((f) => f.n).join(','), '0,1,2', 'frames must be ordered by index');
  assertEquals(frames[0].ct, 'aaa');
  assertEquals((await store.listFileFrames('s2')).length, 1);
  store.close();
});

test('M6: upgrading v1 -> v2 adds the files store without losing data', async () => {
  const name = uniqueName();

  // A client running the *old* schema: only the v1 migration runs.
  const v1 = await openDatabase(name, 1);
  const tx = v1.transaction(['ops', 'docs', 'meta'], 'readwrite');
  tx.objectStore('ops').add({ docId: 'legacy', op: { t: 'ins', id: [1, 'z'], o: null, c: 'L' }, at: 1 });
  tx.objectStore('docs').put({ id: 'legacy', text: 'old but precious', at: 1 });
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  assert(!v1.objectStoreNames.contains('files'), 'v1 must not have the files store');
  v1.close();

  // Now the app runs the v2 schema against the same database.
  const v2 = await openDatabase(name, 2);
  assert(v2.objectStoreNames.contains('files'), 'migration must create the files store');
  const rows = await new Promise((res, rej) => {
    const t = v2.transaction('ops', 'readonly');
    const r = t.objectStore('ops').index('byDoc').getAll('legacy');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  assertEquals(rows.length, 1, 'migrated data must survive');
  assertEquals(rows[0].op.c, 'L');
  v2.close();
}, { needs: 'indexeddb' });

test('M6: every migration step is a function (declarative schema history)', () => {
  assertEquals(MIGRATIONS.length, 2);
  for (const m of MIGRATIONS) assertEquals(typeof m, 'function');
});

test('M6: quota estimation degrades gracefully when unavailable', async () => {
  const store = await openLocalStore(uniqueName());
  const est = await store.estimate();
  assert(typeof est.usage === 'number');
  assert(typeof est.quota === 'number');
  store.close();
});

async function snapshotThenEdit(store) {
  const doc = new RGA('author');
  await store.appendOps('doc', doc.localInsert(0, 'abc'));
  await store.compact('doc', doc.text());
  await store.appendOps('doc', doc.localInsert(3, 'X'));
  await store.appendOps('doc', doc.localInsert(0, 'Z'));
  const restored = new RGA('reader');
  restored.merge(await store.loadOps('doc'));
  assertEquals(restored.text(), 'ZabcX');
  assertEquals(restored.stats().buffered, 0);
}

test('M6: edits after a text snapshot retain their causal baseline', async () => {
  const store = await openLocalStore(uniqueName());
  try { await snapshotThenEdit(store); } finally { store.close(); }
});

test('M6: a snapshot and subsequent edits survive IndexedDB reopen', async () => {
  const name = uniqueName();
  const first = await openLocalStore(name);
  await snapshotThenEdit(first);
  first.close();
  const reopened = await openLocalStore(name);
  try {
    const restored = new RGA('reopened');
    restored.merge(await reopened.loadOps('doc'));
    assertEquals(restored.text(), 'ZabcX');
    assertEquals(restored.stats().buffered, 0);
  } finally { reopened.close(); }
}, { needs: 'indexeddb' });

test('M6: empty snapshots and delete-all histories remain valid', async () => {
  const store = await openLocalStore(uniqueName());
  try {
    const doc = new RGA('author');
    await store.appendOps('doc', doc.localInsert(0, 'abc'));
    await store.appendOps('doc', doc.localDelete(0, 3));
    await store.compact('doc', '');
    const restored = new RGA('reader');
    restored.merge(await store.loadOps('doc'));
    assertEquals(restored.text(), '');
    assertEquals(restored.stats().buffered, 0);
    assertEquals((await store.loadDoc('doc')).text, '');
    assertEquals(await store.countOps('doc'), 6);
  } finally { store.close(); }
});

test('M6: repair replaces only the damaged document history', async () => {
  const store = await openLocalStore(uniqueName());
  try {
    await store.appendOps('damaged', [{ t: 'ins', id: [2, 'bad'], o: [1, 'missing'], c: 'x' }]);
    await store.appendOps('other', [{ t: 'ins', id: [1, 'other'], o: null, c: 'Y' }]);
    const fresh = new RGA('repair');
    const replacement = fresh.localInsert(0, 'recovered');
    assertEquals(await store.replaceOps('damaged', replacement, fresh.text()), 9);
    const restored = new RGA('reader');
    restored.merge(await store.loadOps('damaged'));
    assertEquals(restored.text(), 'recovered');
    assertEquals(restored.stats().buffered, 0);
    assertEquals((await store.loadDoc('damaged')).text, 'recovered');
    assertEquals(await store.countOps('other'), 1);
    await store.replaceOps('damaged', [], '');
    assertEquals(await store.countOps('damaged'), 0);
    assertEquals((await store.loadDoc('damaged')).text, '');
  } finally { store.close(); }
});
