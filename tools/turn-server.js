/**
 * A reference TURN relay (RFC 5389 / 5766 / 8489 subset) for local evidence.
 *
 *   node tools/turn-server.js --port=3478 --user=demo --pass=secret
 *
 * Why this exists: the app has always shipped the TURN *client* path
 * (`turnServers()` in src/collab/webrtc.js, the three fields in the M5 panel)
 * and has always said plainly that no relay is bundled. That left the
 * symmetric-NAT claim untested - there was nothing on loopback to point a
 * relay-only session at. This is that something: a dependency-free relay a test
 * can start in-process.
 *
 * Implemented: Binding, Allocate, Refresh, CreatePermission, ChannelBind, Send,
 * Data; the long-term credential mechanism (401 challenge with NONCE+REALM, 438
 * for a nonce outside the window); MESSAGE-INTEGRITY (HMAC-SHA1 over the header
 * through the attribute, key = MD5(user:realm:pass)) and FINGERPRINT (CRC32 ^
 * 0x536f6674); IPv4/UDP allocations with EVEN-PORT and RESERVATION; permissions
 * keyed by peer IP; channel bindings; padded ChannelData both ways.
 *
 * Deliberately not: a production relay. No TLS (turns:/stuns:), no per-realm
 * quota, no ALTERNATE-SERVER, no IPv6, no bandwidth limits, and it binds
 * loopback unless told otherwise. Four deviations are worth naming rather than
 * hiding: replies leave from the socket that received their request, so a
 * client hears back from the address it spoke to; permission and channel
 * bindings live as long as the allocation instead of expiring after the RFC's 5
 * and 10 minutes; two allocations sharing one 5-tuple are told apart by an
 * XOR-RELAY-ADDRESS in the request and otherwise resolve to the most recent
 * (a real client never hits this, because rtcp-mux means one allocation per
 * peer connection); and the reserved port is simply the allocated even port + 1.
 */
import { createSocket } from 'node:dgram';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cdp.js';

const COOKIE = 0x2112a442;
const FINGERPRINT_XOR = 0x536f6674;
const UDP_TRANSPORT = 17;
const MAX_LIFETIME = 3600;
const DEFAULT_LIFETIME = 600;
const NONCE_WINDOW_MS = 120000;

// Classes sit in bits 4 and 8, which is why success and error are 0x0100/0x0110
// and an indication 0x0010. Every method here fits in the low nibble, so
// masking the type that way is enough to read a request back.
export const CLASS = { request: 0x0000, indication: 0x0010, success: 0x0100, error: 0x0110 };
export const METHOD = {
  binding: 0x0001, allocate: 0x0003, refresh: 0x0004, send: 0x0006,
  data: 0x0007, createPermission: 0x0008, channelBind: 0x0009,
};
const METHOD_NAMES = new Map(Object.entries(METHOD).map(([name, value]) => [value, name]));
export const ATTR = {
  username: 0x0006, messageIntegrity: 0x0008, errorCode: 0x0009, channelNumber: 0x000c,
  lifetime: 0x000d, reserved: 0x000e, xorPeerAddress: 0x0012, data: 0x0013, realm: 0x0014,
  nonce: 0x0015, xorRelayAddress: 0x0016, requestedTransport: 0x0019, evenPort: 0x0022,
  xorMappedAddress: 0x0020, software: 0x8022, fingerprint: 0x8028, responseOrigin: 0x802b,
};
export const ERROR = {
  badRequest: 400, unauthorized: 401, forbidden: 403,
  allocateMismatch: 437, staleNonce: 438, peerUnavailable: 441,
  transportUnsupported: 442, relayPortExhausted: 446,
};
const ERROR_TEXT = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  437: 'Allocate Mismatch Between Request and Answer', 438: 'Stale Nonce',
  441: 'Peer Unavailable', 442: 'Transport Protocol Not Supported',
  446: 'Relay Port Exhaustion', 481: 'Transaction Does Not Exist', 500: 'Server Error',
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    table[i] = c;
  }
  return table;
})();

const crc32 = (bytes) => {
  let c = -1;
  for (const byte of bytes) c = (c >>> 8) ^ CRC_TABLE[(c ^ byte) & 0xff];
  return (c ^ -1) >>> 0;
};

const toUint32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
};

/** One attribute, padded to the four-byte boundary the length field counts. */
export const attr = (type, value) => {
  const pad = (4 - (value.length % 4)) % 4;
  const out = Buffer.alloc(4 + value.length + pad);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(value.length, 2);
  value.copy(out, 4);
  return out;
};

export const textAttr = (type, text) => attr(type, Buffer.from(String(text), 'utf8'));

const header = (type, length, transactionId) => {
  const out = Buffer.alloc(20);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(length, 2);
  out.writeUInt32BE(COOKIE, 4);
  Buffer.from(transactionId, 'hex').copy(out, 8);
  return out;
};

/** IPv4 XOR-MAPPED/XOR-PEER/XOR-RELAY encoding, port and address both masked. */
export const xorAddress = (type, ip, port) => {
  const value = Buffer.alloc(8);
  value[1] = 0x01;
  value.writeUInt16BE(port ^ (COOKIE >> 16), 2);
  const packed = ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  value.writeUInt32BE(packed ^ COOKIE, 4);
  return attr(type, value);
};

const readAddress = (value) => {
  const port = value.readUInt16BE(2) ^ (COOKIE >> 16);
  const raw = value.readUInt32BE(4) ^ COOKIE;
  return { port, ip: [(raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join('.') };
};

// A STUN message always starts 0x00xx or 0x01xx for the types here; a channel
// number starts 0x40-0x4f. The first byte is therefore the whole demuxer.
const isChannelData = (packet) => packet.length >= 4 && packet[0] >= 0x40 && packet[0] <= 0x4f;

/** The four-byte ChannelData frame, padded so the payload stays aligned. */
export function encodeChannelData(channel, payload) {
  const frame = Buffer.alloc(4 + payload.length + ((4 - (payload.length % 4)) % 4));
  frame.writeUInt16BE(channel, 0);
  frame.writeUInt16BE(payload.length, 2);
  payload.copy(frame, 4);
  return frame;
}

export function decodeChannelData(packet) {
  if (!isChannelData(packet)) return null;
  const length = packet.readUInt16BE(2);
  if (packet.length < 4 + length) return null;
  return { channel: packet.readUInt16BE(0), data: packet.subarray(4, 4 + length) };
}

/**
 * Parse a STUN message. Attributes repeat - a CreatePermission carries one
 * XOR-PEER-ADDRESS per peer - so `values` keeps every value per name and the
 * scalar fields read the first. MESSAGE-INTEGRITY covers the header, with its
 * length field rewritten to end at that attribute, through the attribute
 * header; FINGERPRINT covers everything before it with a length that already
 * includes itself. A server looks the key up from USERNAME (`users`), while a
 * client verifying a response passes `key` directly, because responses carry no
 * USERNAME to look one up by.
 */
export function decodeMessage(packet, { users, realm, key } = {}) {
  if (packet.length < 20 || packet.readUInt32BE(4) !== COOKIE) return null;
  const type = packet.readUInt16BE(0);
  const length = packet.readUInt16BE(2);
  if (length % 4 || packet.length < 20 + length) return null;
  const transactionId = packet.subarray(8, 20).toString('hex');
  const values = new Map();
  const unknown = [];
  let integrityOffset = -1;
  for (let offset = 20; offset < 20 + length;) {
    const kind = packet.readUInt16BE(offset);
    const size = packet.readUInt16BE(offset + 2);
    const value = packet.subarray(offset + 4, offset + 4 + size);
    if (kind === ATTR.messageIntegrity) {
      integrityOffset = offset;
      values.set('messageIntegrity', [value]);
    } else if (kind === ATTR.fingerprint) {
      values.set('fingerprint', [value]);
    } else {
      const name = Object.keys(ATTR).find((key) => ATTR[key] === kind);
      if (name) values.set(name, [...(values.get(name) || []), value]);
      else unknown.push(kind);
    }
    offset += 4 + size + ((4 - (size % 4)) % 4);
  }

  const first = (name) => values.get(name)?.[0] || null;
  const text = (name) => (first(name) ? first(name).toString('utf8') : null);
  const username = text('username') || '';
  const account = username.split(':')[0];

  // RFC 5389 15.4: the hash covers the message up to but not including the
  // VALUE of MESSAGE-INTEGRITY, and the length field carries that same span -
  // the four-byte attribute header included, the twenty-byte STUN header not.
  let authentic = false;
  let integrityReason = null;
  if (integrityOffset >= 0) {
    const password = users?.[account];
    const signingKey = key
      || (password == null ? null : createHash('md5').update(`${account}:${realm}:${password}`).digest());
    if (!signingKey) integrityReason = 'unknown user';
    else {
      const through = integrityOffset + 4;
      const signed = Buffer.alloc(through);
      packet.copy(signed, 0, 0, through);
      signed.writeUInt16BE(integrityOffset - 16, 2);
      authentic = createHmac('sha1', signingKey).update(signed).digest().equals(first('messageIntegrity'));
      if (!authentic) integrityReason = 'message-integrity mismatch';
    }
  } else integrityReason = 'no message-integrity';

  if (values.has('fingerprint')) {
    const through = 20 + length - 8;
    const expected = (crc32(packet.subarray(0, through)) ^ FINGERPRINT_XOR) >>> 0;
    if (expected !== first('fingerprint').readUInt32BE(0)) {
      authentic = false;
      integrityReason = 'bad fingerprint';
    }
  }

  return {
    type, class: type & 0x0110, method: type & 0x000f,
    methodText: METHOD_NAMES.get(type & 0x000f) || `0x${type.toString(16)}`,
    transactionId, values, unknown, username, account, authentic, integrityReason,
    hasIntegrity: integrityOffset >= 0,
    realm: text('realm'), nonce: text('nonce'), software: text('software'),
    lifetime: first('lifetime') ? first('lifetime').readUInt32BE(0) : null,
    channel: first('channelNumber') ? first('channelNumber').readUInt16BE(0) : null,
    peers: (values.get('xorPeerAddress') || []).map(readAddress),
    peer: first('xorPeerAddress') ? readAddress(first('xorPeerAddress')) : null,
    relay: first('xorRelayAddress') ? readAddress(first('xorRelayAddress')) : null,
    mapped: first('xorMappedAddress') ? readAddress(first('xorMappedAddress')) : null,
    errorCode: first('errorCode') ? first('errorCode')[2] * 100 + first('errorCode')[3] : null,
    errorReason: first('errorCode') ? first('errorCode').subarray(4).toString('utf8') : null,
    transport: first('requestedTransport') ? first('requestedTransport')[0] : null,
    reservation: first('evenPort') ? first('evenPort')[0] : null,
    data: first('data'),
  };
}

/** Encode a response or indication; the two security attributes come last, in order. */
export function encodeMessage(type, transactionId, attributes, { integrityKey, fingerprint = true } = {}) {
  let body = Buffer.concat(attributes);
  if (integrityKey) {
    const attribute = Buffer.alloc(4);
    attribute.writeUInt16BE(ATTR.messageIntegrity, 0);
    attribute.writeUInt16BE(20, 2);
    const signed = Buffer.concat([header(type, body.length + 4, transactionId), body, attribute]);
    body = Buffer.concat([body, attr(ATTR.messageIntegrity, createHmac('sha1', integrityKey).update(signed).digest())]);
  }
  if (fingerprint) {
    const prefixed = Buffer.concat([header(type, body.length + 8, transactionId), body]);
    body = Buffer.concat([body, attr(ATTR.fingerprint, toUint32((crc32(prefixed) ^ FINGERPRINT_XOR) >>> 0))]);
  }
  return Buffer.concat([header(type, body.length, transactionId), body]);
}

export function createTurnServer(options = {}) {
  const realm = options.realm || 'singularity.local';
  const users = options.users || {};
  const relayIp = options.relayIp || '127.0.0.1';
  const minRelayPort = options.minRelayPort || 49152;
  const maxRelayPort = options.maxRelayPort || 49652;
  const software = options.software || 'singularity-turn/1';
  const onEvent = options.onEvent || (() => {});
  const counters = { forwarded: 0, forwardedBytes: 0, channelled: 0, indications: 0, dropped: 0, errors: 0 };

  const allocations = new Map();
  const reservedPorts = new Map();
  const nonces = new Map();
  let currentNonce = null;
  let nextRelayPort = minRelayPort;
  let server = null;
  let closed = false;

  const keyFor = (ip, port) => `${ip}:${port}`;
  const issueNonce = () => {
    currentNonce = randomBytes(16).toString('hex');
    nonces.set(currentNonce, Date.now() + NONCE_WINDOW_MS);
    for (const [value, expires] of nonces) if (expires < Date.now()) nonces.delete(value);
    return currentNonce;
  };
  const challengeNonce = () => (currentNonce && nonces.has(currentNonce) ? currentNonce : issueNonce());
  const integrityKeyFor = (account) => (users[account] == null
    ? null
    : createHash('md5').update(`${account}:${realm}:${users[account]}`).digest());

  function send(to, packet, port, ip) {
    if (closed || !to) return;
    try {
      to.send(packet, port, ip, () => {});
    } catch (error) {
      onEvent({ kind: 'send-failed', error: error.message, to: `${ip}:${port}` });
    }
  }

  function replyError(to, message, code, port, ip, extra) {
    const text = ERROR_TEXT[code] || 'Error';
    const reason = Buffer.alloc(4 + text.length);
    reason.writeUInt8(Math.floor(code / 100), 2);
    reason.writeUInt8(code % 100, 3);
    reason.write(text, 4);
    counters.errors += 1;
    const body = [
      attr(ATTR.errorCode, reason),
      textAttr(ATTR.realm, realm),
      textAttr(ATTR.nonce, code === ERROR.staleNonce ? issueNonce() : challengeNonce()),
      textAttr(ATTR.software, software),
      ...(extra || []),
    ];
    send(to, encodeMessage(CLASS.error | message.method, message.transactionId, body), port, ip);
    onEvent({ kind: 'error', code, method: message.methodText, from: `${ip}:${port}`, reason: text });
  }

  /**
   * The long-term credential gate. Returns the HMAC key for the success
   * response, or null after sending 401 (no integrity, unknown user, bad
   * integrity, wrong realm) or 438 (a nonce outside the window).
   */
  function authorized(to, message, port, ip) {
    if (!message.hasIntegrity || !users[message.account] || !message.authentic || !message.realm) {
      replyError(to, message, ERROR.unauthorized, port, ip);
      return null;
    }
    if (message.realm !== realm) {
      replyError(to, message, ERROR.unauthorized, port, ip);
      return null;
    }
    if (!nonces.has(message.nonce)) {
      replyError(to, message, ERROR.staleNonce, port, ip);
      return null;
    }
    return integrityKeyFor(message.account);
  }

  function succeed(to, message, attributes, key, port, ip) {
    send(to, encodeMessage(CLASS.success | message.method, message.transactionId,
      [...attributes, textAttr(ATTR.software, software), textAttr(ATTR.realm, realm), textAttr(ATTR.nonce, message.nonce)],
      { integrityKey: key }), port, ip);
  }

  function arm(allocation) {
    clearTimeout(allocation.timer);
    allocation.timer = setTimeout(() => expire(allocation, 'lifetime'), (allocation.lifetime + 30) * 1000);
  }

  function expire(allocation, reason) {
    clearTimeout(allocation.timer);
    const held = allocations.get(allocation.key) || [];
    const rest = held.filter((one) => one !== allocation);
    if (rest.length) allocations.set(allocation.key, rest);
    else allocations.delete(allocation.key);
    if (reservedPorts.get(allocation.key) === allocation.reservedPort) reservedPorts.delete(allocation.key);
    if (allocation.relay) {
      try { allocation.relay.close(); } catch { /* never bound, or already closed */ }
    }
    onEvent({ kind: 'expired', relayPort: allocation.relayPort, reason });
  }

  function allocationsFor(ip, port) {
    return allocations.get(keyFor(ip, port)) || [];
  }

  /** The allocation a request speaks about: named by relay address, else newest. */
  function pickAllocation(ip, port, message) {
    const list = allocationsFor(ip, port);
    if (!list.length) return null;
    if (message.relay) {
      const named = list.find((allocation) => allocation.relayPort === message.relay.port);
      if (named) return named;
    }
    return list[list.length - 1];
  }

  function openRelay(allocation, then) {
    const relay = createSocket('udp4');
    allocation.relay = relay;
    relay.on('message', (packet, rinfo) => onRelayPacket(allocation, packet, rinfo));
    relay.on('error', () => expire(allocation, 'socket error'));
    relay.bind(allocation.relayPort, relayIp, () => then());
  }

  function allocate(to, message, port, ip) {
    const key = authorized(to, message, port, ip);
    if (!key) return;
    if (message.transport !== UDP_TRANSPORT) {
      replyError(to, message, ERROR.transportUnsupported, port, ip);
      return;
    }
    const transportKey = keyFor(ip, port);
    const existing = (allocations.get(transportKey) || [])[0];
    const reserved = reservedPorts.get(transportKey);
    if (existing && (existing.account !== message.account || reserved == null)) {
      replyError(to, message, ERROR.allocateMismatch, port, ip);
      return;
    }
    const candidate = reserved == null
      ? (nextRelayPort % 2 ? nextRelayPort + 1 : nextRelayPort)
      : reserved;
    if (candidate > maxRelayPort) {
      replyError(to, message, ERROR.relayPortExhausted, port, ip);
      return;
    }
    const wantsReservation = message.reservation === 0x00;
    const allocation = {
      key: transportKey, account: message.account, clientIp: ip, clientPort: port,
      relayPort: candidate, relay: null, reservedPort: null,
      lifetime: message.lifetime == null ? DEFAULT_LIFETIME : Math.min(message.lifetime, MAX_LIFETIME),
      permissions: new Map(), channels: new Map(), channelByPeer: new Map(), timer: null,
    };
    openRelay(allocation, () => {
      if (closed || !allocation.relay) {
        replyError(to, message, ERROR.relayPortExhausted, port, ip);
        return;
      }
      nextRelayPort = candidate + 2;
      allocations.set(transportKey, [...(allocations.get(transportKey) || []), allocation]);
      reservedPorts.delete(transportKey);
      if (wantsReservation && candidate + 1 <= maxRelayPort) {
        allocation.reservedPort = candidate + 1;
        reservedPorts.set(transportKey, candidate + 1);
      }
      arm(allocation);
      const attributes = [
        xorAddress(ATTR.xorRelayAddress, relayIp, candidate),
        xorAddress(ATTR.xorMappedAddress, ip, port),
      ];
      if (wantsReservation) attributes.push(attr(ATTR.reserved, toUint32(allocation.reservedPort == null ? 0xffffffff : 0)));
      attributes.push(attr(ATTR.lifetime, toUint32(allocation.lifetime)), attr(ATTR.responseOrigin, Buffer.from('LF', 'utf8')));
      succeed(to, message, attributes, key, port, ip);
      onEvent({ kind: 'allocate', account: message.account, relayPort: candidate, reserved: allocation.reservedPort, from: transportKey });
    });
  }

  function refresh(to, message, port, ip) {
    const key = authorized(to, message, port, ip);
    if (!key) return;
    const allocation = pickAllocation(ip, port, message);
    // A refresh for an allocation that is already gone is a success with
    // lifetime 0: that is how the client learns it has to allocate again.
    if (!allocation) {
      succeed(to, message, [attr(ATTR.lifetime, toUint32(0))], key, port, ip);
      return;
    }
    allocation.lifetime = message.lifetime == null ? DEFAULT_LIFETIME : Math.min(message.lifetime, MAX_LIFETIME);
    if (allocation.lifetime === 0) {
      expire(allocation, 'client deallocation');
      succeed(to, message, [attr(ATTR.lifetime, toUint32(0))], key, port, ip);
      onEvent({ kind: 'deallocate', relayPort: allocation.relayPort, from: allocation.key });
      return;
    }
    arm(allocation);
    succeed(to, message, [attr(ATTR.lifetime, toUint32(allocation.lifetime))], key, port, ip);
    onEvent({ kind: 'refresh', relayPort: allocation.relayPort, lifetime: allocation.lifetime });
  }

  function createPermission(to, message, port, ip) {
    const key = authorized(to, message, port, ip);
    if (!key) return;
    const allocation = pickAllocation(ip, port, message);
    if (!allocation) {
      replyError(to, message, ERROR.allocateMismatch, port, ip);
      return;
    }
    if (!message.peers.length) {
      replyError(to, message, ERROR.badRequest, port, ip);
      return;
    }
    for (const peer of message.peers) allocation.permissions.set(peer.ip, Date.now());
    succeed(to, message, [], key, port, ip);
    onEvent({ kind: 'permission', added: message.peers.map((peer) => peer.ip), relayPort: allocation.relayPort });
  }

  function channelBind(to, message, port, ip) {
    const key = authorized(to, message, port, ip);
    if (!key) return;
    const allocation = pickAllocation(ip, port, message);
    if (!allocation) {
      replyError(to, message, ERROR.allocateMismatch, port, ip);
      return;
    }
    const peer = message.peer;
    if (!peer || message.channel < 0x4000 || message.channel > 0x7fff) {
      replyError(to, message, ERROR.badRequest, port, ip);
      return;
    }
    const held = allocation.channels.get(message.channel);
    if (held && `${held.ip}:${held.port}` !== `${peer.ip}:${peer.port}`) {
      replyError(to, message, ERROR.forbidden, port, ip);
      return;
    }
    const previous = allocation.channelByPeer.get(`${peer.ip}:${peer.port}`);
    if (previous != null && previous !== message.channel) allocation.channels.delete(previous);
    allocation.channels.set(message.channel, peer);
    allocation.channelByPeer.set(`${peer.ip}:${peer.port}`, message.channel);
    allocation.permissions.set(peer.ip, Date.now());
    succeed(to, message, [], key, port, ip);
    onEvent({ kind: 'channel-bind', channel: message.channel, peer: `${peer.ip}:${peer.port}`, relayPort: allocation.relayPort });
  }

  /** Client to peer. A permission for the peer IP is what makes this legal. */
  function forward(allocation, peer, payload, via) {
    if (!peer || !payload) return false;
    if (!allocation.permissions.has(peer.ip)) {
      counters.dropped += 1;
      onEvent({ kind: 'dropped', peer: `${peer.ip}:${peer.port}`, relayPort: allocation.relayPort, reason: 'no permission' });
      return false;
    }
    send(allocation.relay, payload, peer.port, peer.ip);
    counters.forwarded += 1;
    counters.forwardedBytes += payload.length;
    onEvent({ kind: 'forwarded', to: `${peer.ip}:${peer.port}`, bytes: payload.length, relayPort: allocation.relayPort, via });
    return true;
  }

  function sendIndication(message, port, ip) {
    const allocation = pickAllocation(ip, port, message);
    if (!allocation || !message.peer || !message.data) return;
    forward(allocation, message.peer, message.data, 'send-indication');
  }

  /**
   * Everything landing on a relay port: either the owning client using
   * ChannelData, or a peer whose payload has to be handed back - through the
   * bound channel if there is one, otherwise as a Data indication.
   */
  function onRelayPacket(allocation, packet, rinfo) {
    if (rinfo.address === allocation.clientIp && rinfo.port === allocation.clientPort) {
      const frame = decodeChannelData(packet);
      if (frame && forward(allocation, allocation.channels.get(frame.channel), frame.data, 'channel')) {
        counters.channelled += 1;
        onEvent({ kind: 'channel-out', channel: frame.channel, bytes: frame.data.length });
      }
      return;
    }
    if (!allocation.permissions.has(rinfo.address)) {
      counters.dropped += 1;
      onEvent({ kind: 'dropped', peer: `${rinfo.address}:${rinfo.port}`, relayPort: allocation.relayPort, reason: 'no permission' });
      return;
    }
    const channel = allocation.channelByPeer.get(`${rinfo.address}:${rinfo.port}`);
    if (channel != null) {
      counters.channelled += 1;
      send(allocation.relay, encodeChannelData(channel, packet), allocation.clientPort, allocation.clientIp);
      onEvent({ kind: 'channel-in', from: `${rinfo.address}:${rinfo.port}`, channel, bytes: packet.length });
      return;
    }
    counters.indications += 1;
    send(allocation.relay, encodeMessage(CLASS.indication | METHOD.data, randomBytes(12).toString('hex'),
      [xorAddress(ATTR.xorPeerAddress, rinfo.address, rinfo.port), attr(ATTR.data, packet)]),
    allocation.clientPort, allocation.clientIp);
    onEvent({ kind: 'data-indication', from: `${rinfo.address}:${rinfo.port}`, bytes: packet.length });
  }

  function handle(to, packet, rinfo) {
    if (isChannelData(packet)) {
      const frame = decodeChannelData(packet);
      if (!frame) return;
      for (const allocation of allocationsFor(rinfo.address, rinfo.port)) {
        if (allocation.channels.has(frame.channel) && forward(allocation, allocation.channels.get(frame.channel), frame.data, 'channel')) {
          counters.channelled += 1;
          return;
        }
      }
      return;
    }
    const message = decodeMessage(packet, { users, realm });
    if (!message || message.class === CLASS.error) return;
    if (message.class === CLASS.indication) {
      if (message.method === METHOD.send) sendIndication(message, rinfo.port, rinfo.address);
      return;
    }
    switch (message.method) {
      // No credentials: a Binding request is how a client checks it can still
      // reach the server, before it has an allocation to authenticate with.
      case METHOD.binding: {
        send(to, encodeMessage(CLASS.success | message.method, message.transactionId,
          [xorAddress(ATTR.xorMappedAddress, rinfo.address, rinfo.port)],
          { integrityKey: message.hasIntegrity && message.authentic ? integrityKeyFor(message.account) : null }),
        rinfo.port, rinfo.address);
        onEvent({ kind: 'binding', from: `${rinfo.address}:${rinfo.port}` });
        return;
      }
      case METHOD.allocate:
        allocate(to, message, rinfo.port, rinfo.address);
        return;
      case METHOD.refresh:
        refresh(to, message, rinfo.port, rinfo.address);
        return;
      case METHOD.createPermission:
        createPermission(to, message, rinfo.port, rinfo.address);
        return;
      case METHOD.channelBind:
        channelBind(to, message, rinfo.port, rinfo.address);
        return;
      default:
        replyError(to, message, ERROR.badRequest, rinfo.port, rinfo.address);
    }
  }

  return {
    get realm() { return realm; },

    start(port) {
      return new Promise((done, fail) => {
        server = createSocket('udp4');
        server.on('message', (packet, rinfo) => handle(server, packet, rinfo));
        server.on('error', fail);
        server.bind(port, relayIp, () => {
          issueNonce();
          done(server.address());
        });
      });
    },

    allocationFor(ip, port) {
      return allocationsFor(ip, port)[0];
    },

    stats: () => ({
      realm,
      software,
      listening: server ? server.address() : null,
      allocations: [...allocations.values()].flat().map((allocation) => ({
        from: allocation.key,
        account: allocation.account,
        relayPort: allocation.relayPort,
        reservedPort: allocation.reservedPort,
        lifetime: allocation.lifetime,
        permissions: [...allocation.permissions.keys()],
        channels: [...allocation.channels.entries()].map(([channel, peer]) => ({ channel, peer: `${peer.ip}:${peer.port}` })),
      })),
      counters,
    }),

    close() {
      closed = true;
      for (const allocation of [...allocations.values()].flat()) expire(allocation, 'server shutdown');
      allocations.clear();
      reservedPorts.clear();
      if (server) {
        try { server.close(); } catch { /* not bound */ }
      }
    },
  };
}

const args = parseArgs();
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) {
  const port = Number(args.port || 3478);
  const user = args.user || 'demo';
  const pass = args.pass || 'singularity-turn-secret';
  const realm = args.realm || 'singularity.local';
  const quiet = Boolean(args.quiet);
  const events = [];
  const server = createTurnServer({
    realm,
    users: { [user]: pass },
    onEvent: (event) => {
      events.push(event);
      if (!quiet) console.log(`  turn ${JSON.stringify(event)}`);
    },
  });
  const address = await server.start(port);
  console.log(JSON.stringify({
    listening: address, realm, url: `turn:${address.address}:${address.port}`, username: user, credential: pass,
  }));
  process.on('SIGINT', () => { server.close(); process.exit(0); });
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
}
