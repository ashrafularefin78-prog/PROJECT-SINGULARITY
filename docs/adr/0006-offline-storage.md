# ADR 0006 — IndexedDB op log with compaction

## Status
Accepted (shipped)

## Context
M6 must keep working offline and survive reload, with no cloud backend.

## Decision
An IndexedDB causal op log plus text recovery snapshots, versioned migrations and
a scope-relative service worker. Text snapshots retain the durable log because
later operations reference character identities that text alone cannot preserve.
Watermark collection and log trimming apply to in-memory state, not durable history.
Damaged-history repair atomically replaces only the affected document's log.

## Consequences
- Local-first: offline verified with the server stopped.
- Browser owns quota and may evict; no multi-device backup.
- Durable history grows until identity-preserving checkpointing is implemented.
- Empty snapshots and fully deleted documents are valid saved state.
