import { test, assert, assertEquals } from './harness.js';
import { CiphertextRelay, Mesh } from '../src/collab/mesh.js';
import { RelayCarrier } from '../src/collab/relay.js';
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

// ---------------------------------------------------------------------------
// M5 relay carrier (src/collab/relay.js): the browser side of the node
// contract - sealing, the outbox, and failover across a list of nodes. The
// "node" below is the node's HTTP contract wrapped around the in-memory relay,
// so the tests exercise the exact wire shapes without needing a server.
// ---------------------------------------------------------------------------

/** A stand-in node: the real routes, the real envelopes, no sockets. */
function stubNode() {
  const relay = new CiphertextRelay();
  const calls = { posts: 0, drains: 0 };
  const json = (status, payload) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url, 'http://stub.test');
    if (u.pathname === '/relay/post') {
      calls.posts += 1;
      const body = JSON.parse(init.body);
      relay.post(body.to, { from: body.from, to: body.to, header: body.header, ct: body.ct });
      return json(200, { ok: true, seq: calls.posts });
    }
    if (u.pathname === '/relay/drain') {
      calls.drains += 1;
      await new Promise((r) => setTimeout(r, 5)); // stand in for the parked long poll
      const envelopes = relay.drain(u.searchParams.get('peer'));
      return json(200, {
        ok: true,
        envelopes: envelopes.map(({ to, from, header, ct }) => ({ to, from, header, ct })),
      });
    }
    return json(404, { ok: false, error: 'no such route' });
  };
  return { relay, calls, fetchImpl };
}

/** A trivially reversible seal: the carrier must not care what is inside. */
const stubSeal = async (payload) => ({ header: { v: 1 }, ct: JSON.stringify(payload) });
const stubOpen = async ({ ct }) => JSON.parse(ct);

/** Poll until the predicate holds, then resolve; the timeout only fails loudly. */
async function waitFor(predicate, label, ms = 5000) {
  await withTimeout(
    (async () => {
      while (!predicate()) await new Promise((r) => setTimeout(r, 5));
    })(),
    ms,
    label,
  );
}

test('M5 relay carrier: a sealed frame round-trips through the node contract', async () => {
  const node = stubNode();
  const seen = [];
  const a = new RelayCarrier({ peerId: 'alice', urls: ['http://stub.test'], seal: stubSeal, open: stubOpen, fetchImpl: node.fetchImpl });
  const b = new RelayCarrier({
    peerId: 'bob',
    urls: ['http://stub.test'],
    seal: stubSeal,
    open: stubOpen,
    fetchImpl: node.fetchImpl,
    onFrame: (payload) => seen.push(payload),
  });
  a.start();
  b.start();
  const result = await a.post('*', { kind: 'ping', room: 'x' });
  assertEquals(result.delivered, true, 'the node acked');
  await waitFor(() => seen.length === 1, 'the frame to arrive at bob');
  assertEquals(seen[0].kind, 'ping');
  assertEquals(node.calls.posts, 1);
  // What the node holds is the wire envelope: routing fields and ciphertext.
  const stored = node.relay.inspect();
  assertEquals(stored.length, 1);
  assert(stored[0].visibleFields.includes('ct') && stored[0].visibleFields.includes('from'), 'routing plus ct');
  a.stop();
  b.stop();
});

test('M5 relay carrier: a dead node hands the outbox to the next one', async () => {
  const nodeB = stubNode();
  const carrier = new RelayCarrier({
    peerId: 'alice',
    urls: ['http://dead.test', 'http://standby.test'],
    seal: stubSeal,
    open: stubOpen,
    fetchImpl: (url, init) =>
      String(url).includes('dead.test') ? Promise.reject(new TypeError('failed to fetch')) : nodeB.fetchImpl(url, init),
  });
  const result = await carrier.post('*', { kind: 'ops', n: 7 });
  assertEquals(result.delivered, true, 'the standby acked');
  assertEquals(carrier.stats.failovers, 1, 'the dead node rotated once');
  assertEquals(carrier.activeUrl, 'http://standby.test');
  assertEquals(carrier.stats.reposted, 1, 'the frame was re-posted, not sent fresh');
  assertEquals(carrier.outbox.size, 0, 'the outbox is clear');
  assertEquals(nodeB.calls.posts, 1);
});

test('M5 relay carrier: a repeated frame is delivered to the app exactly once', async () => {
  const node = stubNode();
  const seen = [];
  const b = new RelayCarrier({
    peerId: 'bob',
    urls: ['http://stub.test'],
    seal: stubSeal,
    open: stubOpen,
    fetchImpl: node.fetchImpl,
    onFrame: (payload) => seen.push(payload),
  });
  b.start();
  // The same sealed frame twice: what a re-post after a lost response looks like.
  const frame = { to: 'bob', from: 'alice', header: { v: 1 }, ct: JSON.stringify({ id: 'alice#1', payload: { kind: 'ops' } }) };
  await node.fetchImpl('http://stub.test/relay/post', { method: 'POST', body: JSON.stringify(frame) });
  await node.fetchImpl('http://stub.test/relay/post', { method: 'POST', body: JSON.stringify(frame) });
  await waitFor(() => seen.length === 1 && b.stats.duplicates === 1, 'the frame and its duplicate');
  assertEquals(seen.length, 1, 'the app saw it once');
  assertEquals(b.stats.duplicates, 1, 'the carrier absorbed the copy');
  b.stop();
});

test('M5 relay carrier: a base URL is an origin, so routes are never doubled', async () => {
  const seen = [];
  const carrier = new RelayCarrier({
    peerId: 'alice',
    urls: [''],
    seal: stubSeal,
    open: stubOpen,
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ ok: true, seq: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assertEquals(carrier.activeUrl, '', 'an empty base means this origin');
  await carrier.post('*', { kind: 'ping' });
  assertEquals(seen.length, 1);
  assertEquals(seen[0], '/relay/post', 'the route is /relay/post, not /relay/relay/post');
  // And a carrier given nothing at all behaves the same way.
  const bare = new RelayCarrier({ peerId: 'bob', seal: stubSeal, open: stubOpen, urls: [] });
  assertEquals(bare.activeUrl, '');
});

test('M5 relay carrier: 429 backpressure retries the same sealed entry and can deliver', async () => {
  for (const urls of [['http://node.test'], ['http://busy.test', 'http://standby.test']]) {
    const calls = [];
    let seals = 0;
    let entry;
    const carrier = new RelayCarrier({
      peerId: 'alice',
      urls,
      seal: async (payload) => {
        seals += 1;
        return stubSeal(payload);
      },
      open: stubOpen,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: init.body });
        const queued = [...carrier.outbox.values()][0];
        assert(queued, 'backpressure must not remove the queued frame');
        if (calls.length === 1) entry = queued;
        else assertEquals(queued, entry, 'retry retains the original entry reference');
        return new Response(JSON.stringify(calls.length === 1 ? { ok: false, error: 'mailbox full' } : { ok: true }), {
          status: calls.length === 1 ? 429 : 200,
        });
      },
    });
    const result = await carrier.post('bob', { kind: 'ops', n: 7 });
    assertEquals(result.delivered, true, 'only the eventual 200 acknowledgement delivers');
    assertEquals(result.queued, false);
    assertEquals(calls.length, 2, 'backpressure gets a bounded retry');
    assertEquals(calls[1].url, `${urls[1] || urls[0]}/relay/post`, 'retry uses the next available node');
    assertEquals(calls[0].body, calls[1].body, 'failover reuses the sealed wire bytes');
    const wire = JSON.parse(calls[0].body);
    assertEquals(Object.keys(wire).sort().join(','), 'ct,from,header,to', 'wire contains only sealed routing fields');
    assertEquals(wire.to, 'bob');
    assertEquals(wire.from, 'alice');
    assertEquals(JSON.parse(wire.ct).id, result.id, 'message id stays inside the seal');
    assertEquals(seals, 1, 'retry never reseals');
    assertEquals(carrier.stats.acked, 1);
    assertEquals(carrier.stats.reposted, 1);
    assertEquals(carrier.outbox.size, 0);
  }
});

test('M5 relay carrier: exhausted 429 retries remain queued with an error', async () => {
  for (const urls of [['http://node.test'], ['http://one.test', 'http://two.test']]) {
    let calls = 0;
    let up = false;
    const bodies = [];
    const carrier = new RelayCarrier({
      peerId: 'alice',
      urls,
      seal: stubSeal,
      open: stubOpen,
      fetchImpl: async (_url, init) => {
        calls += 1;
        bodies.push(init.body);
        return new Response(JSON.stringify(up ? { ok: true } : { ok: false, error: 'mailbox full' }), { status: up ? 200 : 429 });
      },
    });
    const result = await carrier.post('*', { kind: 'ops' });
    assertEquals(calls, urls.length + 1, 'retry budget is bounded by the fleet size');
    assertEquals(result.delivered, false);
    assertEquals(result.queued, true, 'exhausted backpressure does not drop ciphertext');
    assert(result.error && result.error.includes('429'), 'backpressure error is surfaced');
    assertEquals(carrier.stats.lastError, result.error);
    assertEquals(carrier.stats.acked, 0);
    assertEquals(carrier.outbox.size, 1);
    const entry = carrier.outbox.get(result.id);
    const retry = await carrier.flush();
    assertEquals(retry.ok, false);
    assert(retry.error.includes('429'));
    assertEquals(calls, 2 * (urls.length + 1), 'each flush is independently bounded');
    assertEquals(carrier.outbox.get(result.id), entry, 'continuous backpressure retains the entry');
    up = true;
    assertEquals((await carrier.flush()).ok, true, 'a later flush can still deliver');
    assertEquals(carrier.outbox.size, 0);
    assertEquals(carrier.stats.acked, 1);
    for (const body of bodies) assertEquals(body, bodies[0], 'all retries preserve ciphertext');
  }
});

for (const [status, reason] of [[400, 'invalid envelope'], [413, 'envelope too large']]) {
  test(`M5 relay carrier: ${status} rejection is terminal, not delivery`, async () => {
    let calls = 0;
    const carrier = new RelayCarrier({
      peerId: 'alice',
      urls: ['http://primary.test', 'http://standby.test'],
      seal: stubSeal,
      open: stubOpen,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: false, error: reason }), { status });
      },
    });
    const result = await carrier.post('*', { kind: 'ops' });
    assertEquals(result.delivered, false, 'removal after rejection is not acknowledgement');
    assertEquals(result.queued, false, 'terminal rejection removes the entry');
    assert(result.error && result.error.includes(String(status)) && result.error.includes(reason), 'rejection reason is surfaced');
    assertEquals(carrier.stats.lastError, result.error);
    assertEquals(carrier.stats.acked, 0);
    assertEquals(carrier.stats.failovers, 0, 'protocol errors never rotate');
    assertEquals(carrier.outbox.size, 0);
    await carrier.flush();
    assertEquals(calls, 1, 'rejected bytes are never retried');
  });
}

test('M5 relay carrier: delivery requires both status 200 and json.ok', async () => {
  for (const [status, json] of [[200, { ok: false }], [202, { ok: true }], [200, null]]) {
    const carrier = new RelayCarrier({
      peerId: 'alice',
      urls: ['http://node.test'],
      seal: stubSeal,
      open: stubOpen,
      fetchImpl: async () => new Response(JSON.stringify(json), { status }),
    });
    const result = await carrier.post('*', { kind: 'ops' });
    assertEquals(result.delivered, false, 'HTTP success alone is not the node acknowledgement');
    assertEquals(result.queued, true);
    assert(result.error, 'missing acknowledgement is surfaced');
    assertEquals(carrier.outbox.size, 1);
    assertEquals(carrier.stats.acked, 0);
  }
});

test('M5 relay carrier: a shared flush reports each entry own outcome', async () => {
  let busy = true;
  const carrier = new RelayCarrier({
    peerId: 'alice',
    urls: ['http://node.test'],
    seal: stubSeal,
    open: stubOpen,
    fetchImpl: async (_url, init) => {
      const id = JSON.parse(JSON.parse(init.body).ct).id;
      const status = busy ? 429 : id === 'alice#1' ? 400 : 200;
      return new Response(JSON.stringify({ ok: status === 200, error: status === 400 ? 'invalid envelope' : 'busy' }), { status });
    },
  });
  const first = await carrier.post('*', { kind: 'ops', n: 1 });
  assertEquals(first.queued, true);
  busy = false;
  const second = await carrier.post('*', { kind: 'ops', n: 2 });
  assertEquals(second.delivered, true, 'another entry rejection cannot hide this acknowledgement');
  assertEquals(second.queued, false);
  assertEquals(second.error, undefined);
  assertEquals(carrier.stats.acked, 1, 'only the second entry was acknowledged');
  assertEquals(carrier.outbox.size, 0);
  assert(carrier.stats.lastError.includes('400'), 'the other entry rejection remains surfaced');
});

test('M5 relay carrier: an unreachable fleet queues the frame instead of dropping it', async () => {
  let up = false;
  const node = stubNode();
  const carrier = new RelayCarrier({
    peerId: 'alice',
    urls: ['http://node.test'],
    seal: stubSeal,
    open: stubOpen,
    fetchImpl: (url, init) => (up ? node.fetchImpl(url, init) : Promise.reject(new TypeError('failed to fetch'))),
  });
  const result = await carrier.post('*', { kind: 'ping' });
  assertEquals(result.delivered, false);
  assertEquals(result.queued, true, 'presence gossip degrades, it does not throw');
  assertEquals(carrier.outbox.size, 1, 'the frame waits in the outbox');
  up = true;
  const flush = await carrier.flush();
  assertEquals(flush.ok, true, 'the next flush delivers it');
  assertEquals(carrier.outbox.size, 0);
  assertEquals(node.calls.posts, 1);
});
