---
name: Feature request
about: Suggest a capability for the app, the suite or the tooling
title: ''
labels: ['enhancement']
assignees: ''
---

**The problem it solves**

What can you not do today? Concrete use cases beat abstract features.

**What you propose**

The behaviour, from the user's point of view. If it touches the interface,
describe it the way a screen reader would hear it.

**How it fits the project's constraints**

This project carries two hard constraints. Address both:

- [ ] It needs **no runtime dependency** - no npm package, no framework, no
      bundler in the shipped bundle; hand-written against browser APIs.
- [ ] It works under the **shipped security policy** - strict CSP
      (`connect-src 'self'`, no `unsafe-inline`), Trusted Types enforced, no
      markup sinks.

**Alternatives you considered**

Including the option of not building it - "partial, and it says so" is an
honoured state in this project.

**Would you like to implement it?**

Say so; the [contributing guide](../../CONTRIBUTING.md) lists the gates a
patch must pass.
