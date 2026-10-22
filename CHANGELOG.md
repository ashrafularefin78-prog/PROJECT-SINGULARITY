# Changelog

Versions here are dates, not tags. `v0.1.0` is the first tagged release (2026-10-22); entries below are derived from commit history.
Each entry is derived from the commit history; the newest comes first.

## 2026-10-22 - M7 gets a real NVDA pass

### Added
- **A real screen-reader harness.** `tools/nvda-session.js` starts NVDA with
  debug logging, drives a windowed Edge session over CDP, and decodes NVDA's
  own `Speaking [...]` lines into `docs/reports/nvda-session.json`. The run
  covers all eight panels, the editor, the M3 canvas, Bangla/Arabic editor text
  and the RTL preference: **17/17 steps, 0 failures**, NVDA 2026.2 / Edge
  156.0.4314.36. `docs/reports/nvda-session.md` is the annotated transcript.
- **An internal adversarial harness.** `tools/red-team.js` drives a header-capable
  server and a real relay node: rogue Trusted Types policies, inline handlers and
  `javascript:` URLs, editor markup, same-origin framing, a poisoned
  service-worker cache, the M2 worker under the shipped policy, and the relay's
  field/validation contract. **22/22 checks pass**; the non-independent results
  are in `docs/reports/red-team-session.md` and `.json`.

### Fixed
- **Panel switches moved focus to `<body>`.** `renderPanel` now restores focus
  for tab activation and same-id controls, and focuses the new panel's
  `tabindex="-1"` heading for Alt+1..8 jumps. The first run of the harness
  caught a second bug in that fix: `<main id="main">` matched the generic
  id-restore branch and kept focus on the landmark; restore is now limited to
  controls that lived inside the old panel.
- **The M3 canvas was an unnamed graphic.** It now exposes `role="img"`, a live
  scene-summary `aria-label`, `aria-describedby="scene-alt"` and
  `aria-keyshortcuts`; NVDA reads the summary, camera, object counts and keys.
- **Trusted Types had no policy allowlist.** The app's policy name contained
  `#`, which a CSP `trusted-types` directive cannot name. Renamed it to
  `singularity-script-url` and added `trusted-types singularity-script-url` to
  the meta CSP, `_headers` and both playgrounds, so page script can no longer
  mint a second, permissive policy.
- **The M2 built-in C sample did not compile.** Its `\n` escapes were interpreted
  by the JavaScript template literal, so the textarea received an actual newline
  inside a C string. Doubled the eight escapes; the sample now prints
  `fib(20) = 6765` and exits 0 in the worker.

### Changed
- M7's evidence-backed score moves **55 -> 72** (the structural maximum remains
  83); the in-app total moves **680 -> 697**. The README's old 708 used the
  structural maximum as if it were evidence-backed and is corrected to 697,
  with the remaining VoiceOver/TalkBack and deeper-flow gaps named.
- Cold load is **116.6 KiB gzip JS / 460.7 KiB raw** after the security and
  sample fixes; README, LOAD_CHAOS, DEMO, PLAN and the budget chart are updated
  together, and `tools/check-docs.js` still matches all 46 published numbers.
- The browser runner now includes `tests/stream.test.js`; the browser suite is
  **266 pass + 1 Node-only skip**, and the README's stale 221-test table and
  "18 need a browser" count are corrected to the real 23-suite, 267-test set.
- The internal adversarial pass does **not** raise M8's 96/100: it is not
  independent, and the third-party gap remains declared.

## 2026-10-21 - M0 gains a live system constellation

### Added
- **The dashboard now draws the running tab.** `src/ui/constellation.js` puts
  the eight modules on an elliptical orbit around the shell: the open panel is
  drawn active, the rest carry the scorecard's own verdict (full or partial),
  peers occupy an outer ring, and packets travel the edges in proportion to
  real document throughput. It reports what it reads and nothing else - a
  browser without `performance.memory` has no heap in the picture rather than a
  confident zero, and a renderer that has never painted a frame has no frame
  rate.
- Nine tests: the ring geometry, the state model, the saturation curve, the
  text alternative and the paint pass are proven in bare Node against a
  recording 2D context, and the mount/teardown path runs in the browser. The
  suite is registered in both runners.

### Changed
- The canvas is an `img` with a live `aria-label` built from the same model it
  draws (the a11y contract fails a nameless canvas, WCAG 1.1.1). The audit is
  unchanged: **0 axe-core violations, 412 passing rule results** across all
  nine modules, 211 named interactive controls.
- The loop runs at most 30 fps, stops when the document is hidden, stops when
  the panel is swapped away, and schedules nothing at all under reduced motion
  (one frame per change instead). Like the M3 renderer, an invisible panel is
  not worth a frame.
- Cold load is **115.3 KiB gzip JS**, 26.2 KiB gzip CSS, 455.9 KiB raw over 15
  files; the deferred graph is **90.2 KiB** over 14 modules and is still
  reported separately. The brief's 170 KB ceiling is still met at about 68% of
  it, and the new module's own share is disclosed: 5.0 KiB gzip of 13.6 KiB raw.
  `docs/charts/budget.svg` was redrawn with the bar.
- `tools/payload.js` now measures the line endings git stores, not the ones the
  working tree happens to have. It used `statSync().size`, which counts CRLF on
  a Windows checkout and LF on the Linux runner, so the same commit published
  two different budgets and `tools/check-docs.js` reported drift on whichever
  platform had not generated the numbers. LF is what a host serves, so it is
  both the deterministic figure and the true one; every figure above was
  regenerated on that basis.
- The constellation is below the fold and mounts after first paint, so the
  measured LCP element is still the hero paragraph with CLS 0 - the 1.47 s
  slow-4G figure is untouched rather than re-measured on this machine.
- `sw.js` is at v9: the shell precache covers the new module, and the suite
  (`tests/sw.test.js`) fails if the shell and the import graph diverge.
- Published test totals move to **267 tests across 23 suites** (242 pass, 25
  browser-only skips in bare Node), regenerated by `tools/test-count.js`.


## 2026-10-21 - the throwaway browser profiles leave the repository

### Security
- The three `cdp-probe-*` directories (791 tracked files, ~38 MB on disk) were
  browser user-data-dirs, not project content: a full Edge profile each, with
  `Login Data`, `Network/Cookies`, `History`, `Web Data`, crash dumps and
  session logs. They are out of the index, ignored, and purged from every
  commit by `git filter-repo` rather than merely deleted in a later commit.
- They held **no account material**: `Local State` has an empty `account_info`
  (no browser sync account), and each profile's `Cookies`, `logins`,
  `History.urls` and `autofill` tables are empty. The profiles never
  authenticated, so no Microsoft or Google session existed to revoke. That was
  verified before the purge, not assumed from the directory names.
- `tools/cdp.js` now creates its throwaway profile under `os.tmpdir()` instead
  of `process.cwd()`. Creating it in the working tree is what let a `git add -A`
  publish a live browser profile; the cause is fixed, not just the symptom.
- `.gitignore` covers `cdp-probe-*/`, `singularity-cdp-*/`, `*.log` and `*.err`
  as a backstop for a probe launched by hand.

### Fixed
- `tools/test-count.js --write` built its multi-line replacement with `\n`, so
  on a CRLF checkout the rewritten block never matched the bytes already there
  and `--check` reported drift that did not exist on the Linux CI runner. It
  now uses the file's own line ending, and the same assertion holds on both.
- Re-measured the payload and brought every document to the new numbers at
  once: **109.3 KiB gzip JS** cold load (445.5 KiB raw), **90.7 KiB gzip**
  deferred over 14 modules, `src/app.js` at 66.2 KiB gzip of 212.4 KiB raw, and
  the accessibility artifact's browser recorded as Edge **156.0.4314.36**. The
  report, README, DEMO, PLAN and `docs/charts/budget.svg` (bar width included)
  now agree, and `node tools/check-docs.js` passes all 41 published numbers.

### Housekeeping
- Untracked the 32 root-level measurement logs (`*-run.log`, `perf-lcp*.log`,
  `type-probe*.log`, `zap-deployed.log` and their `.err` pairs). They are
  regenerable scratch and were never referenced by the documents.


## 2026-10-21 - cold load under budget: panels fetch their own graph

### Changed
- **M2, M3, M4 and the WebRTC/relay half of M5 now import their module graph on
  first panel open** with a literal `import()`, instead of shipping every heavy
  subsystem in the cold load. The cold-load payload is **108.4 KiB gzip JS**
  (from 197.6), 25.9 KiB gzip CSS, 442.1 KiB raw; the deferred graph is
  **90.6 KiB gzip JS** over 14 modules and is reported separately by
  `tools/payload.js` rather than folded into the budget number. The brief's
  170 KB ceiling is now met on a first visit (about 64% of it), and the deferred
  modules are still named, walked and disclosed.
- `tools/payload.js` now classifies edges: static imports are cold load,
  dynamic imports and the spawned worker are deferred. It normalises Windows
  path separators in the graph walk (the old walk could count one file twice)
  and emits `deferredJsGzip`, `deferredFiles` and `initialFiles` alongside the
  cold totals.
- `renderPanel` is async with a monotonic token: a slow module import can no
  longer paint over the panel the user switched to, and the title/hash/tab
  chrome waits for the panel that actually rendered. Leaving M3 still stops the
  render loop before the next panel loads.
- Case-study scores are now read from `MODULE_STATUS` (`moduleMeta(...).points`)
  instead of copied: the two cards had drifted (M3 89 vs 84, M4 92 vs 82,
  M8 83 vs 96) and can no longer disagree.
- `sw.js` v8 precaches the modules that were missing from the shell after the
  module work (history, topology, relay, OPFS, substrate, motion, a11y contract,
  HDR, environment, preprocessor) and the HDR probe asset. A new
  `tests/sw.test.js` walks the real import graph and fails if the shell and the
  graph diverge again - online and offline.

### Fixed
- Unlocking a sealed identity threw `ReferenceError: openPrivateKeys` because
  the symbol was used but never imported; it is now destructured in the unlock
  path (the bug was invisible until the module graph was moved behind
  `import()`).
- The browser test harness now launches its throwaway browser with
  `--no-sandbox`: this host runs it under a restricted token where the renderer
  sandbox cannot start, so every page target answered `Page.enable` with a
  timeout. With the flag the suite runs in 6.6 s, and its profile directory is
  created in the workspace instead of `%TEMP%` (which rejected `mkdtemp`).
- `tests/browser-runner.js` no longer loads the deleted
  `futuristic-ui.test.js`, and now runs `hud.test.js` and `sw.test.js`.
- The a11y contract parses CSS Color 4 `rgb(12 34 56 / 25%)` alpha, treats a
  document's first heading as following an implied h1 (so a page opening at h4
  is reported), and no longer leaks `aria-hidden` text into the parallel tree:
  names come from content only for roles where ARIA allows it.
- Removed four stale imports of modules deleted in the previous review
  (`theming`, `transitions`, `holographic`, `telemetry-advanced`) that the
  rewrite of the import block had reintroduced.

### Added
- A ZAP 2.17.0 quick scan of the deployed GitHub Pages origin
  (`docs/reports/zap-deployed.html`), complementing the archived local
  baseline. The local run remains the one with the 1,077-request active scan;
  neither substitutes for a third-party red-team session, which is still
  stated as not done.

### Housekeeping
- The four `singularity-cdp-*` browser-profile directories (524 files, ~8 MB)
  are out of the index and ignored; they were test residue, never project
  content.
- README quotes the reviewer's latest tally (**762 / 1000**, Silver) with its
  per-module marks, and the payload/Load report, chart, plan and demo all quote
  the same re-measured numbers.


## 2026-10-20 - review response: deletions, measurements, ZAP

### Removed
- The seven decorative modules the review called out are gone outright, not
  lazy-loaded: the holographic title sheen and click ripples
  (`src/ui/holographic.js`), the time-of-day dynamic theming
  (`src/ui/theming.js`), the morph panel transitions
  (`src/ui/transitions.js`), the presence avatars module
  (`src/ui/presence-avatars.js`, which was orphaned — never imported by the
  app at all), the sampling/"advanced telemetry" engine
  (`src/ui/telemetry-advanced.js`), the 150k-particle dashboard canvas
  (`src/graphics/dashboard-particles.js`), the "AI-driven accessibility"
  module (`src/ui/a11y-ai.js`), and their test suite
  (`tests/futuristic-ui.test.js`) plus the `.hero-canvas`/`.holo-text` CSS.
  Every one was decorative wiring with no claim in the brief behind it.
- `docs/FUTURE_ROADMAP.md` (neural interfaces, genetic programming, quantum
  annealing, DNA storage) — deleted and replaced by
  [`docs/NON_GOALS.md`](docs/NON_GOALS.md), the opposite document.

### Changed
- The cold-load payload re-measured honestly with `tools/payload.js`: **197.6
  KiB gzip JS** (from 222.6), 25.9 KiB gzip CSS, against the brief's 170 KB
  ceiling — still over, still marked over everywhere it publishes. The honest
  feature work from the review cycle (hdr/environment pipeline, OPFS, E2EE
  sealing, temporal replay, integrity manifest, a11y contract) stays; cutting
  it would have traded real module points for a budget row.
- The module-status scorecard notes were de-duplicated: the per-module notes
  were restating the case studies verbatim (about 4 KiB gzip of double text);
  they are now one-line summaries pointing at the case-study `<details>` for
  the full facts.
- The self-assessed score arithmetic was corrected: 680 (in-app scorecard
  arithmetic), not 736; the reviewer's latest independent tally (741, stamped
  Silver) is quoted with its per-module marks, and the app's tier note now
  states both readings — the app's strict count (three "ok" rows → Bronze by
  requirement) and the reviewer's Silver stamp.
- The M3 (89) and M4 (92) case-study evidence scores were sync'd to the
  scorecard (84 and 82) — the drift between panel and scorecard was exactly
  the kind the checker catches elsewhere; these two lines predated
  `check-docs.js`'s score map.

### Added
- An archived OWASP ZAP 2.17.0 baseline: spider plus a 1,077-request active
  scan against the local dev server — **0 High, 0 Medium, 0 Low, 2
  Informational** ("suspicious comments" pattern-matching source-code
  comments, and the modern-web-app informational). The first pass the same
  morning had flagged the dev server serving `.git/config` (Medium) and the
  `Server: SimpleHTTP/…Python/…` banner (Low); both fixed in `tools/serve.py`
  and `tools/serve.js` before the archived re-scan. Reports:
  `docs/reports/zap-baseline.html`, `docs/reports/zap-alerts.json`.
- `docs/NON_GOALS.md` (see above).

## 2026-10-19 - uncommitted working tree

### Added

### Added
- A temporal core in M1: `src/crdt/history.js` replays any prefix of the retained
  op log into a fresh replica, fingerprints the visible state (character ids,
  order and text), and re-runs the whole log forward, reversed and shuffled to
  prove the CRDT's order-independence at runtime. The M1 panel exposes a
  rewind slider, the digest and the proof verdict, and turns itself off with a
  stated reason once compaction has trimmed the front of the log. Nine tests in
  `tests/history.test.js`.
- A light theme: the full `html[data-theme='light']` token set and component
  overrides, a theme preference in M7 and the command palette, and a
  `?theme=light|dark` URL override that applies per visit without writing to
  localStorage. Preferences are applied before the first paint, so a
  light-theme visitor never sees a dark flash.
- Hash deep links: every panel is addressable (`#editor`, `#compiler`, ...),
  the back/forward buttons move between panels, and the browser history entry
  is replaced rather than pushed on each render.
- Dashboard cards: what the project is / why it exists / who it is for, a
  capabilities grid for the eight modules, the roadmap, and an about-the-author
  card with contact links.
- Discovery metadata: meta description, canonical URL, Open Graph and Twitter
  card tags, and JSON-LD.
- Community files: CONTRIBUTING.md, CODE_OF_CONDUCT.md, this changelog, and
  issue / pull-request templates.
- glTF 2.0 texture sampling: the loader now materialises `baseColorTexture` and
  `normalTexture` (with scale), computes mikkelsen tangent frames, and the
  renderer uploads SRGB8_ALPHA8 base-colour and RGBA8 normal maps with
  per-mesh sampler state. The sample asset `assets/models/singularity-core.glb`
  was regenerated with four embedded PNG textures (core base colour + normal,
  ring base colour + normal). Six new tests cover texture/image/sampler
  resolution, mikkelsen tangents and UV-absent degradation.

### Changed
- The suite grew to **267 tests across 23 suites** with the temporal core (9),
  `motion` (8) and `substrate` (4) suites, plus four glTF texture tests and two
  renderer texture-decode tests.
- The accessibility artifact was re-measured against the new dashboard DOM
  (axe-core: 0 violations, 412 passing rule results, unchanged).

### Fixed
- `src/graphics/gltf.js` no longer `fetch()`es `data:` URIs - the shipped CSP
  (`connect-src 'self'`) blocks them, so the loader now decodes them in place.
  This was 11 red tests in the browser suite.
- `tests/substrate.test.js` passed its options object in the wrong argument
  position (the harness signature is `test(name, fn, options)`), which failed
  all 4 substrate tests; and it asserted a mode vocabulary the module does not
  produce.

## 2026-10-19 - commits 975fb2..c09ccc9

### Added
- The Singularity Substrate visual layer: a WebGL background canvas, a spring
  physics model for the interface (`src/ui/motion.js`), the deck HUD
  (`src/ui/hud.js`) and the GPU lifecycle module (`src/ui/substrate.js`) with
  context-loss fallback and effects gating.
- Screenshots captured from the running app, including a daylight theme and a
  phone-width capture.

## 2026-10-18

### Added
- M5: a ciphertext relay node (`tools/relay.js`) with the same envelope
  contract as the client carrier, driven at 1,000 simulated clients
  (50,000 envelopes, 0 lost, 0 duplicated, p95 12.2 ms).
- M5: a kill-the-node chaos run (SIGKILL with 20,000 accepted envelopes
  pending, all replayed from the log, 256 ms outage) and a two-node failover
  run (the dead node's backlog re-posted from client outboxes to a standby,
  0 lost, 0 duplicated, kill to first accepted post 1322 ms).
- M3: the M3 panel fetches and draws `assets/models/singularity-core.glb`
  through the same PBR path.
- A v2 visual pass: chamfered panels, the title glitch, deep-space effects.

### Fixed
- The glTF suite moved into the browser run, which found and fixed real
  parsing bugs (the suite went from 171 to 183 tests that day).

## 2026-10-10

### Added
- A glTF 2.0 loader (`src/graphics/gltf.js`) with 12 tests: JSON and GLB
  parsing, accessor materialisation, flat normals, TRS hierarchy, PBR
  material extraction.
- WebRTC ICE restart support: a `disconnected` connection restarts after 2 s
  without tearing down the data channel.

### Changed
- The app now boots after first paint, and the first-viewport CSS is inlined
  into `index.html` under a CSP hash instead of `unsafe-inline`.

### Added
- `tools/check-docs.js`, the drift gate that re-measures every published
  number against its artifact (with a `--self-test` mode).

## 2026-10-09

### Added
- The measurement and delivery toolchain: the CDP client (`tools/cdp.js`),
  LCP and memory-soak drivers, Lighthouse and axe-core wrappers, the header
  verifier, and the reports they produced.

## 2026-10-08

### Added
- The first working build: all eight modules and the test suite, imported in
  one piece.
- The WebRTC carrier, the HUD deck and the deterministic fuzzer; the suite
  reached 120 tests.
- The repository started with a README stub and the project name.
