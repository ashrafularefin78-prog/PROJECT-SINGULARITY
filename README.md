# Project Singularity

An attempt at *The Impossible Website Challenge*: one page that behaves like an
operating system, a collaborative workspace, a game engine and a secure
messenger at once — with **zero runtime dependencies** and no framework in the
shipped bundle.

Everything is hand-written against browser APIs: the CRDT, the C front end, the
renderer, the crypto composition, the storage layer and the DOM code. There is
no bundler, no transpiler, and no file in `src/` imported from npm.

## Run it

Anything that can serve static files works. Python is enough (Node is *not*
required anywhere in this project):

```bash
python3 tools/serve.py 5173
# → http://127.0.0.1:5173/
```

Opening `index.html` straight from disk (`file://`) cannot work: browsers block
ES module loading on `file://` pages, so the shell stays empty by design. The
page detects this and shows a notice with the command above instead of
pretending to load.

`tools/serve.py` sends the production security headers locally (strict CSP,
Trusted Types, COOP/COEP), so the app is always exercised under the policy it
ships with.

## Verify it

The test suite runs **in the browser** against the same modules the app uses —
no build step, no test framework to install:

```
http://127.0.0.1:5173/tests/browser.html
```

70 tests across 6 suites (~0.8 s). Each suite also runs standalone from
`tests/*.test.js`; `tests/run.js` is a Node runner for environments that have it.

| Suite | Covers |
|-------|--------|
| `rga.test.js` | CRDT convergence, causality, idempotence, undo/redo replication |
| `crypto.test.js` | X3DH, Double Ratchet, replay/tamper rejection, groups, file streaming |
| `compiler.test.js` | lexer/parser/interpreter, diagnostics with line+column, resource budgets |
| `storage.test.js` | IndexedDB round-trip, compaction, file frames, v1→v2 migration |
| `mesh.test.js` | presence, isolation between rooms, pruning, ciphertext-only relay |
| `renderer.test.js` | 3D maths, real WebGL2 initialisation and a rendered frame |

## What is real, and what is not

| Module | Status | Notes |
|--------|--------|-------|
| M1 Collaborative editor | **Full** | Own RGA CRDT, live cursors, per-user undo, offline merge |
| M4 End-to-end encryption | **Full** | X3DH + Double Ratchet + safety numbers + group epochs + streaming file AEAD |
| M6 Offline-first storage | **Full** | IndexedDB op log, snapshots, quota, migrations, service worker |
| M2 In-browser C runtime | **Partial** | Real compiler for a C subset + worker sandbox + terminal + kill switch. *Not clang/TCC in WASM* |
| M3 3D engine | **Partial** | WebGL2 instancing, shadow maps, 1M GPU particles. *No PBR/IBL, glTF, or WebGPU* |
| M5 Peer mesh | **Partial** | Rooms, presence, recovery, relay contract over BroadcastChannel. *Not WebRTC/STUN/TURN* |
| M7 Accessibility | **Partial** | Semantics, keyboard model, live regions, text alternative, motion/contrast/scale/RTL/visual-effects preferences. *Not screen-reader validated* |
| M8 Hardening | **Partial** | Strict CSP, Trusted Types, sandbox isolation, STRIDE model. *No red-team session* |

**Honest score: 505 / 1000.** Read the ladder the way the brief actually writes
it and there are two different questions: the raw points fall in the **Gold**
band (450–750), but each tier also has a *requirement*, and Gold needs six
modules plus the budget mostly met plus M8 passed. That is not true here, so by
requirement the build lands on **Silver**: four modules genuinely working, plus
real integration. The in-app scorecard shows both readings side by side. The
brief budgets 20 engineers × 12 months for the 1000-point build and calls it
practically impossible; see [docs/PLAN.md](docs/PLAN.md) for the reasoning.

## Layout

```
index.html              app shell
styles/app.css          all styling (no framework, no preprocessor)
src/app.js              the shell that wires the eight modules together
src/crdt/rga.js         RGA CRDT
src/runtime/            C lexer → parser → interpreter, worker, sandbox
src/graphics/           3D maths + WebGL2 renderer
src/crypto/e2ee.js      X3DH, Double Ratchet, safety numbers, group keys, file AEAD
src/collab/mesh.js      rooms, presence, ciphertext-only relay
src/storage/db.js       IndexedDB with versions and migrations
src/security/policy.js  Trusted Types policy + safe DOM helper
sw.js                   service worker (offline shell)
tests/                  browser test suite
tools/serve.py          static server with production headers
docs/                   PLAN.md, ARCHITECTURE.md, THREAT_MODEL.md
```

## Try the interesting bits

- **Two tabs, one document.** Open the app twice; both edit the same CRDT via
  BroadcastChannel and merge live.
- **Airplane mode.** In M1, go offline, keep typing, then go online: a full-state
  sync merges everything with no lost characters.
- **Kill an infinite loop.** In M2, load the infinite-loop sample and run it.
- **Prove the relay is blind.** In M4, send a message and read the relay
  inspector — every field it can see is listed.
- **Drive it from the keyboard.** **Ctrl/⌘ + K** opens the command palette from
  anywhere: module jumps, the offline toggle, virtual peers, log compaction,
  persistent storage, the clipboard, and every accessibility preference. Each
  command calls the same function its button calls, so there is no second
  implementation to drift. **Alt + 1…8** jumps straight to a module (the number
  matches its tab label).
- **Switch the future off.** In M7 set *Visual effects* to **Off**: the aurora,
  scanlines, sweeping light and perspective floor disappear and nothing else
  changes, because they are decorative layers painted under a flat layout. The
  telemetry strip in the header keeps reporting regardless.

## License

MIT — see [LICENSE](LICENSE). In short: use it, modify it, ship it, sell it,
provided the copyright notice and permission notice travel with it. There is no
warranty of any kind, which matters here for one specific reason: M4's crypto is
composed from WebCrypto primitives and tested, but it has never been through an
independent audit, and M8's threat model is documented rather than certified. If
you want to protect real secrets with it, get it reviewed first.
