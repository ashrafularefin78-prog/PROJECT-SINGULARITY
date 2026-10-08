import { test, assert, assertEquals } from './harness.js';
import { CiphertextRelay, Mesh } from '../src/collab/mesh.js';
import { RateLimiter } from '../src/security/policy.js';

const room = () => `room-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Every test is driven by real transport events rather than sleeps: background
 * tabs throttle timers aggressively, and an event-driven suite is both faster
 * and more deterministic. The timeout only exists to fail loudly, never to
 * pace the test.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

test('M5: two peers discover each other in the same room', async () => {
  const r = room();
  let aReady;
  let bReady;
  const aSeesB = new Promise((res) => {
    aReady = res;
  });
  const bSeesA = new Promise((res) => {
    bReady = res;
  });

  const a = new Mesh({
    room: r,
    id: 'peer-a',
    name: 'Ada',
    onPeers: (peers) => {
      if (peers.length >= 2) aReady();
    },
  }).start();
  const b = new Mesh({
    room: r,
    id: 'peer-b',
    name: 'Grace',
    onPeers: (peers) => {
      if (peers.length >= 2) bReady();
    },
  }).start();

  await withTimeout(Promise.all([aSeesB, bSeesA]), 20000, 'mutual discovery');
  const aPeers = a.peers().map((p) => p.id).sort();
  assertEquals(aPeers.join(','), 'peer-a,peer-b');
  assertEquals(a.peers()[0].self, true, 'the first entry is always self');
  assertEquals(b.peers().find((p) => p.id === 'peer-a').name, 'Ada', 'names propagate');
  a.close();
  b.close();
});

test('M5: a peer in another room never sees the room', async () => {
  const shared = room();
  // Prove delivery works in `shared` first, then assert isolation for `other`.
  let bothReady;
  const discovered = new Promise((res) => {
    bothReady = res;
  });
  const a = new Mesh({ room: shared, id: 'peer-a', onPeers: (p) => p.length >= 2 && bothReady() }).start();
  const b = new Mesh({ room: shared, id: 'peer-b' }).start();
  const stranger = new Mesh({ room: room(), id: 'peer-z' }).start();

  await withTimeout(discovered, 20000, 'room discovery');
  assertEquals(a.peers().length, 2, 'the shared room has two peers');
  assertEquals(stranger.peers().length, 1, 'a different room stays isolated');
  a.close();
  b.close();
  stranger.close();
});

test('M5: a broadcast reaches the other peer with its payload intact', async () => {
  const r = room();
  let got;
  const arrived = new Promise((res) => {
    got = res;
  });
  const a = new Mesh({ room: r, id: 'peer-a' }).start();
  const b = new Mesh({
    room: r,
    id: 'peer-b',
    onMessage: (kind, payload, from) => {
      if (kind === 'cursor') got({ payload, from });
    },
  }).start();

  a.send('cursor', { index: 7, name: 'Ada' });
  const hit = await withTimeout(arrived, 20000, 'the cursor broadcast');
  assertEquals(hit.payload.index, 7);
  assertEquals(hit.from, 'peer-a');
  a.close();
  b.close();
});

test('M5: a departed peer is pruned from presence', async () => {
  const r = room();
  let aReady;
  const discovered = new Promise((res) => {
    aReady = res;
  });
  let gone;
  const pruned = new Promise((res) => {
    gone = res;
  });
  let count = 0;
  const a = new Mesh({
    room: r,
    id: 'peer-a',
    onPeers: (peers) => {
      count = peers.length;
      if (count >= 2) aReady();
      if (count === 1) gone();
    },
  }).start();
  const b = new Mesh({ room: r, id: 'peer-b' }).start();
  await withTimeout(discovered, 20000, 'discovery before departure');

  b.close();
  await withTimeout(pruned, 20000, 'the bye message to prune peer-b');
  assertEquals(a.peers().length, 1);
  a.close();
});

test('M5: the relay only ever holds routing metadata plus ciphertext', () => {
  const relay = new CiphertextRelay();
  const secretPlaintext = 'the launch codes are 0000';
  relay.post('bob', { from: 'alice', to: 'bob', header: { dh: 'abc', n: 0 }, ct: 'BASE64CIPHERTEXT' });
  relay.post('bob', { from: 'carol', to: 'bob', ct: 'MORE' });

  const seen = relay.inspect();
  assertEquals(seen.length, 2);
  for (const entry of seen) {
    assert(entry.hasCiphertext, 'relay should see ciphertext');
    assert(!JSON.stringify(entry).includes(secretPlaintext), 'relay must not see plaintext');
    assert(entry.visibleFields.includes('ct'), 'relay routes on the ct field');
  }

  const delivered = relay.drain('bob');
  assertEquals(delivered.length, 2);
  assertEquals(relay.drain('bob').length, 0, 'a drained mailbox is empty');
  assertEquals(relay.stats.delivered, 2);
});

test('M5: relay queues broadcast and direct envelopes for the right recipient', () => {
  const relay = new CiphertextRelay();
  relay.post('*', { from: 'alice', ct: 'broadcast' });
  relay.post('bob', { from: 'alice', to: 'bob', ct: 'direct' });
  const bob = relay.drain('bob');
  assertEquals(bob.length, 2);
  const eve = relay.drain('eve');
  assertEquals(eve.length, 1, 'eve only gets the broadcast');
  assertEquals(eve[0].ct, 'broadcast');
});


// ---------------------------------------------------------------------------
// M8 ingress hardening: the token bucket that keeps presence chatter from
// flooding the room, without ever touching document traffic.
// ---------------------------------------------------------------------------

test('M8: the rate limiter allows a burst, refills over time and counts refusals', () => {
  const limiter = new RateLimiter({ rate: 10, burst: 5 });
  let t = 0;
  // The first five calls pass (the burst), the sixth does not.
  for (let i = 0; i < 5; i += 1) assert(limiter.allow('peer', t), `call ${i} is within the burst`);
  assert(!limiter.allow('peer', t), 'the sixth call in the same instant is refused');
  assertEquals(limiter.throttled, 1);
  // One second later the bucket has refilled ten tokens, capped at the burst.
  assert(limiter.allow('peer', t + 1000), 'a quiet second refills the bucket');
  for (let i = 0; i < 4; i += 1) limiter.allow('peer', t + 1000);
  assert(!limiter.allow('peer', t + 1000), 'the cap holds at `burst`');
  // Buckets are per key, so one noisy peer cannot silence another.
  assert(limiter.allow('other', t), 'a different peer has its own bucket');
  assertEquals(limiter.size, 2);
  limiter.forget('peer');
  assertEquals(limiter.size, 1, 'a departing peer is forgotten');
});

test('M8: the mesh throttles presence traffic but never document operations', () => {
  const mesh = new Mesh({ room: 'flood', id: 'target' });
  mesh.channel = null;
  const ops = Array.from({ length: 400 }, (_, i) => ({ t: 'ins', id: [i + 1, 'x'], o: i === 0 ? null : [i, 'x'], c: 'a' }));
  // A flood of presence packets is capped...
  for (let i = 0; i < 400; i += 1) mesh._receive({ kind: 'ping', from: 'noisy', payload: {} }, 'tab');
  const afterPings = mesh.stats.throttled;
  assert(afterPings > 300, `expected the flood to be throttled, throttled=${afterPings}`);
  // ...while every single op still lands, because losing one would lose a
  // character. This is the invariant that makes throttling safe here.
  const before = mesh.stats.received;
  for (const op of ops) mesh._receive({ kind: 'ops', from: 'noisy', payload: { doc: 'd', ops: [op] } }, 'tab');
  assertEquals(mesh.stats.throttled, afterPings, 'ops are never throttled');
  assert(mesh.stats.received > before, 'and they are all accounted for');
});
