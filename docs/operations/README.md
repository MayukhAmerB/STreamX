# StreamX Enterprise Operations

This directory defines the production operating model for StreamX. The controls
are designed for the current single-VPS modular-monolith architecture and do not
assume that documentation alone makes a control effective.

## Operational objectives

- Keep public API and frontend availability at or above the targets in `SLO.md`.
- Never deploy without a verified backup, migration review, and rollback point.
- Detect service, storage, certificate, backup, and error-budget failures early.
- Keep secrets out of Git, command output, logs, and incident reports.
- Restore the service within the recovery targets in `DISASTER_RECOVERY.md`.

## Control map

| Control | Policy | Executable evidence |
| --- | --- | --- |
| Threat management | `THREAT_MODEL.md` | security audit logs, WAF, rate limits, fail2ban |
| Architectural decisions | `../adr/` | reviewed ADR files |
| Incident handling | `INCIDENT_RESPONSE.md` | incident timeline and post-incident record |
| Backup and recovery | `DISASTER_RECOVERY.md` | `verify-backup.sh`, restore dry-run |
| Reliability | `SLO.md` | Prometheus SLO rules and Grafana dashboard |
| Secret lifecycle | `SECRET_ROTATION.md` | rotation checklist without secret values |
| Schema safety | `DATABASE_MIGRATIONS.md` | `check-migration-safety.sh` |
| Releases | `PRODUCTION_DEPLOYMENT.md` | `release-production.sh` and readiness checks |
| Capacity | `CAPACITY_MANAGEMENT.md` | authenticated k6 tests and recorded results |

## Scheduled checks

- `hostinger-backup.timer`: creates the daily backup.
- `hostinger-backup-verify.timer`: verifies backup age, checksums, and archives.
- `hostinger-uptime-alert.timer`: checks public and local service health.

Installing a unit file does not activate it. Follow the production deployment
runbook and inspect every unit before enabling it.
