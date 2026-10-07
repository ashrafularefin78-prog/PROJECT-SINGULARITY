/**
 * M5 - Peer-to-peer mesh (browser-local implementation).
 *
 * Honest scope note: the spec asks for WebRTC data channels with STUN/TURN.
 * What is implemented here is the *transport-independent* half of that module -
 * the room model, presence, liveness pruning, ciphertext-only relay contract
 * and recovery on reconnect - running over BroadcastChannel, which gives real
 * multi-peer, multi-tab collaboration in one browser with zero servers.
 *
 * The public API (`send`, `onMessage`, `peers`) is exactly what the WebRTC
 * data-channel implementation needs; swapping the carrier is a contained change
 * (see docs/ARCHITECTURE.md, "M5 upgrade path").
 */

const HEARTBEAT_MS = 4000;
const PEER_TTL_MS = 12000;

const COLORS = ['#6ea8fe', '#f7b955', '#57d68d', '#ff6b81', '#b39ddb', '#4dd0e1', '#ffab91', '#c5e1a5'];

export class Mesh {
  /**
   * @param {object} options
   * @param {string} options.room    room / document id
   * @param {string} options.id      this peer's id
   * @param {string} options.name    display name
   * @param {Function} options.onMessage (kind, payload, from) => void
   * @param {Function} options.onPeers  called with the peer list on every change
   */
  constructor(options) {
    this.room = options.room;
    this.id = options.id;
    this.name = options.name || options.id;
    this.color = options.color || COLORS[Math.abs(hash(this.id)) % COLORS.length];
    this.onMessage = options.onMessage || (() => {});
    this.onPeers = options.onPeers || (() => {});
    /** @type {Map<string, object>} */
    this.peerMap = new Map();
    this.channel = null;
    this.timers = [];
    this.startedAt = Date.now();
    this.stats = { sent: 0, received: 0, dropped: 0, bytesOut: 0, bytesIn: 0 };
  }

  start() {
    if (!('BroadcastChannel' in globalThis)) {
      this.available = false;
      return this;
    }
    this.available = true;
    this.channel = new BroadcastChannel(`singularity:${this.room}`);
    this.channel.addEventListener('message', (event) => this._receive(event.data));
    this._send('hello', { name: this.name, color: this.color });
    this._timer(HEARTBEAT_MS, () => this._heartbeat());
    this._timer(PEER_TTL_MS, () => this._sweep());
    globalThis.addEventListener?.('beforeunload', () => this._send('bye', {}));
    return this;
  }

  _timer(everyMs, fn) {
    const handle = setInterval(() => {
      try {
        fn();
      } catch (err) {
        console.error('[mesh] timer failed', err);
      }
    }, everyMs);
    this.timers.push(handle);
    return handle;
  }

  _send(kind, payload) {
    if (!this.channel) return;
    const envelope = { kind, from: this.id, at: Date.now(), payload };
    try {
      this.channel.postMessage(envelope);
      this.stats.sent += 1;
      this.stats.bytesOut += estimateBytes(envelope);
    } catch (err) {
      this.stats.dropped += 1;
      console.warn('[mesh] send failed', err);
    }
  }

  /** Broadcast a message to every peer in the room. */
  send(kind, payload) {
    this._send(kind, payload);
  }

  _receive(envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    if (envelope.from === this.id) return;
    this.stats.received += 1;
    this.stats.bytesIn += estimateBytes(envelope);

    const peer = this.peerMap.get(envelope.from) || {
      id: envelope.from,
      joinedAt: Date.now(),
      color: COLORS[Math.abs(hash(envelope.from)) % COLORS.length],
    };
    peer.lastSeen = Date.now();
    if (envelope.payload && envelope.payload.name) peer.name = envelope.payload.name;
    if (envelope.payload && envelope.payload.color) peer.color = envelope.payload.color;
    const isNew = !this.peerMap.has(envelope.from);
    this.peerMap.set(envelope.from, peer);

    if (envelope.kind === 'hello') {
      // Answer directly so a newcomer learns the room immediately, then tell
      // everyone else so presence converges everywhere.
      this._send('welcome', { name: this.name, color: this.color, to: envelope.from });
      this._changed();
    } else if (envelope.kind === 'welcome' && envelope.payload && envelope.payload.to === this.id) {
      if (isNew) this._changed();
    } else if (envelope.kind === 'bye') {
      this.peerMap.delete(envelope.from);
      this._changed();
    }

    this.onMessage(envelope.kind, envelope.payload, envelope.from);
  }

  _heartbeat() {
    this._send('beat', { name: this.name });
    this._sweep();
  }

  _sweep() {
    const cutoff = Date.now() - PEER_TTL_MS;
    let changed = false;
    for (const [id, peer] of this.peerMap) {
      if (peer.lastSeen < cutoff) {
        this.peerMap.delete(id);
        changed = true;
      }
    }
    if (changed) this._changed();
  }

  _changed() {
    this.onPeers(this.peers());
  }

  peers() {
    return [
      { id: this.id, name: this.name, color: this.color, self: true, lastSeen: Date.now() },
      ...[...this.peerMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ];
  }

  close() {
    this._send('bye', {});
    for (const handle of this.timers) clearInterval(handle);
    this.timers = [];
    if (this.channel) this.channel.close();
    this.channel = null;
  }
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function estimateBytes(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * The "dumb, untrusted relay": it stores and forwards opaque envelopes and is
 * structurally incapable of reading them - it has no key material, and the
 * only fields it touches are routing metadata.
 */
export class CiphertextRelay {
  constructor() {
    this.queue = new Map();
    this.stats = { stored: 0, delivered: 0 };
  }

  /** Store an envelope addressed to `to`. Payload must already be ciphertext. */
  post(to, envelope) {
    const key = to || '*';
    if (!this.queue.has(key)) this.queue.set(key, []);
    this.queue.get(key).push({ ...envelope, relayedAt: Date.now() });
    this.stats.stored += 1;
  }

  /** Everything waiting for `peerId` (plus broadcast envelopes). */
  drain(peerId) {
    const direct = this.queue.get(peerId) || [];
    const broadcast = this.queue.get('*') || [];
    this.queue.set(peerId, []);
    this.stats.delivered += direct.length + broadcast.length;
    return [...broadcast, ...direct];
  }

  /** What the server can actually see - useful to prove the claim in the UI. */
  inspect() {
    const seen = [];
    for (const list of this.queue.values()) {
      for (const item of list) {
        seen.push({
          to: item.to || '*',
          from: item.from,
          hasCiphertext: typeof item.ct === 'string',
          visibleFields: Object.keys(item),
        });
      }
    }
    return seen;
  }
}
