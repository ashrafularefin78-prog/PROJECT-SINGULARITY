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
              worker.js       math.js                     webrtc.js
     ▲            ▲                                            ▲            ▲
     └────────────┴──────────── src/security/policy.js ────────┴────────────┘
                                (Trusted Types + safe DOM)

 src/ui/hud.js  ← the deck: waveform, ticker, frame chrome, module dial
                   (readouts + decorative only; nothing load-bearing)
```

Each module is import-only and free of side effects at import time, which is why
the same files run in Node, in the browser app, and in the test runner without
shims.

| Module | Unit of correctness | Depends on |
|--------|--------------------|-----------|
| `crdt/rga.js` | the op log (commutative, idempotent) + maintenance (collect/trimLog) | nothing |
| `runtime/*` | one worker per run, budgets enforced inside | nothing |
| `graphics/*` | pure maths + a WebGL2 renderer | nothing |
| `crypto/e2ee.js` | WebCrypto only | nothing |
| `collab/mesh.js` | envelopes over a set of pluggable carriers | nothing |
| `collab/webrtc.js` | one data channel per peer, signaled by a pasted code | nothing (browser WebRTC only) |
| `storage/db.js` | IndexedDB schema versions | nothing |
| `security/policy.js` | Trusted Types policy + safe DOM helper | nothing |
| `ui/hud.js` | the deck: readouts (activity waveform, ticker) + chrome (frame, parallax, warp) + the radial module dial | `security/policy.js` (the safe DOM helper) |

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

**Long sessions:** the log would grow without bound, so M1 carries two
maintenance operations. `collect({ graceTs })` removes tombstoned nodes that no
op can still name as an origin, using a watermark derived from what peers have
acknowledged (interior tombstones are kept, because an op can point at one), and
`trimLog(keep)` bounds the in-memory op log while a snapshot remains available
for a peer that is far behind and asks for full state. Both are driven from the
M6 panel and from the command palette, and both report exactly what they removed.

## 3. Trade-offs, and what each one cost

| Decision | Chosen because | Cost paid |
|----------|----------------|-----------|
| **RGA with LWW tombstones** | Order-independence for *both* inserts and deletes; makes undo/redo replicable | Tombstones accumulate; collection is watermark-bounded rather than complete, and interior tombstones are retained forever by design |
| **Linked list, not a rope/index tree** | Correctness first, and legible in ~300 lines | A full scan per lookup would be O(n); mitigated by a cursor that makes sequential edits O(1) amortised (20k appends visit 0 nodes) |
| **Diff the whole textarea** | Zero dependency, tiny, robust for a demo document | O(n) per keystroke; a real editor would use per-input events |
| **Interpret instead of compiling to WASM** | Ships a genuinely safe sandbox with deterministic budgets | Not a C compiler in the spec's sense; slower than native code |
| **Step budget over a CPU timer** | Deterministic and reproducible in tests | A legitimate long computation can be cut short |
| **Two carriers, one mesh protocol** | Tabs collaborate with no server at all, and separate machines get a real peer-to-peer channel | Two failure modes to reason about (ICE failures vs. no BroadcastChannel); no bundled TURN, so symmetric NAT on both ends needs one |
| **Copy-pasted signaling codes** | No signaling server, no third party, no accounts | A human must move one string between machines |
| **Message key → derived nonce** | Structurally impossible to reuse a (key, nonce) pair | Nonce is not random, so it must never be derived from anything but a fresh message key |
| **Strict base64 at every boundary** | One ciphertext has exactly one spelling, so a future MAC-over-text design cannot be fooled | Slightly less tolerant of sloppy pastes (rejected with a reason instead of guessed at) |
| **Network-first for scripts/styles** | A deploy is picked up on the next load | One extra round trip when online |
| **No `innerHTML` anywhere** | The strict CSP is free, XSS surface is zero | Slightly more verbose DOM construction |
| **Panels rendered on demand** | Small initial payload, no hidden timers | Panels rebuild their DOM when revisited |

## 4. M5: how the WebRTC carrier was added without a rewrite

`Mesh` splits carrier from protocol, so the upgrade was contained:

```js
mesh.send(kind, payload)          // what the app calls
mesh.attachRtc(rtc) / detachRtc() // what the app does when signaling completes
mesh.onMessage(kind, payload, from)
mesh.peers()                      // each peer reports the carrier it was heard on
```

`collab/webrtc.js` owns everything specific to the transport: two
`RTCPeerConnection`s, one data channel, `SNG1:`-prefixed invite/answer codes
(`encodeSignal`/`decodeSignal`, both validating untrusted input), ICE gathering
with a bounded timeout, and per-link state. `mesh.js` keeps presence, pruning,
the ciphertext-only relay and flood control, and tags each peer with the
strongest carrier it has been heard on (`webrtc` beats `tab`) so the UI cannot
downgrade a badge because a stray BroadcastChannel packet arrived later. The
same `_receive` path handles both carriers, which is why the M1 editor, cursors
and undo did not change at all when WebRTC was added.

## 5. Security architecture (short version)

- **Untrusted server contract:** the only object that crosses the boundary is
  `{ to, from, header, ct }`. `CiphertextRelay.inspect()` exists to *prove* this
  in the UI: it lists every field the relay can read.
- **Sandbox:** user C never executes on the main thread. The runtime worker has
  no DOM, no storage, no crypto, no network, and is terminated rather than
  asked to stop.
- **CSP:** no `unsafe-inline`, no `unsafe-eval`, `require-trusted-types-for
  'script'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
  COOP `same-origin` + COEP `require-corp`. Delivered as a header by the server
  and as a meta tag by the document, so a host that cannot set headers still
  enforces the script policy.
- Full detail, residual risk and what is out of scope: [THREAT_MODEL.md](THREAT_MODEL.md);
  executed evidence and findings: [SECURITY_REPORT.md](SECURITY_REPORT.md).

## 6. What is deliberately missing

WebGPU renderer, OPFS for large binaries, a SharedArrayBuffer worker pool, an
OffscreenCanvas render loop, a bundled TURN relay, image-based lighting from an
HDRI probe, skeletal animation, clang→WASM, screen-reader
validation, a red-team session, a 10,000-session distributed load rig, a multi-node cluster, and a
narrated 10-minute demo video. None of these are stubbed with fake behaviour:
they simply do not exist, and the scorecard, [PLAN.md](PLAN.md) and
[LOAD_CHAOS.md](LOAD_CHAOS.md) say so in those words.
