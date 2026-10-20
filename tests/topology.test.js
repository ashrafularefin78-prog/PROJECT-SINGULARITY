/**
 * M5 hybrid topology.
 *
 * The room shape is computed locally by every peer, so it has to be a pure
 * function of the sorted peer list: same list, same plan, no coordinator. These
 * tests pin determinism, the mesh/tree switch, the fan-out bound, and the
 * loop-free forwarding rule.
 */
import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { describeTopology, forwardTargets, neighbors, planTopology } from '../src/collab/topology.js';
import { DEFAULT_ICE_SERVERS, iceServersWithTurn, turnServers } from '../src/collab/webrtc.js';

test('M5 topology: a small room is a full mesh', () => {
  const plan = planTopology(['c', 'a', 'b'], { meshLimit: 6 });
  assertEquals(plan.mode, 'mesh');
  assertDeepEquals(plan.order, ['a', 'b', 'c'], 'ids are sorted');
  assertDeepEquals(forwardTargets(plan, 'a'), ['b', 'c'], 'mesh forwards to everyone');
  assertEquals(plan.root, null);
});

test('M5 topology: a large room becomes a deterministic tree', () => {
  const ids = Array.from({ length: 21 }, (_, i) => `peer-${String(i).padStart(2, '0')}`);
  const plan = planTopology(ids, { meshLimit: 6, fanout: 4 });
  assertEquals(plan.mode, 'tree');
  assertEquals(plan.root, 'peer-00');
  assertEquals(plan.parent.get('peer-00'), null);
  assertEquals(plan.parent.size, ids.length, 'every peer is connected');
  for (const [id, kids] of plan.children) {
    assert(kids.length <= 4, `${id} exceeds the fan-out`);
    for (const kid of kids) assertEquals(plan.parent.get(kid), id, 'parent/child agree');
  }
  const maxDepth = Math.max(...plan.depth.values());
  assert(maxDepth >= 2, `a 21-peer tree has depth, got ${maxDepth}`);
  assertEquals(describeTopology(plan).includes('relayed tree'), true);
});

test('M5 topology: every peer computes the same plan regardless of input order', () => {
  const ids = ['p5', 'p1', 'p9', 'p3', 'p7', 'p2', 'p8', 'p4', 'p6'];
  const a = planTopology(ids, { meshLimit: 3 });
  const b = planTopology(ids.slice().reverse(), { meshLimit: 3 });
  assertEquals(a.root, b.root);
  for (const id of ids) {
    assertEquals(a.parent.get(id), b.parent.get(id), `${id} parent`);
    assertDeepEquals(a.children.get(id), b.children.get(id), `${id} children`);
    assertEquals(a.depth.get(id), b.depth.get(id), `${id} depth`);
  }
});

test('M5 topology: forwarding is loop-free and never echoes to the sender', () => {
  const plan = planTopology(Array.from({ length: 12 }, (_, i) => `n${i}`), { meshLimit: 4, fanout: 3 });
  for (const id of plan.order) {
    const from = plan.parent.get(id) || plan.children.get(id)[0];
    const targets = forwardTargets(plan, id, from);
    assert(!targets.includes(id), 'never forwards to itself');
    assert(!targets.includes(from), 'never echoes to the sender');
    assertDeepEquals(targets, neighbors(plan, id).filter((n) => n !== from));
  }
});

test('M5 topology: a single peer is a valid, empty mesh', () => {
  const plan = planTopology(['solo']);
  assertEquals(plan.mode, 'mesh');
  assertDeepEquals(forwardTargets(plan, 'solo'), []);
});

test('M5 TURN: configured relays are validated and appended after STUN', () => {
  const turn = turnServers({ urls: ['turn:turn.example.org:3478', 'turns:turn.example.org:5349'], username: 'u', credential: 'c' });
  assertDeepEquals(turn[0].urls, ['turn:turn.example.org:3478', 'turns:turn.example.org:5349']);
  const list = iceServersWithTurn({ urls: 'turn:turn.example.org:3478', username: 'u', credential: 'c' });
  assertEquals(list[0].urls, DEFAULT_ICE_SERVERS[0].urls, 'STUN stays first');
  assertDeepEquals(list.slice(1), turnServers({ urls: 'turn:turn.example.org:3478', username: 'u', credential: 'c' }));
  assertEquals(iceServersWithTurn(null), DEFAULT_ICE_SERVERS, 'null keeps STUN only');
});

test('M5 TURN: a non-TURN url and a half-configured credential are rejected', () => {
  let badUrl = false;
  let badCredential = false;
  try {
    turnServers({ urls: 'stun:stun.example.org' });
  } catch {
    badUrl = true;
  }
  try {
    turnServers({ urls: 'turn:turn.example.org', username: 'u' });
  } catch {
    badCredential = true;
  }
  assert(badUrl, 'a STUN url is not accepted as TURN');
  assert(badCredential, 'username without credential is rejected');
});
