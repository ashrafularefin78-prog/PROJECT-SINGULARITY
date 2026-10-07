# Architecture

## 1. Module boundaries

```
                      ┌──────────────────────────────┐
   index.html ───────►│  src/app.js  (shell + panels)│
                      └───────────────┬──────────────┘
                                      │
     ┌────────────┬───────────────┬───┴────────┬──────────────┬─────────────┐
     ▼            ▼               ▼            ▼              ▼             ▼
 src/crdt     src/runtime     src/graphics  src/crypto   src/collab   src/storage
 rga.js       sandbox.js      renderer.js   e2ee.js      mesh.js      db.js
              worker.js       math.js
     ▲            ▲                                            ▲            ▲
     └────────────┴──────────── src/security/policy.js ────────┴────────────┘
                                (Trusted Types + safe DOM)
```

Each module is import-only and free of side effects at import time, which is why
the same files run in Node, in the browser app, and in the test runner without
shims.

| Module | Unit of correctness | Depends on |
|--------|--------------------|-----------|
| `crdt/rga.js` | the op log (commutative, idempotent) | nothing |
| `runtime/*` | one worker per run, budgets enforced inside | nothing |
| `graphics/*` | pure maths + a WebGL2 renderer | nothing |
| `crypto/e2ee.js` | WebCrypto only | nothing |
| `collab/mesh.js` | envelopes over a pluggable carrier | nothing |
| `storage/db.js` | IndexedDB schema versions | nothing |
| `security/policy.js` | Trusted Types policy + safe DOM helper | nothing |

## 2. Data flow: an edit, end to end

```
keystroke
  └─► textarea input event
        └─► diffText(before, after)              single-hunk diff
              └─► rga.localDelete / localInsert  ← the CRDT is the source of truth
                    ├─► broadcastOps(ops)  ──► mesh.send('ops') ──► peers
                    ├─► persist(ops)       ──► IndexedDB append-only log
                    └─► updateDocMeta()    ──► counters on screen

remote 'ops' message
  └─► integrateOps → rga.merge        (idempotent: duplicates are free)
        ├─► applyRemoteToTextarea()   caret preserved
        ├─► persist(new ops only)
        └─► updateDocMeta()
```

**Why the CRDT is authoritative and the textarea is a projection:** a textarea
cannot express concurrency. Local text is re-read from the CRDT immediately
after every edit, so the textarea can never drift from the model.

**Offline:** ops stop being broadcast but keep accumulating locally. On
reconnect a `sync-request` asks every peer for their full log. Because merges are
commutative and idempotent, replaying everything reconstructs the exact same
document on every replica — that is what makes "zero lost characters" a
property rather than a hope.

## 3. Trade-offs, and what each one cost

| Decision | Chosen because | Cost paid |
|----------|----------------|-----------|
| **RGA with LWW tombstones** | Order-independence for *both* inserts and deletes; makes undo/redo replicable | Tombstones accumulate; no GC pass yet (compaction only snapshots) |
| **Linked list, not a rope/index tree** | Correctness first, and legible in ~250 lines | Character lookup by index is O(n); a 1M-char document would need an index tree |
| **Diff the whole textarea** | Zero dependency, tiny, robust for a demo document | O(n) per keystroke; a real editor would use per-input events |
| **Interpret instead of compiling to WASM** | Ships a genuinely safe sandbox with deterministic budgets | Not a C compiler in the spec's sense; slower than native code |
| **Step budget over a CPU timer** | Deterministic and reproducible in tests | A legitimate long computation can be cut short |
| **BroadcastChannel as the mesh carrier** | Real multi-tab collaboration with no server at all | No cross-machine P2P; WebRTC is unimplemented |
| **Message key → derived nonce** | Structurally impossible to reuse a (key, nonce) pair | Nonce is not random, so it must never be derived from anything but a fresh message key |
| **Network-first for scripts/styles** | A deploy is picked up on the next load | One extra round trip when online |
| **No `innerHTML` anywhere** | The strict CSP is free, XSS surface is zero | Slightly more verbose DOM construction |
| **Panels rendered on demand** | Small initial payload, no hidden timers | Panels rebuild their DOM when revisited |

## 4. M5 upgrade path: BroadcastChannel → WebRTC

`Mesh` deliberately splits carrier from protocol:

```js
mesh.send(kind, payload)     // interface the app uses
mesh.onMessage(kind, payload, from)
mesh.peers()
```

Replacing the carrier means swapping three internals — `start()` creating an
`RTCPeerConnection` per peer, `_send` fanning out over data channels, and
`_heartbeat` using the signalling channel for discovery — while presence
pruning, the room model, `CiphertextRelay` and every caller stay untouched.
The app has no knowledge of the transport, which is exactly why this is a
contained change rather than a rewrite.

## 5. Security architecture (short version)

- **Untrusted server contract:** the only object that crosses the boundary is
  `{ to, from, header, ct }`. `CiphertextRelay.inspect()` exists to *prove* this
  in the UI: it lists every field the relay can read.
- **Sandbox:** user C never executes on the main thread. The runtime worker has
  no DOM, no storage, no crypto, no network, and is terminated rather than
  asked to stop.
- **CSP:** no `unsafe-inline`, no `unsafe-eval`, `require-trusted-types-for
  'script'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
  COOP `same-origin` + COEP `require-corp`.
- Full detail, including residual risk and what is out of scope, is in
  [THREAT_MODEL.md](THREAT_MODEL.md).

## 6. What is deliberately missing

WebGPU renderer, OPFS for large binaries, SharedArrayBuffer worker pool,
CRDT tombstone GC, fuzzing harness, load and chaos rigs, screen-reader
validation, WebRTC/STUN/TURN, clang→WASM, PBR/IBL/glTF, and the 10-minute demo
video. None of these are stubbed with fake behaviour: they simply do not exist,
and the scorecard says so.
