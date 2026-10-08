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
    /** How many ops have been dropped from the front of the log by trimLog(). */
    this.logTrimmed = 0;
    /**
     * Walk cursor: the last (node, visible index) this replica resolved.
     * Lookups start from the nearest anchor - head, tail or the cursor - so
     * sequential editing costs O(1) per operation instead of a full scan of the
     * document, which is what made typing one character at a time quadratic.
     */
    this._cursor = { node: this.head, index: -1 };
    /** Reverse index: origin id -> number of children. Makes tombstone GC O(1)
     *  per candidate instead of a scan of every node. */
    this._childCount = new Map();
    /** Nodes visited by index resolution. Exposed so tests can assert that the
     *  access pattern is not secretly quadratic. */
    this.walkSteps = 0;
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

/**
   * Walk from a known (node, index) pair to a target index. The caller
   * guarantees the invariant that `node` is visible and sits at `fromIndex`.
   */
  _walkTo(node, fromIndex, target) {
    let n = node;
    let i = fromIndex;
    if (i < target) {
      while (n && i < target) {
        n = n.next;
        this.walkSteps += 1;
        if (!n) return null;
        if (!n.deleted) i += 1;
      }
      return n;
    }
    while (n && i > target) {
      n = n.prev;
      this.walkSteps += 1;
      if (!n) return null;
      if (!n.deleted) i -= 1;
    }
    return n && !n.deleted ? n : null;
  }

  /**
   * The node at a visible index, clamped to the last visible character.
   *
   * The original implementation always scanned from the head, so appending n
   * characters one at a time cost O(n^2). This starts from whichever anchor is
   * closest - the cursor, the head, or the tail - which makes the common access
   * patterns (typing at the caret, appending, editing near the end) O(1) or
   * O(distance) instead of O(document).
   */
  nodeAtVisible(index) {
    if (index < 0 || this.visible === 0) return null;
    let target = index;
    if (target >= this.visible) target = this.visible - 1;

    // Anchors must be *visible* nodes: the walk below relies on the invariant
    // that its start node sits at `fromIndex` among visible items. The list
    // tail in particular can be a tombstone (deleting at the end leaves them),
    // so walk back over any trailing tombstones to the last visible item.
    let tailNode = this.tail;
    let tailIndex = this.visible - 1;
    while (tailNode && tailNode !== this.head && tailNode.deleted) tailNode = tailNode.prev;

    let from = this.head;
    let fromIndex = -1;
    const cursor = this._cursor;
    if (cursor && cursor.node && cursor.node !== this.head && !cursor.node.deleted && this.nodes.has(idKey(cursor.node.id))) {
      if (Math.abs(target - cursor.index) < Math.abs(target - fromIndex)) {
        from = cursor.node;
        fromIndex = cursor.index;
      }
    }
    if (tailNode && tailNode !== this.head && Math.abs(target - tailIndex) < Math.abs(target - fromIndex)) {
      from = tailNode;
      fromIndex = tailIndex;
    }
    const node = this._walkTo(from, fromIndex, target);
    if (node) this._cursor = { node, index: target };
    return node;
  }

  /** Visible index of a node id, or -1 when the character is not visible. */
  visibleIndexOf(id) {
    const node = this.nodes.get(idKey(id));
    if (!node || node.deleted) return -1;
    // Count visible characters before it, walking outwards from the node so the
    // cost follows the caret's position rather than the document's length.
    let i = 0;
    for (let n = node.prev; n && n !== this.head; n = n.prev) {
      this.walkSteps += 1;
      if (!n.deleted) i += 1;
    }
    return i;
  }

  stats() {
    return {
      visible: this.visible,
      tombstones: this.tombstones,
      items: this.nodes.size,
      buffered: this._buffer.length,
      ops: this.log.length,
      clock: this.clock,
      reclaimed: this.reclaimed || 0,
      seenPruned: this.seenPruned || 0,
      seen: this._seen.size,
      logTrimmed: this.logTrimmed,
    };
  }

  // ------------------------------------------------------------- maintenance

  /**
   * Reclaim tombstoned items - the memory a CRDT leaks as a document is edited
   * forever. A tombstone is only dropped when nothing can ever reference it
   * again:
   *
   *   - no live or tombstoned sibling has it as its direct origin (a later
   *     insert naming it would otherwise be stranded), and
   *   - it is not the head or the tail anchor, and
   *   - when `graceTs` is given, its delete stamp is at or below that watermark,
   *     which is how a caller keeps tombstones that an in-flight op might still
   *     name as an origin.
   *
   * Deleted items that are already in `_seen` stay covered: a peer replaying the
   * original delete is recognised as a duplicate before it needs the node.
   */
  collect(options = {}) {
    const safeTs = options.safeTs == null ? this.clock : options.safeTs;
    // An op still waiting for an origin would be stranded if that origin is
    // dropped, so anything the buffer names is pinned this round.
    const pinned = new Set();
    for (const op of this._buffer) if (op.o != null) pinned.add(idKey(op.o));
    let reclaimed = 0;
    for (const node of [...this.nodes.values()]) {
      if (!node.deleted || node === this.head) continue;
      // Interior tombstones are NOT collectable: a child's origin points at
      // them, and re-parenting a child to its grandparent can reorder it
      // against a concurrent sibling, which is exactly how an RGA diverges.
      // Only leaves go, and only below the watermark. The tail anchor is
      // allowed to move back to the previous item when a leaf tail goes.
      if (this._childCount.has(idKey(node.id))) continue;
      if (node.dt > safeTs) continue;
      if (pinned.has(idKey(node.id))) continue;
      if (node.prev) node.prev.next = node.next;
      if (node.next) node.next.prev = node.prev;
      else this.tail = node.prev;
      this.nodes.delete(idKey(node.id));
      this._childCount.delete(idKey(node.id));
      this.tombstones -= 1;
      if (this._cursor.node === node) this._cursor = { node: this.head, index: -1 };
      reclaimed += 1;
    }
    this.reclaimed = (this.reclaimed || 0) + reclaimed;
    // Fingerprints older than the watermark can never be needed again: even a
    // full log replay from a peer is idempotent on its own (an insert whose
    // item already exists, or a delete whose stamp is older, is a no-op), so
    // this set is an optimisation, not the correctness guarantee.
    let pruned = 0;
    if (options.pruneSeen !== false) {
      for (const fp of [...this._seen]) {
        const ts = Number(fp.slice(fp.indexOf(':') + 1).split('@')[0]);
        if (!Number.isFinite(ts) || ts <= safeTs) {
          this._seen.delete(fp);
          pruned += 1;
        }
      }
    }
    this.seenPruned = (this.seenPruned || 0) + pruned;
    return reclaimed;
  }

  /**
   * The conservative watermark for collect(): the lowest Lamport clock every
   * connected peer has reported. No peer below it can still be holding an op
   * whose origin we would drop. With no peers at all, pass Infinity - nobody
   * else can be writing, so every leaf tombstone is safe.
   */
  static safeWatermark(peerClocks) {
    if (!peerClocks || !peerClocks.length) return Infinity;
    return Math.min(...peerClocks);
  }

  /**
   * Keep only the newest `keep` ops. Callers that trim must be able to catch a
   * new replica up from a snapshot instead of the log, which the app does: a
   * sync response carries the document text whenever this replica has trimmed
   * (see onMeshMessage in src/app.js).
   */
  trimLog(keep = 0) {
    const want = Math.max(0, keep);
    const drop = Math.max(0, this.log.length - want);
    if (drop) {
      this.log = this.log.slice(drop);
      this.logTrimmed += drop;
    }
    return drop;
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
    if (op.o != null) {
      const key = idKey(op.o);
      this._childCount.set(key, (this._childCount.get(key) || 0) + 1);
    }
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
