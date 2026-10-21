# ADR 0008 — Strict CSP + Trusted Types, meta fallback

## Status
Accepted (partial)

## Context
Ship a hostile-environment app with no build server, no third-party scripts and no
markup sinks on a static host.

## Decision
Enforce a strict CSP and Trusted Types, isolate the runtime in a Worker, rate-limit
per-peer ingress, generate SRI at deploy time, and build against a written STRIDE
model. GitHub Pages sends no custom headers, so the active policy there is the
meta CSP in index.html (no frame-ancestors/COOP/COEP); full policy travels in
_headers for hosts that read it.

## Consequences
- Verified locally and in built artifacts via tools/verify-headers.js.
- Clickjacking/cross-origin isolation depend on a host that reads _headers.
- No third-party red-team session yet; ZAP baseline archived (0 High/Med/Low,
  2 Informational).
