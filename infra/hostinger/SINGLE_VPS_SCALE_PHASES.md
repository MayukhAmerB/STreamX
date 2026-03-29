# Single VPS Scaling Phases (Non-Breaking)

This rollout keeps current production behavior intact and enables scaling in controlled phases.

Important:

- No destructive commands are used.
- Do not run `docker compose down -v`.
- Always validate after each phase before moving to the next.

## Phase 1 (Current Safe Baseline)

What runs:

- app stack (`frontend`, `backend`, `postgres`, `redis`, `media`, `livekit`, `livekit-egress`, `owncast`, `transcoder`)
- async worker
- observability (`prometheus`, `grafana`)

Command:

```bash
chmod +x infra/hostinger/deploy-phases.sh
./infra/hostinger/deploy-phases.sh phase1
```

## Phase 2 (Resource Isolation)

Adds resource caps to reduce cross-service contention.

Command:

```bash
./infra/hostinger/deploy-phases.sh phase2
```

Notes:

- Uses `infra/hostinger/docker-compose.hostinger.resource-limits.yml`.
- Tune CPU/memory values in `backend/.env.hostinger.production`.

Recommended starting profile for `8 vCPU / 32 GB`:

```env
BACKEND_CPUS=2.5
BACKEND_MEM_LIMIT=6g
BACKEND_MEM_RESERVATION=3g

BACKEND_POOL_CPUS=1.5
BACKEND_POOL_MEM_LIMIT=2g
BACKEND_POOL_MEM_RESERVATION=1g

POSTGRES_CPUS=2.0
POSTGRES_MEM_LIMIT=8g
POSTGRES_MEM_RESERVATION=4g

REDIS_CPUS=1.0
REDIS_MEM_LIMIT=2g
REDIS_MEM_RESERVATION=1g

WORKER_CPUS=1.0
WORKER_MEM_LIMIT=1.5g
WORKER_MEM_RESERVATION=768m

TRANSCODER_CPUS=1.2
TRANSCODER_MEM_LIMIT=3g
TRANSCODER_MEM_RESERVATION=1.5g

LIVEKIT_CPUS=2.0
LIVEKIT_MEM_LIMIT=6g
LIVEKIT_MEM_RESERVATION=3g

LIVEKIT_EGRESS_CPUS=3.0
LIVEKIT_EGRESS_MEM_LIMIT=4g
LIVEKIT_EGRESS_MEM_RESERVATION=2g
LIVEKIT_EGRESS_TWIRP_TIMEOUT_SECONDS=60

OWNCAST_CPUS=0.5
OWNCAST_MEM_LIMIT=1g
OWNCAST_MEM_RESERVATION=512m
```

Why `LIVEKIT_EGRESS_CPUS=3.0`:

- Browser Host Studio uses LiveKit participant egress to relay the host's WebRTC media to RTMP.
- On the single-node `8 vCPU / 32 GB` profile, `1.5` vCPU leaves egress below the safe floor for some stream presets and can surface as `Egress ... timed out` during `StartParticipantEgress`.
- Keeping egress at `3.0` preserves headroom for browser-host broadcasts without changing the rest of the Phase 5 topology.
- A `60` second egress Twirp timeout gives the egress worker enough time to attach to browser-published tracks and start the RTMP stream before the API gives up.

## Phase 3 (Backend Pool + Internal Gateway LB)

Adds:

- backend pool containers: `backend-2`, `backend-3`, `backend-4`
- internal gateway load balancer (`127.0.0.1:8088`)

Command:

```bash
./infra/hostinger/deploy-phases.sh phase3
```

Compose overlays used:

- `infra/hostinger/docker-compose.hostinger.backend-pool.yml`
- `infra/hostinger/docker-compose.hostinger.gateway-lb.yml`

Gateway routing config:

- `infra/hostinger/nginx/gateway-lb.conf`

If you decide to route host-nginx through gateway, point existing host-nginx upstream to `127.0.0.1:8088` only after validating gateway health.

## Phase 4 (PgBouncer + PostgreSQL Tuning)

Adds:

- `pgbouncer` connection pool in front of postgres
- backend/worker/transcoder DB path switched to `pgbouncer`
- postgres runtime tuning for `8 vCPU / 32 GB` profile

Command:

```bash
./infra/hostinger/deploy-phases.sh phase4
```

PgBouncer defaults:

- `PGBOUNCER_POOL_MODE=transaction`
- `PGBOUNCER_MAX_CLIENT_CONN=1000`
- `PGBOUNCER_DEFAULT_POOL_SIZE=50`
- `PGBOUNCER_RESERVE_POOL_SIZE=10`
- `PGBOUNCER_RESERVE_POOL_TIMEOUT=5`

## Phase 5 (Full Single-Node Scale Profile)

Combines phase3 + phase4:

```bash
./infra/hostinger/deploy-phases.sh phase5
```

Use this only after phase4 is stable.

## Rollback

Rollback to stable baseline:

```bash
./infra/hostinger/deploy-phases.sh phase1
```

This removes phase-specific containers via `--remove-orphans` and keeps persistent volumes.

## Cloudflare content delivery policy

Recommended DNS/proxy split:

- Proxy ON: `@`, `www`
- DNS only: `api`, `livekit`, `stream`, `monitor`

Reason:

- frontend/content caching benefits from Cloudflare proxy
- realtime signaling/media paths are more predictable in DNS-only mode
- TURN and WebRTC transport for `livekit` are significantly more reliable when Cloudflare proxy is bypassed

## Validation checklist per phase

1. Container health:

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml ps
docker compose -f infra/observability/docker-compose.observability.yml ps
```

2. Backend health:

```bash
curl -fsS -H "Host: api.alsyedinitiative.com" -H "X-Forwarded-Proto: https" http://127.0.0.1:8000/health/live
curl -fsS -H "Host: api.alsyedinitiative.com" -H "X-Forwarded-Proto: https" http://127.0.0.1:8000/health/ready
```

3. Smoke test:

- Login
- Course playback
- Meeting join
- Chat
- Recording start/stop
- Join from a restrictive/mobile network and verify participant stays connected without repeated reconnect loops
