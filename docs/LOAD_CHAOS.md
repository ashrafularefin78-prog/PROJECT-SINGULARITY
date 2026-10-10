# Load, performance and accessibility report

The brief asks for *raw data and graphs* for the performance budget, for a chaos
test that kills a server node with zero data loss, and for measured evidence
rather than adjectives.

This report contains everything that was **actually measured**, the exact
method and command for each row, and an explicit list of what was **not** run.
Nothing here is extrapolated to a row that was not exercised, and no row is
marked met that was measured under the wrong conditions. Every number below can
be reproduced on this machine with the command in its section: the measurement
tools are part of the repository (`tools/*.js`, no npm dependencies), not
throwaway scripts.

![Measured values against the brief's targets](charts/budget.svg)

## How it was measured

| Item | Value |
|------|-------|
| Browser | Microsoft Edge 154.0.4258.62 (Chromium), driven headlessly over the DevTools Protocol. The machine auto-updated to 155.0.4283.45 while the work was in flight: the soak and Lighthouse artifacts above were recorded on 154, and the accessibility re-run recorded 155 in `docs/reports/a11y.json`. Every number below is reported with the version its own artifact records |
| Driver | `tools/cdp.js` — a ~350-line CDP client built on Node's own `fetch`/`WebSocket` globals, no npm packages |
| Server | `python3 tools/serve.py 5173` / `node tools/serve.js` on 127.0.0.1, serving the **real `_headers` policy** (strict CSP, COOP/COEP, Trusted Types) |
| Instrumentation | `PerformanceObserver` installed before first paint (LCP, FCP, layout shift, long tasks), `Performance.getMetrics`, `Runtime.getHeapUsage` after an explicit GC, `HeapProfiler.takeHeapSnapshot`, the browser accessibility tree, axe-core |
| Repetition | every timing row was run at least twice under each profile; the tables show each run, not a best case |
| Drift control | `node tools/check-docs.js` re-measures the payload from the import graph, reads every JSON report, and asserts that the exact strings this document and the chart publish are still the ones the artifacts produce. It has caught three real drifts: a 4-line code change that moved the payload from 112.9 to 113.2 KiB gzip; a soak figure that predated the completed hour; and - the one that matters most - moving the application module behind the deferred boot hid `src/app.js` from the walk, so the same command cheerfully reported a *smaller* bundle. `tools/payload.js` now reads the module's specifier out of the bootstrap, the walk is back to 18 modules, and the row above is 116.1 KiB. `--self-test` injects a wrong number and asserts the check fails, so a checker that passes on everything cannot pass for the wrong reason |

Two environments are reported on purpose:

* **bare Node** (`npm test`) runs 146 of the 152 tests and skips the 6 that need
  a canvas or IndexedDB, so the exit code means "no regressions" rather than
  "this machine has no GPU".
* **headless Edge** (`npm run test:browser`) runs all 152, including the WebGL2
  renderer and the IndexedDB store, in 2.3–3.2 s depending on what else the machine
  is doing (the spread is reported rather than averaged away).

### Why there is no 10,000-user run here

The brief's budget rows "10,000 concurrent users, p95 < 200 ms" and "kill any
server node, lose zero data" describe a **distributed deployment**: a server
fleet, a load generator with 10,000 browser sessions, and a node that can be
killed. This project ships as a static bundle with no application server at all
(the server only hands out files), so there is no server node to kill and no
fleet to load. Fabricating either number from a single tab would be the exact
dishonesty this report exists to avoid.

What *was* run instead is stated per row, with its conditions. Every unmeasured
row is marked unmeasured on the in-app dashboard too.

## Results

| Budget row | Brief's target | Measured here | Verdict |
|------------|----------------|---------------|---------|
| Initial JS payload | ≤ 170 KB gzip | **116.1 KiB gzip JS** (446.6 KiB raw over 18 modules) + 16.9 KiB gzip CSS, measured from the import graph | **met** (cold load, every module counted, worker included; the entry point is deferred past the first paint but still ships) |
| Largest Contentful Paint | ≤ 1.5 s, throttled 4G, mid-range Android | **603 ms**, FCP with it (the hero is the first thing painted), under Slow 4G + 4x CPU at 412×915, against 72 ms unthrottled on loopback | **met** — see section 2 |
| Interaction to Next Paint | ≤ 100 ms during a 50-user session | 32 ms under real typing, single user, **no 50-user session**. Under automation the metric does not populate at all | not measured (conditions not met) |
| 3D frame rate | 60 FPS steady at 100k instances + shadows + 1M particles | **60 FPS** at defaults (20k instances, 150k particles, shadows); **58 FPS** at maximum settings | **met at defaults**, 58/60 at maximum |
| Lighthouse | ≥ 95 in all four categories | desktop **100 / 100 / 100 / 100**, mobile **100 / 100 / 96 / 100** (Performance / Accessibility / Best practices / SEO) | **met in both form factors** — see section 2b |
| Cumulative layout shift | (implicit: under 0.1) | **0.002** on the mobile viewport and **0.005** desktop (`tools/cls.js`); Lighthouse agrees at 0.003 / 0.005 | **met**, with one unreproduced outlier from an earlier build reported rather than hidden (section 2b) |
| Memory after 1 hour | ≤ 400 MB, no leaks | a **60-minute soak**, one sample per minute through all nine modules: JS heap after GC **1.10 → 1.53 MiB** (peak 1.56 MiB at minute 52), and the minute-60 heap snapshot holds **fewer nodes (70,231 vs 77,490) and less memory (5.99 vs 6.71 MiB)** than the minute-10 one | **met on the conditions run** — desktop browser, JS heap after a forced GC, not RSS or GPU memory |
| Concurrent users | 10,000 @ p95 < 200 ms | not run; the local approximations are listed below | not measured |
| Chaos survival | kill any server node, lose zero data | not run; the local failure injections below are the closest thing that exists here | not measured |
| Durability window | (implicit: no lost edits) | an edit survives a reload **0 ms** later, repeatedly — see below | **met** |

## Raw measurements

### 1. Initial JS payload — met

`node tools/payload.js` walks the `import` graph from the entry points a cold
load actually fetches (the scripts `index.html` loads, the linked stylesheet, the
bootstrap `src/boot-note.js` - which names the module the deferral starts - and the runtime worker) and gzips every file:

| Method | Result |
|--------|--------|
| Import-graph walk (this report's measurement) | **116.1 KiB gzip JS over 18 modules**, 16.9 KiB gzip CSS, 446.6 KiB raw total |
| App's own budget probe (fetches each shipped script in the page, gzips with `CompressionStream`) | counts the same files live and is visible on the M0 dashboard |

The two largest files are `src/app.js` (42.3 KiB gzip of 130.5 KiB raw) and
`src/runtime/interpreter.js` (19.6 KiB gzip of 76.2 KiB raw) — the second grew
during the M2 work that added `<string.h>`, `<ctype.h>`, `<math.h>`, the
preprocessor, typedefs, two-dimensional arrays, function pointers and unions,
and `src/runtime/preprocess.js` (4.0 KiB gzip) is new from the same work. The brief's
ceiling is 170 KB gzip, so the bundle uses ~68% of it with every module counted,
including the ones the first paint no longer waits for.

### 2. Throttled LCP — 603 ms cold, met

`node tools/perf.js lcp --repeat=2` navigates the app under CDP network
emulation (Slow 4G: 150 ms RTT, 1.6 Mbps down, 750 Kbps up) and 4x CPU
throttling at a 412×915 mobile viewport, against the real dev server — which now
compresses text the way the hosts do — then reads `largest-contentful-paint`
from a buffered `PerformanceObserver`. Raw runs: `docs/reports/lcp.json`.

| Profile | LCP | LCP element | FCP | TTFB | CLS | Long tasks | JS heap |
|---------|-----|-------------|-----|------|-----|-----------|---------|
| Slow 4G + 4x CPU, cold | **603 ms** | `P.lede` (the hero paragraph) | 603 ms | 45.2 ms | 0 | 1 (61 ms) | 1.2 MiB |
| Slow 4G + 4x CPU, second navigation | 82 ms | `P.lede` | 82 ms | 7.2 ms | 0 | 0 | 2.5 MiB |
| unthrottled loopback | 72 ms | `P.lede` | 72 ms | 8.5 ms | 0 | 0 | 1.91 MiB |

The second throttled row is published because the gap is instructive rather than
flattering: it is the *same browser profile* navigating a second time, so the
document and the inline block come back out of the memory cache and the 4G
profile never sees them. It is not a claim about a first visit. The cold run is,
and it meets the 1.5 s target with about 897 ms of headroom where the
build before this work missed it by a factor of three (**4,705 ms**, FCP
1,955 ms, and 86% of LCP spent waiting to paint).

**What moved it, in the order it was done — including the attempts that failed:**

1. **The hero paragraph is static HTML.** `P.lede` used to be built by
   `src/app.js` during boot, so it could not paint until the whole module graph
   had been fetched, parsed and executed: under 4x CPU that was 1,955 ms of FCP
   and 4,705 ms of LCP. It now lives in `index.html`, and the module *adopts* the
   node (`adoptHero`), replacing only the ring and the badge strip.
2. **The first viewport's CSS is inlined.** `styles/critical.css` (generated by
   `tools/critical-css.py`, 20.9 KiB raw / 5.3 KiB gzip) is inlined into `index.html` under a
   `style-src` SHA-256 — so the policy keeps `'self'` and no `'unsafe-inline'` —
   and `styles/app.css` is applied by the module once it runs. The split is not a
   hand-copied subset: the script owns it, and `--check` fails if `index.html`,
   `_headers` and the generated file drift apart.
3. **The module boots after the first paint.** `src/boot-note.js` waits for the
   browser's own `first-contentful-paint` paint entry and only then starts
   `src/app.js` with a dynamic `import()`. Two earlier attempts are recorded
   because they failed: a plain deferred module script still executes before
   the first paint, and starting the module from a double
   `requestAnimationFrame` was coalesced into the frame that would have painted,
   measuring FCP 683 ms.
4. **The reference server compresses.** `tools/serve.js` now negotiates brotli
   or gzip like the hosts do; before that, every local metric was measured
   against bytes the deployed site never sends (Lighthouse estimated the
   difference at 239 KiB).

**What is left, stated rather than implied:** the measurement runs against
`tools/serve.js` on loopback, so TTFB is 45.2 ms and says nothing about a
real network; the cold run still spends one 61 ms task starting the module
after the paint; and the page is still one module graph, so a slow link waits
for it after the paint rather than before it. The row is about when the page
becomes readable, which is what the brief asks.

### 2b. Lighthouse — run in both form factors

`node tools/lighthouse.js --form-factor=mobile|desktop` runs the real Lighthouse
CLI (12.8.2, installed under `.tools/`, not a project dependency) against the
local build, with the **real `_headers` policy** served, now over a compressing
server. Reports: `docs/reports/lighthouse-mobile.json`,
`docs/reports/lighthouse-desktop.json`.

| Category | Mobile (412×915, simulated 4G) | Desktop | Target | Verdict |
|----------|-------------------------------|---------|--------|---------|
| Performance | **100** | **100** | ≥ 95 | met in both form factors |
| Accessibility | **100** | **100** | ≥ 95 | met |
| Best practices | **96** | **100** | ≥ 95 | met |
| SEO | **100** | **100** | ≥ 95 | met |

Mobile key metrics: FCP 0.9 s, LCP 1.1 s,
TBT 0 ms, **CLS 0.003**, Speed Index 1.1 s, TTI
1.1 s, 185 KiB total. The desktop run: FCP 0.3 s,
LCP 0.7 s, CLS 0.005, Speed Index 0.5 s, 187 KiB total.
`render-blocking-resources` and `uses-text-compression` now pass — they were
the two audits failing on the earlier build (an estimated 300 ms and an
estimated 239 KiB of savings), and they are what the inline block and the
compressing server fixed. The remaining non-perfect audits on mobile are
`first-contentful-paint` and `largest-contentful-paint` at 0.99 (both inside
Lighthouse's top scoring band) and `font-size` at 0 in best practices: one
selector (`.small`) computes to 11.48px, just below the 12px legibility
threshold, in the footer and a panel — not in the hero.

#### The layout shifts the inline block introduced, and how each was fixed

Deferring the stylesheet means the first paint is styled by the inline block
alone, so *any* shell rule the block omits shows up as a layout shift when the
sheet lands. Chasing the first desktop run — Performance **88**, CLS 0.219 —
found six, each confirmed by loading the page with `styles/app.css` blocked and
comparing the geometry to the styled page (`.tools/scratch/cls-trace2.mjs`):

| Element | Deferred, so at first paint it… | Shift | Fix |
|---------|--------------------------------|-------|-----|
| `.spark` (topbar sparkline svg) | fell back to an intrinsic 213px height, inflating the header to 308px | 0.219 desktop | allowlisted (138×26) |
| `button, .button` (base rule) | left the command button with no padding, so the header row grew 14px once the sheet arrived | 0.219 / 0.092 | allowlisted |
| `h1, h2, h3` and `p` (base margins) | made the hero about 16px taller than the styled one | 0.007 | allowlisted |
| `.hud` (fixed-position chrome) | stayed in the body grid and took a row, so the deck strip landed on the `1fr` row and measured **413px** instead of 49px | 0.197 desktop | allowlisted exactly (with `#hero`, for its own `max-width: 1200px`) |
| `.wave` (deck strip chart svg) | same intrinsic-size fallback inside an empty deck | (with `.hud`) | allowlisted |
| telemetry strip, status-chip row | reserved 37px and 0px but fill to 68/52.5px and 55px as boot fills them | 0.061 / 0.048 | `min-height` steps at the widths where their contents wrap (measured at 13 widths) |

The result is `tools/cls.js` — its own `layout-shift` observer installed before
first paint, with the visual viewport resized twice to imitate the mobile URL
bar: **CLS 0.002** on the mobile viewport and 0.005 on the desktop one, down from
0.092 and 0.219. `tools/critical-css.py --check` keeps the split honest from
here: a rule that leaves the inline block by accident fails
`tests/policy.test.js` instead of silently painting late.

#### One mobile CLS reading did not reproduce — and the change made for it was reverted

The first mobile run scored Performance **67** with **CLS 1.000**, and Lighthouse's
culprit audit named a single node: `body > div.fx > span.fx-aurora`, the decorative
layer sized with `inset: -20%`. The hypothesis was clean: a box sized as a
percentage of the viewport moves when the mobile visual viewport changes (the URL
bar collapsing), and a full-viewport element moving scores the maximum 1.000. The
rule was changed to the visually identical `transform: scale(1.4)`, which is not a
layout shift.

Then the numbers refused to cooperate:

| Run | CSS | Performance | CLS | LCP |
|-----|-----|-------------|-----|-----|
| mobile #1 | original | 67 | **1.000** | 3.0 s |
| mobile #2 | transform geometry | 82 | **0** | 4.4 s |
| mobile #3 (control) | **original restored** | 80 | **0** | 4.7 s |
| mobile #4 (shipped, idle machine) | original | 80 | **0** | 4.7 s |
| mobile #5 (shipped: inline critical CSS, deferred boot, compressing server) | original | **100** | **0.003** | 1.1 s |
| desktop (shipped, idle machine) | original | 98 | 0.005 | 1.0 s |

Mobile #5 is the run the section-2b numbers are taken from: the same machine, the
shipped build, with the hero static, the critical CSS inline and the module
booting after the first paint.
Run #4 was the last build before that work. The layout-shifts audit lists **no shift entries at
all** in it, and the same audit in run #1 is where the 1.000 came from.

The control run is the one that matters: with the pre-fix rule put back, CLS was
**0** as well. `node tools/cls.js` says the same thing from the other direction —
it installs a `layout-shift` observer before first paint, loads at 412×915, then
shrinks and restores the layout viewport to imitate the URL bar moving, and it
records **0 shift entries** on load and across both resizes, with the original
rule and with the candidate one (`docs/reports/cls.json`, `cls-legacy.json`).

So the aurora change is **not** credited with fixing anything, and it was
reverted: `styles/app.css` carries the original rule. What the evidence supports
is narrower and is stated as such — the 1.000 reading appeared once, on the third
and last attempt of a Lighthouse run whose first two attempts had already died on
a closed connection, and it has not been reproduced in three runs since. It is
reported as an unexplained outlier rather than as a fix.

The one layout shift in this app that *was* diagnosed and fixed lives in the same
file: the tab strip shipped empty and was filled 938 ms into boot, measuring 21px
before and 53px after, which moved every module panel 58px down the page — a
desktop CLS of **0.375**, now **0.005**, by reserving the filled height with
`min-height`. The mobile outlier is left named, with the A/B above, because
claiming a fix that a control run contradicts is exactly the kind of claim the
rest of this report exists to avoid.

### 3. Memory soak — 60 minutes, and the last snapshot is *smaller* than the first

`node tools/perf.js soak --minutes=60 --snapshot-at=10,60` opens the app,
clicks through the nine module tabs one per minute (each panel builds and tears down
its own DOM, canvases and workers — an idle page would prove far less), forces a full
GC every minute, resizes the window every minute (a renderer re-creating its drawing
buffer is a classic leak path), and records the JS heap *after* that GC, the V8 node
count and the DOM size. It then takes real heap snapshots at minutes 10 and
60, both of which survived on disk. Raw samples:
`.tools/soak/samples.jsonl`; report: `docs/reports/soak.json`.

| Metric | First minute | Last minute | Peak | Delta |
|--------|--------------|-------------|------|-------|
| JS heap after GC | 1.10 MiB | 1.53 MiB | 1.56 MiB (minute 52) | +0.43 MiB over 60 minutes |
| Per minute | — | — | — | +0.010 MiB/min |
| V8 nodes | 969 | 940 | 1,616 | rises and falls with the active module, and returns |
| DOM elements | 532 | 235 | 532 | rises and falls with the active module |
| Canvases | 0 | 0 | 1 | the 3D panel is the only module that allocates one |
| Documents | 1 | 1 | 1 | constant: nothing opens a document it forgets to close |

Verdict against the brief's row (**≤ 400 MB after 1 hour, no leaks**): the measured
heap is two orders of magnitude below the budget, and it completed all 60 of its minutes, so the duration in
the row's own words is satisfied by a real 60-sample run with no
interpolation. It is still reported against the conditions actually run: a desktop
browser (Edge
154.0.4258.62) on this machine, not a mid-range
phone; the number is the **JS heap after a forced GC**, not resident set size, and it
excludes GPU memory. Nothing here is extrapolated past minute 60.

#### The strongest evidence is the pair of snapshots, not the line

An hour of runtime with object churn left the heap smaller: **5.99 MiB reachable over 70,231 nodes** at minute 60, against 6.71 MiB over 77,490 nodes at minute 10. A leak cannot survive that comparison; a heap nothing ever touched could fake a flat line but not a shrinking one.

#### Where the bytes actually are

| Snapshot | Nodes | Reachable bytes | Largest retained categories |
|---|---|---|---|
| minute 10 | 77,490 | 6.71 MiB | native 5.69 MiB, code 0.45 MiB, object shape 0.19 MiB, array 0.15 MiB |
| minute 60 | 70,231 | 5.99 MiB | native 4.91 MiB, code 0.51 MiB, object shape 0.19 MiB, array 0.15 MiB |

The minute-10 and minute-60 snapshots, compared object type by object type. Across the whole heap the minute-60 snapshot holds **7,259 fewer nodes** and **0.72 MiB less reachable memory** than the minute-10 one — 50 more minutes of clicking through nine modules left the heap *smaller*. That is what rules a leak out; a flat line alone could also be a heap nothing ever touched.

| Grew most | min 10 | min 60 | Delta | Count delta |
|---|---|---|---|---|
| `native blink::CachedMatchedProperties` | 0 | 58,344 | +58,344 | +429 |
| `code system / BytecodeArray` | 0 | 50,280 | +50,280 | +180 |
| `native system / DoubleStringCache` | 0 | 49,160 | +49,160 | +1 |
| `array (object properties)` | 0 | 48,744 | +48,744 | +80 |
| `code system / InstructionStream` | 180,608 | 219,008 | +38,400 | +32 |
| `object shape system / DescriptorArray` | 98,776 | 100,240 | +1,464 | +6 |
| `native system / ArrayList` | 77,128 | 78,588 | +1,460 | +0 |
| `object shape system / Map` | 82,864 | 83,224 | +360 | +9 |

| Shrank most | min 10 | min 60 | Delta | Count delta |
|---|---|---|---|---|
| `native blink::GridSizingTrackCollection` | 156,960 | 52,320 | -104,640 | -60 |
| `native blink::ComputedStyle` | 111,312 | 79,704 | -31,608 | -439 |
| `native blink::ComputedStyleBase::StyleMiscData` | 105,776 | 75,504 | -30,272 | -344 |
| `native blink::ComputedStyleBase::StyleMiscInherited1Data` | 96,928 | 89,440 | -7,488 | -36 |
| `native blink::ComputedStyleBase::StyleSurroundData` | 94,224 | 86,736 | -7,488 | -24 |
| `native blink::ComputedStyleBase::StyleBoxData` | 63,888 | 59,664 | -4,224 | -24 |
| `native system / ExternalStringData` | 421,889 | 419,431 | -2,458 | -47 |
| `array (anonymous)` | 103,416 | 101,368 | -2,048 | +0 |
| `native blink::ImmutableCSSPropertyValueSet` | 111,728 | 111,392 | -336 | -7 |

The minute-60 snapshot by retained type:

| Retained object type | Bytes |
|---|---|
| `native` | 5,151,695 |
| `code` | 535,388 |
| `object shape` | 196,632 |
| `array` | 156,324 |
| `string` | 125,904 |
| `closure` | 83,416 |
| `object` | 30,912 |

| Largest single retained objects | Bytes | Count |
|---|---|---|
| `native system / JSArrayBufferData` | 1,600,904 | 8 |
| `native system / ExternalStringData` | 419,431 | 489 |
| `native system / FunctionTemplateInfo` | 246,080 | 3847 |
| `code system / InstructionStream` | 219,008 | 151 |
| `native blink::ImmutableCSSPropertyValueSet` | 111,392 | 772 |
| `array (anonymous)` | 101,368 | 267 |

The single largest retained item is `native system / JSArrayBufferData`: the
ArrayBuffers behind the WebGL context and the module panels' backings, not JS objects
the app keeps allocating. That split is why the per-minute series is the growth
evidence and the snapshot is the attribution — a working set of a few MiB that does
not grow is a working set, not a leak. The eight object types that grew between the
two snapshots total ~242 KiB,
while the single largest that shrank (`blink::GridSizingTrackCollection`) gave back
102 KiB.

#### The earlier runs, and why each was rerun

Every earlier run is kept rather than overwritten, because each later run exists to fix
what the previous one exposed. Logs: `.tools/logs/soak*.log`; the reports that were
saved are named below.

| Run | Samples | Heap after GC | What was wrong with it |
|-----|---------|---------------|------------------------|
| idle page, no module rotation | 10 | 1.06 → 1.11 MiB (peak 1.11) | first version: it sampled an empty tab strip, so almost none of the app's code was exercised |
| idle page, `--tabs=0` | 20 | 1.04 → 1.16 MiB (peak 1.16) | same flaw, longer: it proved the idle page is stable, which was never the question |
| module rotation, first attempt | 20 | 1.10 → 1.50 MiB (peak 1.52) | rotation worked; the run was still capped at 20 samples by a bad argument |
| module rotation, machine restarted mid-run | 35 | 1.04 → 1.57 MiB (peak 1.57) | killed at minute 35 by the restart; the report was rebuilt from the samples already on disk (`tools/perf.js analyse`) |
| **this run** | **60** | **1.10 MiB → 1.53 MiB (peak 1.56 MiB at minute 52)** | —; heap snapshots at minutes 10, 60 |

### 4. Durability — an edit is never lost, measured

`node tools/durability.js` types a unique marker into the M1 editor and reloads
the page after a fixed delay, then checks whether the marker came back from
IndexedDB. This is the honest form of "nothing is lost":

| Reload delay after the edit | Edit survived? |
|------------------------------|----------------|
| 0 ms (immediately) | yes |
| 100 ms | yes |
| 250 ms | yes |
| 500 ms | yes |
| 1 s | yes |
| 2 s | yes |
| 4 s | yes |
| 8 s | yes |

Raw: `docs/reports/durability.json`. The first attempt at this check reported
"lost" for Bangla/Arabic text — that was a **bug in the check**, not in the app:
the probe reloaded the page and read the editor without re-opening its module
tab, so it read an empty string. Fixed in `tools/a11y.js`, and the multi-byte
round trip now passes in both directions.

### 5. Accessibility — three real findings, all fixed

`node tools/a11y.js` walks all nine module views, runs axe-core (the engine
behind Lighthouse's accessibility category) in each, and audits the browser
accessibility tree — the tree a screen reader is handed. Raw:
`docs/reports/a11y.json`.

| Finding | Severity | Fix |
|---------|----------|-----|
| `input[type=checkbox]` in the M3 panel had no accessible name | **critical** | the label now points at the control's id (`#shadow-map`); the tree shows 0 unnamed controls |
| `#main` scrolls but could not be reached with the keyboard | **serious** | `tabindex="0"` on the scrollable region, so keyboard users can scroll the module panel |
| content not contained by landmarks — the module tab list | moderate | the tab list is wrapped in a `<nav>`; `role="tablist"` on the `<nav>` itself had overridden its navigation landmark role |

After the fixes: **0 axe-core violations, 406 passing rule results, 0 interactive
controls without an accessible name, 0 heading level jumps**, across all nine
views.

Text shaping, since the brief asks specifically about Bangla and Arabic inside
the editor:

| Check | Result |
|-------|--------|
| Editor font | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |
| Bangla (`বাংলা`) renders glyphs | 171 ink pixels at 29.87 px width — the font has real coverage, not tofu |
| Arabic (`العربية`) renders glyphs | 120 ink pixels at 28.08 px width |
| Arabic contextual shaping applied | yes — the joined form measures differently from the same letters written separately |
| Multi-byte round trip through the CRDT and IndexedDB | insert ✓, survives a reload ✓, 16 codepoints intact |
| Writing direction | `dir="ltr"` with `unicode-bidi` left at normal; the M7 panel exposes a writing-direction preference for RTL readers |

What this is **not** is a screen-reader session. NVDA and VoiceOver cannot run on
a headless CI machine, and this report does not claim they were run. The
accessibility-tree audit covers the same tree those tools consume; the parts
that genuinely need a person listening to a screen reader — announcement order,
verbosity, interruption behaviour — remain unverified and are listed at the end
of this file.

### 6. Dead code and hostile input, by the numbers

The fuzz suite (unchanged by this work, still green) feeds the compiler and the
network layer hostile input rather than trusting them:

| Injection | Result |
|-----------|--------|
| 400 random and mutated C sources | tokens or a positioned diagnostic, never a raw JS exception |
| 161 malformed signaling codes | 154 rejected with a reason, 7 structurally valid |
| 27 single-byte ciphertext mutations, 40 malformed frames | 0 accepted |
| 3 infinite C programs | each killed by the deterministic step budget |
| Random concurrent edit programs | convergence from any delivery order |

### 7. Response headers — delivered, and verified as delivered

`node tools/verify-headers.js` starts the server and compares the headers it
delivers with what `_headers` says, plus asserting the three directives a
`<meta>` tag cannot express:

| Header | Value | Source |
|--------|-------|--------|
| `Content-Security-Policy` | strict policy incl. `frame-ancestors 'none'`, `require-trusted-types-for 'script'` | `_headers` |
| `Cross-Origin-Opener-Policy` | `same-origin` | `_headers` |
| `Cross-Origin-Embedder-Policy` | `require-corp` | `_headers` |
| `Cross-Origin-Resource-Policy` | `same-origin` | `_headers` |
| `X-Content-Type-Options` / `Referrer-Policy` / `Permissions-Policy` | `nosniff` / `no-referrer` / `geolocation=(), camera=(), microphone=()` | `_headers` |

`_headers` is now the **single source** for these: the local servers parse the
file rather than keeping a second copy of the policy, so what is measured here
is what Cloudflare Pages and Netlify will deliver. See `docs/DEPLOY.md`.

### 8. 3D frame rate

| Configuration | FPS | Draw calls | Notes |
|---------------|-----|-----------|-------|
| 20,000 instances, 150,000 particles, shadows on (defaults) | **60** | 4 | includes the depth-only shadow pass |
| 100,000 instances, 1,000,000 particles, shadows on (maximum) | **58** | 4 | one instanced draw + ground + shadow + particles |

58 FPS at maximum settings is below the brief's "60 FPS steady" and is reported
as short, not rounded up. The renderer animates instances in the vertex shader,
so main-thread CPU per frame stays flat as instance count grows.

### 9. CRDT throughput (M1)

| Test | Work | Time | Rate |
|------|------|------|------|
| Sequential typing | 20,000 single-character appends | 1,531 ms | 13,062 appends/s, **0 node visits** (cursor walk) |
| 3-replica convergence | 10,000 ops produced, 40,000 delivered (shuffled + duplicated) | 4,290 ms | 9,323 deliveries/s, converged |
| 50-replica convergence | 400 ops produced, 20,000 delivered | 181 ms | **110,293 deliveries/s**, converged |

### 10. Mesh fan-out (M5)

| Test | Result |
|------|--------|
| Peers | 10 mesh instances in one tab (BroadcastChannel carrier) |
| Traffic | 600 sends of a document envelope, each fanned out to the other 9 peers |
| Deliveries | 5,940, 0 lost |
| Delivery latency | p50 **46 ms**, p95 **67 ms**, max 69 ms (target p95 < 200 ms) |

### 11. Storage path (M6)

| Test | What was run | Result |
|------|--------------|--------|
| Append | 1,000 ops in 4 batches of 250 | 68 ms, 14,630 ops/s |
| Read back | 1,000 ops | 9 ms |
| Compaction | save snapshot + trim the log | 64 ms |
| Durability window | reload 0 ms after an edit | edit survived (section 4) |
| Quota | `navigator.storage.estimate()` | 131,624 MiB quota, ~5.4 MiB used by this origin |

### 12. Degradation behaviour (the local stand-in for chaos)

| Injected failure | Required behaviour | Evidence |
|------------------|--------------------|----------|
| Offline (airplane mode) with edits in flight | edits persist locally and merge with zero lost characters on reconnect | `tests/rga.test.js` (offline merge), `tests/storage.test.js` (op log round-trip) |
| Damaged op log | the log is rebuilt from recovered text and the UI says so | `tests/storage.test.js` damaged-log path, M6 recovery notice |
| Out-of-order / duplicated / delayed delivery | convergence, no duplication | `tests/rga.test.js`, `tests/fuzz.test.js` |
| Malformed ciphertext / replayed message | rejected, never decrypted | `tests/crypto.test.js`, `tests/fuzz.test.js` |
| Malformed signaling code / hostile paste | rejected with a reason, never half-parsed | `tests/webrtc.test.js`, `tests/fuzz.test.js` |
| Presence flood | throttled, document traffic untouched | `tests/mesh.test.js` |
| Runaway C program | killed by the step/depth budget, deterministically | `tests/fuzz.test.js` |

The service worker's offline shell was verified by stopping the server process
and reloading the page under a subpath deployment (`--prefix`), which is also how
the GitHub Pages layout is reproduced locally.

### 13. The suite itself

| Command | Environment | Result |
|---------|-------------|--------|
| `npm test` | bare Node 24, no browser | 146 passed, 0 failed, 6 skipped (the 6 need a canvas or IndexedDB) |
| `npm run test:browser` | Edge 154/155 via CDP, real WebGL2 + IndexedDB | **152 passed, 0 failed, 0 skipped** — 2.3 s on an idle machine, 3.2 s under load |
| `npm run test:browser --url=<deployment>` | the same suite against the site, or against the workerd deploy artifact | **152 passed, 0 failed, 0 skipped** |

`npm test` used to report those 6 as failures because the machine has no GPU.
Capability-aware skips replaced the red herrings, so a failing build now means a
real regression. The new `tests/stdlib.test.js` suite (32 tests) is the evidence
for the M2 work: every `<string.h>`, `<ctype.h>` and `<math.h>` function the
brief listed, `#define`, `typedef`, two-dimensional arrays, function pointers and
unions, each exercised by a complete C program — including the fail-closed cases
(a `strcpy` that would overflow its destination is an error, never silent
corruption).

### 14. The demo recording

The brief asks for a demo video. There is no narrator, so what exists is a
scripted screen recording of the real application, captioned with the script in
[docs/DEMO.md](DEMO.md):

| | |
|---|---|
| File | [docs/demo/demo.mp4](demo/demo.mp4) — 15:19, 8.8 MiB, 1280×720, H.264, 6 fps |
| Recorded by | `node tools/demo.js` — drives the real UI over CDP (tabs, buttons, ranges, selects, palette, typing) |
| Captured | 4,926 compositor frames, held for their real intervals (clamped at 8 s) so idle pauses stay in real time |
| Audio | none — the script is printed into each beat as an on-screen caption |
| Beats | 22 of 23 performed; the closing caption was on screen when the recording process was interrupted, and the video was then rebuilt from the captured frames with `--encode-only` |
| Evidence | `docs/reports/demo.json` lists every beat and whether its interaction actually happened |

The honest caveat, stated in the same breath: a silent captioned screencast is
not a narrated video, and no screen reader was involved in producing it. What it
does prove is that the tour in DEMO.md runs against the shipped build, in order,
with every interaction landing.

## What this report does not claim

- No 10,000-user load: no distributed rig was available, and the project has no
  application server to load.
- No node-kill chaos test: no cluster exists; the local failure injections above
  are the reachable substitute.
- No screen-reader session (NVDA/VoiceOver): the accessibility tree and axe-core
  were audited, which is what a screen reader consumes, but nobody listened.
- No mid-range phone. The one-hour soak and the Lighthouse runs are desktop Edge on
  this machine. The soak's number is the JS heap after a forced GC — not resident set
  size, and not GPU memory — so it is reported against the conditions run, not
  promoted to the brief's.
- No multi-machine WebRTC session driven by a person end to end: the
  two-carrier data-channel test is automated inside one machine.
- No INP number from a 50-user session: the metric does not populate under
  synthesized input and the session does not exist locally.

Reproduce any row:

```sh
python3 tools/serve.py 5173     # or: node tools/serve.js
npm test                        # 146 tests, no browser needed
npm run test:browser            # all 152, in a real browser
node tools/payload.js           # import-graph payload size
node tools/perf.js lcp          # throttled LCP -> docs/reports/lcp.json
node tools/perf.js soak         # memory soak -> docs/reports/soak.json
node tools/lighthouse.js --form-factor=mobile    # -> docs/reports/lighthouse-mobile.json
node tools/lighthouse.js --form-factor=desktop   # -> docs/reports/lighthouse-desktop.json
node tools/cls.js               # layout shift across a viewport change -> docs/reports/cls.json
node tools/a11y.js              # axe-core + accessibility tree -> docs/reports/a11y.json
node tools/durability.js        # durability window -> docs/reports/durability.json
node tools/verify-headers.js    # headers really delivered -> exit code
node tools/check-docs.js        # every number in this report still matches its artifact
python3 tools/gen-soak-section.py  # rewrite section 3 of this report from the measured JSON
tools/build-site.py             # deploy artifact, then: verify-headers, workerd suite
node tools/demo.js --encode-only  # re-encode the recorded tour (or record it fresh)
```

Lighthouse and ffmpeg are the two tools that are not in the repository: they are
installed into `.tools/` (never into `package.json`) because the app ships with
zero dependencies and the suite runs without any.
