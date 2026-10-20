# Non-goals — what this project deliberately does not build

This document exists because the previous version of it (`docs/FUTURE_ROADMAP.md`)
was a wish list written in a voice the project does not speak. It promised
neural interfaces by Q1 2027, "genetic programming" for shaders, quantum
annealing for relay routing, DNA storage of CRDT logs and "10k MAU by 2028" —
none of which anybody here can do, and none of which appears anywhere in the
code. It was deleted for that reason. It is replaced by the opposite document: a
list of things that will NOT be built, so nobody mistakes the roadmap for a to-
do list and so the gaps in the modules stay plainly visible instead of dressed
up as futuristic features.

## Things the brief asks the modules to have, that they do not have yet

| Missing | Where it bites | Why it is not built today |
|---------|----------------|---------------------------|
| clang/TCC (or any real C frontend) compiled to WASM in M2 | subset C only | Getting Musl/clang to a shipping state here is a research effort, not an engineering sprint; the interpreter with a hard sandbox is what is deliverable and tested |
| WebGPU compute in M3 | no compute shaders, no ray tracing | the WebGL2 renderer is real and measured; WebGPU would be a second renderer attached to nothing |
| A TURN server in M5 | symmetric NAT on both ends ends the session | one can be configured (`src/collab/webrtc.js` exposes the API) but hosting relay bandwidth is a deployment responsibility, not an app feature; STUN-only is the shipped truth |
| Real-device screen-reader validation in M7 | what the axe-core checks cannot prove | this environment has neither NVDA nor VoiceOver; the shipped evidence is axe-core (0 violations, 412 passing rule results) plus the a11y contract tests, and the gap is stated as not done |
| Response headers on GitHub Pages in M8 | frame-ancestors/COOP/COEP inactive on the canonical host | Pages cannot send headers; `_headers` is ready for any host that reads it and `tools/verify-headers.js` proves the built artifact serves it |
| A third-party red-team pass in M8 | no independent adversary | stated as not done; STRIDE is self-service and says so |

## Things never going into the shipped page, on principle

- **No npm/third-party "futuristic" dependencies.** Zero runtime dependencies
  is a scored, tested constraint; an "AI overlay" cannot import its way in.
- **No claims that depend on infrastructure this project does not host.**
  A 10,000-user rig does not exist; nobody here can lease it. Every load/chaos
  number is therefore run at the scale that was actually exercised.
- **No pseudo-features.** The eight modules stand or fall on testable
  engineering; nothing in italics announced as revolutionary ships.
- **No fabricated telemetry.** The app collects nothing it does not surface;
  there is no telemetry export pathway to a third party.

## If someone wants to contribute toward any of these

[CONTRIBUTING.md](CONTRIBUTING.md) documents the gates any change must pass
(the full test suite, `tools/check-docs.js`, payload re-measurement via
`tools/payload.js --json`, and a descriptive commit message — every change
lands with its own subject line, never "update"). Pick up a row above, state it
in the PR, and show the tests.
