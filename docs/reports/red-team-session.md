# Internal adversarial review - 2026-10-22

**Status: internal, model-assisted adversarial testing. This is not a third-party
audit, not an independent red-team, and it does not raise M8's 100/100.**

The run targeted the working tree at commit `64be267` (dirty: the NVDA and
security changes were uncommitted at run time) on Windows 10.0.26300, Node
24.20.0 and Microsoft Edge 156.0.4314.36. The reproducible harness is
[`tools/red-team.js`](../../tools/red-team.js); the machine-readable evidence is
[`red-team-session.json`](red-team-session.json). The run finished **22/22
checks passed, 0 failed**.

## What was actually attacked

| Area | Attempts |
|------|----------|
| Trusted Types | create a second policy from page script; assign plain text to `innerHTML`; assign an inline event handler; assign a script element body |
| CSP | inject a script element; trigger a `javascript:` URL; put markup through the M1 editor |
| Clickjacking | frame the app from a same-origin wrapper against the header-capable local server |
| Service worker | write a poisoned `/src/app.js` into the live cache, reload online, inspect the cache again |
| Worker policy | compile and run the built-in C sample in the M2 worker under the shipped policy |
| Relay | post extra plaintext fields; drain and list the returned envelope; search the durable log for a canary; malformed JSON, bad routing ids, empty and oversized ciphertext |

The M2 sample was also exercised end to end because it is the easiest way to
prove that the policy rename did not break `new Worker(scriptUrl(...))`.

## Finding RT-1 (low, fixed): Trusted Types had no policy allowlist

**Found by:** the first browser probe, before any fix.

`require-trusted-types-for 'script'` alone blocks plain-string DOM sinks, but it
does not say *which policies may exist*. The pre-fix probe did this:

```js
const p = trustedTypes.createPolicy('red-team-probe', { createHTML: (s) => s });
div.innerHTML = p.createHTML('<img src=x onerror="...">');
```

Observed before the fix:

```text
policyCreated: true
trustedHtmlAssigned: true
imgCount: 1
plain innerHTML: TypeError (TrustedHTML required)
```

The image was inserted into the DOM. Its inline handler did not execute - CSP
still blocks inline script - but any code that can execute could mint its own
permissive TrustedHTML policy and bypass the app's "no markup sink" construction.
That is defence-in-depth failure, not a standalone XSS.

**Fix:** the policy was renamed from `singularity#script-url` to
`singularity-script-url`, because `#` cannot be named in a CSP `trusted-types`
allowlist (`trusted-types test#policy` rejects the policy as disallowed). The
CSP in `index.html`, `_headers` and both playgrounds now carries:

```text
trusted-types singularity-script-url
```

Observed after the fix:

```text
createPolicy('red-team-xss'): TypeError - Policy "red-team-xss" disallowed
plain innerHTML: TypeError - TrustedHTML assignment required
M2 worker: exit 0, sample output ends with done.
service worker: still registers and controls the page
```

The allowlist is only as strong as the CSP execution barrier: once arbitrary
script runs in the origin, the rest of the origin is already lost. It is still
worth having because it makes the intended policy the only one that exists.

## Accepted risks and limits

- **GitHub Pages clickjacking remains open.** The header-capable local server
  sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`, and the same-origin
  frame is unreadable (RT-H3/RT-C1). GitHub Pages cannot send custom headers, so
  the canonical deployment still has no frame-ancestors or XFO. This is the
  deployment gap already recorded in `SECURITY_REPORT.md`, not something this
  review fixed.
- **Service-worker cache poisoning is not a separate boundary.** Any same-origin
  code can write the cache. RT-S1 shows the write succeeds; RT-S2 shows an
  online reload fetches the shell network-first and replaces the poisoned entry.
  Offline, the last cached bytes win - which is why the cache is not presented
  as an integrity boundary.
- **The relay can read `header`.** Routing ids and ciphertext are the only
  required fields. Extra fields such as `plaintext` and `message` were dropped
  and never appeared in the durable log (RT-R1 to RT-R3). The app's own
  `tools/relay-e2e.js` additionally asserts that its sealed envelope's plaintext
  keys do not appear in the node's data directory. A different client that puts
  plaintext into `header` would be handing it to the relay; the relay contract
  does not promise otherwise.
- **No live cross-network WebRTC tamper test.** One machine cannot prove NAT
  traversal or a real man-in-the-middle path. Signaling validation and sealed
  frames are covered by `tests/webrtc.test.js` and `tests/mesh.test.js`; the
  cross-network gap remains declared in the threat model.
- **No third-party or human red-team.** This review shares an author with the
  code. It is evidence of work, not independent assurance.

## Incidental correctness finding

The M2 built-in sample failed its own demo: the C string escapes in the
JavaScript template literal were single `\n`, so the textarea received an actual
newline inside `printf("fib(20) = %d\n", ...)`. The interpreter correctly
reported an unterminated string at line 28. The eight C escapes are now doubled
(`\\n` in the JavaScript source), and the worker run ends with `done.` and
`fib(20) = 6765` (RT-W2). This was a demo bug, not a security finding.

## Reproduce

```powershell
node tools/red-team.js
```

The harness starts the project's own server (so the shipped `_headers` are in
play), starts a real relay node, drives Edge over CDP, writes
`docs/reports/red-team-session.json`, and exits non-zero if any check fails. It
does not require network access or third-party tools.
