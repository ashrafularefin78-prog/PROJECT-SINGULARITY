# Security test report

Companion to [THREAT_MODEL.md](THREAT_MODEL.md), which states the STRIDE model and
the mitigations. This document is the *evidence*: what was actually executed
against the build, what it proved, and what remains untested.

Everything below was run locally against the shipped bundle, in the browser, on
the code in this repository. There was **no third-party audit and no red-team
session**, which is stated again in the residual risk section because it is the
single biggest limitation of this report.

## 1. Method

| Method | What it covers |
|--------|----------------|
| `tests/crypto.test.js` (18 tests) | The protocol layer: X3DH, Double Ratchet, bundle signatures, replay, tampering, group epochs, streaming file AEAD, passphrase-encrypted private key storage |
| `tests/fuzz.test.js` (11 tests) | Deterministic fuzzing of the two parsers that face hostile input (C front end, signaling/crypto decoders) plus the CRDT and the ciphertext paths |
| `tests/mesh.test.js` (13 tests) | Ingress handling and the browser relay carrier: ciphertext-only relay visibility, room isolation, presence flood control, a sealed round trip through the node's contract, outbox failover across a dead node, and sealed-frame-id dedupe |
| `tests/webrtc.test.js` (7 tests) | Signaling-code validation, including codes from untrusted sources |
| `tests/storage.test.js` (8 tests) | Damaged-log recovery, migrations, quota behaviour |
| `tests/stdlib.test.js` (51 tests) | The C library surface and the preprocessor, including the fail-closed cases (a `strcpy` that would overflow its destination is an error, not silent corruption) |
| In-app probes (M8 panel) | Live CSP / Trusted Types behaviour, the hostile-input probe that tries `innerHTML` and `eval()` and shows the refusal |
| Manual browser runs | Header/CSP inspection over the served response, offline shell under a subpath deployment, two-carrier WebRTC channel, encrypted message round-trip |

Total suite: **258 tests across 22 suites**, all 258 green in a browser
(~2.3 s, runnable from the site at `/tests/browser.html`); under bare Node the
same suite reports 234 pass and 24 browser-only skips instead of failing them.

Fuzz corpora (the numbers in the table are the counts printed by the suite):
400 lexer inputs, 408 parser inputs, 60 sources compiled twice, 3 runaway
programs, 24 concurrent CRDT edit programs (1,214 operations), 27 single-byte
ciphertext mutations, 40 malformed frames, 201 base64 inputs, 161 signaling
codes.

## 2. Results by attack surface

| Surface | Attack tried | Result |
|---------|--------------|--------|
| Prekey bundle (spoofing/MITM) | Swap `spk`, forge `spkSig`, present a different identity's bundle, replay a bundle | **Rejected.** Verification now runs inside the handshake (`Identity.verifyBundle`) before any key material is derived; negative tests assert each case aborts |
| Message integrity (tampering) | Flip each of 27 single-byte positions across a ciphertext | **All 27 rejected, 0 accepted**, and the untouched message still decrypts (no silent ratchet desync) |
| Message integrity | Random garbage frames, truncated ciphertext, empty header, non-base64 payload ("shape" fuzz) | **40/40 rejected**, no plaintext returned |
| Replay | Deliver the same message twice, same group frame twice | **Rejected** — used message keys are consumed, not reused |
| Nonce reuse | 60 identical plaintexts in one chain | **60 distinct ciphertexts**, each decryptable; a repeat would mean (key, nonce) reuse |
| Skipped-message DoS | Skip far ahead in the chain | Bounded by `MAX_SKIP = 1000`; out-of-order delivery within the bound works, dropping still decrypts |
| File streaming | Reorder frames, drop a frame, tamper a frame | **All rejected** — index and stream id are authenticated, the decryptor enforces strict ordering |
| Group membership | A kicked member reads post-kick traffic | **Rejected** — re-keying rotates the epoch secret; old keys cannot read on |
| Signaling codes (untrusted paste) | 161 codes: random base64, random text, junk shapes, wrong version, unknown kind, missing SDP, a depth bomb, and single-character mutations of a real code | **154 rejected with a named reason, 7 accepted (all structurally valid), 0 half-parsed** |
| Base64 codec | 201 inputs: valid, invalid characters, truncations, character substitutions | **142 rejected, 59 exact**, 0 silently normalised (see finding S-2) |
| C front end (untrusted code) | 400 lexer inputs, 408 parser inputs: character soup, statement duplication, unterminated comments/strings, exotic numeric literals, non-ASCII | **Every input produced either a well-formed result or a structured diagnostic with line+column; no crash, no hang, no half-built AST** |
| Sandbox escape | C code attempting DOM/storage/crypto/network access | Interpreter runs in a worker whose only import is the interpreter; no DOM, no `fetch`, no `crypto`, no IndexedDB. Wall-clock kill switch plus step/heap/depth caps |
| Resource exhaustion (user code) | 3 infinite programs (spin loop, empty `for`, unbounded recursion) | **Stopped deterministically** by the step/depth budget, twice with identical outcomes, each in well under 2 s |
| CRDT integrity | Duplicated, reordered, delayed ops from hostile peers | Converges; duplicates absorbed; unexplainable ops parked in a causal buffer instead of applied |
| Presence flood | Ingress flood at a peer | **Throttled** for presence packets, 0 document envelopes dropped (dropping an op would lose a character) |
| XSS / markup injection | Hostile HTML/script strings through every user-visible input | No markup sinks exist in the codebase (`createElement`/`textContent` only); Trusted Types enforced; CSP has no `unsafe-inline`/`unsafe-eval`. The in-app probe demonstrates the refusal |
| Cross-origin script injection | Worker/service-worker URL minting with a foreign origin | Rejected by the single Trusted Types policy (`scriptUrl` throws) |
| Storage damage | Damaged op log on load | Log rebuilt from recovered text, recovery reported in the UI, no silent data claim |

## 3. Findings

Findings are listed with the fix and the test that now covers it.

### S-1 (high, fixed) — the handshake did not verify the prekey bundle

**Found by:** writing the negative tests for M4.
**Issue:** `x3dhInitiate`/`x3dhRespond` accepted whatever bundle they were given.
Signature verification existed, but only in the test suite, so a relay that
spliced a signed prekey into a bundle would have completed a handshake with it.
**Impact:** a MITM could have negotiated keys with a substituted prekey; safety
numbers would later diverge, but only if a user compared them.
**Fix:** the bundle is verified inside the handshake, before any key material
exists, and a swapped prekey, forged signature or foreign identity key now aborts
the session.
**Evidence:** `M4: the bundle check the handshake runs rejects forged and swapped
prekeys` (4 negative cases).

### S-2 (medium, fixed) — non-canonical base64 was accepted

**Found by:** the fuzz corpus for the crypto codec (test `M4 fuzz: the base64
codec is either exact or an error`).
**Issue:** `atob` is lenient: it accepts unpadded and truncated-looking input and
silently normalises it. The same bytes therefore had more than one textual
spelling, and both the crypto decoder and the signaling decoder accepted them.
**Impact:** today's MACs are computed over decoded bytes, so this was not
exploitable — but it is exactly the class of ambiguity that becomes a signature
bypass the moment a MAC or signature covers the encoded text (a design that is
easy to reach for later). It also weakened signaling-code validation.
**Fix:** `unb64()` and the signaling decoder now require canonical base64
(`/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/`) and reject
anything else with a named error.
**Evidence:** 201 codec inputs, 0 lenient acceptances; the same test asserts that
decoding is a fixed point.

### S-3 (low, fixed) — numeric literals could overflow to `Infinity`

**Found by:** the parser fuzz corpus (400-digit literal).
**Issue:** a long enough integer literal became `Infinity` in the lexer's token
value and flowed into arithmetic as a value no C program can produce.
**Impact:** in the worst case a user-visible result would be wrong in a way no
diagnostic explained; not a memory-safety issue in an interpreter with checked
arithmetic, but a correctness and resource-reporting hole.
**Fix:** non-finite literals are rejected at the lexer with
`number literal '…' is out of range`, carrying line and column.
**Evidence:** the fuzz test asserts every `num` token is finite.

## 4. Residual risk and what was NOT tested

| Gap | Why it matters | Status |
|-----|----------------|--------|
| **No third-party audit, no red-team session** | Self-tested crypto is not audited crypto; protocol-level mistakes are exactly what an audit finds | Not done. Stated in the in-app scorecard (M8 and M4 notes) and in the README |
| **OWASP ZAP baseline scan** | A full ZAP 2.17.0 run (spider + 1,077-request active scan against the local dev server, 2026-10-20): **0 High, 0 Medium, 0 Low, 2 Informational** — `10027` suspicious comments (ZAP pattern-matches ordinary source-code comments such as "where it is null") and `10109` modern-web-application, both informational. The first pass the same morning had flagged `40035` Medium — the dev server served `.git/config` — and `10036` Low — a `Server: SimpleHTTP/...Python/3.14.8` banner; both are fixed in `tools/serve.py` (dot-file deny list + `server_version = "singularity-dev"`) and `tools/serve.js` (dot-segment deny), and the archived re-scan shows the two findings gone. CSP and Trusted Types verified in the running app; no vulnerability findings. Reports: [`docs/reports/zap-baseline.html`](reports/zap-baseline.html) (HTML) and [`docs/reports/zap-alerts.json`](reports/zap-alerts.json) (machine-readable). A second, passive quick scan of the **deployed GitHub Pages origin** (`docs/reports/zap-deployed.html`, 2026-10-21) reports **0 High, 5 Medium, 2 Low, 5 Informational**: the Mediums are properties of static hosting (no CSP response header, no anti-clickjacking response header, no COOP/COEP, no HSTS) plus ZAP's CSP-quality notes (`style-src 'unsafe-inline'`, a directive with no fallback), not injection findings; the app's meta CSP and Trusted Types still apply there. Limits: the active scan runs against a local dev server, the deployed run is passive only, and ZAP's markup findings do not substitute for a human red-team pass | Run locally and against the deployed origin; stated in M8 scorecard and README |
| **No local encryption at rest** | IndexedDB holds plaintext documents and session state; device access equals data access | Declared in the threat model, not mitigated |
| **Key storage is unhardened** | Keys are `CryptoKey` objects in memory (non-extractable where possible) with no platform keystore binding | Declared; M4 note in the app says "no audited key storage" |
| **No SRI** | With no build step, hashes would go stale and break the app; the CSP allowlist plus same-origin delivery is the mitigation | Deliberate trade-off, documented |
| **`frame-ancestors` cannot be expressed in a meta CSP** | Clickjacking protection depends on the host reading `_headers` | Declared, not mitigated on the canonical host: GitHub Pages serves the meta policy only, so clickjacking protection is absent there. `_headers` and `tools/serve.py` deliver it on hosts that read the file; stated in the M8 note |
| **No screen-reader security review of the JS surface** | Not a security property per se, but assistive-tech-visible content could leak local data | Out of scope here |
| **Multi-machine WebRTC session never driven by a person** | The automated test covers a real data channel in one machine; NAT traversal across two networks is unproven | Not done |
| **No hostile-extension / XSS-in-practice test in a hardened browser profile** | CSP and Trusted Types were verified inside the running app, not against a crafted exploit corpus | Not done |

## 5. Reproduce it

```bash
python3 tools/serve.py 5173
# app:      http://127.0.0.1:5173/
# suite:    http://127.0.0.1:5173/tests/browser.html   (258 tests, 22 suites)
```

The M8 panel shows the live policy state (CSP, Trusted Types, sandbox isolation)
and the hostile-input probe; the M4 panel shows the relay inspector listing
exactly what the relay can read.
