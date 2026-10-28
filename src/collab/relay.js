/**
 * M5 - the relay carrier: the browser side of the ciphertext relay contract.
 *
 * `tools/relay.js` is the node; this is the client. It speaks the node's HTTP
 * surface - `POST /relay/post`, `GET /relay/drain?peer=<id>&wait=<s>`,
 * `GET /relay/stats` - and adds the three things a browser carrier needs:
 *
 *   - Sealing, injected rather than built in. A `seal(payload)` /
 *     `open(frame)` pair is supplied by the caller (the app seals with a key
 *     derived from the room passphrase), so this module never touches key
 *     material and the node never receives anything but opaque frames. The
 *     frame carries a per-message id inside the sealed plaintext, so the
 *     receiving carrier can hand each message up exactly once even when a
 *     repost delivers it twice - at-least-once on the wire, once at the app.
 *   - An outbox. A post that the node did not acknowledge stays queued, so a
 *     node that dies mid-flight is answered by re-posting to the next node in
 *     the list. This is the guarantee the load harness measures with
 *     `--failover`: an envelope the fleet could not get confirmed is never
 *     dropped, because the ciphertext is still on the sender.
 *   - Failover across a list of base URLs. Transport errors, 5xx responses and
 *     429 backpressure rotate and retry within a bounded budget, keeping any
 *     unacknowledged frames queued. Other 4xx responses are terminal protocol
 *     errors and are surfaced, never retried into a loop.
 *
 * Same-origin by design: the shipped app carries `connect-src 'self'`, so a
 * relay has to be mounted under the same origin (a route or reverse proxy next
 * to the static files). A URL in `urls` is a *base* - an origin like
 * `http://127.0.0.1:8890` or the empty string for this origin - and the node's
 * own routes (`/relay/post`, `/relay/drain`, ...) are appended to it. The M5
 * panel says this out loud rather than letting the CSP turn a cross-origin URL
 * into a mystery failure.
 *
 * Delivery through a relay this app can reach is for peers that are not on the
 * same browser and not on a WebRTC link; the CRDT is idempotent and presence
 * is gossip, so nothing here needs ordering guarantees from the node.
 */

const DEFAULT_WAIT_S = 15;
const SEEN_LIMIT = 4096;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Trim the trailing slash so `${url}${path}` never doubles it. */
const normalize = (url) => String(url).replace(/\/+$/, '');

export class RelayCarrier {
  /**
   * @param {object} options
   * @param {string}   options.peerId  this peer's routing id (same id the mesh uses)
   * @param {string[]} options.urls    relay base URLs (origins), most preferred
   *                                   first; `''` means this origin
   * @param {Function} options.seal    async (payload) => ({ header?, ct })
   * @param {Function} options.open    async ({ header?, ct }) => payload
   * @param {Function} [options.onFrame]  (payload, id, from) => void | Promise
   * @param {Function} [options.onStatus] called on every failover with `status()`
   * @param {Function} [options.fetchImpl] injectable for tests; defaults to fetch
   * @param {number}   [options.wait]  long-poll seconds for drains
   */
  constructor(options) {
    if (!options || !options.peerId) throw new Error('RelayCarrier needs a peerId');
    if (typeof options.seal !== 'function' || typeof options.open !== 'function') {
      throw new Error('RelayCarrier needs seal() and open() functions');
    }
    // A base URL is an origin (`http://127.0.0.1:8890`, or `''` for this
    // origin) and the node's own routes are appended to it. Keep the empty
    // string: `filter(Boolean)` here once silently turned "this origin" back
    // into the literal path `/relay`, and every request became
    // `/relay/relay/...` - the end-to-end run in tools/relay-e2e.js is what
    // caught it, so this line is load-bearing.
    const urls = (Array.isArray(options.urls) ? options.urls : [options.urls])
      .filter((u) => u !== undefined && u !== null)
      .map(normalize);
    this.peerId = options.peerId;
    this.urls = urls.length ? urls : [''];
    this.activeIndex = 0;
    this.seal = options.seal;
    this.open = options.open;
    this.onFrame = options.onFrame || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.fetchImpl = options.fetchImpl || ((...callArgs) => globalThis.fetch(...callArgs));
    this.wait = Number.isFinite(options.wait) ? options.wait : DEFAULT_WAIT_S;
    this.outbox = new Map(); // frame id -> { id, wire, attempts, state, error }
    this.seen = new Set(); // frame ids already delivered to onFrame
    this.nextId = 1;
    this.stopped = true;
    this.started = false;
    this.drainTask = null;
    this.flushing = null;
    this.stats = {
      posted: 0,
      acked: 0,
      reposted: 0,
      received: 0,
      duplicates: 0,
      undecryptable: 0,
      failovers: 0,
      outboxStuck: 0,
      lastError: null,
    };
  }

  /** Start draining. The carrier is usable without this, but it will not receive. */
  start() {
    if (this.started) return this;
    this.started = true;
    this.stopped = false;
    this.drainTask = this.drainLoop();
    this.onStatus(this.status());
    return this;
  }

  stop() {
    this.stopped = true;
    this.started = false;
    return this;
  }

  get activeUrl() {
    return this.urls[this.activeIndex];
  }

  status() {
    return {
      activeUrl: this.activeUrl,
      urls: [...this.urls],
      failovers: this.stats.failovers,
      outbox: this.outbox.size,
      started: this.started,
      lastError: this.stats.lastError,
    };
  }

  /** The active node's own counters, straight from `GET /relay/stats`. */
  async nodeStats() {
    const res = await this._fetchJson('GET', '/relay/stats', null, 8000);
    return res.status === 200 ? res.json : null;
  }

  /**
   * Seal one payload and post it to `to` ('*' to the whole room). Resolves to
   * `{ id, delivered, queued, error? }`: transient failures stay queued for a
   * later `flush()` or `post()`, while terminal protocol rejections are removed
   * and reported as undelivered. Presence gossip degrades rather than throwing.
   */
  async post(to, payload) {
    const id = `${this.peerId}#${this.nextId}`;
    this.nextId += 1;
    const frame = await this.seal({ id, payload });
    const wire = { to, from: this.peerId, ct: frame.ct };
    if (frame.header !== undefined) wire.header = frame.header;
    // Keep the outcome on this reference: removal alone is not acknowledgement,
    // and a shared flush can acknowledge one entry while rejecting another.
    const entry = { id, wire, attempts: 1, state: 'queued', error: null };
    this.outbox.set(id, entry);
    this.stats.posted += 1;
    const result = await this.flush();
    if (entry.state === 'acked') return { id, delivered: true, queued: false };
    const queued = this.outbox.has(id);
    if (queued) this.stats.outboxStuck += 1;
    return { id, delivered: false, queued, error: entry.error || result.error || this.stats.lastError };
  }

  /** Post everything still queued through the active node, rotating on failure. */
  flush() {
    if (!this.flushing) {
      this.flushing = this._flushOutbox().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  async _flushOutbox() {
    let error = null;
    let rejectionError = null;
    for (let rotation = 0; rotation <= this.urls.length; rotation += 1) {
      if (rotation > 0) this._rotate();
      let transportDown = false;
      for (const entry of [...this.outbox.values()]) {
        let res;
        try {
          res = await this._fetchJson('POST', '/relay/post', entry.wire);
        } catch (err) {
          transportDown = true;
          error = String((err && err.message) || err);
          entry.error = error;
          this.stats.lastError = error;
          break;
        }
        if (res.status === 200 && res.json && res.json.ok) {
          entry.state = 'acked';
          entry.error = null;
          this.outbox.delete(entry.id);
          this.stats.acked += 1;
          if (entry.attempts > 1) this.stats.reposted += 1;
          continue;
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          // A protocol error is not a node problem: another node would reject
          // the same bytes. Drop it and say so; never retry into a loop.
          entry.state = 'rejected';
          this.outbox.delete(entry.id);
          error = `node rejected the envelope: ${res.status} ${(res.json && res.json.error) || ''}`.trim();
          entry.error = error;
          rejectionError = error;
          this.stats.lastError = error;
          continue;
        }
        // Backpressure (429), like transport/5xx failures, keeps the entry for
        // bounded failover here and a later flush if the retry budget runs out.
        transportDown = true;
        error = `node answered ${res.status}`;
        entry.error = error;
        this.stats.lastError = error;
        break;
      }
      if (this.outbox.size === 0) return rejectionError ? { ok: false, error: rejectionError } : { ok: true };
      if (!transportDown) return { ok: false, error: error || 'post did not complete' };
    }
    return { ok: false, error: error || 'no relay node answered' };
  }

  _rotate() {
    this.activeIndex = (this.activeIndex + 1) % this.urls.length;
    this.stats.failovers += 1;
    for (const entry of this.outbox.values()) entry.attempts += 1;
    this.onStatus(this.status());
  }

  async drainLoop() {
    while (!this.stopped) {
      let res;
      try {
        res = await this._fetchJson('GET', `/relay/drain?peer=${encodeURIComponent(this.peerId)}&wait=${this.wait}`, null, (this.wait + 10) * 1000);
      } catch (err) {
        if (this.stopped) return;
        this.stats.lastError = String((err && err.message) || err);
        await sleep(200);
        continue;
      }
      if (!res || res.status !== 200 || !res.json || !res.json.ok || !Array.isArray(res.json.envelopes)) {
        await sleep(200);
        continue;
      }
      for (const wire of res.json.envelopes) await this._receive(wire);
      if (this.outbox.size) await this.flush();
    }
  }

  async _receive(wire) {
    this.stats.received += 1;
    let frame;
    try {
      frame = await this.open(wire);
    } catch {
      this.stats.undecryptable += 1;
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.id !== 'string') {
      this.stats.undecryptable += 1;
      return;
    }
    if (this.seen.has(frame.id)) {
      this.stats.duplicates += 1;
      return;
    }
    this.seen.add(frame.id);
    // Bounded, oldest-out: the set only exists to absorb re-posts closes to
    // the failover window, not to remember every frame forever.
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values();
      for (let i = 0; i < SEEN_LIMIT / 2; i += 1) this.seen.delete(oldest.next().value);
    }
    try {
      await this.onFrame(frame.payload, frame.id, wire.from);
    } catch (err) {
      console.error('[relay] frame handler failed', err);
    }
  }

  async _fetchJson(method, path, body, timeoutMs = 20000) {
    const url = `${this.activeUrl}${path}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller ? controller.signal : undefined,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* a non-JSON error page is reported by status alone */
      }
      return { status: res.status, json };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
