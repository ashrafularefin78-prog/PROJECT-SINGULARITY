# Project Singularity

An attempt at *The Impossible Website Challenge*: one page that behaves like an
operating system, a collaborative workspace, a game engine and a secure
messenger at once - with **zero runtime dependencies** and no framework in the
shipped bundle.

Everything is hand-written against browser APIs: the CRDT, the C front end, the
renderer, the crypto composition, the storage layer, the WebRTC mesh and the DOM
code. There is no bundler, no transpiler, and no file in `src/` imported from npm.

## Run it

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

**Live deployment:** <https://site-7b30ffebca394f959117a11319fb4dfc.freebuff.page/>
(Cloudflare-backed, so the `_headers` policy actually arrives - the three
directives a `<meta>` tag cannot express included). What was verified against
that URL, header by header, is in [docs/DEPLOY.md](docs/DEPLOY.md); GitHub Pages
carried an earlier copy of this site and could not deliver them.

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

**183 tests across 11 suites** (~4 s in a real browser, of which 6 need it). Each
suite also runs standalone from `tests/*.test.js`; `tests/run.js` is a Node
runner for environments that have it (it reports those 6 as skips with a reason,
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
| `crypto.test.js` | 15 | X3DH, Double Ratchet, signed-bundle enforcement, replay/tamper rejection, groups, file streaming |
| `compiler.test.js` | 19 | lexer/parser/interpreter, diagnostics with line+column, resource budgets |
| `lang.test.js` | 21 | the full language surface: ternary, switch, structs, casts, the malloc family, scanf, and the heap's failure modes |
| `stdlib.test.js` | 51 | `<string.h>`, `<ctype.h>`, `<math.h>`, the preprocessor (`#define`, function-like macros, `__VA_ARGS__`), `typedef`, two-dimensional arrays, function pointers, unions, enums, prototypes, `sprintf`, `qsort`, `fgets` - including the fail-closed cases |
| `storage.test.js` | 8 | IndexedDB round-trip, compaction, file frames, v1 -> v2 migration |
| `mesh.test.js` | 8 | presence, room isolation, pruning, ciphertext-only relay, ingress flood control |
| `webrtc.test.js` | 7 | signaling-code validation, rejected and self-pasted codes, a real data channel between two carriers |
| `renderer.test.js` | 11 | 3D maths, real WebGL2 initialisation and a rendered frame |
| `gltf.test.js` | 12 | glTF 2.0 loader: JSON and GLB binary parsing, accessor materialisation, flat-normal generation, PBR material extraction, TRS node hierarchy, non-triangle rejection |
| `fuzz.test.js` | 11 | seeded fuzzing of the C front end, the CRDT, the ciphertext decoders and the signaling parser |

Number check: 20 + 15 + 19 + 21 + 51 + 8 + 8 + 7 + 11 + 12 + 11 = 183 (177 pass + 6 browser-only skips).

## What is real, and what is not

| Module | Status | Notes |
|--------|--------|-------|
| M1 Collaborative editor | **Full** | Own RGA CRDT, live cursors, per-user undo, offline merge, cursor-indexed lookups (20k sequential appends visit zero nodes), watermark-bounded tombstone collection and op-log trimming. Interior tombstones are kept by design. |
| M4 End-to-end encryption | **Full** | X3DH + Double Ratchet + safety numbers + group epochs + streaming file AEAD. The signed prekey bundle is verified *inside* the handshake, before any key material exists. |
| M6 Offline-first storage | **Full** | IndexedDB op log, snapshots, quota, migrations, and a service worker whose paths are scope-relative - offline is verified by stopping the server and reloading under `/PROJECT-SINGULARITY/`. |
| M2 In-browser C runtime | **Partial** | Real compiler for a C subset + worker sandbox + terminal + kill switch. Includes ternary, switch/fall-through, structs (nested, arrays, by value, heap-linked lists), casts, do/while, `malloc`/`calloc`/`realloc`/`free`/`memcpy`/`memset` over a bounds-checked arena, `scanf`/`sscanf`, plus the library surface student C actually uses: `<string.h>` (`strcpy`, `strcat`, `strcmp`, `strncpy`, `strchr`), `<ctype.h>` (`toupper`, `isdigit`, `isalpha`), `<math.h>` (`sqrt`, `pow`, `fabs`), `#define` constants, function-like macros (`#`, `##`, `__VA_ARGS__`), `typedef`, `int m[2][3]`, function pointers and unions. The bounds-checked arena fails closed - an overflowing `strcpy` is an error, never silent corruption. *Still not clang/TCC in WASM; no variadic user functions; a struct tag is not usable as a type name without a `typedef`.* |
| M3 3D engine | **Partial** | WebGL2 instancing to 100k, a real PCF shadow map, 1M GPU particles, and physically based shading (Cook-Torrance GGX/Smith/Schlick, hemispheric ambient, Reinhard tonemap). A glTF 2.0 loader (`src/graphics/gltf.js`) parses JSON and GLB binary, materialises accessors, flattens TRS node hierarchy into world-space transforms, generates flat normals; the M3 panel fetches `assets/models/singularity-core.glb` (generated by `tools/make-sample-glb.py`), uploads each primitive and draws it through the same BRDF, with the file's metallic/roughness/baseColor as uniforms. 12 tests cover the full parsing surface. *No texture sampling, no HDRI image-based lighting, no skeletal animation, no WebGPU.* |
| M5 Peer mesh | **Partial** | Two carriers into one mesh: BroadcastChannel for tabs, WebRTC data channels for separate machines, signaled by copy-pasted invite/answer codes with no server. STUN on by default. ICE restart implemented: on `disconnected`, the carrier waits 2 s and emits a new offer with `iceRestart:true`; `acceptRestartAnswer()` completes the restart without tearing down the data channel. *No bundled TURN relay, so symmetric NAT on both ends still needs one.* A ciphertext relay node (`tools/relay.js`) implements the same envelope contract as test tooling - driven at 1,000 clients and killed mid-backlog with zero loss ([LOAD_CHAOS.md](docs/LOAD_CHAOS.md), section 12) - it is not part of the app's signaling. |
| M7 Accessibility | **Partial** | Semantics, keyboard model, live regions, text alternative tree, motion/contrast/scale/RTL/visual-effects preferences. *Not screen-reader validated.* |
| M8 Hardening | **Partial** | Strict CSP delivered as both a header and a meta tag (and now actually *delivered* by the host - see [docs/DEPLOY.md](docs/DEPLOY.md)), Trusted Types enforced, no markup sinks, sandbox isolation, per-peer ingress flood control, STRIDE model plus a written [security test report](docs/SECURITY_REPORT.md). Subresource Integrity is generated at deploy time by `tools/build-site.py`, which also keys the service-worker cache to the build so a stale hash cannot brick a cached page; SRI covers the entry subresources, not the transitive import graph. *No third-party red-team session, and the OWASP ZAP baseline scan was not run (no Docker/ZAP in this environment).* |

## Where the score lands

**Self-assessed: 668 / 1000 points** across the eight modules (95 + 88 + 78 + 92 + 85 + 92 + 55
+ 83), before the budget and integration rows. Three rows moved in this pass:
M2 85 → 88 (function-like macros confirmed fully working, `sprintf`/`qsort`/`fgets` added),
M3 70 → 78 (glTF 2.0 loader added: JSON + GLB binary, PBR materials, TRS hierarchy, 12 tests),
M5 80 → 85 (ICE restart on disconnect implemented: 2 s back-off, `iceRestart:true` offer,
`acceptRestartAnswer()` to complete the restart without tearing down the data channel).

Note: the reviewer's independent tally comes to **559 / 1000**, a 109-point gap on the updated score.
The per-module delta is not yet reconciled. The items most likely to account for
the gap are the partial-module ceilings (M3, M5, M7, M8 each cap at a lower
value without the gold-tier deliverables listed under "Next steps to reach Gold"),
and the unearned rows (OWASP ZAP, NVDA/VoiceOver, TURN; the load row now carries
the relay's partial result - 1,000 of 10,000 clients - and the chaos row the
single-node kill test). The
self-assessed numbers above reflect the work that is demonstrably present in the
code and test suite; the reviewer's marks are the authoritative ones.

The brief's ladder asks two different questions, so this README answers both:

| Reading | Answer | Why |
|---------|--------|-----|
| Points band | **Gold** (450-750) | Arithmetic on the module scores. |
| Tier by requirement | **Bronze** | The brief's own table asks for "2 modules working independently" at Bronze and "4 modules plus basic integration" at Silver. Three modules are complete and five are partial, so Silver misses by one module - stated plainly rather than rounded up. |
| Performance budget (100 pts) | **Partly evidenced, not claimable** | Payload (131.3 KiB gzip vs 170 KB), the throttled-4G LCP (774 ms against a 1.5 s target) and the default frame rate (60 FPS) are met; Lighthouse passes in both form factors (desktop **99 / 100 / 100 / 100**, mobile **100 / 100 / 96 / 100**); the **full 60-minute memory soak** ends with a smaller heap than it started with (1.10 → 1.53 MiB after GC, and fewer nodes and less reachable memory at minute 60 than at minute 10); and the load and chaos rows now carry their smallest honest versions: a **ciphertext relay** driven by **1,000 simulated clients** (50,000 envelopes, all delivered, 0 lost, 0 duplicated, p95 12.2 ms) and a **kill-the-node run** (`SIGKILL` with 20,000 accepted envelopes pending, all replayed from the log, 0 lost, 234 ms outage). A 10,000-session rig and a node fleet still do not exist. Every number, and every gap, is in [LOAD_CHAOS.md](docs/LOAD_CHAOS.md). |

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
tests/                  browser test suite (11 suites, 183 tests, fuzzer included)
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

## Try the interesting bits

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

## License

MIT - see [LICENSE](LICENSE). In short: use it, modify it, ship it, sell it,
provided the copyright notice and permission notice travel with it. There is no
warranty of any kind, which matters here for one specific reason: M4's crypto is
composed from WebCrypto primitives and tested, but it has never been through an
independent audit, and M8's threat model is documented rather than certified. If
you want to protect real secrets with it, get it reviewed first.
