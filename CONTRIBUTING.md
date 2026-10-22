# Contributing to Project Singularity

Thank you for looking at this project. Two constraints shape every patch here,
and a contribution that respects them is easy to review and easy to accept.

## The two constraints

1. **Zero runtime dependencies.** Nothing in `src/` may import from npm, and
   nothing may add a bundler, transpiler or framework to the shipped bundle.
   The shipped page is hand-written HTML, CSS and ES modules against browser
   APIs - that is the point of the challenge, not an accident of history.
2. **The security policy is not negotiable.** The app runs under a strict CSP
   with Trusted Types enforced. In practice that means:
   - no `innerHTML`, `outerHTML`, `eval` or any other markup sink - build DOM
     with the safe helpers in `src/security/policy.js`;
   - no inline styles or inline scripts (the one allowed inline style block is
     the generated critical CSS, hashed into the CSP);
   - no new network origins: `connect-src` is `'self'`.

## Setting up

Any static file server works, and the project ships one that also sends the
production security headers locally:

```bash
python3 tools/serve.py 5173
# app:   http://127.0.0.1:5173/
# suite: http://127.0.0.1:5173/tests/browser.html
```

Opening `index.html` from disk does not work (browsers block ES modules on
`file://`); the page detects this and says so instead of pretending.

The verification tooling is JavaScript. If you have no system Node, the
project fetches its own portable copy:

```bash
python3 tools/bootstrap-node.py          # into .tools/ (git-ignored)
.tools/node-*/node.exe tests/run.js      # Windows; bin/node elsewhere
```

## The gates a change must pass

Run all of these before opening a pull request; CI runs the same set:

| Gate | Command | What it proves |
|------|---------|----------------|
| Fast suite | `node tests/run.js` | No regressions in the 242 tests that do not need a browser (the 25 browser-only ones skip with a reason). |
| Full suite | `node tools/browser-run.js` | All 267 tests green in a real browser, including WebGL2, IndexedDB and the peer connection. Point it at a deployment with `--url=` to test that deployment. |
| Docs gate | `node tools/check-docs.js` | Every number the README and reports publish is still the number the artifacts produce. If your change moves a measurement, re-run the measuring tool and update the doc from its output - never hand-edit a published number. |
| Critical CSS | `python3 tools/critical-css.py` | Required after any edit to `styles/app.css`; it regenerates the inlined first-viewport block and its CSP hash. `--check` verifies the sync. |
| Accessibility | `node tools/a11y.js` | axe-core must still report 0 violations across all nine modules. |

## How to work

- Look at how neighbouring code does it, and match it. The codebase has one
  style and it is consistent on purpose.
- Add or extend tests for behaviour you change. The suites are plain ES
  modules in `tests/`; if your test needs a canvas, IndexedDB or a peer
  connection, declare that so it skips cleanly under Node instead of failing.
- Keep the honesty rule: the README and the docs describe what is real and
  name what is not. If your feature replaces a "does not do X" caveat, update
  the caveat in the same patch.
- Screenshots in `assets/screenshots/` are captured from the running app with
  `tools/cls.js`, not drawn by hand.
- Write commit subjects that state what changed and what it proves, in the
  imperative: `Cut cold-load JS to 197.6 KiB by splitting the module graph`,
  not `Update files` or `Latest update`. `git log --oneline` is part of the
  evidence trail here, so a title that could describe any commit is a defect.

## Reporting issues

Use the issue templates. For bugs, the console output and the exact serve
command matter more than a description; for feature proposals, say how the
idea fits the two constraints above.

## License

By contributing you agree that your contributions are licensed under the MIT
license that covers the project.
