# ADR 0002: Separate Authorization From Media Delivery

- Status: Accepted
- Date: 2026-09-01

## Decision

Django authorizes course and live-class access. Nginx and the streaming services
deliver high-volume media using short-lived, scoped authorization artifacts.
The public Owncast page is not an authorization boundary.

## Consequences

Application workers do not proxy large media payloads. Every playback launch
must still prove entitlement, and direct stream endpoints must remain protected.
