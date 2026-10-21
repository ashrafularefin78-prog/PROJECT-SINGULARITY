# ADR 0007 — User-driven accessibility preferences

## Status
Accepted (partial)

## Context
An instrument-dense UI must remain usable with keyboard, screen reader, high
contrast and 200% text.

## Decision
Semantic elements, a roving-tabindex tablist, live regions, a text alternative
for the 3D scene, and user-controlled preferences for motion, contrast, scale,
direction, language and theme. Code stays left-to-right in RTL layouts.

## Consequences
- axe-core reports 0 violations, 412 passing checks.
- Not yet validated with NVDA or VoiceOver; honest M7 ceiling of 55/100.
