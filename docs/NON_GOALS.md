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
| Arbitrary native C/C++ programs in M2 | OS APIs, threads, exceptions and recent standards are unavailable | Real Clang 8.0.1/WASI compilation now ships locally, but a restricted browser runtime is not a native operating system |
| WebGPU compute in M3 | no compute shaders, no ray tracing | the WebGL2 renderer is real and measured; WebGPU would be a second renderer attached to nothing |
| A TURN server in M5 | symmetric NAT on both ends ends the session | one can be configured (`src/collab/webrtc.js` exposes the API) but hosting relay bandwidth is a deployment responsibility, not an app feature; STUN-only is the shipped truth |
| VoiceOver/TalkBack validation in M7 | what the NVDA pass cannot prove about Safari, macOS and Android | NVDA 2026.2 is installed and recorded (17/17 steps, real speech log) alongside axe-core (0 violations, 412 passing rule results); this machine has no macOS or Android device, and the remaining gap is stated as not done |
| Response headers on GitHub Pages in M8 | frame-ancestors/COOP/COEP inactive on the canonical host | Pages cannot send headers; `_headers` is ready for any host that reads it and `tools/verify-headers.js` proves the built artifact serves it |
| A third-party red-team pass in M8 | no independent adversary | stated as not done; STRIDE is self-service and says so |

## Things never going into the shipped page, on principle

- **No npm/framework or speculative "futuristic" dependencies.** The shell is
  hand-written; the explicit exception is M2's self-hosted Clang/WASI toolchain,
  chosen to provide real C/C++ compilation rather than pretending a subset is complete.
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
