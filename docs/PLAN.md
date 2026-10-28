# Project Singularity — build plan

Derived from `Impossible_Website_Challenge.pdf`. This is the plan the
implementation follows, including the decisions about what *not* to build and a
record of where the plan changed because the work turned out to be reachable.

## 1. What the brief actually asks for

| # | Requirement | Hard part |
|---|-------------|-----------|
| — | Zero runtime dependencies: no React/Vue/jQuery/Three.js/Yjs/Socket.IO/npm in the shipped bundle | everything is hand-written |
| — | Untrusted server: it may only relay ciphertext + discovery metadata | forces real E2EE |
| — | Browser-native first: WebGPU, WebRTC, WebCrypto, WASM, SW, IndexedDB, Workers, OPFS | no polyfills allowed |
| — | One public URL, every module tested, every trade-off written down | tests are part of the grade |

Eight modules (M1 CRDT editor, M2 in-browser C runtime, M3 3D engine, M4 E2EE,
M5 P2P mesh, M6 offline sync, M7 accessibility/i18n, M8 hardening), a
performance budget, and a 1000-point tier ladder.

## 2. Scoping judgement, made explicit

The brief itself says: *20 engineers × 12 months, success rate practically zero*,
and advises a solo attempt to target Bronze/Silver with one or two modules done
properly. So the plan was:

**Pick the modules where a complete, honest implementation is reachable, and
declare the rest as partial rather than faking them.**

| Module | Plan | Why |
|--------|------|-----|
| M1 CRDT editor | **Full** | Self-contained, testable to a proof-like standard with property tests. The crown jewel. Now with cursor-indexed lookups (no rescans), watermark-bounded tombstone collection and op-log trimming. |
| M4 E2EE | **Full** | WebCrypto supplies the primitives; the composition (X3DH + Double Ratchet + streaming AEAD) is engineering, not research. The signed prekey bundle is verified inside the handshake, before any key material exists. |
| M6 offline sync | **Full** | IndexedDB + service worker + versioned migrations is well-trodden, and the scope-relative paths make the offline shell work under a subpath deployment. |
| M2 C/C++ runtime | **Partial**, with real compilation | Self-hosted Clang 8.0.1 compiles C/C++ and standard libraries to restricted WASI WebAssembly in a disposable worker. The lightweight C-subset interpreter remains independently available with deterministic step/heap/depth budgets and a bounds-checked arena. Neither mode implements an operating system or every C/C++ program. |

## 3. What was actually measured (evidence, not aspiration)

The plan's performance and load rows were executed at the smallest honest scale
and the artifacts are committed. The payload row is re-measured from the current
working tree; the load, chaos and failover rows retain historical report evidence,
not fresh validation of the persistence corrections. `tools/check-docs.js` checks
those figures against their respective sources:

| Plan row | Executed as | Evidence |
|----------|-------------|----------|
| Initial JS payload | **122.2 KiB** gzip JS cold load + 26.9 KiB gzip CSS = 149.1 KiB gzip, 482.5 KiB raw over 15 initial files (14 JS + stylesheet), against the 170 KB JS ceiling - met; M2/M3/M4, the WebRTC/relay half of M5 and M9 SINGU AI load on demand; 18 deferred files total 119.9 KiB gzip JS, plus a separate approximately 18.4 MiB compressed toolchain asset set | `tools/payload.js`, LOAD_CHAOS.md section 1 |
| Concurrent users | **1,000 simulated clients** through the ciphertext relay: 50,000 envelopes, all delivered, 0 lost, p95 12.2 ms | `docs/reports/relay-load.json` |
| Chaos survival | `SIGKILL` with 20,000 envelopes pending: all replayed from the log after a **256 ms outage** | `docs/reports/relay-chaos.json` |
| Failover | primary killed for good, backlog re-posted from client outboxes to a standby: 0 lost, 0 duplicated, kill to first accepted post **1322 ms** | `docs/reports/relay-failover.json` |

What the plan does not claim: a 10,000-session rig (none exists), a cluster
(two relay processes on one laptop), or a bundled TURN relay.

## 4. Project-wide improvement plan — 2026-10-28

The current implementation is the baseline, not the earlier ambition labels.
Implement confirmed safety and correctness fixes before adding speculative features.
The acceptance column lists required checks, not historical evidence for the changes.
Real-browser regressions exercise pending OPFS writes, failed IndexedDB append
recovery, mesh snapshot adoption and reloads. Fresh compiler downloads on this
machine can be intercepted by IDM; the asset-specific HTTP error is reported,
not hidden by a fallback or a weakened security policy.

| Priority | Change | Acceptance gate |
|----------|--------|-----------------|
| P1 | Serialize ratchet and sender-chain state; commit receive state only after authentication | Concurrent messages use distinct keys; a tampered frame cannot prevent authentic delivery |
| P1 | Make equal-timestamp CRDT delete/undo deterministic and observe remote effect clocks | Delivery permutations converge on identical text and history digests |
| P1 | Preserve causal operation history when saving text snapshots; restore valid empty documents | Snapshot followed by edits and delete-all both survive reopen without losing text |
| P1 | Drain pending writes before snapshots/compaction; retain failed batches for rejection recovery | Writes queued during a flush are also awaited; a rejected append prevents snapshot success; a later enqueue retries retained causal operations and the queue resumes |
| P1 | Distinguish relay acknowledgement, terminal rejection and retryable backpressure | 429 retains the sealed outbox; 400/413 never report delivery; 200 acknowledges once |
| P1 | Add self-hosted Clang/WebAssembly alongside the lightweight interpreter | Real C/C++ projects, headers, stdin, diagnostics, exit status and hard worker termination run locally |
| P1 | Reject malformed glTF containers, accessor bounds and cyclic node graphs | Invalid fixtures fail promptly; valid interleaved geometry still loads |
| P1 | Enforce dev-server path boundaries and scope service-worker cache ownership | Encoded backslashes/HEAD cannot disclose private files; sibling caches survive activation |
| P2 | Synchronize ghost edits, preserve backslashes in editable controls, and own asynchronous panel runs | Real typing keeps model and textarea equal; stale runs cannot overwrite newer results |
| P2 | Dispose renderer resources and panel timers on departure and failed uploads | Repeated visits and injected upload failures release owned resources |
| P2 | Reconcile documentation, test counts and measured payloads; validate the generated artifact | Node and browser regressions, actual UI workflows, artifact tests, headers and documentation checks pass |

The compiler targets the bundled Clang 8.0.1 WASI toolchain: C through C11 and
C++ through C++17, without C++ exceptions, native OS APIs, networking or threads.
Compiler assets are compressed, integrity-checked, self-hosted and loaded on demand;
programs receive only restricted WASI console, clock and random capabilities.
This intentionally replaces the original zero-runtime-dependency constraint for
M2 only; the application shell remains framework-free with no npm dependencies.
A text snapshot is not an identity-preserving CRDT checkpoint, so durable operation
history is retained rather than claiming unsafe bounded-log compaction.

No new cloud backend, accounts, external source upload, deployment, score increase,
independent security audit or unmeasured device guarantees are part of this plan.
