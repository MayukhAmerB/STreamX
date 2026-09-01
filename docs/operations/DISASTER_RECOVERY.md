# Disaster Recovery Plan

## Targets

- Recovery point objective (RPO): 24 hours for database and persisted media.
- Recovery time objective (RTO): 4 hours for a complete single-VPS rebuild.
- Backup verification objective: every backup verified within 6 hours.
- Offsite requirement: at least one encrypted copy outside the production VPS.

Once offsite synchronization is configured, set
`HOSTINGER_BACKUP_REQUIRE_OFFSITE=1` for the verifier. A successful configured
offsite command writes `offsite-sync.completed`; the marker contains no secret.

Redis is treated as reconstructable cache/queue state unless an incident requires
its explicit restore. PostgreSQL, backend media, recordings, and Owncast data are
durable recovery assets.

## Recovery order

1. Provision and secure the replacement host; install Docker, Nginx, Certbot,
   firewall rules, and key-only SSH.
2. Restore the repository at a known-good immutable commit.
3. Recreate production environment secrets from the approved secret store.
4. Copy a verified backup to the host and run the restore dry-run.
5. Restore PostgreSQL and persistent volumes using `restore-data.sh`.
6. Start application services, apply migrations, and validate local health.
7. Restore Nginx transactionally and validate origin certificates.
8. Update DNS only after origin tests pass; then validate public journeys.

## Required drills

- Daily: checksum/archive verification of the newest backup.
- Monthly: restore into an isolated database/host and verify login, entitlement,
  course playback, payment reconciliation, and broadcast access.
- Quarterly: simulate total VPS loss and measure achieved RPO/RTO.

The destructive restore steps remain in `infra/hostinger/RESTORE_RUNBOOK.md`.
Drill results must record backup timestamp, recovery duration, failures, and
corrective actions without recording secret values.
