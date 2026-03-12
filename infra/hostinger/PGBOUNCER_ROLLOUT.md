# PgBouncer Rollout (Safe)

This rollout enables PostgreSQL connection pooling without changing application behavior.

## 1) Enable Phase 4

```bash
cd /opt/alsyed/StreamX
git fetch origin
git checkout main
git pull --ff-only origin main
chmod +x infra/hostinger/deploy-phases.sh
./infra/hostinger/deploy-phases.sh phase4
```

## 2) Verify app health

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml ps
curl -fsS -H "Host: api.alsyedinitiative.com" -H "X-Forwarded-Proto: https" http://127.0.0.1:8000/health/live
curl -fsS -H "Host: api.alsyedinitiative.com" -H "X-Forwarded-Proto: https" http://127.0.0.1:8000/health/ready
```

## 3) Verify PgBouncer is active

```bash
docker ps --filter name=pgbouncer
docker logs --tail 80 streamx-pgbouncer-1
```

## 4) Runtime smoke tests

- Login
- Course playback
- Meeting join + chat
- Recording start/stop

## 5) Rollback if needed

```bash
./infra/hostinger/deploy-phases.sh phase1
```

This rollback keeps persistent data volumes.
