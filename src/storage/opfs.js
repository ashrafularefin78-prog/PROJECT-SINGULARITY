/**
 * M6 - the OPFS durability tier.
 *
 * IndexedDB is the structured store and stays authoritative. OPFS is the
 * crash-safety mirror the brief asks for: a write-ahead copy of every op batch,
 * one file per batch, plus an atomically replaced snapshot. A batch file is
 * created by `createWritable()`, which commits on close and leaves the previous
 * file untouched if the tab dies mid-write - a torn tail is impossible by
 * construction, not by a repair pass.
 *
 * The design is deliberately boring:
 *
 *   singularity/
 *     doc-<id>.json        snapshot {text, at, ops}
 *     ops-<id>/000001.json one accepted batch {seq, at, ops}
 *     ops-<id>/000002.json
 *
 * A batch file is only removed after IndexedDB has durably compacted past it.
 * Recovery reads the snapshot and then the batches, which is exactly the same
 * order the app already uses for IndexedDB plus its op log.
 *
 * Everything here degrades to a no-op when OPFS is unavailable (Safari private
 * mode, older browsers, Node), and the caller is told which state it got.
 */

export const OPFS_ROOT = 'singularity';

/** OPFS paths are names, not URLs: keep them to an allowlist. */
export function safeDocId(docId) {
  const cleaned = String(docId || 'doc').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return cleaned || 'doc';
}

const pad = (n) => String(n).padStart(6, '0');

/** One file per acknowledged batch. Ordering is lexical by design. */
export function batchFileName(seq) {
  if (!Number.isInteger(seq) || seq < 0) throw new Error('batch sequence must be a non-negative integer');
  return `${pad(seq)}.json`;
}

/** Parse a batch file, returning null for a shape this version cannot trust. */
export function parseBatch(text) {
  try {
    const data = JSON.parse(text);
    if (!data || !Number.isInteger(data.seq) || !Array.isArray(data.ops)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Parse a snapshot file, returning null rather than a half-usable document. */
export function parseSnapshot(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data.text !== 'string') return null;
    return { text: data.text, at: data.at || null, ops: Number.isInteger(data.ops) ? data.ops : 0 };
  } catch {
    return null;
  }
}

export function opfsSupported(scope = globalThis) {
  return !!(scope.navigator && scope.navigator.storage && typeof scope.navigator.storage.getDirectory === 'function');
}

/**
 * Open the mirror. The returned object never throws on a missing OPFS; callers
 * check `supported` and surface it as "unavailable" instead of pretending.
 */
export async function openOpfsMirror(scope = globalThis) {
  const supported = opfsSupported(scope);
  const state = { supported, error: null, seq: 0, batches: 0, bytes: 0, lastWriteAt: null };
  let root = null;

  if (supported) {
    try {
      const top = await scope.navigator.storage.getDirectory();
      root = await top.getDirectoryHandle(OPFS_ROOT, { create: true });
    } catch (err) {
      state.error = err.message;
    }
  }

  const docDir = async (docId, create = true) => root.getDirectoryHandle(`ops-${safeDocId(docId)}`, { create });

  /** Write `text` to `name` atomically: createWritable commits on close. */
  async function writeAtomic(dir, name, body) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(body);
    } finally {
      await writable.close();
    }
  }

  async function readFile(dir, name) {
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return await file.text();
    } catch {
      return null;
    }
  }

  return {
    state,

    /** Persist an accepted op batch. Errors are reported, never swallowed. */
    async appendBatch(docId, ops) {
      if (!root || !ops.length) return state.batches;
      try {
        const dir = await docDir(docId);
        state.seq += 1;
        const body = JSON.stringify({ seq: state.seq, at: new Date().toISOString(), ops });
        await writeAtomic(dir, batchFileName(state.seq), body);
        state.batches += 1;
        state.bytes += body.length;
        state.lastWriteAt = Date.now();
      } catch (err) {
        state.error = err.message;
      }
      return state.batches;
    },

    /** Replace the snapshot. The old one stays readable until close commits. */
    async writeSnapshot(docId, docText, opCount = 0) {
      if (!root) return false;
      try {
        await writeAtomic(root, `doc-${safeDocId(docId)}.json`, JSON.stringify({
          text: docText,
          at: new Date().toISOString(),
          ops: opCount,
        }));
        state.lastWriteAt = Date.now();
        return true;
      } catch (err) {
        state.error = err.message;
        return false;
      }
    },

    async readSnapshot(docId) {
      if (!root) return null;
      const body = await readFile(root, `doc-${safeDocId(docId)}.json`);
      return body == null ? null : parseSnapshot(body);
    },

    /** Read every batch in sequence order. A corrupt batch is skipped, loudly. */
    async readBatches(docId) {
      if (!root) return { ops: [], batches: 0, corrupt: 0 };
      const ops = [];
      let batches = 0;
      let corrupt = 0;
      try {
        const dir = await docDir(docId);
        const names = [];
        for await (const [name] of dir.entries()) if (/^\d{6}\.json$/.test(name)) names.push(name);
        names.sort();
        for (const name of names) {
          const body = await readFile(dir, name);
          const parsed = body == null ? null : parseBatch(body);
          if (!parsed) {
            corrupt += 1;
            continue;
          }
          batches += 1;
          ops.push(...parsed.ops);
          state.seq = Math.max(state.seq, parsed.seq);
        }
      } catch {
        // No directory yet: a first run, not an error.
      }
      return { ops, batches, corrupt };
    },

    /** Drop batches that IndexedDB has already compacted into a snapshot. */
    async pruneBatches(docId, keep = 0) {
      if (!root) return 0;
      let removed = 0;
      try {
        const dir = await docDir(docId);
        const names = [];
        for await (const [name] of dir.entries()) if (/^\d{6}\.json$/.test(name)) names.push(name);
        names.sort();
        for (const name of names.slice(0, Math.max(0, names.length - keep))) {
          await dir.removeEntry(name);
          removed += 1;
        }
      } catch {
        // Nothing to prune.
      }
      return removed;
    },

    /** Remove one document's mirror: used by delete flows and by the tests. */
    async removeDoc(docId) {
      if (!root) return false;
      try {
        await root.removeEntry(`ops-${safeDocId(docId)}`, { recursive: true });
      } catch {
        /* no directory is already removed */
      }
      try {
        await root.removeEntry(`doc-${safeDocId(docId)}.json`);
      } catch {
        /* no snapshot is already removed */
      }
      return true;
    },

    /** File count and total bytes, for the M6 panel. */
    async status(docId) {
      if (!root) return { supported, available: false, batches: 0, bytes: 0, snapshot: false, error: state.error };
      let batches = 0;
      let bytes = 0;
      try {
        const dir = await docDir(docId, false);
        for await (const [, handle] of dir.entries()) {
          if (!handle || typeof handle.getFile !== 'function') continue;
          batches += 1;
          try {
            bytes += (await handle.getFile()).size;
          } catch {
            /* a file removed between listing and stat is simply not counted */
          }
        }
      } catch {
        /* no directory yet */
      }
      const snapshot = (await readFile(root, `doc-${safeDocId(docId)}.json`)) != null;
      return { supported, available: true, batches, bytes, snapshot, seq: state.seq, error: state.error };
    },
  };
}
