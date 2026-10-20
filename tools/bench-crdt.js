/**
 * Measure the CRDT at the size the brief asks about, and prove the result.
 *
 *   node tools/bench-crdt.js --chars=1000000 --replicas=50
 *
 * Two questions, two runs:
 *
 *   1. Scale - how long does it take one replica to type N characters, what
 *      does each operation cost, how big is the serialised document, and how
 *      long does a re-index / random-access probe take at that size? A CRDT
 *      that is fast at 10k and quadratic at 1M is not a CRDT you can ship.
 *   2. Convergence - do M replicas that edit concurrently, with their ops
 *      delivered in a different order to each of them, end up with byte-equal
 *      text *and* the same structural digest? Text alone is not enough: two
 *      peers can show the same characters with different ids, and the next edit
 *      would then fork the document. `src/crdt/history.js` supplies the digest,
 *      so the benchmark and the M1 temporal card agree on what agreeing means.
 *
 * Output is JSON on stdout so it can be committed as an artifact:
 *
 *   node tools/bench-crdt.js > docs/reports/crdt-scale.json
 */
import { RGA } from '../src/crdt/rga.js';
import { stateDigest } from '../src/crdt/history.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const CHARS = Number(arg('chars', 1000000));
const REPLICAS = Number(arg('replicas', 50));
if (!Number.isFinite(CHARS) || CHARS < 1) throw new Error('--chars must be a positive integer');
if (!Number.isFinite(REPLICAS) || REPLICAS < 2) throw new Error('--replicas must be at least 2');

/** Deterministic PRNG: the same run twice must print the same numbers. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

// ---------------------------------------------------------------- 1. scale

const replica = new RGA('bench');
const rand = mulberry32(0xC0FFEE);
const text = new Array(CHARS);
for (let i = 0; i < CHARS; i += 1) text[i] = String.fromCharCode(97 + (i % 26));
const source = text.join('');

const tType = now();
// Typing is append-mostly with a few interior edits, which is what an editor
// actually does. The interior edits are what force the index walk; appending
// alone would only measure the fast path. A plain array records the same
// edits, so "the CRDT reproduced the document" is checked against a model
// rather than against the input order, which interior typing deliberately
// breaks.
const model = [];
for (let i = 0; i < CHARS; i += 1) {
  let cursor = model.length;
  if (i % 5000 === 4999) cursor = (cursor * 31 + 7) % (model.length + 1);
  replica.localInsert(cursor, source[i]);
  model.splice(cursor, 0, source[i]);
}
const typeMs = now() - tType;

const identical = replica.text() === model.join('');
const stats = replica.stats();

const tRead = now();
let checksum = 0;
for (let i = 0; i < 10000; i += 1) {
  const at = Math.floor(rand() * stats.visible);
  const node = replica.nodeAtVisible(at);
  checksum = (checksum * 31 + (node ? node.ch.charCodeAt(0) : 0)) | 0;
}
const randomAccessMs = now() - tRead;

const serialised = JSON.stringify(replica.log);
const logBytes = Buffer.byteLength(serialised, 'utf8');

// ----------------------------------------------------------- 2. convergence

/** Replicas that start empty, edit concurrently, then exchange ops shuffled. */
function converge(count) {
  const peers = [];
  const local = mulberry32(0x5EED);
  for (let i = 0; i < count; i += 1) {
    const peer = new RGA(`r${i}`);
    // Each replica starts from the same 40-character prefix so the merge has a
    // shared history, then diverges: 30 inserts and a couple of deletes.
    if (i === 0) peer.localInsert(0, 'shared prefix: the quick brown fox jumps over ');
    peers.push({ peer, ops: peer.log.slice() });
  }
  // Seed every peer with replica 0's ops before they edit, in a different
  // order per peer, so causality is exercised rather than assumed.
  const seed = peers[0].ops;
  for (let i = 1; i < count; i += 1) {
    const order = seed.slice().sort((a, b) => ((a.id[0] * 7919 + i) % 101) - ((b.id[0] * 7919 + i) % 101));
    peers[i].peer.merge(order);
    peers[i].ops = peers[i].peer.log.slice();
  }

  const tConcurrent = now();
  for (let i = 0; i < count; i += 1) {
    const { peer } = peers[i];
    const before = peer.log.length;
    for (let k = 0; k < 30; k += 1) {
      const at = Math.floor(local() * (peer.visible + 1));
      peer.localInsert(at, String.fromCharCode(65 + ((i * 7 + k) % 26)));
    }
    if (peer.visible > 4 && i % 3 === 0) peer.localDelete(Math.floor(local() * (peer.visible - 2)), 2);
    peers[i].newOps = peer.log.slice(before);
  }
  const editMs = now() - tConcurrent;

  // Deliver every peer's fresh ops to every other peer, in a per-peer shuffle.
  const tMerge = now();
  for (let dst = 0; dst < count; dst += 1) {
    for (let src = 0; src < count; src += 1) {
      if (src === dst) continue;
      const ops = peers[src].newOps.slice();
      for (let k = ops.length - 1; k > 0; k -= 1) {
        const j = Math.floor(local() * (k + 1));
        [ops[k], ops[j]] = [ops[j], ops[k]];
      }
      peers[dst].peer.merge(ops);
    }
  }
  const mergeMs = now() - tMerge;

  const texts = new Set();
  const digests = new Set();
  for (const { peer } of peers) {
    texts.add(peer.text());
    digests.add(stateDigest(peer));
  }
  const stats = peers[0].peer.stats();
  return {
    replicas: count,
    opsPerReplica: peers.reduce((n, p) => n + p.newOps.length, 0),
    convergedText: texts.size === 1,
    convergedDigest: digests.size === 1,
    digest: [...digests][0],
    visible: stats.visible,
    tombstones: stats.tombstones,
    editMs: Math.round(editMs * 100) / 100,
    mergeMs: Math.round(mergeMs * 100) / 100,
  };
}

const convergence = converge(REPLICAS);

const report = {
  measuredAt: new Date().toISOString(),
  runtime: `node ${process.version}`,
  scale: {
    characters: CHARS,
    typeMs: Math.round(typeMs * 100) / 100,
    msPerOp: Math.round((typeMs / CHARS) * 10000) / 10000,
    opsPerSecond: Math.round((CHARS / typeMs) * 1000),
    visible: stats.visible,
    tombstones: stats.tombstones,
    nodes: stats.items,
    logOps: stats.ops,
    textMatchesInput: identical,
    textLength: replica.text().length,
    randomAccess: { probes: 10000, ms: Math.round(randomAccessMs * 100) / 100, checksum },
    logJsonBytes: logBytes,
    bytesPerChar: Math.round((logBytes / CHARS) * 100) / 100,
  },
  convergence,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!identical || !convergence.convergedText || !convergence.convergedDigest) {
  // A benchmark that measured divergence is a failed run, whatever the timings.
  process.exitCode = 1;
}
