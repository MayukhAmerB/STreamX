# StreamX Restore Runbook

This runbook is for a full disaster recovery drill on Hostinger.

## Preconditions

- Backups are generated daily by `infra/hostinger/backup-data.sh`.
- You have a backup reference (`latest` or timestamp folder).
- You have maintenance window approval.

## 1) Verify backup integrity (non-destructive)

```bash
cd /opt/alsyed/StreamX
HOSTINGER_RESTORE_DRY_RUN=1 ./infra/hostinger/restore-data.sh latest
```

Expected: checksum verification passes with no restore applied.

## 2) Put site in maintenance mode (recommended)

- Option A: show temporary maintenance page from VPS nginx.
- Option B: block user writes temporarily at app/load balancer level.

## 3) Perform destructive restore

```bash
cd /opt/alsyed/StreamX
HOSTINGER_RESTORE_CONFIRM=1 ./infra/hostinger/restore-data.sh latest
```

Optional flags:

- `HOSTINGER_RESTORE_INCLUDE_REDIS=0` skip redis volume restore
- `HOSTINGER_RESTORE_VALIDATE_HEALTH=0` skip readiness probe

## 4) Validate restore result

Run:

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml ps
curl -fsS -H "Host: api.alsyedinitiative.com" -H "X-Forwarded-Proto: https" http://127.0.0.1:8000/health/ready
```

Manual checks:

- Admin login works.
- Course catalog loads.
- One known paid user can access protected lecture playback.
- One recording file can be downloaded from admin recordings.
- Live session join works for host and student role.

## 5) Rollback plan for failed restore

If restore result is unhealthy:

1. Stop compose services.
2. Restore from previous known-good backup timestamp.
3. Repeat validation.

## 6) Drill cadence

- Run full restore drill at least once per month.
- Capture drill result in an ops log:
  - backup ref used
  - duration
  - failed steps
  - remediation actions
