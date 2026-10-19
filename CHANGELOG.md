# Changelog

Versions here are dates, not tags - the repository has no tagged releases yet.
Each entry is derived from the commit history; the newest comes first.

## 2026-10-19 - uncommitted working tree

### Added
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

### Changed
- The suite grew to **200 tests across 13 suites** with the new `motion`
  (8) and `substrate` (4) suites.
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
