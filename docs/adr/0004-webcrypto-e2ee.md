# ADR 0004 — Compose E2EE from WebCrypto

## Status
Accepted (shipped, unaudited)

## Context
M4 needs private messaging without importing a crypto library or audited protocol.

## Decision
Compose X3DH, a Double Ratchet, safety numbers, group epochs and streaming file
AEAD from WebCrypto primitives. The signed prekey bundle is verified inside the
handshake, before any key material exists.

## Consequences
- No external crypto dependency; relay sees ciphertext only.
- Local key storage is not hardware-backed; no independent audit yet.
- Metadata still exists outside the ciphertext.
