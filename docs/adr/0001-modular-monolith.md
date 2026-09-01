# ADR 0001: Retain a Modular Monolith

- Status: Accepted
- Date: 2026-09-01

## Decision

Keep Django as a modular monolith with explicit application boundaries and
background workers. LiveKit and Owncast remain specialized realtime services.

## Consequences

Business transactions remain local and operational complexity stays manageable.
Large modules must be split by domain responsibility before microservices are
considered. Service extraction requires measured scaling or isolation evidence.
