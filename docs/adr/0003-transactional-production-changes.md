# ADR 0003: Transactional Production Changes

- Status: Accepted
- Date: 2026-09-01

## Decision

Production changes require an immutable commit, clean tracked checkout, verified
backup, preflight, health checks, and explicit rollback point. Nginx changes are
validated before reload and backups never remain in active include directories.

## Consequences

Ad-hoc edits on the VPS are not part of the deployment process. Emergency edits
must be captured in Git immediately after service stabilization and reviewed.
