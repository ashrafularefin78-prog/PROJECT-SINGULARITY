---
name: Bug report
about: Something in the app or the suite does not behave as documented
title: ''
labels: ['bug']
assignees: ''
---

**What happened**

A clear description of the wrong behaviour. If a test failed, paste the
failing test's name and its message.

**What you expected instead**

**How to reproduce it**

Minimal steps, including the exact serve command:

```bash
python3 tools/serve.py 5173
# page or suite URL you opened:
```

**Environment**

- Browser and version (e.g. `Edge 156`, `Chrome 131`, `Firefox 133`):
- OS:
- Deployed site or local checkout (if local, which commit):

**Console output**

Paste anything the console printed - CSP violations included. They look like
`Refused to ...` and are often the whole diagnosis.

**Context**

Which module (M0 dashboard, M1 editor, M2 C runtime, M3 3D engine, M4 E2EE,
M5 mesh, M6 offline, M7 access, M8 hardening), and what you were doing when
it broke.
