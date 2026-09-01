# Formal Production Deployment

## Preconditions

- Approved immutable Git commit and reviewed diff.
- Green backend tests, frontend build, Compose validation, and migration check.
- Production secrets present without printing them.
- Latest backup verified and offsite-copy status known.
- No active incident, critical alert, or live class.
- Rollback commit and operator identified.

## Release

From `/opt/alsyed/StreamX`, run:

```bash
RELEASE_COMMIT="<full-approved-sha>" \
  ./infra/hostinger/release-production.sh
```

The script verifies the exact SHA and clean tracked worktree, validates Compose
and migrations, creates and verifies a backup, deploys through the existing safe
deployment path, activates the tracked Al Syed Nginx configuration through a
rollback-safe installer, then runs production-readiness checks. Nginx backups
are stored outside `sites-enabled`; activation is refused if an active backup
file is detected. It does not edit DNS, Cloudflare, firewall, or environment
files.

## Rollback

If health or a critical journey fails, stop the rollout. Re-deploy the previous
known-good commit. Restore data only when the migration or application changed
data incompatibly; restoring data is destructive and follows the DR runbook.

After deployment, verify login, course access, admin access, payment order
creation in the approved mode, live-class authorization, protected playback,
chat, metrics targets, certificates, and all public domains.
