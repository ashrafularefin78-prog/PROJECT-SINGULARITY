# Security test report

Companion to [THREAT_MODEL.md](THREAT_MODEL.md), which states the STRIDE model and
the mitigations. This document is the *evidence*: what was actually executed
against the build, what it proved, and what remains untested.

Everything below was run locally against the shipped bundle, in the browser, on
the code in this repository. There was **no third-party audit**. One internal,
model-assisted adversarial session is recorded in
[reports/red-team-session.md](reports/red-team-session.md) and its 22 checks in
[reports/red-team-session.json](reports/red-team-session.json); it shares an
author with the code, so the third-party gap remains the biggest limitation of
this report.

## 1. Method

| Method | What it covers |
|--------|----------------|
| `tests/crypto.test.js` (18 tests) | The protocol layer: X3DH, Double Ratchet, bundle signatures, replay, tampering, group epochs and passphrase-encrypted private key storage |
| `tests/stream.test.js` (6 tests) | Streaming file AEAD: irregular chunks, frame order, the authenticated final flag and lazy decryption |
| `tests/fuzz.test.js` (11 tests) | Deterministic fuzzing of the two parsers that face hostile input (C front end, signaling/crypto decoders) plus the CRDT and the ciphertext paths |
| `tests/mesh.test.js` (19 tests) | Ingress handling and the browser relay carrier: ciphertext-only relay visibility, room isolation, presence flood control, a sealed round trip through the node's contract, outbox failover across a dead node, and sealed-frame-id dedupe |
| `tests/webrtc.test.js` (7 tests) | Signaling-code validation, including codes from untrusted sources |
| `tests/storage.test.js` (12 tests) | Damaged-log recovery, migrations, quota behaviour |
| `tests/stdlib.test.js` (51 tests) | The C library surface and the preprocessor, including the fail-closed cases (a `strcpy` that would overflow its destination is an error, not silent corruption) |
| `tests/hardening.test.js` (14 tests) | The static audit of generated C: every finding the pass raises from a corpus program, the names it refuses to invent, and the `NOT_CHECKED` list that says where it stays silent |
| `tests/sanitizer.test.js` (17 tests) | The runtime memory watcher over one execution: use-after-free through a NULL-tolerant builtin, double free, invalid free, a heap byte read before it was written - and that the watcher changes no value the program can see |
| `tests/hardening-samples.test.js` (7 tests) | Six vulnerable/fixed C pairs, each claiming the kinds it actually trips, the output each half really prints and the step count with the watcher on and off |
| In-app probes (M8 panel) | Live CSP / Trusted Types behaviour, the hostile-input probe that tries `innerHTML` and `eval()` and shows the refusal |
| `tools/red-team.js` (22 checks) | Internal adversarial pass: rogue Trusted Types policies, inline handlers and `javascript:` URLs, editor markup, same-origin framing, a poisoned service-worker cache, the M2 worker under the shipped policy, and the relay's field/validation contract |
| Manual browser runs | Header/CSP inspection over the served response, offline shell under a subpath deployment, two-carrier WebRTC channel, encrypted message round-trip |

Total suite: **471 tests across 35 suites**. Browser eligibility: 463 tests; 8 Node-only checks are skipped.
The suite is runnable at `/tests/browser.html`; under bare Node it reports 441 pass and 30
browser-only skips instead of failing unavailable capabilities.

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
| Unsafe C in generated code, read from the source | `gets()`, `scanf("%s")` with no field width, `strcpy`/`strcat`/`sprintf` into a destination the source proves smaller, a `memcpy`/`strncpy` count larger than the block, `printf` whose format string came from input, a local address that escapes the function, a `free()` of something the heap never handed out | **Named, with a CWE tag, only where the source proves it** - 13 kinds in one vocabulary shared by both checkers (`src/runtime/hardening.js`, 14 tests). Where the destination's size is never stated the pass says nothing at all and records that in `NOT_CHECKED`: an unknown destination is not a proven-small one |
| Memory errors a run does not show | Reading after `free()` through a builtin that tolerates NULL, the same block released twice, a handle kept past the release, a heap byte printed before anything wrote it | **Reported over the execution** by `src/runtime/sanitizer.js` (17 tests). Output and interpreter step count are identical with the watcher on and off, asserted for every pair in `src/runtime/hardening-samples.js`; the watcher adds a name, never a value |
| A heap write past the end of a block | `strcpy` of a 64-byte source into an 8-byte destination | **Refused before it lands.** The arena bounds-checks every access, so the run stops with `holds 8 character(s)` instead of corrupting a neighbour - which is why the audit's silence about an unsized destination is not a hole |
| Generated C that the audit calls unsafe | A SINGU program whose findings are error-severity, driven through the autopilot | **Blocks, and does not guess.** The repair loop stops at `STOP: no safe repair for "review"` with the finding's own kind and CWE kept in the transcript; the run is not silently passed on to a green verdict |
| CRDT integrity | Duplicated, reordered, delayed ops from hostile peers | Converges; duplicates absorbed; unexplainable ops parked in a causal buffer instead of applied |
| Presence flood | Ingress flood at a peer | **Throttled** for presence packets, 0 document envelopes dropped (dropping an op would lose a character) |
| XSS / markup injection | Hostile HTML/script strings through every user-visible input | No markup sinks exist in the codebase (`createElement`/`textContent` only); Trusted Types enforced with a `trusted-types` allowlist; CSP has no `unsafe-inline`/`unsafe-eval`. The in-app probe and the internal red-team run demonstrate the refusal |
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

### S-4 (low, fixed) - Trusted Types had no policy allowlist

**Found by:** the internal red-team browser probe on 2026-10-22.
**Issue:** `require-trusted-types-for 'script'` blocked plain-string sinks, but
nothing restricted which policies page script could create. A probe created
`red-team-probe` with a permissive `createHTML` and used it to insert an `<img>`;
the markup entered the DOM (the inline handler was still blocked by CSP). The
app's policy was named `singularity#script-url`, and `#` cannot be named in a CSP
`trusted-types` allowlist, so adding the directive required a rename.
**Impact:** defence-in-depth loss. It requires script execution first, so it was
not a standalone XSS; CSP remains the execution barrier.
**Fix:** the policy is now `singularity-script-url`, and `index.html`, `_headers`
and both playgrounds carry `trusted-types singularity-script-url`. In the
post-fix probe, `createPolicy('red-team-xss')` fails with `Policy
"red-team-xss" disallowed`, plain `innerHTML` still fails with a TrustedHTML
error, and the M2 worker and service worker still run.
**Evidence:** `node tools/red-team.js`, checks RT-H1, RT-X1 to RT-X6, RT-W2 and
RT-S2; [`reports/red-team-session.md`](reports/red-team-session.md).

### S-5 (medium, fixed) — the free list accepted a double free and a stack address

**Found by:** writing the vulnerable/fixed memory pairs and running each half
before claiming what the checker catches.
**Issue:** `free(p)` of a block already released returned silently, which puts
the same range in the free list twice and gives one address two owners; and
`free(&local)` was accepted, handing a stack range to an allocator that only
ever recycles arena blocks.
**Impact:** the classic double free, inside a runtime whose whole defence is
that every access is bounded by the block that owns it. The next allocation
after either of those releases hands out bytes something else still uses.
**Fix:** both fail closed in the interpreter - `double free: this block was
already released` and `free() of a pointer that is not a live allocation`, each
with line and column. The refusal is unconditional; the watcher is not required
for it, and with the watcher on the same event is also named `double-free`
(CWE-415) or `invalid-free` (CWE-763).
**Evidence:** `tests/sanitizer.test.js` and the `double-free` pair in
`src/runtime/hardening-samples.js`, whose buggy half is refused and whose fixed
half prints `7`.

### S-6 (low, fixed) — a released handle read through a tolerant builtin said nothing

**Found by:** probing the use-after-free pair instead of assuming the watcher
caught it, which it did not.
**Issue:** `free()` turns the handle into NULL, and `puts()`, `strlen()` and
`printf("%s")` all tolerate NULL. So `free(tag); puts(tag);` printed `(null)`,
finished with exit 0 and produced no finding - the one class the memory watcher
exists for was silent precisely where the program looks unharmed.
**Impact:** a reader of the panel would take `(null)` plus an empty report as a
clean run. The bytes do belong to whatever allocates next; the program cannot
see that, but a checker asked to watch must.
**Fix:** every builtin call sweeps its arguments for a released handle and
reports `use-after-free` (CWE-416) naming the call and the line that released
it. `free()` is excluded because it already has a sharper verdict on the same
pointer.
**Evidence:** `tests/sanitizer.test.js`; the pair's measured claims - the buggy
half prints `(null)` with one finding, the fixed half prints `A` with none, and
both halves take the same number of steps with the watcher on and off.

## 4. Residual risk and what was NOT tested

| Gap | Why it matters | Status |
|-----|----------------|--------|
| **No third-party audit; internal red-team only** | Self-tested crypto is not audited crypto; protocol-level mistakes are exactly what an audit finds. An internal pass shares the author's blind spots | Internal adversarial review, re-run on this build: **22/22** (2026-11-01, [`report`](reports/red-team-session.json)). The 2026-10-22 pass is the one that found the Trusted Types allowlist gap (S-4). The artifact committed before this build recorded **21/22**, RT-W2's terminal empty: the built-in sample's output never arrived within the 30-second wait under a version of the tool that recorded nothing when it did, and *why* it did not finish is still not established - the panel painted that day, since RT-W1 found the Compile button. `tools/red-team.js` now reports the terminal the page actually shows, and a UI regression drives the same panel end to end. No independent red-team. Stated in the in-app scorecard (M8 and M4 notes) and in the README |
| **OWASP ZAP baseline scan** | A full ZAP 2.17.0 run (spider + 1,077-request active scan against the local dev server, 2026-10-20): **0 High, 0 Medium, 0 Low, 2 Informational** — `10027` suspicious comments (ZAP pattern-matches ordinary source-code comments such as "where it is null") and `10109` modern-web-application, both informational. The first pass the same morning had flagged `40035` Medium — the dev server served `.git/config` — and `10036` Low — a `Server: SimpleHTTP/...Python/3.14.8` banner; both are fixed in `tools/serve.py` (dot-file deny list + `server_version = "singularity-dev"`) and `tools/serve.js` (dot-segment deny), and the archived re-scan shows the two findings gone. CSP delivery is verified (`tools/verify-headers.js` asserts the built server serves `_headers`, and `index.html` carries the same policy as a meta); that a DOM sink actually rejects a plain string under it is asserted by no test, and no vulnerability findings were reported. Reports: [`docs/reports/zap-baseline.html`](reports/zap-baseline.html) (HTML) and [`docs/reports/zap-alerts.json`](reports/zap-alerts.json) (machine-readable). A second, passive quick scan of the **deployed GitHub Pages origin** (`docs/reports/zap-deployed.html`, 2026-10-21) reports **0 High, 5 Medium, 2 Low, 5 Informational**: the Mediums are properties of static hosting (no CSP response header, no anti-clickjacking response header, no COOP/COEP, no HSTS) plus ZAP's CSP-quality notes (`style-src 'unsafe-inline'`, a directive with no fallback), not injection findings; the meta CSP applies there, but nothing has measured whether `require-trusted-types-for` delivered inside a meta policy actually gates the sinks - and the dashboard's Trusted Types chip only reports that the browser exposes the API, which is a different claim. Limits: the active scan runs against a local dev server, the deployed run is passive only, and ZAP's markup findings do not substitute for a human red-team pass. A deployed-origin scan on a host that serves `_headers` is wired as `.github/workflows/deployed-host-scan.yml` (headers gate, then ZAP with `tools/zap-verdict.js` as the Low-and-above gate); it has not run yet, because no header-capable deployment exists | Run locally and against the deployed origin; stated in M8 scorecard and README |
| **No local encryption at rest** | IndexedDB holds plaintext documents and session state; device access equals data access | Declared in the threat model, not mitigated |
| **Key storage is unhardened** | Keys are `CryptoKey` objects in memory (non-extractable where possible) with no platform keystore binding | Declared; M4 note in the app says "no audited key storage" |
| **Source hosting has no generated SRI** | The deploy build generates SRI and an integrity manifest; serving the raw repository does not | Build artifacts carry hashes; the Clang/WASI assets are also SHA-256 checked against their self-hosted manifest before use |
| **`frame-ancestors` cannot be expressed in a meta CSP** | Clickjacking protection depends on the host reading `_headers` | Declared, not mitigated on the canonical host: GitHub Pages serves the meta policy only, so clickjacking protection is absent there. `_headers` and `tools/serve.py` deliver it on hosts that read the file; stated in the M8 note |
| **No screen-reader security review of the JS surface** | Not a security property per se, but assistive-tech-visible content could leak local data | Out of scope here |
| **Multi-machine WebRTC session never driven by a person** | The automated test covers a real data channel in one machine; NAT traversal across two networks is unproven | Not done |
| **No hostile-extension / third-party XSS corpus** | CSP and Trusted Types were verified inside the running app and by an internal probe suite, not by an independent exploit corpus in a hardened profile | Internal probes done; independent exercise not done |
| **The audit names a thing only when the source proves the thing** | `strcpy(dst, src)` where neither side's size ever appears in the source, and an allocation whose size is a runtime value the pass cannot evaluate, are real risks it does not claim to see | Recorded in the code as `NOT_CHECKED`, shipped to the panel beside the findings, and asserted by `tests/hardening.test.js`. The arena still bounds the write when the program runs, so the audit's silence is not an unguarded path |
| **The watcher belongs to the interpreter, not to Clang** | The WebAssembly backend compiles real native code inside the sandbox and has no arena and no sanitizer. Its command asks for no warnings at all (`-O0`, `-ferror-limit 10`), so a `-Wformat-security`-class remark never reaches the panel either | `Watch the run` is disabled outside the interpreter and the panel says which layer is speaking. A Clang run reports compiler diagnostics, not memory findings |
| **Not ASan, not valgrind** | A real sanitizer shadows every byte of the address space, including the stack and globals; this one watches the arena's blocks and the interpreter's handles | Declared in the panel's "What says what" card, which names each layer, its version and its boundary |
| **No exploit, no payload** | The six pairs demonstrate a defect class and its fix. None of them builds an overwrite that redirects control flow, and nothing here was pointed at a system the project does not own | Deliberate. Each pair's claim is a printed string or a refusal, measured and asserted in `tests/hardening-samples.test.js` |

## 5. Reproduce it

```bash
python3 tools/serve.py 5173
# app:      http://127.0.0.1:5173/
# suite:    http://127.0.0.1:5173/tests/browser.html   (471 tests, 35 suites)
node tools/red-team.js
# 22/22 internal adversarial checks; writes docs/reports/red-team-session.json
node tests/run.js
# 441 pass, 30 browser-only skips. The hardening surface is tests/hardening.test.js
# (14), tests/sanitizer.test.js (17) and tests/hardening-samples.test.js (7): 38
# tests that re-measure every claim the panels and the sample pairs make.
```

The M8 panel shows the live policy state (CSP, Trusted Types, sandbox isolation)
and the hostile-input probe; the M4 panel shows the relay inspector listing
exactly what the relay can read. In M2, choose "C subset · lightweight
interpreter", press "Check the source" to run the static audit over the editor,
and leave "Watch the run" ticked to have the execution reported by the memory
watcher; the "Hardening pairs" card loads a vulnerable program and its fix into
the editor, and the claims beside each pair are the ones those 38 tests assert.
