# ADR 0006 — IndexedDB op log with compaction

## Status
Accepted (shipped)

## Context
M6 must keep working offline and survive reload, with no cloud backend.

## Decision
An IndexedDB op log plus compacted snapshots, versioned migrations and a
scope-relative service worker. Compaction uses a watermark and keeps a snapshot
fallback for peers catching up.

## Consequences
- Local-first: offline verified with the server stopped.
- Browser owns quota and may evict; no multi-device backup.
- Compaction trades history for size.
