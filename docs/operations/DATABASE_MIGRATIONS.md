# Database Migration Strategy

## Rules

- Every model change includes a committed migration and passes
  `makemigrations --check --dry-run`.
- Production deployments take and verify a backup before migration.
- Prefer expand/migrate/contract: add nullable structures, deploy compatible
  code, backfill in bounded batches, switch reads, then remove old structures in
  a later release.
- Large indexes use a PostgreSQL-safe online strategy and are not created in a
  request-serving transaction.
- Destructive operations require explicit review and a tested rollback/restore
  path. A reverse migration is not assumed to recover deleted data.
- Application replicas must remain compatible while containers are replaced.

Run `infra/hostinger/check-migration-safety.sh <base-ref>` before deployment.
The script flags changed migrations containing destructive operations and requires
`MIGRATION_RISK_ACCEPTED=1` only after an operator has reviewed the plan.
