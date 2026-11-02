/**
 * Protocol gate for the reference TURN relay in tools/turn-server.js.
 *
 *   node tools/turn-selftest.js [--quiet] [--out=<path>]
 *
 * Why a second tool: the browser proof in tools/turn-relay-e2e.js shows that a
 * real ICE agent can put traffic through the relay, which is the claim the
 * project wants to make. It cannot show *what the relay refused*. A peer with no
 * permission, a stale nonce, a wrong password, a corrupted fingerprint and a
 * duplicate Allocate all look like "nothing happened" from inside an
 * RTCPeerConnection. This drives the same socket-level protocol directly, so the
 * refusals are part of the evidence rather than an assumption about it.
 *
 * Everything here is loopback: one relay, two client transports, two peers.
 */
import { createSocket } from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTR, CLASS, ERROR, METHOD, attr, createTurnServer, decodeChannelData, decodeMessage,
  encodeChannelData, encodeMessage, textAttr, xorAddress,
} from './turn-server.js';
import { parseArgs } from './cdp.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = parseArgs();
const quiet = Boolean(args.quiet);
// The gate and the publisher are the same script, so writing must be asked for:
// CI runs this to verify the relay, and docs/reports/measurements.json hashes
// whatever it finds afterwards. Republishing on a verification run rewrote the
// artifact out from under its own recorded SHA-256.
const outPath = typeof args.out === 'string' ? join(root, String(args.out)) : null;
const REALM = 'singularity.local';
const USER = 'demo';
const PASS = 'singularity-turn-secret';
const STALE_NONCE = '000000000000000000000000';
const UDP = attr(ATTR.requestedTransport, Buffer.from([17, 0, 0, 0]));
const EVEN_PORT = attr(ATTR.evenPort, Buffer.from([0x00]));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [];
const events = [];
let server = null;

function check(id, area, attempt, expected, observed, ok) {
  const entry = { id, area, attempt, expected, observed, ok: Boolean(ok) };
  checks.push(entry);
  if (!quiet) console.log(`  ${entry.ok ? 'PASS' : 'FAIL'} ${id}  ${area}: ${attempt}`);
  if (!entry.ok) console.log(`       observed: ${JSON.stringify(observed)} - expected: ${expected}`);
}

const bind = (port = 0) => new Promise((done, fail) => {
  const socket = createSocket('udp4');
  // An error before bind means the socket never came up; after bind it is an
  // ICMP unreachable from a relay port we just closed, which is expected noise.
  const reject = (error) => fail(error);
  socket.once('error', reject);
  socket.on('error', () => { /* post-bind unreachable */ });
  socket.bind(port, '127.0.0.1', () => {
    socket.removeListener('error', reject);
    done(socket);
  });
});

async function poll(fn, ms = 1500) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(20);
  }
}

/**
 * A STUN/TURN client over one UDP socket. Error responses carry a fresh nonce
 * and the client adopts it, because that is the recovery path a real allocation
 * takes rather than something this test arranges. Responses are verified with
 * the credential key directly - a success reply has no USERNAME to look one up
 * by.
 */
function createClient(socket) {
  const state = {
    realm: REALM,
    nonce: null,
    key: createHash('md5').update(`${USER}:${REALM}:${PASS}`).digest(),
    pending: new Map(),
    indications: [],
    frames: [],
  };
  socket.on('message', (packet, rinfo) => {
    const from = `${rinfo.address}:${rinfo.port}`;
    const message = decodeMessage(packet, { key: state.key, realm: state.realm });
    if (!message) {
      const frame = decodeChannelData(packet);
      if (frame) state.frames.push({ ...frame, raw: packet.length, from });
      return;
    }
    if (message.class === CLASS.indication) {
      state.indications.push({ ...message, raw: packet.length, from });
      return;
    }
    if (message.class === CLASS.error) {
      if (message.realm) state.realm = message.realm;
      if (message.nonce) state.nonce = message.nonce;
    }
    const waiting = state.pending.get(message.transactionId);
    if (waiting) {
      state.pending.delete(message.transactionId);
      waiting(message);
    }
  });

  function transmit(type, attributes, { integrity = true, nonce, key, corrupt = false } = {}) {
    const transactionId = randomBytes(12).toString('hex');
    const body = [...attributes];
    if (integrity) {
      body.unshift(textAttr(ATTR.nonce, nonce || state.nonce || ''),
        textAttr(ATTR.realm, state.realm),
        textAttr(ATTR.username, USER));
    }
    const packet = encodeMessage(type, transactionId, body, { integrityKey: integrity ? key || state.key : null });
    if (corrupt) packet[packet.length - 1] ^= 0xff;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        state.pending.delete(transactionId);
        fail(new Error(`no reply to 0x${type.toString(16)} within 2000ms`));
      }, 2000);
      state.pending.set(transactionId, (message) => {
        clearTimeout(timer);
        done(message);
      });
      socket.send(packet, server.port, '127.0.0.1', () => {});
    });
  }

  return {
    socket,
    state,
    address: () => socket.address(),
    request: (method, attributes = [], options = {}) => transmit(CLASS.request | method, attributes, options),
    challenge: async () => transmit(CLASS.request | METHOD.allocate, [UDP], { integrity: false }),
    indication: (method, attributes = []) => {
      socket.send(encodeMessage(CLASS.indication | method, randomBytes(12).toString('hex'),
        [textAttr(ATTR.username, USER), textAttr(ATTR.realm, state.realm), textAttr(ATTR.nonce, state.nonce), ...attributes],
        { integrityKey: state.key }), server.port, '127.0.0.1', () => {});
    },
    channelData: (channel, payload) => socket.send(encodeChannelData(channel, payload), server.relayPort, '127.0.0.1', () => {}),
    nextIndication: (method) => poll(() => state.indications.find((one) => one.method === method)),
    nextFrame: () => poll(() => state.frames.shift()),
  };
}

/** A peer endpoint: what the relay forwards to, and what answers back. */
async function createPeer() {
  const socket = await bind();
  const address = socket.address();
  const inbox = [];
  socket.on('message', (packet, rinfo) => {
    inbox.push({ text: packet.toString('utf8'), bytes: packet.length, from: `${rinfo.address}:${rinfo.port}` });
  });
  return {
    socket,
    address,
    at: () => `${address.address}:${address.port}`,
    inbox,
    send: (text) => new Promise((done) => socket.send(Buffer.from(text, 'utf8'), server.relayPort, '127.0.0.1', () => done())),
    last: () => inbox[inbox.length - 1] || null,
  };
}

async function main() {
  const address = await (async () => {
    const relay = createTurnServer({
      realm: REALM,
      users: { [USER]: PASS },
      minRelayPort: 49200,
      maxRelayPort: 49260,
      onEvent: (event) => events.push(event),
    });
    const bound = await relay.start(0);
    server = { relay, port: bound.port, relayPort: null };
    return bound;
  })();
  if (!quiet) console.log(`turn relay listening on turn:127.0.0.1:${address.port} (realm ${REALM})`);

  const socketA = await bind();
  const socketB = await bind();
  const clientA = createClient(socketA);
  const clientB = createClient(socketB);
  const peer = await createPeer();
  const stranger = await bind();
  // Client B has never seen a challenge, so it asks for one the way a real
  // allocation does: an unauthenticated Allocate that comes back 401 with a
  // realm and a nonce it then signs with.
  await clientB.challenge();

  // 1. The STUN layer on its own, before any TURN semantics.
  const binding = await clientA.request(METHOD.binding, [], { integrity: false });
  const mine = socketA.address();
  check(
    'TURN-S1',
    'stun layer',
    'an unauthenticated Binding request answers with the client transport address',
    'success whose XOR-MAPPED-ADDRESS equals the bound socket',
    { class: binding.class, mapped: binding.mapped, bound: `${mine.address}:${mine.port}` },
    binding.class === CLASS.success && binding.mapped && binding.mapped.ip === mine.address && binding.mapped.port === mine.port,
  );

  // 2. The challenge, and the client's adoption of realm plus nonce.
  const challenge = await clientA.request(METHOD.allocate, [UDP], { integrity: false });
  check(
    'TURN-S2',
    'long-term credentials',
    'Allocate with no MESSAGE-INTEGRITY is refused with 401 plus REALM and NONCE',
    'error 401 carrying the realm and a nonce the client then uses',
    { code: challenge.errorCode, realm: challenge.realm, adoptedNonce: Boolean(challenge.nonce) },
    challenge.class === CLASS.error && challenge.errorCode === ERROR.unauthorized && challenge.realm === REALM && Boolean(challenge.nonce),
  );

  // 3 and 4. The two ways a credential can be wrong.
  const wrongKey = createHash('md5').update(`${USER}:${REALM}:not-the-password`).digest();
  const refused = await clientA.request(METHOD.allocate, [UDP], { key: wrongKey });
  check(
    'TURN-S3',
    'long-term credentials',
    'Allocate signed with the wrong password is refused rather than downgraded',
    'error 401 and no allocation recorded',
    { code: refused.errorCode, allocations: server.relay.stats().allocations.length },
    refused.class === CLASS.error && refused.errorCode === ERROR.unauthorized && server.relay.stats().allocations.length === 0,
  );

  const tampered = await clientA.request(METHOD.allocate, [UDP], { corrupt: true });
  const tamperReason = [...events].reverse().find((event) => event.kind === 'error');
  check(
    'TURN-S4',
    'fingerprint',
    'an Allocate whose FINGERPRINT was altered in flight is refused',
    'error 401 and still no allocation',
    { code: tampered.errorCode, lastError: tamperReason?.reason },
    tampered.class === CLASS.error && tampered.errorCode === ERROR.unauthorized && server.relay.stats().allocations.length === 0,
  );

  // 5. A correct allocation, with the relay address and integrity verified.
  const allocated = await clientA.request(METHOD.allocate, [UDP]);
  server.relayPort = allocated.relay ? allocated.relay.port : null;
  check(
    'TURN-S5',
    'allocation',
    'an authenticated Allocate returns an even relay address and echoes the transport address',
    'success with an even XOR-RELAY-ADDRESS, XOR-MAPPED-ADDRESS of this socket, LIFETIME 600, verified MESSAGE-INTEGRITY',
    { relay: allocated.relay, mapped: allocated.mapped, lifetime: allocated.lifetime, authentic: allocated.authentic, origin: allocated.values.has('responseOrigin') },
    allocated.class === CLASS.success && allocated.authentic && allocated.relay && allocated.relay.port % 2 === 0
      && allocated.mapped && allocated.mapped.port === mine.port && allocated.lifetime === 600 && allocated.values.has('responseOrigin'),
  );

  const mismatch = await clientA.request(METHOD.allocate, [UDP]);
  check(
    'TURN-S6',
    'allocation',
    'a second Allocate from the same 5-tuple with no reservation is refused',
    'error 437 Allocate Mismatch',
    { code: mismatch.errorCode, reason: mismatch.errorReason },
    mismatch.class === CLASS.error && mismatch.errorCode === ERROR.allocateMismatch,
  );

  const reserved = await clientB.request(METHOD.allocate, [UDP, EVEN_PORT]);
  const reservedPair = await clientB.request(METHOD.allocate, [UDP, EVEN_PORT]);
  check(
    'TURN-S7',
    'even-port reservation',
    'a reservation is offered and the next Allocate from that transport consumes the port above it',
    'first response RESERVATION 0x00000000, second relay port equal to the first plus one',
    { first: reserved.relay?.port, second: reservedPair.relay?.port, reservation: reserved.values.get('reserved')?.[0]?.readUInt32BE(0) },
    reserved.class === CLASS.success && reserved.values.has('reserved')
      && reserved.values.get('reserved')[0].readUInt32BE(0) === 0
      && reservedPair.class === CLASS.success && reservedPair.relay.port === reserved.relay.port + 1,
  );

  const droppedBefore = server.relay.stats().counters.dropped;
  stranger.send(Buffer.from('unsolicited', 'utf8'), server.relayPort, '127.0.0.1', () => {});
  const leaked = await clientA.nextIndication(METHOD.data);
  check(
    'TURN-S8',
    'permission filter',
    'a peer with no permission is dropped and never reaches the client',
    'the drop counter increments and no Data indication arrives',
    { dropped: server.relay.stats().counters.dropped - droppedBefore, leaked: leaked ? leaked.data?.toString('utf8') : null },
    server.relay.stats().counters.dropped > droppedBefore && leaked === null,
  );

  const permission = await clientA.request(METHOD.createPermission, [xorAddress(ATTR.xorPeerAddress, peer.address.address, peer.address.port)]);
  check(
    'TURN-S9',
    'permission filter',
    'CreatePermission installs a peer-IP permission on the allocation',
    'success and the peer IP visible in relay stats',
    { class: permission.class, permissions: server.relay.stats().allocations.map((one) => one.permissions).flat() },
    permission.class === CLASS.success && server.relay.stats().allocations.some((one) => one.permissions.includes(peer.address.address)),
  );

  clientA.indication(METHOD.send, [
    xorAddress(ATTR.xorPeerAddress, peer.address.address, peer.address.port),
    attr(ATTR.data, Buffer.from('SINGULARITY-PING', 'utf8')),
  ]);
  const forwarded = await poll(() => peer.last());
  check(
    'TURN-S10',
    'relay path',
    'a Send indication is forwarded to the peer from the relay address',
    'the peer sees the payload with the relay transport as its source, not the client port',
    { text: forwarded?.text, from: forwarded?.from, relay: `127.0.0.1:${server.relayPort}`, client: `${mine.address}:${mine.port}` },
    forwarded?.text === 'SINGULARITY-PING' && forwarded.from === `127.0.0.1:${server.relayPort}` && mine.port !== server.relayPort,
  );

  await peer.send('SINGULARITY-PONG');
  const indication = await clientA.nextIndication(METHOD.data);
  check(
    'TURN-S11',
    'relay path',
    'the reply from the peer comes back as a Data indication naming the peer',
    'indication whose XOR-PEER-ADDRESS is the peer, whose DATA is the payload, and which arrived from the relay address',
    { peer: indication?.peer, text: indication?.data?.toString('utf8'), from: indication?.from },
    Boolean(indication) && indication.class === CLASS.indication && indication.data?.toString('utf8') === 'SINGULARITY-PONG'
      && indication.peer && indication.peer.port === peer.address.port
      && indication.from === `127.0.0.1:${server.relayPort}`,
  );

  const bound = await clientA.request(METHOD.channelBind,
    [attr(ATTR.channelNumber, Buffer.from([0x40, 0x01])), xorAddress(ATTR.xorPeerAddress, peer.address.address, peer.address.port)]);
  check(
    'TURN-S12',
    'channel binding',
    'ChannelBind pairs a channel number with the peer and implies its permission',
    'success and the binding visible in relay stats',
    { class: bound.class, channels: server.relay.stats().allocations.map((one) => one.channels).flat() },
    bound.class === CLASS.success && server.relay.stats().allocations.some((one) => one.channels.some((channel) => channel.channel === 0x4001)),
  );

  clientA.channelData(0x4001, Buffer.from('7-bytes', 'utf8'));
  const viaChannel = await poll(() => peer.inbox.find((one) => one.text === '7-bytes'));
  await peer.send('5byte');
  const frame = await clientA.nextFrame();
  check(
    'TURN-S13',
    'channel framing',
    'ChannelData travels both ways with the length field counting the payload, not the padding',
    'the peer gets exactly 7 bytes; the client gets a 0x4001 frame of wire length 12 holding 5 bytes, from the relay address',
    { toPeer: viaChannel?.bytes, fromPeer: viaChannel?.from, wire: frame?.raw, channel: frame?.channel, data: frame?.data?.toString('utf8'), arrived: frame?.from },
    viaChannel?.bytes === 7 && viaChannel?.from === `127.0.0.1:${server.relayPort}`
      && Boolean(frame) && frame.channel === 0x4001 && frame.data.toString('utf8') === '5byte'
      && frame.raw === 4 + 5 + ((4 - (5 % 4)) % 4) && frame.from === `127.0.0.1:${server.relayPort}`,
  );

  const stale = await clientA.request(METHOD.refresh, [], { nonce: STALE_NONCE });
  const recovered = await clientA.request(METHOD.refresh, [attr(ATTR.lifetime, Buffer.from([0, 0, 0, 100]))]);
  check(
    'TURN-S14',
    'nonce window',
    'a signed request with a nonce outside the window gets 438 and the retry with the offered nonce succeeds',
    'error 438 carrying a different nonce, then a Refresh success echoing lifetime 100',
    { first: stale.errorCode, offered: stale.nonce !== STALE_NONCE, then: recovered.class, lifetime: recovered.lifetime },
    stale.class === CLASS.error && stale.errorCode === ERROR.staleNonce && Boolean(stale.nonce)
      && stale.nonce !== STALE_NONCE && recovered.class === CLASS.success && recovered.lifetime === 100,
  );

  const unknownMethod = await clientA.request(0x000b, []);
  check(
    'TURN-S15',
    'method dispatch',
    'a request for a method this relay does not implement is refused rather than ignored',
    'error 400 for type 0x000b',
    { code: unknownMethod.errorCode, reason: unknownMethod.errorReason },
    unknownMethod.class === CLASS.error && unknownMethod.errorCode === ERROR.badRequest,
  );

  const released = await clientA.request(METHOD.refresh, [attr(ATTR.lifetime, Buffer.from([0, 0, 0, 0]))]);
  const indicationsBefore = clientA.state.indications.length;
  stranger.send(Buffer.from('after-release', 'utf8'), server.relayPort, '127.0.0.1', () => {});
  await sleep(250);
  const ports = server.relay.stats().allocations.map((one) => one.relayPort);
  check(
    'TURN-S16',
    'deallocation',
    'Refresh with lifetime 0 deletes the allocation and stops the relay port',
    'success with lifetime 0, that relay port gone from the table, nothing forwarded afterwards',
    { lifetime: released.lifetime, remainingPorts: ports, newIndications: clientA.state.indications.length - indicationsBefore },
    released.class === CLASS.success && released.lifetime === 0 && !ports.includes(server.relayPort)
      && clientA.state.indications.length === indicationsBefore,
  );

  const pairBinding = await clientB.request(METHOD.binding, [], { integrity: false });
  const listed = server.relay.stats().allocations;
  check(
    'TURN-S17',
    'two transports',
    'the second client keeps both of its allocations while the first holds none',
    'every remaining allocation belongs to the second transport address, and Binding still answers it',
    { owners: listed.map((one) => one.from), released: `127.0.0.1:${mine.port}`, pairMapped: pairBinding.mapped?.port },
    listed.length === 2 && listed.every((one) => one.from === `127.0.0.1:${socketB.address().port}`)
      && pairBinding.mapped && pairBinding.mapped.port === socketB.address().port,
  );

  const stats = server.relay.stats();
  for (const socket of [socketA, socketB, peer.socket, stranger]) {
    try { socket.close(); } catch { /* already closed */ }
  }
  server.relay.close();
  return stats;
}

const stats = await main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  check('TURN-FATAL', 'harness', 'the self-test runs to completion', 'no thrown error', { error: String(error && error.message ? error.message : error) }, false);
  if (server) server.relay.close();
  return null;
});

const generated = new Date();
const failed = checks.filter((entry) => !entry.ok);
const report = {
  schema: 1,
  kind: 'turn-protocol-self-test',
  date: `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, '0')}-${String(generated.getDate()).padStart(2, '0')}`,
  generatedAt: generated.toISOString(),
  environment: { node: process.version, platform: process.platform, transport: 'udp/loopback' },
  relay: { url: `turn:127.0.0.1:${server ? server.port : 0}`, realm: REALM, username: USER, software: 'singularity-turn/1' },
  counters: stats ? stats.counters : null,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  limitations: [
    'Loopback only: the NAT topology is simulated by separate UDP endpoints, not by crossing a real symmetric NAT.',
    'This proves the relay protocol. The browser claim is proved separately by tools/turn-relay-e2e.js.',
    'It is not a hosted service and carries none of the availability or abuse controls one would need.',
  ],
  checks,
  events: events.slice(-30),
};
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(`\n${report.summary.passed}/${report.summary.total} checks passed, ${report.summary.failed} failed`);
console.log(outPath ? `# report: ${outPath}` : '# no artifact written - pass --out=<path> to publish one');
if (stats) console.log(`# counters: ${JSON.stringify(stats.counters)}`);
process.exitCode = failed.length ? 1 : 0;
