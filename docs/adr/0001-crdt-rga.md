# ADR 0001 — RGA CRDT for the collaborative editor

## Status
Accepted (shipped)

## Context
M1 must support multi-user text editing with live cursors, per-user undo,
offline merge and cursor-indexed lookups, with no OT server.

## Decision
Use a Replicated Growable Array (RGA) with stable character ids (`[clock, replica]`),
tombstones, watermark-bounded collection, op-log trimming, and per-user undo stacks.
Retention of interior tombstones is deliberate so deleted positions remain
addressable for undo and merge.

## Consequences
- Convergence is provable by replaying any prefix into a fresh replica and
  fingerprinting visible state.
- Memory grows with edits; collection trims only safe tombstones.
- Higher implementation complexity than OT, but serverless and offline-first.
