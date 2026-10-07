/**
 * M1 - Real-Time Collaborative Editor: hand-written CRDT.
 *
 * Algorithm: RGA (Replicated Growable Array), Roh et al. 2011.
 *
 * Insertions
 *   Every character is an immutable item with
 *     id     - [lamportTimestamp, replicaId], globally unique and totally ordered
 *     origin - id of the character it was inserted *after* (null = document start)
 *     ch     - the character
 *   Concurrent inserts sharing an origin are ordered by DESCENDING id, so a new
 *   item is placed after every existing sibling with a greater id. Because a
 *   child always carries a greater Lamport timestamp than its parent, a sibling
 *   subtree is always contiguous, which makes the "skip while ref.id > new.id"
 *   scan correct.
 *
 * Deletions
 *   Deletes are tombstones, and the deleted flag is a per-character
 *   last-writer-wins register stamped with its own Lamport timestamp
 *   (`node.dt`). `del`/`undel` are therefore idempotent *and* commutative, which
 *   is what allows undo/redo to be replicated to peers without divergence.
 *
 * Properties (enforced by tests/rga.test.js)
 *   - Commutativity : op order never changes the converged text
 *   - Idempotence   : replaying any op set changes nothing
 *   - Convergence   : replicas that saw the same op set render equal text
 *   - No lost data  : out-of-order/offline delivery is buffered causally
 *
 * Zero dependencies. No third-party CRDT library was used or consulted.
 */

/** Total order over ids: Lamport timestamp first, replica id as the tie-break. */
export function compareId(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  const ra = a[1];
  const rb = b[1];
  if (ra === rb) return 0;
  return ra < rb ? -1 : 1;
}

export function idKey(id) {
  return id[0] + '@' + id[1];
}

export class RGA {
  constructor(replica = 'a') {
    this.replica = String(replica);
    this.clock = 0;
    /** @type {Map<string, object>} idKey -> node */
    this.nodes = new Map();
    /** Sentinels: head is a permanent anchor, tail points at the last item. */
    this.head = { id: null, ch: null, deleted: true, dt: -1, prev: null, next: null };
    this.tail = this.head;
    this.visible = 0;
    this.tombstones = 0;
    /** Fingerprints of ops already merged - pure de-duplication of the log. */
    this._seen = new Set();
    /** Ops parked until their origin/item arrives (causal delivery). */
    this._buffer = [];
    this._draining = false;
    /** Full op history: what a freshly joined replica replays to catch up. */
    this.log = [];
    /** Per-user undo/redo. Never contains another replica's edits. */
    this.undoStack = [];
    this.redoStack = [];
  }

  // ---------------------------------------------------------------- local ops

  /** Insert `text` at visible index `index`. Returns the ops it produced. */
  localInsert(index, text) {
    if (!text) return [];
    const origin = this.nodeAtVisible(index - 1);
    let prevId = origin ? origin.id : null;
    const ops = [];
    for (const ch of text) {
      const op = { t: 'ins', id: [this._next(), this.replica], o: prevId, c: ch };
      this.apply(op);
      ops.push(op);
      prevId = op.id;
    }
    this._pushUndo(ops);
    return ops;
  }

  /** Delete `count` characters starting at visible index `index`. */
  localDelete(index, count) {
    const ops = [];
    let i = 0;
    for (let n = this.head.next; n && ops.length < count; n = n.next) {
      if (n.deleted) continue;
      if (i >= index) {
        const op = { t: 'del', id: n.id, ts: this._next() };
        this.apply(op);
        ops.push(op);
      } else {
        i += 1;
      }
    }
    this._pushUndo(ops);
    return ops;
  }

  /**
   * Undo this replica's last local batch. Returns the ops that were generated,
   * ready to be broadcast so peers converge. Never touches a peer's characters.
   *
   * Undo/redo stacks hold normalised *effect* intents ({ id, effect }) rather
   * than op types, so undo and redo stay exact inverses of each other.
   */
  undo() {
    const batch = this.undoStack.pop();
    if (!batch || !batch.length) return [];
    const ops = batch.map((intent) =>
      this._effectOp(intent.id, intent.effect === 'present' ? 'absent' : 'present'),
    );
    this.redoStack.push(batch);
    return ops;
  }

  /** Redo the last undone batch. Returns the ops to broadcast. */
  redo() {
    const batch = this.redoStack.pop();
    if (!batch || !batch.length) return [];
    const ops = batch.map((intent) => this._effectOp(intent.id, intent.effect));
    this.undoStack.push(batch);
    return ops;
  }

  /** Apply "this character is present/absent" as a fresh Lamport-stamped op. */
  _effectOp(id, effect) {
    const op = { t: effect === 'present' ? 'undel' : 'del', id, ts: this._next() };
    this.apply(op);
    return op;
  }

  // --------------------------------------------------------------- remote ops

  /** Apply one op. Idempotent, commutative, and causal-buffered. */
  apply(op) {
    const fp = op.t + ':' + idKey(op.id) + ':' + (op.ts == null ? 0 : op.ts);
    if (this._seen.has(fp)) return true;

    let resolved;
    if (op.t === 'ins') {
      resolved = this._applyInsert(op);
    } else {
      resolved = this._applyDelete(op);
    }

    if (!resolved) {
      this._buffer.push(op);
      return false;
    }

    this._seen.add(fp);
    this._observe(op.id[0]);
    this.log.push(op);
    if (!this._draining) this._drainBuffer();
    return true;
  }

  /** Merge a peer's op batch. Returns how many ops were new to this replica. */
  merge(ops) {
    let added = 0;
    for (const op of ops) {
      const before = this.log.length;
      this.apply(op);
      if (this.log.length > before) added += 1;
    }
    return added;
  }

  // ------------------------------------------------------------------- query

  text() {
    let out = '';
    for (let n = this.head.next; n; n = n.next) if (!n.deleted) out += n.ch;
    return out;
  }

  /** The node at a visible index, clamped to the last visible character. */
  nodeAtVisible(index) {
    if (index < 0) return null;
    let i = -1;
    let last = null;
    for (let n = this.head.next; n; n = n.next) {
      if (n.deleted) continue;
      i += 1;
      last = n;
      if (i === index) return n;
    }
    return last;
  }

  /** Visible index of a node id, or -1 when the character is not visible. */
  visibleIndexOf(id) {
    let i = 0;
    for (let n = this.head.next; n; n = n.next) {
      if (!n.deleted && compareId(n.id, id) === 0) return i;
      if (!n.deleted) i += 1;
    }
    return -1;
  }

  stats() {
    return {
      visible: this.visible,
      tombstones: this.tombstones,
      items: this.nodes.size,
      buffered: this._buffer.length,
      ops: this.log.length,
      clock: this.clock,
    };
  }

  // --------------------------------------------------------------- internals

  _pushUndo(ops) {
    if (!ops.length) return;
    this.undoStack.push(
      ops.map((op) => ({ id: op.id, effect: op.t === 'del' ? 'absent' : 'present' })),
    );
    this.redoStack.length = 0;
  }

  _applyInsert(op) {
    if (this.nodes.has(idKey(op.id))) return true;
    const origin = op.o == null ? this.head : this.nodes.get(idKey(op.o));
    if (!origin) return false; // causal wait
    const node = { id: op.id, ch: op.c, deleted: false, dt: -1, prev: null, next: null };
    this.nodes.set(idKey(op.id), node);
    this._link(origin, node);
    this.visible += 1;
    return true;
  }

  /** Last-writer-wins on the deleted flag, keyed by the op's Lamport stamp. */
  _applyDelete(op) {
    const node = this.nodes.get(idKey(op.id));
    if (!node) return false; // item not here yet
    const ts = op.ts == null ? 0 : op.ts;
    if (ts > node.dt) {
      node.dt = ts;
      const wantDeleted = op.t === 'del';
      if (node.deleted !== wantDeleted) {
        node.deleted = wantDeleted;
        if (wantDeleted) {
          this.visible -= 1;
          this.tombstones += 1;
        } else {
          this.visible += 1;
          this.tombstones -= 1;
        }
      }
    }
    return true;
  }

  _link(originNode, node) {
    let ref = originNode.next;
    while (ref && compareId(ref.id, node.id) > 0) ref = ref.next;
    if (ref) {
      node.prev = ref.prev;
      node.next = ref;
      ref.prev.next = node;
      ref.prev = node;
    } else {
      node.prev = this.tail;
      node.next = null;
      this.tail.next = node;
      this.tail = node;
    }
  }

  _drainBuffer() {
    if (!this._buffer.length) return;
    this._draining = true;
    try {
      let progress = true;
      while (progress && this._buffer.length) {
        progress = false;
        const queue = this._buffer;
        this._buffer = [];
        for (const op of queue) {
          const before = this.log.length;
          this.apply(op);
          if (this.log.length > before) progress = true;
        }
      }
    } finally {
      this._draining = false;
    }
  }

  /** Lamport clock: adopt remote timestamps so our future ids stay greater. */
  _observe(ts) {
    if (ts > this.clock) this.clock = ts;
  }

  /** Mint a fresh locally-unique timestamp. */
  _next() {
    this.clock += 1;
    return this.clock;
  }
}
