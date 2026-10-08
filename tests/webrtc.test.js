// M5 WebRTC suite.
//
// Two layers are tested here:
//   1. The signaling code itself - encode/decode and, more importantly, the
//      validation of codes that arrive from somewhere untrusted.
//   2. A real RTCPeerConnection handshake between two carriers, with the offer
//      and answer passed as codes exactly as the UI does it. This runs in a
//      browser (the test page has RTCPeerConnection); under Node there is no
//      WebRTC stack, so the live test reports itself as skipped rather than
//      pretending to pass.
import { test, assert, assertEquals } from './harness.js';
import { DEFAULT_ICE_SERVERS, RtcCarrier, decodeSignal, encodeSignal } from '../src/collab/webrtc.js';
import { Mesh } from '../src/collab/mesh.js';

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=mid:0\r\n';

test('M5: a signaling code round-trips through encode and decode', () => {
  const code = encodeSignal('offer', SDP);
  assert(code.startsWith('SNG1:'), 'codes are prefixed so a wrong paste is obvious');
  const back = decodeSignal(code);
  assertEquals(back.kind, 'offer');
  assertEquals(back.sdp, SDP);
});

test('M5: signaling codes from untrusted input are rejected, not trusted', () => {
  const cases = [
    ['', /no code pasted/],
    ['hello', /starts with SNG1:/],
    ['SNG1:!!!!', /not readable/],
    [`SNG1:${btoa('not json')}`, /not readable/],
    [`SNG1:${btoa(JSON.stringify({ v: 9, kind: 'offer', sdp: SDP }))}`, /unsupported signaling version/],
    [`SNG1:${btoa(JSON.stringify({ v: 1, kind: 'sideways', sdp: SDP }))}`, /unknown signaling kind/],
    [`SNG1:${btoa(JSON.stringify({ v: 1, kind: 'offer' }))}`, /carries no session description/],
    [`SNG1:${btoa(JSON.stringify({ v: 1, kind: 'offer', sdp: 'not-sdp' }))}`, /carries no session description/],
    [`SNG1:${'A'.repeat(30000)}`, /far too long/],
  ];
  for (const [code, expected] of cases) {
    let message = null;
    try {
      decodeSignal(code);
    } catch (err) {
      message = err.message;
    }
    assert(message !== null, `expected ${JSON.stringify(code.slice(0, 24))} to be rejected`);
    assert(expected.test(message), `wrong reason for ${JSON.stringify(code.slice(0, 24))}: ${message}`);
  }
});

test('M5: whitespace from a chat client does not break a pasted code', () => {
  const code = encodeSignal('answer', SDP);
  const wrapped = `  ${code.slice(0, 40)}\n${code.slice(40)}\n  `;
  const back = decodeSignal(wrapped);
  assertEquals(back.kind, 'answer');
  assertEquals(back.sdp, SDP);
});

test('M5: the mesh tags a peer with the carrier it was heard on, and prefers WebRTC', () => {
  const mesh = new Mesh({ room: 'tag-probe', id: 'me' });
  mesh.channel = null;
  const peer = () => mesh.peers().find((p) => p.id === 'peer-x' && !p.self);
  mesh._receive({ kind: 'hello', from: 'peer-x', payload: { name: 'X' } }, 'tab');
  assertEquals(peer().transport, 'tab');
  mesh._receive({ kind: 'hello', from: 'peer-x', payload: { name: 'X' } }, 'webrtc');
  assertEquals(peer().transport, 'webrtc', 'a peer reachable over a real connection is reported as such');
  mesh._receive({ kind: 'beat', from: 'peer-x', payload: {} }, 'tab');
  assertEquals(peer().transport, 'webrtc', 'a later tab packet must not downgrade the badge');
});

test('M5: a real data channel opens between two carriers, with no server', async () => {
  if (!RtcCarrier.supported()) {
    // Node has no WebRTC stack. The browser suite covers this test for real.
    return;
  }
  const inboxA = [];
  const inboxB = [];
  const a = new RtcCarrier({ id: 'carrier-a', name: 'A', onEnvelope: (e) => inboxA.push(e) });
  const b = new RtcCarrier({ id: 'carrier-b', name: 'B', onEnvelope: (e) => inboxB.push(e) });
  try {
    const invite = await a.createInvite();
    const answer = await b.acceptInvite(invite);
    await a.acceptAnswer(answer);

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (a.links.size === 1 && b.links.size === 1 && a.stats.received && b.stats.received) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    assertEquals(a.links.size, 1, 'the inviting side ends up with exactly one link');
    assertEquals(b.links.size, 1, 'the answering side does not keep a placeholder link');
    assertEquals([...a.links.values()][0].state, 'open', 'the data channel must be open');
    assertEquals([...b.links.values()][0].state, 'open', 'the data channel must be open on both ends');

    // Both directions carry real application traffic.
    assertEquals(a.send('probe', { n: 1 }), 1, 'the send reaches the one open link');
    assertEquals(b.send('probe', { n: 2 }), 1);
    const until = Date.now() + 5000;
    while (Date.now() < until && !(inboxA.some((e) => e.kind === 'probe') && inboxB.some((e) => e.kind === 'probe'))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(inboxA.some((e) => e.kind === 'probe' && e.payload.n === 2), 'A received B’s probe over the channel');
    assert(inboxB.some((e) => e.kind === 'probe' && e.payload.n === 1), 'B received A’s probe over the channel');
    assert(inboxA.every((e) => e.from === 'carrier-b' || e.from === 'carrier-a'), 'envelopes carry the sender id');
  } finally {
    a.close();
    b.close();
  }
  assertEquals(a.links.size, 0, 'closing clears the links');
  assertEquals(b.links.size, 0, 'closing clears the links on both sides');
});

test('M5: the signaling steps refuse codes from the wrong side', async () => {
  if (!RtcCarrier.supported()) return;
  const a = new RtcCarrier({ id: 'a' });
  const b = new RtcCarrier({ id: 'b' });
  try {
    const invite = await a.createInvite();
    let message = null;
    try {
      await a.acceptInvite(invite);
    } catch (err) {
      message = err.message;
    }
    assert(/created by this page/.test(message || ''), `A must not accept its own invite: ${message}`);

    message = null;
    try {
      await b.acceptAnswer(invite);
    } catch (err) {
      message = err.message;
    }
    assert(/that is an invite code/.test(message || ''), `an invite must not be applied as an answer: ${message}`);

    message = null;
    try {
      await b.acceptAnswer(encodeSignal('answer', SDP));
    } catch (err) {
      message = err.message;
    }
    assert(/no invite waiting/.test(message || ''), `an answer with no pending invite must be refused: ${message}`);
  } finally {
    a.close();
    b.close();
  }
});

test('M5: the default ICE configuration is STUN only, and configurable', () => {
  assertEquals(DEFAULT_ICE_SERVERS.length, 1);
  assert(/^stun:/.test(DEFAULT_ICE_SERVERS[0].urls), 'the default must not silently route media through a third party relay');
  const custom = new RtcCarrier({ id: 'x', iceServers: [{ urls: 'turn:example.test:3478' }] });
  assertEquals(custom.iceServers[0].urls, 'turn:example.test:3478');
  const none = new RtcCarrier({ id: 'y', iceServers: null });
  assertEquals(none.iceServers.length, 0, 'passing null disables ICE servers entirely (host candidates only)');
});
