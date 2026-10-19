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
| M2 C runtime | **Partial** | clang→WASM is out of reach here, but a *real* lexer/parser/interpreter plus a worker sandbox, terminal and hard kill switch delivers most of the module's engineering value. Grew during the build: ternary, switch/fall-through, structs (nested, arrays, by value, heap-linked), casts, do/while, malloc/calloc/realloc/free/memcpy/memset and scanf. |
| M3 3D engine | **Partial** | WebGL2 instancing, a real depth-only shadow pass with hardware PCF, GPU particles and a Cook-Torrance BRDF were all reachable and are in, and the panel draws a real glTF 2.0 binary (`assets/models/singularity-core.glb`) through the same BRDF, sampling base-colour and normal maps from the file. Image-based lighting from an HDRI probe and skeletal animation are the remaining M3 gaps — and faking them would be dishonest. |
| M5 mesh | **Partial** | The room/presence/relay/recovery model is implementable and testable, and **this changed during the build**: WebRTC data channels were reachable without infrastructure, so the mesh now runs two carriers (tabs over BroadcastChannel, machines over WebRTC with copy-pasted signaling). TURN is still not bundled. |
| M7 accessibility | **Partial** | Semantics, keyboard model, live regions, text-alternative tree and preferences are real; screen-reader validation was not performed. |
| M8 hardening | **Partial** | Strict CSP (header *and* meta tag), Trusted Types, sandbox isolation, per-peer ingress flood control and a STRIDE model are real; no live red-team session was run. |

Still deliberately **not** attempted at all: WebGPU renderer, OPFS, a
SharedArrayBuffer worker pool, an OffscreenCanvas render loop, a bundled TURN
relay, and a **10-minute narrated demo video** (the brief's deliverable list asks
for one; it was not recorded, and [DEMO.md](DEMO.md) is the tour script a
narrator would follow instead - with the expected output of every step, which
also makes it a manual acceptance test).

The parser/crypto **fuzzer** was originally in this "not attempted" list and
moved out of it: a seeded, deterministic fuzzer for the C front end, the CRDT,
the ciphertext decoders and the signaling parser is now part of the suite
(`tests/fuzz.test.js`, 11 tests). It immediately found two real defects — a
numeric literal that could overflow to `Infinity`, and `atob`-based decoders that
silently normalised non-canonical base64 — which is the argument for having it.

## 3. Build order (following the brief's own advice)

1. **M6 + M8 basics first** — storage and security headers are the foundation
   everything else sits on. Done before any feature code.
2. **M1 CRDT, with properties proven before any networking.** The RGA was built
   and its commutative/idempotent/convergent properties tested *before* a
   transport existed. Three real bugs were found by those tests, not by review.
3. **M5 + M4** — turn the local editor into a private collaborative one, then
   make the transport real (WebRTC) once the model underneath it was proven.
4. **M2** — the biggest single risk, prototyped early as the brief suggests, then
   grown feature by feature with a test for every construct added.
5. **M3 + M7** — the engine, and accessibility designed in rather than bolted on.
6. **Integration, budget measurement, honest scorecard.**

## 4. Engineering rules adopted for the whole codebase

- **No build step.** Plain ES modules served as-is. Nothing to install.
- **No `innerHTML`, ever.** DOM is built with `createElement`/`textContent`, so
  the strict CSP is compatible with the code rather than something to work
  around. Trusted Types is left enforced in development.
- **Fail closed.** Every failure path throws or reports; nothing is swallowed
  into a silent default.
- **Budgets are explicit and tested.** Step limits, heap caps, depth caps and
  wall-clock kills are all asserted in the test suite.
- **Measure, don't claim.** The dashboard reads live numbers (FPS, op counts,
  quota, payload) and marks unmeasured budget rows as unmeasured. The same rule
  applies to the tier ladder: it shows the points band *and* grades each tier's
  requirement from the scorecard, because those two answers differ here.

## 5. Where the score actually lands

| Reading | Answer | Why |
|---------|--------|-----|
| Points (of the brief's 1000) | **680** | 95 + 88 + 90 + 92 + 88 + 92 + 55 + 78 across the eight modules, before the budget and integration rows. M4 90 → 92 (sealing wired into initCrypto, persisted in IndexedDB). M8 at 78 (no red-team or ZAP yet). M3 at 90 (GGX prefilter). |
| Points band | **Gold** (450–750) | Purely arithmetic. |
| Tier by *requirement* | **Bronze** | The brief's own table asks for "2 modules working independently" at Bronze and "4 modules plus basic integration" at Silver. Three modules are complete (M1, M4, M6) and five are partial, so Silver misses by one module. |
| Budget row (100 pts) | **Partly evidenced, not claimable** | Payload is over (173.8 KiB gzip vs 170 KB), the 3D frame rate is met at the defaults (60 FPS) and short at maximum settings (58), the throttled-4G LCP is met at **774 ms** under Slow 4G plus 4x CPU throttling, Lighthouse passes in both form factors (desktop **99 / 100 / 100 / 100**, mobile **100 / 100 / 96 / 100**), and the full 60-minute memory soak is met (the heap at minute 60 holds fewer nodes and less memory than at minute 10). The load and chaos rows now have their smallest honest versions measured: a ciphertext relay at 1,000 simulated clients (50,000 envelopes, 0 lost, 0 duplicated), a SIGKILL-and-replay of that node (20,000 accepted envelopes pending, all replayed, 0 lost, 256 ms outage) and a two-node failover run (the primary killed for good; the same 20,000-envelope backlog re-posted from the client outboxes to a standby, 0 lost, 0 duplicated, kill to first accepted post **1322 ms**); a 10,000-session rig still does not exist, and two relay processes on one laptop are not a fleet. See [LOAD_CHAOS.md](LOAD_CHAOS.md). |
| Integration row (100 pts) | **Partly** | The modules genuinely drive each other (editor ⇄ CRDT ⇄ mesh ⇄ crypto ⇄ storage ⇄ worker sandbox), with tests across the seams; a full end-to-end multi-machine session has not been run by a person. |

## 6. Definition of done for this pass

- [x] Site boots from one URL with no install and no plugins
- [x] 244 automated tests across 15 suites (all 244 green in a browser; 226 pass with 18 browser-only skips under bare Node), runnable from the site itself
- [x] A deterministic fuzzer for the C front end, the CRDT, the crypto decoders
      and the signaling parser
- [x] Every module panel does something real, or says what it does not do
- [x] Architecture, STRIDE threat model and a written security test report
- [x] Load measurements with raw numbers, and the unmeasured rows named
- [x] Scorecard published with partials marked as partials, and the tier read
      both ways (points band vs requirement)
- [x] Demo tour script with the expected output of every step
- [ ] Narrated 10-minute demo video (the script exists; the recording does not)
- [ ] Screen-reader validation, clang→WASM, IBL/skeletal animation, TURN,
      red-team session, chaos rig, narrated demo video
