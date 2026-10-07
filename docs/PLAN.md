# Project Singularity — build plan

Derived from `Impossible_Website_Challenge.pdf`. This is the plan the
implementation follows, including the decisions about what *not* to build.

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
properly. So the plan is:

**Pick the modules where a complete, honest implementation is reachable, and
declare the rest as partial rather than faking them.**

| Module | Plan | Why |
|--------|------|-----|
| M1 CRDT editor | **Full** | Self-contained, testable to a proof-like standard with property tests. The crown jewel. |
| M4 E2EE | **Full** | WebCrypto supplies the primitives; the composition (X3DH + Double Ratchet + streaming AEAD) is engineering, not research. |
| M6 offline sync | **Full** | IndexedDB + service worker + versioned migrations is well-trodden. |
| M2 C runtime | **Partial** | clang→WASM is out of reach here, but a *real* lexer/parser/interpreter plus a worker sandbox, terminal and hard kill switch delivers most of the module's engineering value. |
| M3 3D engine | **Partial** | WebGL2 instancing, real shadow maps and GPU particles are achievable; PBR/IBL/glTF/skeletal animation are not, and faking them would be dishonest. |
| M5 mesh | **Partial** | The room/presence/relay/recovery model is implementable and testable; WebRTC+STUN/TURN traversal needs infrastructure this environment does not have. |
| M7 accessibility | **Partial** | Semantics, keyboard model, live regions, text-alternative tree and preferences are real; screen-reader validation was not performed. |
| M8 hardening | **Partial** | Strict CSP, Trusted Types, sandbox isolation and a STRIDE model are real; no live red-team session was run. |

Deliberately **not** attempted at all: WebGPU renderer, OPFS, SAB-based worker
pool, fuzzing harness, chaos/load rigs, 10-minute demo video.

## 3. Build order (following the brief's own advice)

1. **M6 + M8 basics first** — storage and security headers are the foundation
   everything else sits on. Done before any feature code.
2. **M1 CRDT, with properties proven before any networking.** The RGA was built
   and its commutative/idempotent/convergent properties tested *before* a
   transport existed. Three real bugs were found by those tests, not by review.
3. **M5 + M4** — turn the local editor into a private collaborative one.
4. **M2** — the biggest single risk, prototyped early as the brief suggests.
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
  quota, payload) and marks unmeasured budget rows as unmeasured.

## 5. Definition of done for this pass

- [x] Site boots from one URL with no install and no plugins
- [x] 70 automated tests green across 6 suites, runnable from the site itself
- [x] Every module panel does something real, or says what it does not do
- [x] Architecture and STRIDE documents written
- [x] Scorecard published with partials marked as partials
- [ ] Screen-reader validation, WebRTC carrier, clang→WASM, PBR/glTF, red team
