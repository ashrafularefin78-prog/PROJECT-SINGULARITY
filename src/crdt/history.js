/**
 * Temporal core: deterministic replay of the CRDT op log.
 *
 * The RGA keeps the ops that built the current document, in arrival order. This
 * module treats that log as a program: replay any prefix into a fresh replica
 * and the resulting text must equal the text the live replica held after the
 * same number of ops. Replay the *whole* log in a different order and the
 * structural fingerprint must be identical, because the CRDT's contract is that
 * order never changes the merged state.
 *
 * That is what makes this more than a history widget: it is a second, independent
 * execution path for the same data. If the two paths ever disagree, one of them
 * has a bug, and the fingerprint is how the disagreement becomes visible instead
 * of silently changing someone's document.
 *
 * Two honest limits, both surfaced in the UI rather than hidden here:
 *   - `logTrimmed > 0` means compaction dropped the front of the log, so states
 *     older than the retained window cannot be reconstructed at all;
 *   - the fingerprint covers the visible state (character ids, order and text),
 *     not tombstone bookkeeping, which is allowed to differ between replicas
 *     that have garbage-collected at different times.
 */
import { RGA } from './rga.js';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a over the UTF-16 code units of a string, as a 64-bit BigInt. */
function fnv1a64(text) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/**
 * Canonical serialization of the *visible* state: every character in document
 * order with the id that identifies it. Text alone is not enough - two replicas
 * that independently typed "abc" hold the same characters and are not converged.
 */
export function canonicalState(rga) {
  const parts = [];
  for (let node = rga.head.next; node; node = node.next) {
    if (node.deleted) continue;
    parts.push(JSON.stringify([node.id[0], node.id[1], node.ch]));
  }
  return parts.join('\u0000');
}

/**
 * A 16-hex-character structural fingerprint. Stable across replicas that have
 * merged the same ops; different for the same text built from different ops.
 *
 * This detects accidental divergence (a bug, a dropped op, a bad merge). It is
 * not a cryptographic commitment, and it is not claimed to be one.
 */
export function stateDigest(rga) {
  return fnv1a64(canonicalState(rga)).toString(16).padStart(16, '0');
}

/**
 * Replay the first `upTo` ops of `log` into a fresh replica.
 * Returns the text, its fingerprint, and how many ops are still waiting for a
 * dependency (0 for a self-contained log).
 */
export function replayTo(log, upTo = log.length) {
  const end = Math.max(0, Math.min(Number.isFinite(upTo) ? upTo : log.length, log.length));
  const replica = new RGA('replay');
  replica.merge(log.slice(0, end));
  return {
    ops: end,
    text: replica.text(),
    digest: stateDigest(replica),
    buffered: replica.stats().buffered,
  };
}

/** Deterministic PRNG (mulberry32) so a "shuffled" replay is reproducible. */
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

/** A seeded permutation that never mutates the caller's array. */
export function shuffleOps(log, seed = 0x51a17e57) {
  const out = log.slice();
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Replay the same op set in three orders - forward (arrival), reverse (the
 * worst case for causal delivery) and a seeded shuffle - and compare the
 * fingerprints. `agree` is true only when all three converge.
 */
export function replayReport(log, options = {}) {
  const orders = {
    forward: log.slice(),
    reverse: log.slice().reverse(),
    shuffled: shuffleOps(log, options.seed),
  };
  const results = {};
  for (const [name, ops] of Object.entries(orders)) {
    const replica = new RGA('replay');
    replica.merge(ops);
    results[name] = {
      digest: stateDigest(replica),
      chars: replica.stats().visible,
      buffered: replica.stats().buffered,
    };
  }
  const digests = new Set(Object.values(results).map((r) => r.digest));
  return {
    ops: log.length,
    agree: digests.size === 1,
    digest: results.forward.digest,
    buffered: Math.max(...Object.values(results).map((r) => r.buffered)),
    orders: results,
  };
}
