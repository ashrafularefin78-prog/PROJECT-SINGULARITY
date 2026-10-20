/**
 * M5 - WebRTC data channels with serverless (copy/paste) signaling.
 *
 * The mesh in mesh.js owns presence, liveness and the relay contract; this file
 * owns the one thing BroadcastChannel cannot do - a real peer connection
 * between two *separate* browsers, over the network, with no server involved
 * anywhere in the path.
 *
 * Signaling without a signaling server
 *   WebRTC needs the two ends to exchange an SDP session description. Normally
 *   a server brokers that. Here the description IS the message: the offerer
 *   produces a short code, hands it to the peer over any channel at all
 *   (chat, email, a QR code), and pastes the peer's answer code back. That is
 *   the whole protocol, and it is why this module needs no backend and no
 *   account.
 *
 *   Both sides wait for ICE gathering to finish before exporting the code, so
 *   every candidate travels inside the SDP and the exchange stays a single
 *   copy-paste in each direction instead of a stream of trickle messages.
 *
 * NAT traversal
 *   Host candidates alone connect peers on the same network. `iceServers` adds
 *   STUN (to discover a public reflexive candidate) and, if you supply one, TURN
 *   (to relay when both peers are behind symmetric NAT). Only STUN is listed by
 *   default; a TURN server is a policy decision and a bandwidth cost, so it is
 *   yours to add - see docs/ARCHITECTURE.md.
 */

const CODE_PREFIX = 'SNG1:';
const MAX_CODE_CHARS = 20000;
const CHANNEL_LABEL = 'singularity';
const GATHER_TIMEOUT_MS = 3000;

/** STUN only, and only for candidate discovery. Replace/extend via options. */
export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Validate a TURN configuration and return an RTCIceServer list.
 *
 * TURN is not bundled (it costs bandwidth and is a policy choice), but a room
 * that has one should be able to use it. URLs must really be TURN, and a
 * username without a credential is a configuration error rather than a silent
 * unauthenticated allocation attempt that fails minutes later during ICE.
 */
export function turnServers({ urls, username, credential } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  if (!list.length || !list.every((url) => typeof url === 'string' && /^turns?:/i.test(url.trim()))) {
    throw new Error('TURN urls must start with turn: or turns:');
  }
  if ((username == null) !== (credential == null)) {
    throw new Error('TURN username and credential must be provided together');
  }
  const entry = { urls: list.map((url) => url.trim()) };
  if (username != null) {
    entry.username = String(username);
    entry.credential = String(credential);
  }
  return [entry];
}

/** STUN first, then the optional TURN relays. */
export function iceServersWithTurn(turn) {
  return turn ? [...DEFAULT_ICE_SERVERS, ...turnServers(turn)] : DEFAULT_ICE_SERVERS;
}

const toB64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

// A pasted code must be exactly what the other side generated. `atob` will
// happily decode unpadded or truncated input, so the shape is checked first and
// anything else is reported as an unreadable code instead of being guessed at.
const STRICT_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const fromB64 = (b64) => {
  if (!STRICT_B64.test(b64)) throw new Error('not canonical base64');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

/** A session description as a copy-pasteable string. */
export function encodeSignal(kind, sdp) {
  return CODE_PREFIX + toB64(JSON.stringify({ v: 1, kind, sdp }));
}

/**
 * Parse a code someone pasted in. Everything here is untrusted input, so the
 * shape is validated before any of it reaches a peer connection.
 */
export function decodeSignal(code) {
  const raw = String(code || '').trim().replace(/\s+/g, '');
  if (!raw) throw new Error('no code pasted');
  if (!raw.startsWith(CODE_PREFIX)) throw new Error(`a signaling code starts with ${CODE_PREFIX}`);
  if (raw.length > MAX_CODE_CHARS) throw new Error('that code is far too long to be a session description');
  let parsed;
  try {
    parsed = JSON.parse(fromB64(raw.slice(CODE_PREFIX.length)));
  } catch {
    throw new Error('that code is not readable - copy the whole thing, including the SNG1: prefix');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('a signaling code must decode to an object');
  if (parsed.v !== 1) throw new Error(`unsupported signaling version ${parsed.v}`);
  if (parsed.kind !== 'offer' && parsed.kind !== 'answer') throw new Error(`unknown signaling kind '${parsed.kind}'`);
  if (typeof parsed.sdp !== 'string' || !parsed.sdp.includes('v=0')) throw new Error('that code carries no session description');
  return { kind: parsed.kind, sdp: parsed.sdp };
}

/** The ICE username fragment uniquely identifies one of our own connections. */
const ufragOf = (sdp) => (/a=ice-ufrag:(\S+)/.exec(String(sdp)) || [])[1] || null;

const waitForIce = (pc) =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Bounded: some NATs never report "complete", and a code with host
    // candidates is still worth trying rather than hanging the UI forever.
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, GATHER_TIMEOUT_MS);
  });

let linkSeq = 0;

/** One direct connection to one peer. */
class Link {
  constructor(carrier, pc, label) {
    this.carrier = carrier;
    this.pc = pc;
    this.label = label;
    this.channel = null;
    this.state = 'new';
    this.openedAt = null;
    this._restartTimer = null;

    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      if (s === 'failed') {
        clearTimeout(this._restartTimer);
        carrier._note(`${label}: ICE failed - both peers may be behind symmetric NAT (a TURN server is required)`, 'bad');
        this.state = 'failed';
        carrier.onClose(this);
      } else if (s === 'disconnected') {
        carrier._note(`${label}: connection interrupted, ICE restart in 2 s…`, 'warn');
        // ICE restart: a new offer with iceRestart:true re-gathers candidates
        // without tearing down the data channel, so messages already buffered
        // in the channel are not lost.  The remote peer must accept the new SDP
        // via the out-of-band signaling path the user already used; we emit the
        // new code into the carrier's state log so the user can copy-paste it.
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(async () => {
          if (pc.iceConnectionState !== 'disconnected') return;
          try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            await waitForIce(pc);
            const code = encodeSignal('offer', pc.localDescription.sdp);
            carrier._note(`${label}: ICE restart code ready — paste it to the remote peer and apply their answer`, 'ok');
            carrier.lastRestartCode = code;
          } catch (err) {
            carrier._note(`${label}: ICE restart failed (${err.message})`, 'bad');
          }
        }, 2000);
      } else if (s === 'connected' || s === 'completed') {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
    });
  }

  attach(channel) {
    this.channel = channel;
    channel.addEventListener('open', () => {
      this.state = 'open';
      this.openedAt = Date.now();
      this.carrier._note(`${this.label}: data channel open`, 'ok');
      this.carrier.onOpen(this);
    });
    channel.addEventListener('message', (event) => {
      let envelope = null;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        this.carrier.stats.dropped += 1;
        return;
      }
      this.carrier.receive(envelope, this);
    });
    channel.addEventListener('close', () => {
      this.state = 'closed';
      this.carrier._note(`${this.label}: channel closed`, 'warn');
      this.carrier.onClose(this);
    });
  }

  send(envelope) {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    try {
      this.channel.send(JSON.stringify(envelope));
      this.carrier.stats.sent += 1;
      return true;
    } catch {
      this.carrier.stats.dropped += 1;
      return false;
    }
  }

  close() {
    try {
      if (this.channel) this.channel.close();
    } catch {
      /* already gone */
    }
    try {
      this.pc.close();
    } catch {
      /* already gone */
    }
  }
}

export class RtcCarrier {
  /**
   * @param {object} options
   * @param {string} options.id            our peer id (rides on every envelope)
   * @param {string} options.name          display name
   * @param {Function} options.onEnvelope  called with each received envelope
   * @param {Function} options.onState     called with human-readable log lines
   * @param {Array}    options.iceServers  STUN/TURN list
   */
  constructor(options = {}) {
    this.id = options.id || 'peer';
    this.name = options.name || this.id;
    this.onEnvelope = options.onEnvelope || (() => {});
    this.onState = options.onState || (() => {});
    this.iceServers = options.iceServers === null
      ? []
      : options.iceServers
        ? options.iceServers
        : iceServersWithTurn(options.turn);
    /** @type {Map<string, Link>} */
    this.links = new Map();
    /** PCs whose data channel has not arrived yet (the answering side). */
    this.pending = new Map();
    /** ufrags of codes this page produced, to catch a paste into the wrong end. */
    this.ownUfrags = new Set();
    this.stats = { sent: 0, received: 0, dropped: 0, bytesOut: 0, bytesIn: 0, links: 0 };
    this.lastError = null;
    /** Set by an ICE restart; contains the new offer code to send to the peer. */
    this.lastRestartCode = null;
  }

  static supported() {
    return typeof globalThis.RTCPeerConnection === 'function';
  }

  _note(text, tone = 'dim') {
    this.onState({ text, tone, at: Date.now() });
  }

  _pc() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc.addEventListener('datachannel', (event) => {
      // Adopt the placeholder created by acceptInvite if there is one, so the
      // answering side counts exactly one link per connection - not one empty
      // placeholder plus the real channel.
      const held = this.pending.get(pc);
      if (held) this.pending.delete(pc);
      const link = held || new Link(this, pc, 'incoming');
      this._index(link);
      link.attach(event.channel);
    });
    return pc;
  }

  _index(link) {
    link.key = `link-${(linkSeq += 1)}`;
    this.links.set(link.key, link);
    this.stats.links = this.links.size;
  }

  onOpen(link) {
    // Announce ourselves down the new link; presence then converges through the
    // exact same handlers the BroadcastChannel carrier uses.
    link.send({ kind: 'hello', from: this.id, at: Date.now(), payload: { name: this.name } });
    const peerIds = [...this.links.values()].filter((l) => l.state === 'open').length;
    this._note(`${peerIds} WebRTC link${peerIds === 1 ? '' : 's'} open`, 'ok');
  }

  onClose(link) {
    for (const [key, l] of this.links) if (l === link) this.links.delete(key);
    this.stats.links = this.links.size;
  }

  receive(envelope, link) {
    if (!envelope || typeof envelope !== 'object') return;
    if (envelope.from === this.id) return;
    this.stats.received += 1;
    this.stats.bytesIn += JSON.stringify(envelope).length;
    if (link && envelope.from) link.peer = envelope.from;
    this.onEnvelope(envelope);
  }

  /** Fan an envelope out to every open data channel. */
  send(kind, payload) {
    const envelope = { kind, from: this.id, at: Date.now(), payload };
    const text = JSON.stringify(envelope);
    let delivered = 0;
    for (const link of this.links.values()) if (link.send(envelope)) delivered += 1;
    if (delivered) this.stats.bytesOut += text.length * delivered;
    return delivered;
  }

  /**
   * Step 1 (the peer who starts): produce the invite code to hand over.
   * The data channel is created here, so the opener owns it.
   */
  async createInvite() {
    if (!RtcCarrier.supported()) throw new Error('this browser has no RTCPeerConnection');
    const pc = this._pc();
    const link = new Link(this, pc, 'outgoing');
    this._index(link);
    link.attach(pc.createDataChannel(CHANNEL_LABEL, { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);
    this.ownUfrags.add(ufragOf(pc.localDescription.sdp));
    this._note('invite code ready - send it to your peer', 'ok');
    return encodeSignal('offer', pc.localDescription.sdp);
  }

  /**
   * Step 2 (the peer who was invited): turn an invite code into an answer code.
   * One connection per invite is tracked, so several peers can be invited.
   */
  async acceptInvite(code) {
    if (!RtcCarrier.supported()) throw new Error('this browser has no RTCPeerConnection');
    const signal = decodeSignal(code);
    if (signal.kind !== 'offer') throw new Error('that is an answer code - paste it on the other side');
    this._rejectOwnCode(signal);
    const pc = this._pc();
    // Held, not indexed: the link becomes real when the data channel arrives.
    this.pending.set(pc, new Link(this, pc, 'incoming'));
    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);
    this.ownUfrags.add(ufragOf(pc.localDescription.sdp));
    this._note('answer code ready - paste it back to the inviter', 'ok');
    return encodeSignal('answer', pc.localDescription.sdp);
  }

  /** Step 3 (the peer who started): consume the answer code and connect. */
  async acceptAnswer(code) {
    const signal = decodeSignal(code);
    if (signal.kind !== 'answer') throw new Error('that is an invite code - it belongs on the other side');
    this._rejectOwnCode(signal);
    const pending = [...this.links.values()].find((l) => l.pc.currentRemoteDescription === null && l.pc.signalingState === 'have-local-offer');
    if (!pending) throw new Error('there is no invite waiting for an answer - create one first');
    await pending.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    this._note('answer applied - connecting…');
    return pending;
  }

  /**
   * Refuse a code this page just produced. It is the one copy-paste mistake the
   * protocol cannot otherwise detect, and without this check it fails later as a
   * confusing ICE timeout instead of an immediate, actionable message.
   */
  _rejectOwnCode(signal) {
    const frag = ufragOf(signal.sdp);
    if (frag && this.ownUfrags.has(frag)) {
      throw new Error('that code was created by this page - paste it into the other browser');
    }
  }

  channels() {
    return [...this.links.values()].filter((l) => l.state === 'open' && l.peer).map((l) => l.peer);
  }

  /**
   * Apply the answer to an ICE restart offer.  After a `disconnected` event the
   * carrier emits a new offer code via `lastRestartCode`.  The remote peer pastes
   * it through `acceptInvite` as if it were a fresh invite, pastes the answer
   * back, and the local side calls this method with that answer code to complete
   * the restart without tearing down the data channel.
   */
  async acceptRestartAnswer(code) {
    const signal = decodeSignal(code);
    if (signal.kind !== 'answer') throw new Error('that is an invite code - paste it on the other side');
    this._rejectOwnCode(signal);
    // Find the link whose PC is in have-local-offer state following the restart.
    const link = [...this.links.values()].find(
      (l) => l.pc.signalingState === 'have-local-offer' || l.pc.iceConnectionState === 'disconnected',
    );
    if (!link) throw new Error('no ICE restart is pending - create one first with a disconnected link');
    await link.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    this.lastRestartCode = null;
    this._note('ICE restart answer applied - reconnecting…', 'ok');
  }

  close() {
    for (const link of this.links.values()) link.close();
    for (const link of this.pending.values()) link.close();
    this.links.clear();
    this.pending.clear();
    this.stats.links = 0;
  }
}
