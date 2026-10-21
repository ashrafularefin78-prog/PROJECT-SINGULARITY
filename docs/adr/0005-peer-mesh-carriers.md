# ADR 0005 — Three-carrier peer mesh

## Status
Accepted (partial)

## Context
Peers must collaborate without a signaling server, TURN fleet or trusted relay.

## Decision
Three carriers feed one mesh: BroadcastChannel for tabs, WebRTC data channels with
copy-paste invite/answer codes for machines, and a sealed ciphertext relay with an
HKDF room key, sender outbox, URL failover and sealed-frame-id dedupe.

## Consequences
- Works across tabs, machines and disconnected peers with no signaling server.
- Copy-paste signaling is not seamless; symmetric NAT on both ends needs TURN.
- Relay is a dev-node contract, not a deployed fleet.
