/**
 * M5 - Peer-to-peer mesh: presence, liveness and the ciphertext-only relay.
 *
 * This class owns everything that does not depend on how bytes travel: the room
 * model, presence, heartbeat/pruning, the untrusted-relay contract and recovery
 * when a carrier drops. Three carriers can feed it at once:
 *
 *   - BroadcastChannel (always on): real multi-peer collaboration between tabs
 *     of the same browser, with zero servers and zero configuration.
 *   - WebRTC data channels (src/collab/webrtc.js, attached with attachRtc): real
 *     connections between different machines over the network, signaled by a
 *     copy-pasted invite/answer code rather than a signaling server.
 *   - The HTTP relay carrier (src/collab/relay.js, attached with attachRelay):
 *     store-and-forward through tools/relay.js, sealed with a room key, for
 *     peers that share neither a browser nor a direct link. It survives a node
 *     death: on failure the carrier rotates to the next node in its list and
 *     re-posts its outbox.
 *
 * All carriers deliver the same envelope shape into `_receive`, so presence,
 * the relay and the UI path are identical whichever one a peer arrived on, and
 * the peer list says which one it was.
 */

import { RateLimiter } from '../security/policy.js';

const HEARTBEAT_MS = 4000;
const PEER_TTL_MS = 12000;

/** Presence chatter, which may be throttled. Document ops never are. */
const THROTTLEABLE = new Set(['hello', 'welcome', 'beat', 'bye', 'ping', 'cursor']);

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
    this.stats = { sent: 0, received: 0, dropped: 0, bytesOut: 0, bytesIn: 0, throttled: 0 };
    /** M8: per-peer flood control for presence traffic (see RateLimiter). */
    this.limiter = new RateLimiter({ rate: 40, burst: 80 });
  }

  start() {
    if (!('BroadcastChannel' in globalThis)) {
      this.available = false;
      this.rtc = null;
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
    const envelope = { kind, from: this.id, at: Date.now(), payload };
    if (this.channel) {
      try {
        this.channel.postMessage(envelope);
        this.stats.sent += 1;
        this.stats.bytesOut += estimateBytes(envelope);
      } catch (err) {
        this.stats.dropped += 1;
        console.warn('[mesh] broadcast send failed', err);
      }
    }
    if (this.rtc) {
      const delivered = this.rtc.send(kind, payload);
      if (delivered) {
        this.stats.sent += 1;
        this.stats.bytesOut += estimateBytes(envelope);
        this.stats.rtcSent = (this.stats.rtcSent || 0) + delivered;
      }
    }
    if (this.relay) {
      // Fire-and-forget: presence is gossip, and the carrier's own outbox +
      // failover is what keeps a later document op from being dropped.
      this.relay
        .post('*', envelope)
        .then((result) => {
          if (result.delivered) {
            this.stats.sent += 1;
            this.stats.bytesOut += estimateBytes(envelope);
            this.stats.relaySent = (this.stats.relaySent || 0) + 1;
          }
        })
        .catch(() => {
          this.stats.dropped += 1;
        });
    }
  }

  /**
   * Add the WebRTC carrier. Its inbound envelopes are routed through exactly the
   * same handler as the tab carrier, so nothing else in the mesh changes.
   */
  attachRtc(rtc) {
    this.rtc = rtc;
    this.rtc.onEnvelope = (envelope) => this._receive(envelope, 'webrtc');
    // Say hello down any link that is already open, and let peers know we moved.
    this._send('hello', { name: this.name, color: this.color });
    return this;
  }

  detachRtc() {
    if (this.rtc) this.rtc.close();
    this.rtc = null;
  }

  /**
   * Add the HTTP relay carrier. Frames arrive through the same handler as the
   * tab and WebRTC carriers - the transport label is the only difference - and
   * anything the carrier has not yet acknowledged is re-posted by the carrier
   * itself when a node fails.
   */
  attachRelay(carrier) {
    this.relay = carrier;
    carrier.onFrame = (payload) => this._receive(payload, 'relay');
    // Announce on the new transport immediately; presence converges on both.
    this._send('hello', { name: this.name, color: this.color });
    return this;
  }

  detachRelay() {
    if (this.relay) this.relay.stop();
    this.relay = null;
  }

  /** Broadcast a message to every peer in the room. */
  send(kind, payload) {
    this._send(kind, payload);
  }

  _receive(envelope, via = 'tab') {
    if (!envelope || typeof envelope !== 'object') return;
    if (envelope.from === this.id) return;
    this.stats.received += 1;
    this.stats.bytesIn += estimateBytes(envelope);

    // Flood control, presence only. A throttled message is counted and dropped;
    // an `ops` or `sync-*` message is never subject to this, because dropping
    // one would lose a character rather than save a frame.
    if (THROTTLEABLE.has(envelope.kind) && !this.limiter.allow(envelope.from)) {
      this.stats.throttled += 1;
      return;
    }

    const peer = this.peerMap.get(envelope.from) || {
      id: envelope.from,
      joinedAt: Date.now(),
      color: COLORS[Math.abs(hash(envelope.from)) % COLORS.length],
    };
    // A peer can be reachable over both carriers at once (two tabs of the same
    // browser that have also paired over WebRTC). Track every carrier seen and
    // report the strongest one, rather than letting the last packet win.
    if (!peer.transports) peer.transports = new Set();
    peer.transports.add(via);
    peer.transport = peer.transports.has('webrtc') ? 'webrtc' : via;
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
      this.limiter.forget(envelope.from);
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
      { id: this.id, name: this.name, color: this.color, self: true, transport: 'local', lastSeen: Date.now() },
      ...[...this.peerMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ];
  }

  close() {
    this._send('bye', {});
    for (const handle of this.timers) clearInterval(handle);
    this.timers = [];
    if (this.channel) this.channel.close();
    this.channel = null;
    if (this.rtc) this.rtc.close();
    if (this.relay) this.relay.stop();
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
