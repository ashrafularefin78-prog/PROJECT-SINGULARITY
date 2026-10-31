# Phase 0 baseline audit - 31 Oct 2026

Scratch baseline for the phased plan. Counts and marks below were read from the
repository on this date; the GitHub row is a dated snapshot, not a runtime
request.

## Per-module scores

Self scores are `MODULE_STATUS` in `src/app.js`. Reviewer marks are the latest
independent tally. "Gap" is reviewer minus self.

| Module | Self | Reviewer | Gap | Structural ceiling | Declared gap (verbatim from the case study) |
|--------|-----:|---------:|----:|-------------------:|---------------------------------------------|
| M1 editor | 87 | 87 | 0 | - | No full-module gap; tombstones and the bounded op log are stated trade-offs. |
| M2 runtime | 74 | 88 | +14 | - | "About 18.4 MiB of compressed toolchain assets on first compile, compiler memory overhead, and older C/C++ standards. Native APIs, threads and C++ exceptions are unavailable. The interpreter is explicitly a C subset." |
| M3 engine | 84 | 88 | +4 | - | "The measured HDR probe drives diffuse irradiance only; specular light remains procedural. No skeletal animation or WebGPU path yet. Normals are generated flat when absent, and the material model is deliberately narrow." |
| M4 encryption | 82 | 89 | +7 | - | "Key storage is local and not hardware-backed, and the composition has not had an independent audit. The relay sees ciphertext only, but metadata still exists." |
| M5 mesh | 78 | 78 | 0 | - | "Copy-paste signaling is not seamless, and a symmetric NAT on both ends still needs a TURN server. The relay is a dev-node contract today, not a deployed fleet." |
| M6 storage | 85 | 85 | 0 | - | "The browser owns quota and can evict storage. Text snapshots retain durable causal history, so the log can grow; in-memory trimming is separate. There is no cloud sync: this is local-first, not multi-device backup." |
| M7 accessibility | 66 | 70 | +4 | 83 | "VoiceOver/TalkBack and the deeper M2/M4/M5/M6 flows remain unvalidated. Bangla and Arabic shaping in the editor is delegated to the browser text layout; the panel labels are translated, not the whole app." |
| M8 hardening | 72 | 80 | +8 | - | "No third-party red-team session. ... Clickjacking and cross-origin isolation therefore depend on a host that reads _headers, which the canonical GitHub Pages deployment is not." |
| M9 budget | 88 | 88 | 0 | - | "A 10,000-session rig does not exist, and two relay processes on one laptop are not a fleet." |
| M10 integration | 69 | 76 | +7 | - | Third-party red-team and chaos evidence still missing; releases are tags without GitHub releases. |

Totals: self **785 / 1000** (628 / 800 over the eight core modules), reviewer
**829 / 1000**. Points band: Platinum (ceiling 950). Requirement ladder: Silver
because M8 is not deployed on a header-capable host.

## Counts and signals

| Claim | Verified value | Source |
|-------|----------------|--------|
| Test suites | 28 | `node tests/run.js --json` |
| Tests | 385 | same |
| Browser-eligible | 378 | same |
| Bare Node | 356 passed, 0 failed, 29 skipped | same |
| Browser run | 378 passed, 0 failed, 7 skipped | headless Chrome |
| Commits on `main` | 58 | `git rev-list --count origin/main` and GitHub |
| Tags | v0.1.0, v1.0.0 | GitHub API |
| GitHub releases | 0 | GitHub API |
| Stars / forks | 0 / 0 | GitHub API, snapshot 31 Oct 2026 |
| Cold-load JS | 124.2 KiB gzip (15 initial files; 151.1 KiB gzip with CSS, 490.2 KiB raw) | `tools/payload.js` |

## Phase map

- Phase 1 (M7): VoiceOver/TalkBack need real devices - blocked locally. The
  66-vs-83 label is resolved in the dashboard, the case study, A11Y_VALIDATION
  and the README. The axe gate already runs in the browser suite and CI.
- Phase 2 (M5): hosted relay, deployed end-to-end log, TURN and NAT matrix need
  a host and a second network - blocked locally.
- Phase 3 (M8): third-party red team needs an independent tester - blocked.
- Phase 4: fresh deployed LCP p75, deployed ZAP and 5,000-client load need a
  deployed origin - blocked. Local payload is re-measured here.
- Phase 5 (M3): HDR specular prefiltering, skeletal animation, WebGPU and a HUD
  overlay are locally actionable.
- Phase 6 (M2): one standard/atomics shim and an explicit exceptions scope-out
  are locally actionable.
- Phase 7 (M4/M6): an independent audit cannot be self-produced; any artifact
  produced here must stay labelled internal.
- Phase 8: repository signals are updated; screenshots, sitemap, `.d.ts` and
  releases need inspection.

## Phase 5 progress (same date)

- **M3 specular IBL is a GGX prefilter now.** `ggxPrefilterChain` builds six
  importance-sampled roughness levels (32^2 down to 1^2) with deterministic
  radical-inverse samples; the renderer uploads them as explicit cube mip levels
  and both PBR shaders sample `roughness * 5`. The measured HDR probe rebuilds
  the diffuse SH cube *and* the specular chain via `applyProbeLighting`; the
  reset rebuilds both from the procedural sky.
- Still declared, not done: skeletal animation, WebGPU, the split-sum BRDF
  integration LUT (the prefilter uses N=V with an analytic Schlick Fresnel),
  VoiceOver/TalkBack, and every externally blocked phase item above.
- M3 self-score moves **84 → 87** (below the reviewer's 88), so the eight-module
  self total is **631 / 800** and the in-app total is **788 / 1000**.
- Counts after the change: **389 tests / 28 suites**; 382 browser-eligible;
  360 Node pass + 29 skip; 382 browser pass + 7 skip. The rows above remain the
  Phase 0 baseline.

## Phase 5 progress - skeletal animation (same date)

- **M3 skeletal animation is real.** `src/graphics/skin.js` samples glTF clips
  (LINEAR/STEP, shortest-arc slerp), `gltf.js` parses skins and
  `JOINTS_0`/`WEIGHTS_0`, and the renderer blends four joints per vertex from an
  RGBA32F bone texture refreshed each frame. `assets/models/skinned-totem.glb`
  is a deterministic seven-joint, six-second sample generated by
  `tools/make-skinned-glb.mjs`; a browser test draws it through the real shader
  pipeline and requires `gl.getError() === NO_ERROR`.
- **WebGPU is out of scope, with a reason.** [NON_GOALS.md](NON_GOALS.md)
  records the decision: WebGL2 is the measured compatibility target, and a
  second backend with no requirement it uniquely satisfies is surface, not
  engineering.
- M3 self-score moves **87 → 90** (the reviewer's pre-skinning mark is 88), so
  the eight-module total is **634 / 800** and the in-app total is **791 / 1000**.
- Counts after the change: **403 tests / 30 suites**; 395 browser-eligible;
  373 Node pass + 30 skip; 395 browser pass + 8 skip. The `skin.test.js` suite
  was silently absent from the browser registry; a new `suite-registry.test.js`
  fails if the two runners' lists ever diverge again.
