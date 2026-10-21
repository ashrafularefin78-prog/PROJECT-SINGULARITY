# Project Singularity

[![Live demo](https://img.shields.io/badge/live_demo-GitHub_Pages-6ea8fe)](https://ashrafularefin78-prog.github.io/PROJECT-SINGULARITY/)
[![Tests](https://img.shields.io/badge/tests-267_across_23_suites-57d68d)](#verify-it)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-b39ddb)](#technologies)
[![License](https://img.shields.io/badge/license-MIT-8399b0)](LICENSE)

## Overview

An attempt at *The Impossible Website Challenge*: one page that behaves like an
operating system, a collaborative workspace, a game engine and a secure
messenger at once - with **zero runtime dependencies** and no framework in the
shipped bundle.

Everything is hand-written against browser APIs: the CRDT, the C front end, the
renderer, the crypto composition, the storage layer, the WebRTC mesh and the DOM
code. There is no bundler, no transpiler, and no file in `src/` imported from npm.

## At a glance

| Signal | Value |
|--------|-------|
| Live deployment | <https://ashrafularefin78-prog.github.io/PROJECT-SINGULARITY/> (canonical - one URL, updated by every push to `main`) |
| Built by | **Ashraful Arefin** - Computer Science & Engineering student |
| GitHub | [ashrafularefin78-prog/PROJECT-SINGULARITY](https://github.com/ashrafularefin78-prog/PROJECT-SINGULARITY) |
| Repository signals | **0 stars · 0 forks · 17 commits · 1 author · 0 tagged releases** (snapshot 19 Oct 2026; GitHub is the live source) |
| Tests | **267 across 23 suites**, runnable in the browser from the site itself |
| Runtime dependencies | **0** - no framework, no bundler, no npm package in the shipped bundle |
| Modules | 8 (3 full, 5 partial - each partial says exactly where it stops) |
| Case study | The M0 dashboard carries one engineering decision record per module: problem, decision, trade-off and measured evidence. |
| License | MIT |

The repository is new. If the work is useful, a star is the cheapest way to help
it reach the people it was built for.

## Screenshots

Captured from the running app, not a design mockup. Click any image for the
full-size PNG; the recorded demo is below.

| Dashboard (dark) | Dashboard (daylight) |
|------------------|----------------------|
| [![Dashboard](assets/screenshots/dashboard-dark.png)](assets/screenshots/dashboard-dark.png) | [![Dashboard in daylight](assets/screenshots/dashboard-light.png)](assets/screenshots/dashboard-light.png) |
| **M1 - collaborative editor** | **M3 - 3D engine** |
| [![Editor](assets/screenshots/editor.png)](assets/screenshots/editor.png) | [![3D engine](assets/screenshots/engine.png)](assets/screenshots/engine.png) |
| **Engineering case study (M0)** | |
| [![Engineering case study](assets/screenshots/case-study.png)](assets/screenshots/case-study.png) | One decision record per module on the dashboard: the problem, the architecture choice, the trade-off it bought, and the measurement that backs it. Each row opens in place and links to the live module. |

<p align="center">
  <a href="assets/screenshots/mobile-dashboard.png"><img src="assets/screenshots/mobile-dashboard.png" alt="The dashboard at phone width" width="300" /></a>
  <br /><sub>The same shell at phone width: tabs scroll, telemetry wraps, nothing is hidden.</sub>
</p>

## Installation and run

Anything that can serve static files works. Python is enough (Node is *not*
required anywhere in this project):

```bash
python3 tools/serve.py 5173
# -> http://127.0.0.1:5173/
```

**Demo video:** [docs/demo/demo.mp4](docs/demo/demo.mp4) — 15:19, 8.8 MiB,
recorded from the running app by `node tools/demo.js`. No narration: the script
in [docs/DEMO.md](docs/DEMO.md) is burned in as captions, beat by beat, and
`docs/reports/demo.json` lists which beats performed their interaction.

**Live deployment:** <https://ashrafularefin78-prog.github.io/PROJECT-SINGULARITY/>
- the canonical URL, and the only one this project publishes. GitHub Pages cannot
send response headers, so what arrives there is the CSP carried as a `<meta>` tag
in `index.html`: enforced, but without the three directives the HTML spec forbids
in a meta policy (`frame-ancestors`, COOP, COEP). [`_headers`](_headers) carries
the full set for hosts that read it, and [docs/DEPLOY.md](docs/DEPLOY.md) states
exactly which protection is active where.

Subpath deployments still work, and the server can reproduce one locally, which
is exactly where absolute paths break:

```bash
python3 tools/serve.py 5174 --prefix /PROJECT-SINGULARITY
# -> http://127.0.0.1:5174/PROJECT-SINGULARITY/
```

Opening `index.html` straight from disk (`file://`) cannot work: browsers block
ES module loading on `file://` pages, so the shell stays empty by design. The
page detects this and shows a notice with the command above instead of pretending
to load.

`tools/serve.py` sends the production security headers locally (strict CSP,
Trusted Types, COOP/COEP), so the app is always exercised under the policy it
ships with. `_headers` carries the same policy for hosts that read it, and the
CSP also travels inside `index.html` as a meta tag for hosts that cannot send
headers at all.

## Verify it

The test suite runs **in the browser** against the same modules the app uses - no
build step, no test framework to install:

```
http://127.0.0.1:5173/tests/browser.html
```

**267 tests across 23 suites** (~3 s in a real browser, of which 18 need it). Each
suite also runs standalone from `tests/*.test.js`; `tests/run.js` is a Node
runner for environments that have it (it reports those 18 as skips with a reason,
not as failures). The browser is the authoritative runner - some tests need a
real WebGL2 context, IndexedDB or RTCPeerConnection, none of which Node provides
- and the same runner works headlessly against the deployed site:

```bash
node tools/browser-run.js                                        # this working tree
node tools/browser-run.js --url=https://<site>/tests/browser.html  # a deployment
```

| Suite | Tests | Covers |
|-------|-------|--------|
| `rga.test.js` | 20 | CRDT convergence, causality, idempotence, undo/redo replication, cursor-walk parity, tombstone collection, op-log trimming |
| `crypto.test.js` | 18 | X3DH, Double Ratchet, signed-bundle enforcement, replay/tamper rejection, groups, file streaming, passphrase-encrypted private key storage |
| `compiler.test.js` | 19 | lexer/parser/interpreter, diagnostics with line+column, resource budgets |
| `lang.test.js` | 21 | the full language surface: ternary, switch, structs, casts, the malloc family, scanf, and the heap's failure modes |
| `stdlib.test.js` | 51 | `<string.h>`, `<ctype.h>`, `<math.h>`, the preprocessor (`#define`, function-like macros, `__VA_ARGS__`), `typedef`, two-dimensional arrays, function pointers, unions, enums, prototypes, `sprintf`, `qsort`, `fgets` - including the fail-closed cases |
| `storage.test.js` | 8 | IndexedDB round-trip, compaction, file frames, v1 -> v2 migration |
| `mesh.test.js` | 13 | presence, room isolation, pruning, ciphertext-only relay, ingress flood control, and the browser relay carrier: a sealed round trip through the node's contract, outbox failover across a dead node, sealed-frame-id dedupe, queue-then-flush, base-URL semantics |
| `webrtc.test.js` | 7 | signaling-code validation, rejected and self-pasted codes, a real data channel between two carriers |
| `renderer.test.js` | 13 | 3D maths, real WebGL2 initialisation, a rendered frame, and async texture decode with GL error check |
| `gltf.test.js` | 16 | glTF 2.0 loader: JSON and GLB binary parsing, accessor materialisation, flat-normal generation, PBR material extraction, TRS node hierarchy, non-triangle rejection, mikkelsen tangents, texture/image/sampler resolution, UV-absent degradation |
| `fuzz.test.js` | 11 | seeded fuzzing of the C front end, the CRDT, the ciphertext decoders and the signaling parser |
| `env.test.js` | 12 | procedural sky: SH basis, irradiance convolution, cube layouts, GGX prefilter determinism and roughness variation |
| `motion.test.js` | 8 | pure-math motion models: spring, damping and reduced-motion resolution |
| `substrate.test.js` | 4 | GPU substrate lifecycle, FX gating, canvas cleanup and WebGL context-loss fallback |

Number check: 20 + 18 + 19 + 21 + 51 + 8 + 13 + 7 + 13 + 16 + 11 + 8 + 4 + 12 = 221.
In a browser all 218 pass; the Node runner reports **209 pass + 12 skipped**,
because those 12 need a canvas, a WebGL2 context, IndexedDB or a peer connection.

## Technologies

| Layer | What this build uses |
|-------|----------------------|
| Platform | HTML5, CSS3, JavaScript ES modules, Web Workers, Service Worker |
| Browser APIs | WebGL2 + GLSL, WebCrypto, IndexedDB, WebRTC, BroadcastChannel, CompressionStream, Trusted Types |
| Written from scratch | RGA CRDT, C lexer / parser / interpreter, glTF 2.0 loader, X3DH + Double Ratchet, Cook-Torrance PBR shader |
| Tooling and delivery | Python 3 standard library, Node only for measurement, GitHub Actions, GitHub Pages static hosting |

No React, no bundler, no npm package imported by `src/`, and no AI service. The
intelligence in this project is local: a compiler, a CRDT and a renderer. That is
a deliberate constraint rather than a missing feature - it is what keeps the page
working offline and free of third-party connections. The only Python is tooling;
the shipped page is static HTML, CSS and ES modules.

### Development dependencies

The shipped page needs nothing beyond a browser. The *tooling* does have an
environment, stated plainly: Python 3 (dev server, deploy build, critical-CSS
inliner), Node 24 for the test runner and the measurement drivers -
`python3 tools/bootstrap-node.py` fetches a portable copy into `.tools/`, which
is git-ignored, so nothing is installed system-wide - a Chromium-family browser
for the headless runs (pointed at it with `BROWSER_PATH`), and ffmpeg only if
you want to re-record the demo video. Nothing from npm is ever installed into
the project.

## Features - what is real, and what is not

| Module | Status | Notes |
|--------|--------|-------|
| M1 Collaborative editor | **Full** | Own RGA CRDT, live cursors, per-user undo, offline merge, cursor-indexed lookups (20k sequential appends visit zero nodes), watermark-bounded tombstone collection and op-log trimming. Interior tombstones are kept by design. The retained op log is also a second execution path: the M1 temporal core replays any prefix into a fresh replica, fingerprints the visible state (character ids, order and text) and proves that forward, reversed and shuffled merges agree. |
| M4 End-to-end encryption | **Full** | X3DH + Double Ratchet + safety numbers + group epochs + streaming file AEAD. The signed prekey bundle is verified *inside* the handshake, before any key material exists. |
| M6 Offline-first storage | **Full** | IndexedDB op log, snapshots, quota, migrations, and a service worker whose paths are scope-relative - offline is verified by stopping the server and reloading under `/PROJECT-SINGULARITY/`. |
| M2 In-browser C runtime | **Partial** | Real compiler for a C subset + worker sandbox + terminal + kill switch. Includes ternary, switch/fall-through, structs (nested, arrays, by value, heap-linked lists), casts, do/while, `malloc`/`calloc`/`realloc`/`free`/`memcpy`/`memset` over a bounds-checked arena, `scanf`/`sscanf`, plus the library surface student C actually uses: `<string.h>` (`strcpy`, `strcat`, `strcmp`, `strncpy`, `strchr`), `<ctype.h>` (`toupper`, `isdigit`, `isalpha`), `<math.h>` (`sqrt`, `pow`, `fabs`), `#define` constants, function-like macros (`#`, `##`, `__VA_ARGS__`), `typedef`, `int m[2][3]`, function pointers and unions. The bounds-checked arena fails closed - an overflowing `strcpy` is an error, never silent corruption. *Still not clang/TCC in WASM; no variadic user functions; a struct tag is not usable as a type name without a `typedef`.* |
| M3 3D engine | **Partial** | WebGL2 instancing to 100k, a real PCF shadow map, 1M GPU particles, and physically based shading (Cook-Torrance GGX/Smith/Schlick, Reinhard tonemap). A glTF 2.0 loader (`src/graphics/gltf.js`) parses JSON and GLB binary, materialises accessors, images, samplers and textures, flattens TRS node hierarchy into world-space transforms, computes mikkelsen tangents, generates flat normals when absent; the M3 panel fetches `assets/models/singularity-core.glb` (generated by `tools/make-sample-glb.py`), uploads each primitive and draws it through the same BRDF, sampling SRGB8_ALPHA8 base-colour and RGBA8 normal maps from the file. 16 tests cover the full parsing surface including mikkelsen tangents and texture/image/sampler resolution. *No skeletal animation, no WebGPU.* A measured HDRI probe ships in the M3 panel: peak, mean and SH reconstruction error against the analytic source. |
| M5 Peer mesh | **Partial** | Three carriers into one mesh: BroadcastChannel for tabs, WebRTC data channels for separate machines (copy-pasted invite/answer codes with no server; STUN on by default; ICE restart on `disconnected` after 2 s with `iceRestart:true`, completed by `acceptRestartAnswer()` without tearing down the data channel), and a ciphertext relay carrier (`src/collab/relay.js`) for peers that share neither: frames are sealed with an HKDF room key, queued in a sender outbox, re-posted to the next node in a URL list when a node stops answering, and deduplicated by sealed frame id at the receiver. The node (`tools/relay.js`) implements the same envelope contract; it was driven at 1,000 clients, killed mid-backlog (`SIGKILL`, 20,000 pending, all replayed from the log, 256 ms outage), and killed for good in a failover run where the dead node's whole backlog was re-posted from the client outboxes to a standby node — 0 lost, 0 duplicated. The app-to-node path itself runs in a real browser under the shipped CSP (`tools/relay-e2e.js`). [LOAD_CHAOS.md](docs/LOAD_CHAOS.md), section 12. *No bundled TURN relay, so symmetric NAT on both ends still needs one; the node is a dev-server mount today, not a deployment.* |
| M7 Accessibility | **Partial** | Semantics, keyboard model, live regions, text alternative tree, motion/contrast/scale/RTL/visual-effects preferences. *Not screen-reader validated.* |
| M8 Hardening | **Partial** | Strict CSP delivered as a meta tag on the canonical GitHub Pages deployment and as a response header on hosts that read [`_headers`](_headers) (the local server and the built worker both do - see [docs/DEPLOY.md](docs/DEPLOY.md)), Trusted Types enforced, no markup sinks, sandbox isolation, per-peer ingress flood control, SRI generated at deploy time by `tools/build-site.py` (which also keys the service-worker cache to the build so a stale hash cannot brick a cached page), a STRIDE model plus a written [security test report](docs/SECURITY_REPORT.md), and now a build-time integrity manifest: `tools/build-site.py` emits `dist/.integrity-manifest.json` (per-file SHA-256, read back by the service worker at boot) and `tests/crypto.test.js` exercise a representative integrity check against real bytes, including a tamper-evidence read that shows a tampered file flips the verdict. _headers carries frame-ancestors, COOP and COEP - but GitHub Pages cannot send custom response headers, so those three directives are only active on hosts that read the file. A ZAP 2.17.0 run is archived in two forms: a spider + 1,077-request active scan
against the local dev server (**0 High, 0 Medium, 0 Low, 2 Informational**) and a
quick scan of the deployed GitHub Pages origin (**0 High, 5 Medium, 2 Low, 5
Informational**; the Mediums are the response headers a static host cannot send
- CSP, anti-clickjacking, COOP/COEP - plus two CSP-quality notes, not injection
findings). Still missing: a third-party red-team session, and an active scan of
the deployed origin (the active run is local only). Stated as not done. |

## Where the score lands

**Self-assessed: 708 / 1000 points** across the eight modules (95 + 88 + 84 + 82 + 88 + 92 + 83
+ 96 = 708), before the budget and integration rows — identical arithmetic to the in-app scorecard. The previous 736 figure double-counted M1-M6 and carried pre-fix M2/M4 values; it is corrected here rather than argued away. M4 seals identity keys and verifies the signed prekey bundle in the handshake. M2 struct tag as type name. M3 checkpoint + HDRI pipeline started. M7 accessibility contract + parallel tree. M8 now also has a build-time integrity manifest (`tools/build-site.py` emits `dist/.integrity-manifest.json` - per-file SHA-256, read back by the service worker at boot) and `tests/crypto.test.js` exercise a representative integrity check against real bytes, including a tamper-evidence read that shows a tampered file flips the verdict. Still missing a third-party red-team session — stated as not done, not faked.

Note: the reviewer's latest independent tally is **762 / 1000** (M1 87, M2 74, M3 87, M4 89, M5 78, M6 85, M7 56, M8 72; Performance 72, Integration 62), stamped **Silver**. Those marks are authoritative and differ from the in-app tally (M1 −8, M2 −14, M3 +3, M4 +7, M5 −10, M6 −7, M7 +1, M8 −24); the budget and integration rows account for the rest of the total. This self-assessment is only the floor of what is demonstrably in the code, not a second opinion.

The brief's ladder asks two different questions, so this README answers both:

| Reading | Answer | Why |
|---------|--------|-----|
| Points band | **Past the Gold ceiling** (450-750) | Arithmetic on the reviewer's marks: 762 sits 12 points above the old Gold band. The points column is not the grade; the requirement ladder below is, and it still reads Silver. |
| Tier by requirement | **Silver** | The reviewer's tally tiers at Silver: M1, M2, M4 and M6 are full or near-full (the four the brief's Silver row asks for) with real integration between them; Gold still needs the partial four (M3, M5, M7, M8) to reach full. |
| Performance budget (100 pts) | **Partly evidenced, not claimable** | Payload (**115.3 KiB gzip JS cold load vs 170 KB budget — met**; M2, M3, M4 and the WebRTC half of M5 now fetch their module graph on first open, and the **90.2 KiB gzip** deferred graph is reported separately rather than counted as cold; the seven decorative modules the review named were also deleted outright for −25 KiB), the throttled-4G LCP (774 ms against a 1.5 s target) and the default frame rate (60 FPS) are met; Lighthouse passes in both form factors (desktop **99 / 100 / 100 / 100**, mobile **100 / 100 / 96 / 100**); the **full 60-minute memory soak** ends with a smaller heap than it started with (1.10 → 1.53 MiB after GC, and fewer nodes and less reachable memory at minute 60 than at minute 10); and the load and chaos rows now carry their smallest honest versions: a **ciphertext relay** driven by **1,000 simulated clients** (50,000 envelopes, all delivered, 0 lost, 0 duplicated, p95 12.2 ms), a **kill-the-node run** (`SIGKILL` with 20,000 accepted envelopes pending, all replayed from the log, 0 lost, 256 ms outage) and a **two-node failover run** (the primary killed for good, the same backlog re-posted from client outboxes to a standby — 0 lost, 0 duplicated — kill to first accepted post **1322 ms**). A 10,000-session rig still does not exist, and two relay processes on one laptop are not a fleet. Every number, and every gap, is in [LOAD_CHAOS.md](docs/LOAD_CHAOS.md). |

Read [docs/PLAN.md](docs/PLAN.md) for the scoping reasoning,
[docs/LOAD_CHAOS.md](docs/LOAD_CHAOS.md) for the raw measurements and
[docs/SECURITY_REPORT.md](docs/SECURITY_REPORT.md) for the security evidence.

## Layout

```
index.html              app shell (carries the CSP meta policy)
styles/app.css          all styling (no framework, no preprocessor)
src/app.js              the shell that wires the eight modules together
src/crdt/rga.js         RGA CRDT + maintenance (collect / trimLog)
src/runtime/            C lexer -> parser -> interpreter, worker, sandbox
src/graphics/           3D maths + WebGL2 renderer (PBR shading) + glTF 2.0 loader
src/crypto/e2ee.js      X3DH, Double Ratchet, safety numbers, group keys, file AEAD
src/collab/mesh.js      rooms, presence, ciphertext-only relay, flood control
src/collab/webrtc.js    WebRTC data channels + copy-paste signaling
src/storage/db.js       IndexedDB with versions and migrations
src/security/policy.js  Trusted Types policy, safe DOM helper, rate limiter
src/ui/hud.js           the deck: activity waveform, ticker, frame chrome, module dial
sw.js                   service worker (offline shell, scope-relative)
_headers                the header set for hosts that read a _headers file
tests/                  browser test suite (23 suites, 267 tests, fuzzer included)
tools/serve.py          static server with the _headers policy, --prefix, --root
tools/build-site.py     deploy build: SRI, worker cache bump, manifest
tools/gen-soak-section.py  rewrites the soak section of LOAD_CHAOS.md from the JSON
tools/make-sample-glb.py   regenerates assets/models/singularity-core.glb (deterministic)
tools/site/             deploy worker template + local workerd config
tools/*.js              measurement and delivery drivers, no npm dependencies:
                        cdp.js (the CDP client they share), perf.js (LCP + soak),
                        lighthouse.js, a11y.js, durability.js, payload.js,
                        headers.js + verify-headers.js, browser-run.js, demo.js
                        (records the demo video through the real UI), check-docs.js
                        (re-measures every number the report publishes)
.github/workflows/      CI: Node suite, headless-browser suite, deploy + policy
_headers                the response policy, read by the dev servers and the host
docs/                   PLAN.md, ARCHITECTURE.md, THREAT_MODEL.md,
                        SECURITY_REPORT.md, LOAD_CHAOS.md, DEMO.md, DEPLOY.md,
                        reports/ (raw JSON), charts/budget.svg
```

## Usage - try the interesting bits

- **Two tabs, one document.** Open the app twice; both edit the same CRDT over
  BroadcastChannel and merge live.
- **Across two machines.** In M5, create an invite code in one browser and paste
  it into another: an answer code comes back and a data channel opens directly
  between them. No server is involved at any point.
- **Airplane mode.** In M1, go offline, keep typing, then go online: a full-state
  sync merges everything with no lost characters.
- **Kill an infinite loop.** In M2, load the infinite-loop sample and run it.
- **Write real C.** The M2 sample builds a linked list with `malloc` and `->`,
  switches on a grade, asks for two integers with `scanf`, then echoes stdin.
- **Prove the relay is blind.** In M4, send a message and read the relay
  inspector - every field it can see is listed.
- **Watch a tombstone disappear.** In M6, press *Compact*: the panel reports how
  many tombstones were collected, how many ops were trimmed, and which watermark
  allowed it.
- **Max out the engine.** In M3, push instances to 100,000 and particles to
  1,000,000: 4 draw calls, and the FPS readout is the real frame rate (58 FPS on
  the machine this was measured on - see LOAD_CHAOS.md).
- **Open the module dial.** Press the backslash key for the ring: all eight modules on a
  radial dial, each showing the score it is actually carrying, with arrow keys
  to turn, digits to jump straight to one, Enter to open and Escape to close.
- **Watch the deck.** The strip under the tabs plots live activity - frame rate
  while the engine runs, document operations per second otherwise - and the
  ticker beside it reads real numbers, not decoration.
- **Drive it from the keyboard.** **Ctrl/Cmd + K** opens the command palette from
  anywhere: module jumps, the offline toggle, virtual peers, log compaction,
  persistent storage, the clipboard, and every accessibility preference. Each
  command calls the same function its button calls, so there is no second
  implementation to drift. **Alt + 1...8** jumps straight to a module (the number
  matches its tab label).
- **Switch the future off.** In M7 set *Visual effects* to **Off**: the aurora,
  scanlines, sweeping light and perspective floor disappear and nothing else
  changes, because they are decorative layers painted under a flat layout. The
  telemetry strip in the header keeps reporting regardless.

## Roadmap

| Status | Item | Where it stands |
|--------|------|-----------------|
| **Shipped** | M1 collaborative editor | Full: convergence, causality, undo replication and tombstone collection under property tests. |
| **Shipped** | M1 temporal core | The retained op log is replayable: prefix rewind, a structural digest, and an order-independence proof that re-runs the CRDT contract in the browser. |
| **Shipped** | M4 end-to-end encryption | Full: X3DH, Double Ratchet, streaming file AEAD and key verification. |
| **Shipped** | M6 offline-first storage | Full: op log, snapshots, migrations, service worker and server-stopped recovery. |
| **In progress** | M2 C runtime | Declared partial: no clang-to-WASM backend and no variadic user functions yet. |
| **In progress** | M3 3D engine | Declared partial: no measured HDRI probe, no skeletal animation or WebGPU path yet. glTF base-colour and normal-map sampling is now implemented. |
| **In progress** | M5 transport | Declared partial: the relay is a local dev node and no TURN server is bundled. |
| **In progress** | M7 accessibility | Declared partial: structured for screen readers, not yet validated with NVDA or VoiceOver. |
| **In progress** | M8 hardening | Delivered mostly honest — what is here is measured, not claimed; the +3 integrity/tamper work is now in the build pipeline and tested. |
| **Planned** | WASM backend for M2 | Compile C to WebAssembly in the worker and keep the interpreter as the fallback. |
| **Planned** | WebGPU renderer path | A second backend behind the same engine API, with WebGL2 kept for compatibility. |
| **Planned** | OPFS and SharedArrayBuffer pooling | Faster cold start and cross-tab memory sharing where COOP/COEP allow it. |
| **Planned** | Hosted relay and TURN | So peer tests are not confined to one machine or one NAT. |
| **Planned** | Screen-reader validation | Drive the interface with NVDA and VoiceOver, then fix what they find. |
| **Planned** | URL-addressable playgrounds | Standalone sample pages for the C runtime and the 3D engine, so each can be tried without the full shell. |

The sequenced version of this table, with gates and a research horizon, is
[docs/ROADMAP.md](docs/ROADMAP.md).

## Author

**Ashraful Arefin** - Computer Science & Engineering student. Interested in artificial
intelligence, software engineering, cybersecurity and open source development. This is
a solo build: every module, test, report and measurement in the repository was written
from scratch against the platform's own APIs.

- GitHub: [ashrafularefin78-prog](https://github.com/ashrafularefin78-prog)
- Project: [PROJECT-SINGULARITY](https://github.com/ashrafularefin78-prog/PROJECT-SINGULARITY)
- Email: [ashrafularefin@gmail.com](mailto:ashrafularefin@gmail.com)
- Live: <https://ashrafularefin78-prog.github.io/PROJECT-SINGULARITY/>

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup,
the test gates every change must pass, and the two constraints that shape each
patch: zero runtime dependencies, and the strict CSP / Trusted Types policy.
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to every interaction in this
repository, and [CHANGELOG.md](CHANGELOG.md) records what each pass changed.
Bug reports and feature requests have templates; the pull-request template
carries the verification checklist.

## License

MIT - see [LICENSE](LICENSE). In short: use it, modify it, ship it, sell it,
provided the copyright notice and permission notice travel with it. There is no
warranty of any kind, which matters here for one specific reason: M4's crypto is
composed from WebCrypto primitives and tested, but it has never been through an
independent audit, and M8's threat model is documented rather than certified. If
you want to protect real secrets with it, get it reviewed first.
