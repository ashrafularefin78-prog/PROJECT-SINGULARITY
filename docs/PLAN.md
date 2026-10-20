# Project Singularity — build plan

Derived from `Impossible_Website_Challenge.pdf`. This is the plan the
implementation follows, including the decisions about what *not* to build and a
record of where the plan changed because the work turned out to be reachable.

## 1. What the brief actually asks for

| # | Requirement | Hard part |
|---|-------------|-----------|
| — | Zero runtime dependencies: no React/Vue/jQuery/Three.js/Yjs/Socket.IO/npm in the shipped bundle | everything is hand-written |
| — | Untrusted server: it may only relay ciphertext + discovery metadata | forces real E2EE |
| — | Browser-native first: WebGPU, WebRTC, WebCrypto, WASM, SW, IndexedDB, Workers, OPFS | no polyfills allowed |
| — | One public URL, every module tested, every trade-off written down | tests are part of the grade |

Eight modules (M1 CRDT editor, M2 in-browser C runtime, M3 3D engine, M4 E2EE,
M5 P2P mesh, M6 offline sync, M7 accessibility/i18n, M8 hardening), a
performance budget, and a 1000-point tier ladder.

## 2. Scoping judgement, made explicit

The brief itself says: *20 engineers × 12 months, success rate practically zero*,
and advises a solo attempt to target Bronze/Silver with one or two modules done
properly. So the plan was:

**Pick the modules where a complete, honest implementation is reachable, and
declare the rest as partial rather than faking them.**

| Module | Plan | Why |
|--------|------|-----|
| M1 CRDT editor | **Full** | Self-contained, testable to a proof-like standard with property tests. The crown jewel. Now with cursor-indexed lookups (no rescans), watermark-bounded tombstone collection and op-log trimming. |
| M4 E2EE | **Full** | WebCrypto supplies the primitives; the composition (X3DH + Double Ratchet + streaming AEAD) is engineering, not research. The signed prekey bundle is verified inside the handshake, before any key material exists. |
| M6 offline sync | **Full** | IndexedDB + service worker + versioned migrations is well-trodden, and the scope-relative paths make the offline shell work under a subpath deployment. |
| M2 C runtime | **Partial** → **Near-full** | clang→WASM is out of reach here, but a *real* lexer/parser/interpreter plus a worker sandbox, terminal and hard kill switch delivers most of the module's engineering value. All ISO C language constructs now supported: ternary, switch/fall-through, structs (nested, arrays, by value, heap-linked lists), casts, do/while, malloc/calloc/realloc/free/memcpy/memset, scanf/sscanf, `#define` constants, function-like macros (`#`, `##`, `__VA_ARGS__`), `typedef`, `int m[2][3]`, function pointers and unions. Struct tags are usable as type names without a `typedef` (the one ISO C papercut removed). Bounds-checked arena fails closed - overflowing `strcpy` is an error, never silent corruption. |
