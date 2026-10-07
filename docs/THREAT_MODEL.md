# STRIDE threat model

Scope: the shipped page, its workers, its local storage, and the untrusted relay.
Assets worth protecting, in order: **user plaintext and keys**, **document
integrity**, **availability of the tab**, then everything else.

Trust boundaries:
1. main thread ↔ runtime worker (runs attacker-supplied C)
2. browser ↔ relay (sees only ciphertext + routing metadata)
3. tab ↔ tab (peer messages, hostile peers assumed present)
4. page ↔ local storage (IndexedDB, survives reloads)

## 1. STRIDE table

| Threat | Vector | Mitigation implemented | Evidence |
|--------|--------|------------------------|----------|
| **Spoofing** | Relay substitutes a peer's prekey bundle to MITM the handshake | Signed prekey (Ed25519/ECDSA over `SPK`) plus a 60-digit safety number users compare out of band | `verifyBundleWith` rejects a swapped `spk` and a forged signature; `safetyNumber` changes when an identity key changes |
| **Spoofing** | Peer impersonates another peer id inside the room | Presence carries a distinct id; the UI labels self vs remote; identity keys (not names) are what crypto binds to | Mesh tests: peers never see another room; presence pruned on `bye` |
| **Tampering** | Relay edits ciphertext in flight | AES-256-GCM with the header bound as additional data | Tamper test flips a byte → decryption throws |
| **Tampering** | Relay reorders or drops file frames | Each frame's AAD binds stream id, index and final flag; the decryptor enforces a strictly increasing index | Reorder test and drop test both fail closed |
| **Tampering** | Replay of a captured message | Used message keys are recorded; skipped-key cache is consumed on first use | Replay test throws on the second delivery |
| **Tampering** | A peer sends garbage ops to corrupt the CRDT | Ops are validated structurally: unknown origins are parked in a causal buffer, never applied blindly | Property test: 300 randomized trials converge, and ops the replica cannot explain are counted in `buffered` |
| **Repudiation** | Silent divergence between replicas, discovered later | Convergence is a *property test*, not an assumption: verified against independently shuffled delivery orders | `M1: property - 300 randomized concurrent trials converge` |
| **Repudiation** | Storage says "saved" but the log is not self-contained | On load, ops that cannot be applied are detected, the log is rebuilt from recovered text, and the UI reports the recovery | `loadDocument()` damaged-log path + the M6 recovery notice |
| **Information disclosure** | Relay or server reads user content | Only ciphertext and routing metadata ever leave the device | `CiphertextRelay.inspect()` lists the exact fields the relay can read; a test asserts plaintext never appears |
| **Information disclosure** | Nonce reuse leaks plaintext across messages | The AEAD nonce is *derived* from the unique message key, never chosen independently | 60 identical plaintexts → 60 distinct ciphertexts, all decryptable |
| **Information disclosure** | XSS exfiltrates keys from the page | No markup sinks exist; Trusted Types enforced; script-src without `unsafe-inline`/`unsafe-eval` | CSP meta/headers in the running app; an in-app probe attempts `innerHTML` and `eval()` and shows them refused |
| **Information disclosure** | Local data readable after the device is lost | **Not addressed.** IndexedDB is plaintext at rest. Declared below. | — |
| **Denial of service** | Infinite loop in user C freezes the tab | Step budget (deterministic), heap cap, recursion cap, wall-clock kill switch, and execution only in a worker that can be terminated | Loop test stops at exactly 5,000,000 steps; recursion test hits the depth cap; heap test refuses the allocation |
| **Denial of service** | Oversized allocation exhausts memory | Array allocations are charged against a byte cap before allocation | Heap-budget test |
| **Denial of service** | Peer floods the room with messages | Heartbeat/liveness pruning, message counting surfaced in the UI | Mesh stats expose sent/received/dropped |
| **Denial of service** | Storage quota exhausted | Quota is measured, ops are compacted into snapshots instead of truncated, and eviction is reported | `estimate()`, compaction test |
| **Elevation of privilege** | Sandbox escape from M2 into M4's key material | Separate worker with no DOM/storage/crypto/network; keys are only ever touched on the main thread | M2 worker source imports nothing but the interpreter |
| **Elevation of privilege** | Prototype pollution via peer payloads | Payloads are treated as data; objects are rebuilt field-by-field rather than merged blindly; no dynamic property assignment from peer input | Code review of `integrateOps`, `_receive` |
| **Elevation of privilege** | Cross-origin script injection via worker/service-worker URLs | A single Trusted Types policy mints same-origin script URLs only, and rejects anything else | `scriptUrl()` throws on a cross-origin input |

## 2. Residual risk (accepted, with reasons)

1. **No local encryption at rest.** Documents and message state sit in IndexedDB
   in plaintext. Anyone with the unlocked device and profile access can read
   them. Fixing it properly means a passphrase/KDF and a locked-state UX, which
   was out of scope for this pass.
2. **No screen-reader validation.** Accessibility is structurally designed and
   testable by keyboard, but has not been driven by NVDA/VoiceOver/TalkBack.
3. **No red-team session.** The claims above are backed by unit tests written by
   the same author as the code, which is weaker evidence than an independent
   adversary.
4. **Crypto is unaudited.** The composition follows X3DH/Double Ratchet
   published designs and uses only WebCrypto primitives, but no external
   cryptographer has reviewed it. Do not use it to protect anything real.
5. **X25519 was unavailable in the test browser**, so the app ran on the P-256
   fallback. The fallback path is therefore the *better*-tested one, and the
   X25519 path is less exercised.
6. **`requestAnimationFrame` and timers are throttled in background tabs**, which
   the mesh tests had to be rewritten around; the suite is now event-driven
   rather than sleep-driven.

## 3. Explicitly out of scope

Request smuggling, SSRF, CSRF and clickjacking are out of scope *by
construction* rather than by mitigation: this is a static site with no
server-side request handling, no forms (`form-action 'none'`), no dynamic
request construction from user input, and framing is denied
(`frame-ancestors 'none'`). Rate limiting and abuse detection are also not
implemented, because there is no server to rate limit — the relay is local.

## 4. What I would attack first

Being honest about my own attack surface: (a) the sandbox boundary, because a
runtime escape reaches the page that holds keys; (b) the peer message path,
because `integrateOps` is the only place remote data reaches the CRDT; and
(c) the CRDT's causal buffer, because unbounded parking is an availability bug
waiting to happen even though it is not currently a correctness bug.
