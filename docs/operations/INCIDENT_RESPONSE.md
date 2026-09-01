# Incident Response

## Severity

- SEV-1: public outage, data loss, confirmed compromise, payment integrity risk,
  or all students unable to join a live class.
- SEV-2: material degradation, partial join failures, one critical dependency
  unavailable, or rapidly consuming error budget.
- SEV-3: limited impact with a safe workaround.

## Response sequence

1. Declare severity, UTC start time, incident commander, and communications owner.
2. Preserve evidence before changing state: current SHA, `docker compose ps`,
   Nginx status/config test, resource state, alerts, and relevant redacted logs.
3. Stabilize first. Stop deployments, reduce load, fail over, or roll back the
   last change. Never debug by deleting volumes, databases, or backups.
4. Communicate impact and next update time. Do not speculate about compromise.
5. Recover and verify the user journey from the origin and public route.
6. Monitor for at least 30 minutes, or one full live class for streaming issues.
7. Close with a blameless timeline, root cause, corrective actions, and owners.

## Evidence commands

Run `infra/hostinger/verify-production-readiness.sh` and save its output. Add:

```bash
date -u
git rev-parse HEAD
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
sudo journalctl -u nginx --since '-2 hours' --no-pager
sudo nginx -t
df -h
free -h
```

Never paste environment files, JWTs, passwords, stream keys, payment secrets,
or complete request headers into an incident channel.
