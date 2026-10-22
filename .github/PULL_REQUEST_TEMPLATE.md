## Summary

What changes, in one or two sentences.

## Motivation

Which issue or gap this addresses. Link the issue number if there is one.

## Constraints check

- [ ] No new runtime dependency (no npm package, framework or bundler in the
      shipped bundle).
- [ ] No markup sinks: DOM is built with the safe helpers in
      `src/security/policy.js`; no `innerHTML`, no inline styles or scripts.
- [ ] Works under the shipped CSP and Trusted Types policy.

## Verification

Run the gates (see [CONTRIBUTING.md](../CONTRIBUTING.md)) and tick what you
ran:

- [ ] `node tests/run.js` - fast suite green (browser-only tests may skip)
- [ ] `node tools/browser-run.js` - all 267 tests green in a real browser
- [ ] `node tools/check-docs.js` - every published number still matches its
      artifact; if your change moved a measurement, you re-ran the measuring
      tool and updated the docs from its output
- [ ] `python3 tools/critical-css.py` - run if `styles/app.css` changed
- [ ] `node tools/a11y.js` - axe-core still reports 0 violations

## Honesty check

If this patch changes what the project can or cannot do, the README and the
docs say so in the same patch - caveats removed only because the capability
now exists, added only because the code now exists.
