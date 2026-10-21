# Project Singularity - roadmap beyond the brief

`PLAN.md` records how the eight-module brief was built, including what was
deliberately not attempted. This document is the next layer: what "more
advanced" means for a project that already meets its own definition of done, how
each step will be judged, and the order to take them in.

The rule for everything below: **a capability is not done until it has a test, a
number, and a place in the UI that shows the number.** Features that only look
advanced are chrome, and chrome belongs in the HUD where it is already marked
decorative.

## 0. Constraints the roadmap may not break

| Rule | Consequence |
|------|-------------|
| Zero runtime dependencies, no build step | every algorithm is hand-written and shipped as an ES module |
| Static hosting (GitHub Pages canonical) | no server, no accounts, no telemetry, no cloud AI |
| Honest partials | an unmeasured claim is deleted or labelled unmeasured |
| Same code in test and production | no test double for the CRDT, crypto or storage layers |

## 1. Where the project stands

- 8 modules, 3 full and 5 declared partial; self-assessed 708/1000.
- 254 tests across 16 suites (236 pass + 18 browser-only skips in bare Node).
- Canonical deployment: <https://ashrafularefin78-prog.github.io/PROJECT-SINGULARITY/>.
- The remaining module gaps are named: no third-party red-team or ZAP baseline
  (M8), no screen-reader pass (M7), no TURN relay or HDRI probe (M5/M3).

## 2. Horizon 1 - temporal core (shipped in this pass)

The CRDT has always kept its op log; until now nothing treated that log as a
second executable path. The temporal core does, and that is the cheapest kind of
advanced: no new dependency, no new host capability, only a stronger claim about
data that already exists.

| Item | What shipped | Gate |
|------|--------------|------|
| T1.1 replay to an op index | `src/crdt/history.js` rebuilds state from any prefix | every prefix equals the live incremental state (`tests/history.test.js`) |
| T1.2 structural digest | FNV-1a over character ids, order and text | same op set → same digest; same text from different ops → different digest |
| T1.3 order-independence proof | forward, reversed and seeded-shuffle replays | all three agree on the digest, including deletes and undo/redo |
| T1.4 visible surface | "Temporal core" card in M1 | slider, digest, proof verdict; slider disables itself when the log was compacted |

**Known limit, surfaced in the UI:** once `trimLog` drops the front of the log,
earlier states are not reconstructible. The card says so instead of pretending.

Next H1 items, in order:

1. **T1.5 peer digest exchange** - send the digest in the presence frame and flag
   a peer whose digest differs, so divergence is detected without comparing text.
2. **T1.6 timeline export** - download the retained log plus digests as JSON so a
   reviewer can replay a session outside the browser.
3. **T1.7 snapshot-aware replay** - pair the digest with the M6 snapshot so time
   travel survives compaction, using the existing catch-up path.

## 3. Horizon 2 - capability leaps

Each item below adds a capability the browser genuinely provides today and the
project currently does not use. Ordered by payoff per unit of risk.

| ID | Capability | Why it is a leap | Gate |
|----|------------|------------------|------|
| D2.1 | **OPFS durability tier** | the origin-private filesystem is the one storage primitive the app does not use; it survives cache eviction better than IndexedDB and is synchronous inside a worker | crash-injection test: kill the page mid-append, reopen, zero accepted edits lost; quota report published |
| E2.1 | **WebGPU compute path** | particles and GGX prefiltering move from draw calls to compute dispatches, with WebGL2 unchanged as the fallback | measured parity on the 1M-particle scene, capability-gated so a missing adapter is a declared skip, not a failure |
| S2.1 | **Local-first retrieval** | a hand-written inverted index plus trigram fuzzy search over documents and retained ops, ranked on-device | query latency and recall published alongside the index size; no network call in the trace |
| T2.1 | **Convergence sentinel** | digest comparison across peers turns "it looks the same" into a boolean the dashboard can show | two-tab and two-peer tests, with a deliberate divergence injected and detected |
| A2.1 | **VoiceOver/NVDA pass** | the honest ceiling on M7 is evidence, not code | recorded pass over editor, tablist, theme controls; scorecard updated |
| X2.1 | **ZAP baseline in CI** | passive scan of the built artifact, findings triaged in `docs/SECURITY_REPORT.md` | report artifact committed, every finding either fixed or accepted with a reason |

Sequencing note: D2.1 before T1.7 (durability makes the snapshot trustworthy),
E2.1 after A2.1 (accessibility debt is cheaper to pay before a new renderer), and
T2.1 immediately after T1.5.

## 4. Horizon 3 - research bets

These are worth attempting only after Horizon 2, and each may end in a written
"no" - which is a result if it is measured.

1. **WASM backend for the C subset.** Compile the existing AST to a module with
   `WebAssembly.Module` and run it beside the interpreter, keeping the
   interpreter as the semantic reference. Gate: identical output on the whole
   corpus, and a speedup number that is measured, not asserted.
2. **Relay fleet with WebTransport.** A second transport beside the HTTP relay,
   with datagrams for presence and streams for envelopes. Gate: chaos run against
   two nodes with WebTransport enabled, zero lost or duplicated envelopes.
3. **WebCodecs session recorder.** Encode the canvas and the DOM-free HUD into a
   short clip entirely client-side, replacing the current ffmpeg-based demo path.
   Gate: recorded clip plays, size and encode time published.
4. **WebNN adaptive quality.** A tiny on-device model choosing particle count and
   shadow resolution from frame timing. Gate: frame-time stability improves on the
   throttled profile, and the model is skipped where the API is absent.
5. **Compaction with proof.** Formalise snapshot-plus-suffix catch-up so replay
   covers the whole session even after GC. Gate: a property test that reconstructs
   a random document from a snapshot and a bounded suffix for 300 seeds.

## 5. What this roadmap will not do

- No npm package, bundler, transpiler or framework enters `src/`.
- No account system, analytics, error reporting or hosted AI.
- No "AI feature" that is a prompt wrapper; anything model-shaped must run
  on-device and be measured.
- No claimed module promotion without the missing evidence: M8 stays partial
  until a scan and a red-team pass exist, M7 until a screen-reader pass does.

## 6. Order of work

| Pass | Work | Expected outcome |
|------|------|------------------|
| 1 (this one) | T1.1-T1.4 temporal core | a second execution path for the CRDT, 9 new tests, new M1 card |
| 2 | T1.5, T2.1, D2.1 | divergence detection across peers, OPFS durability with a crash test |
| 3 | A2.1, X2.1 | M7 and M8 evidence gaps closed or honestly re-scored |
| 4 | E2.1, S2.1 | WebGPU compute path, on-device retrieval |
| 5 | Horizon 3 candidate | one research bet, chosen by measured payoff rather than novelty |
