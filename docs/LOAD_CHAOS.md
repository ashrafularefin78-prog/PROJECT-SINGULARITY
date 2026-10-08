# Load and chaos test report

The brief asks for *raw data and graphs* for the performance budget, and for a
chaos test that kills a server node with zero data loss.

This report contains everything that was **actually measured**, the exact
method, and an explicit list of what was **not** run. Nothing here is
extrapolated to a row that was not exercised, and no row is marked met that was
measured under the wrong conditions.

![Measured values against the brief's targets](charts/budget.svg)

## Method and environment

| Item | Value |
|------|-------|
| Host | Windows workstation, single Chromium browser tab |
| Server | `python3 tools/serve.py 5173` on 127.0.0.1 (static files only) |
| Network | loopback, **no throttling profile applied** |
| GPU | ANGLE (AMD Radeon), WebGL 2.0 (OpenGL ES 3.0 Chromium) |
| Instrumentation | the app's own telemetry (payload via `CompressionStream`, paint and interaction via `PerformanceObserver`, frame rate from the renderer loop), plus `performance.memory` |
| Repetition | payload, LCP and frame rate were sampled at least twice; the ranges below are the observed range, not a best case |

### Why there is no 10,000-user run here

The brief's budget rows "10,000 concurrent users, p95 < 200 ms" and "kill any
server node, lose zero data" describe a **distributed deployment**: a server
fleet, a load generator with 10,000 browser sessions, and a node that can be
killed. This project ships as a static bundle with no application server at all
(the server only hands out files), so there is no server node to kill and no
fleet to load. Fabricating either number from a single tab would be the exact
dishonesty this report exists to avoid.

What *was* run instead is stated per row, with its conditions, and every
unmeasured row is marked unmeasured on the in-app dashboard too.

## Results

| Budget row | Brief's target | Measured here | Verdict |
|------------|----------------|---------------|---------|
| Initial JS payload | ≤ 170 KB gzip | **79.0 KiB gzip / 243.2 KiB raw over 12 files** (plus 14.9 KiB gzip of CSS) | **met** (cold load, every module loaded, deck included) |
| Largest Contentful Paint | ≤ 1.5 s, throttled 4G, mid-range Android | 711 ms and 960 ms on loopback, **unthrottled** | not measured (conditions not met) |
| Interaction to Next Paint | ≤ 100 ms during a 50-user session | 32 ms under real typing, single user, **no 50-user session**. Under automation the metric does not populate at all, and Chromium logs a deprecation warning about the `durationThreshold` argument (see the note below) | not measured (conditions not met) |
| 3D frame rate | 60 FPS steady at 100k instances + shadows + 1M particles | **60 FPS** at 20,000 instances + 150,000 particles + PCF shadows (defaults); **58 FPS** at 100,000 instances + 1,000,000 particles (maximum settings) | **met at defaults**, 58/60 at maximum |
| Lighthouse | ≥ 95 in all four categories | not run (no Lighthouse in this environment; the empty-`<p>`/no-audit case is marked unmeasured in the app) | not measured |
| Memory after 1 hour | ≤ 400 MB, no leaks | 5.06–5.91 MiB JS heap during a ~10 minute session with the suite, load tests and the renderer run | not measured (minutes, not an hour; no 10-vs-60-minute heap comparison) |
| Concurrent users | 10,000 @ p95 < 200 ms | not run; see the two local approximations below | not measured |
| Chaos survival | kill any server node, lose zero data | not run; the local degradation tests below are the closest thing that exists here | not measured |

## Raw measurements

Note on the interaction metric: the app observes Event Timing with
`durationThreshold: 16`. Chromium warns that this argument belongs on the
observer's constructor instead, and both forms were probed here: neither one
reports a CDP-synthesized interaction, while real typing does eventually report
a value. That is one more reason this row is marked *not measured* rather than
*met* - a metric that only appears under some input paths is not a metric you
should score yourself on.

### 1. Initial JS payload — met

Two independent measurements, from the same page:

| Method | Result |
|--------|--------|
| App's own budget probe (fetches each shipped script, gzips it with `CompressionStream`) | 79.0 KiB gzip over 12 files, 243.2 KiB raw (the 12th file and the 6 KiB growth are the deck) |
| Independent import-graph walk (this report's measurement, follows `import` specifiers from `src/app.js`) | 78.0 KiB gzip over 11 modules, 240.9 KiB raw; `styles/app.css` adds 14.9 KiB gzip on top |

The brief's ceiling is 170 KB gzip, so the bundle uses ~43% of it. This is with
every module loaded — nothing is deferred — which is the honest way to measure
"cold load, modules lazy-loaded" when there is no build step and no lazy-loading
machinery.

### 2. Boot timeline (loopback, warm cache)

| Event | Time from navigation start |
|-------|----------------------------|
| Time to first byte of the document | 108 ms |
| `DOMContentLoaded` | 260 ms |
| Full `load` event | 261 ms |
| App's own boot log line "ready" | 180 ms |

The app's boot log is a real event log, not an animation: each line is emitted by
the code that performed the step (storage opened, document rebuilt, mesh joined,
observers armed).

### 3. 3D frame rate

| Configuration | FPS | Draw calls | Notes |
|---------------|-----|-----------|-------|
| 20,000 instances, 150,000 particles, shadows on (defaults) | **60** | 4 | includes the depth-only shadow pass |
| 100,000 instances, 1,000,000 particles, shadows on (maximum) | **58** | 4 | one instanced draw + ground + shadow + particles |

Both runs are on the same AMD Radeon via ANGLE. 58 FPS at maximum settings is
below the brief's "60 FPS steady" and is reported as short, not rounded up. The
renderer animates instances in the vertex shader, so main-thread CPU per frame
stays flat as instance count grows — that is the property the panel reports.

Does the deck chrome (frame, parallax, ticker, waveform, radar ring) cost
frames? Measured back to back on the same scene:

| Settings | Effects full | Effects off |
|----------|--------------|-------------|
| Defaults (20,000 instances, 150,000 particles) | 60 FPS | 60 FPS |
| 70,000 instances, 1,000,000 particles | 59 FPS | 56–58 FPS |

That is inside run-to-run noise, so the honest reading is "no measurable cost on
this GPU", not "free". Every deck animation is a transform on its own
compositor layer, which is why a wider viewport with a million particles does not
show a difference — and it is also why "Effects: off" is still the right switch
on a machine where compositor layers are not free.

### 4. CRDT throughput (M1)

| Test | Work | Time | Rate |
|------|------|------|------|
| Sequential typing | 20,000 single-character appends | 1,531 ms | 13,062 appends/s, **0 node visits** (cursor walk) |
| 3-replica convergence | 10,000 ops produced, 40,000 delivered (shuffled + duplicated) | 4,290 ms | 9,323 deliveries/s, converged |
| 50-replica convergence | 400 ops produced, 20,000 delivered (independent shuffle per replica) | 181 ms | **110,293 deliveries/s**, converged, 312 chars |

The 50-replica row is the closest local approximation of a 50-user editing
session: 50 independent CRDT replicas merging the same op set in 50 different
orders. It is **not** a 50-user session — there is no rendering, no network and
no server in it — and it is not reported as the brief's concurrent-user row.

### 5. Mesh fan-out (M5)

| Test | Result |
|------|--------|
| Peers | 10 mesh instances in one tab (BroadcastChannel carrier) |
| Traffic | 600 sends of a document envelope, each fanned out to the other 9 peers |
| Deliveries | 5,940 (5,400 document envelopes + 540 presence envelopes), 0 lost |
| Delivery latency | p50 **46 ms**, p95 **67 ms**, max 69 ms (target p95 < 200 ms) |
| Flood control | 0 document envelopes throttled — the limiter applies to presence packets only, by design, because dropping an op would lose a character |

One tab is one process: this measures the mesh's fan-out and dispatch cost, not
WAN traversal. The WebRTC carrier's own end-to-end path is covered by
`tests/webrtc.test.js`, which opens a real data channel between two carriers and
asserts that application traffic crosses it in both directions.

### 6. Storage path (M6)

| Test | Result |
|------|--------|
| Append | 1,000 ops in 4 batches of 250 | 68 ms | 14,630 ops/s |
| Read back | 1,000 ops | 9 ms |
| Compaction | save snapshot + trim the log | 64 ms | 0 ops left in the log afterwards |
| Quota | `navigator.storage.estimate()` | 131,624 MiB quota, 5.44 MiB used by this origin (the app's own document plus load-test rows) |

### 7. Degradation behaviour (the local stand-in for chaos)

There is no server node to kill, so the failures that *can* be injected locally
were injected and are asserted in the suite:

| Injected failure | Required behaviour | Evidence |
|------------------|--------------------|----------|
| Offline (airplane mode) with edits in flight | edits persist locally and merge with zero lost characters on reconnect | `tests/rga.test.js` (offline merge), `tests/storage.test.js` (op log round-trip) |
| Damaged op log | the log is rebuilt from recovered text and the UI says so | `tests/storage.test.js` damaged-log path, M6 recovery notice |
| Out-of-order / duplicated / delayed delivery | convergence, no duplication | `tests/rga.test.js` (commutative, idempotent), `tests/fuzz.test.js` (shuffled + double delivery) |
| Malformed ciphertext / replayed message | rejected, never decrypted | `tests/crypto.test.js`, `tests/fuzz.test.js` (27 single-byte mutations, 40 malformed frames, 0 accepted) |
| Malformed signaling code / hostile paste | rejected with a reason, never half-parsed | `tests/webrtc.test.js`, `tests/fuzz.test.js` (161 codes, 154 rejected) |
| Presence flood | throttled, document traffic untouched | `tests/mesh.test.js` (flood test), measurement above |
| Runaway C program | killed by the step/depth budget, deterministically | `tests/fuzz.test.js` (3 infinite programs) |

The service worker's offline shell was verified by stopping the server process
and reloading the page under a subpath deployment (`--prefix`), which is also how
the GitHub Pages layout is reproduced locally.

## What this report does not claim

- No Lighthouse run, no axe run, no screen-reader run.
- No throttled-4G profile, so the paint and interaction numbers are informational.
- No 1-hour memory soak and no 10-versus-60-minute heap comparison, only a
  minutes-long session with a small JS heap.
- No 10,000-user load: no distributed rig was available, and the project has no
  application server to load.
- No node-kill chaos test: no cluster exists; the local failure injections above
  are the reachable substitute.
- No multi-machine WebRTC session driven by a person end to end (the two-carrier
  data-channel test is automated but runs inside one machine).

Reproduce any row: `python3 tools/serve.py 5173`, open the app, and the numbers
above are visible live on the M0 dashboard, in the M1/M3/M5/M6 panels and in
`/tests/browser.html`.
