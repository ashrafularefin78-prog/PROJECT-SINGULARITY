/**
 * M6 - Offline-first storage.
 *
 * Three layers, each with a job:
 *   ops   : append-only CRDT op log (crash safety: we never rewrite history)
 *   docs  : compacted snapshots so replay does not grow without bound
 *   files : large binary payloads (encrypted file transfer frames)
 *   meta  : small key/value state (identity, room, schema bookkeeping)
 *
 * Migrations are declared as an ordered array and applied inside the upgrade
 * transaction, so a client on any previous version arrives at the current
 * schema without losing a single row. tests/storage.test.js proves it by
 * opening an old database and upgrading it.
 */

export const DB_NAME = 'singularity';
export const DB_VERSION = 2;

export const MIGRATIONS = [
  // v1: the core stores.
  (db) => {
    const ops = db.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
    ops.createIndex('byDoc', 'docId');
    db.createObjectStore('docs', { keyPath: 'id' });
    db.createObjectStore('meta', { keyPath: 'key' });
  },
  // v2: encrypted file frames for chunked transfers.
  (db) => {
    const files = db.createObjectStore('files', { keyPath: 'id' });
    files.createIndex('byStream', 'streamId');
  },
];

export function openDatabase(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB unavailable in this context'));
      return;
    }
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      for (let v = event.oldVersion; v < version; v += 1) {
        const migrate = MIGRATIONS[v];
        if (migrate) migrate(db, request.transaction);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB.open failed'));
    request.onblocked = () => reject(new Error('indexedDB upgrade blocked by another tab'));
  });
}

/** Minimal in-memory fallback when IndexedDB is blocked (e.g. some private modes). */
class MemoryBackend {
  constructor() {
    this.ops = new Map();
    this.docs = new Map();
    this.meta = new Map();
    this.files = new Map();
    this.seq = 0;
  }
}

class Store {
  constructor(db, backend) {
    this.db = db;
    this.memory = backend || null;
  }

  _tx(stores, mode) {
    return this.db.transaction(stores, mode);
  }

  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  _done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  get persistent() {
    return !this.memory;
  }

  // ------------------------------------------------------------------- ops

  async appendOps(docId, ops) {
    if (!ops.length) return 0;
    if (this.memory) {
      for (const op of ops) {
        this.memory.seq += 1;
        this.memory.ops.set(this.memory.seq, { seq: this.memory.seq, docId, op, at: Date.now() });
      }
      return ops.length;
    }
    const tx = this._tx('ops', 'readwrite');
    const store = tx.objectStore('ops');
    for (const op of ops) store.add({ docId, op, at: Date.now() });
    await this._done(tx);
    return ops.length;
  }

  async loadOps(docId) {
    if (this.memory) {
      return [...this.memory.ops.values()].filter((r) => r.docId === docId).map((r) => r.op);
    }
    const tx = this._tx('ops', 'readonly');
    const rows = await this._req(tx.objectStore('ops').index('byDoc').getAll(docId));
    return rows.map((r) => r.op);
  }

  async countOps(docId) {
    if (this.memory) {
      return [...this.memory.ops.values()].filter((r) => r.docId === docId).length;
    }
    const tx = this._tx('ops', 'readonly');
    return this._req(tx.objectStore('ops').index('byDoc').count(docId));
  }

  /** Replace the op log with a snapshot: bounded storage, no data loss. */
  async compact(docId, snapshotText) {
    if (this.memory) {
      for (const [seq, row] of this.memory.ops) if (row.docId === docId) this.memory.ops.delete(seq);
      this.memory.docs.set(docId, { id: docId, text: snapshotText, at: Date.now() });
      return true;
    }
    const tx = this._tx(['ops', 'docs'], 'readwrite');
    const index = tx.objectStore('ops').index('byDoc');
    const keys = await this._req(index.getAllKeys(docId));
    const ops = tx.objectStore('ops');
    for (const key of keys) ops.delete(key);
    tx.objectStore('docs').put({ id: docId, text: snapshotText, at: Date.now() });
    await this._done(tx);
    return true;
  }

  // ------------------------------------------------------------------ docs

  async saveDoc(docId, text) {
    if (this.memory) {
      this.memory.docs.set(docId, { id: docId, text, at: Date.now() });
      return true;
    }
    const tx = this._tx('docs', 'readwrite');
    tx.objectStore('docs').put({ id: docId, text, at: Date.now() });
    await this._done(tx);
    return true;
  }

  async loadDoc(docId) {
    if (this.memory) return this.memory.docs.get(docId) || null;
    const tx = this._tx('docs', 'readonly');
    return (await this._req(tx.objectStore('docs').get(docId))) || null;
  }

  // ------------------------------------------------------------------ meta

  async setMeta(key, value) {
    if (this.memory) {
      this.memory.meta.set(key, value);
      return true;
    }
    const tx = this._tx('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    await this._done(tx);
    return true;
  }

  async getMeta(key, fallback = null) {
    if (this.memory) return this.memory.meta.has(key) ? this.memory.meta.get(key) : fallback;
    const tx = this._tx('meta', 'readonly');
    const row = await this._req(tx.objectStore('meta').get(key));
    return row ? row.value : fallback;
  }

  // ----------------------------------------------------------------- files

  async putFileFrame(frame) {
    if (this.memory) {
      this.memory.files.set(`${frame.streamId}:${frame.n}`, frame);
      return true;
    }
    const tx = this._tx('files', 'readwrite');
    tx.objectStore('files').put({ id: `${frame.streamId}:${frame.n}`, ...frame });
    await this._done(tx);
    return true;
  }

  async listFileFrames(streamId) {
    if (this.memory) {
      return [...this.memory.files.values()]
        .filter((f) => f.streamId === streamId)
        .sort((a, b) => a.n - b.n);
    }
    const tx = this._tx('files', 'readonly');
    const rows = await this._req(tx.objectStore('files').index('byStream').getAll(streamId));
    return rows.sort((a, b) => a.n - b.n);
  }

  // ---------------------------------------------------------------- quotas

  async estimate() {
    if (!globalThis.navigator || !navigator.storage || !navigator.storage.estimate) {
      return { usage: 0, quota: 0, supported: false };
    }
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, supported: true };
  }

  async requestPersistence() {
    if (!globalThis.navigator || !navigator.storage || !navigator.storage.persist) return false;
    return navigator.storage.persist();
  }

  close() {
    if (this.db) this.db.close();
  }
}

/** Open the store, transparently degrading to memory if IndexedDB is blocked. */
export async function openLocalStore(name = DB_NAME) {
  try {
    const db = await openDatabase(name);
    return new Store(db, null);
  } catch (err) {
    const fallback = new Store(null, new MemoryBackend());
    fallback.reason = err.message;
    return fallback;
  }
}
