# Realtime Scale Hardening Guide

This phase hardens capacity for meeting joins and recordings without changing application behavior.

## 0) TURN/TLS for network stability

For production cohorts on mixed mobile/corporate networks, STUN-only LiveKit is not enough. Enable LiveKit's embedded TURN relay so participants can fall back to TURN/UDP and TURN/TLS when direct WebRTC paths are unstable.

Required host exposure:

- `443/udp` for TURN/UDP
- `5349/tcp` for TURN/TLS
- keep `livekit.alsyedinitiative.com` on `DNS only`
- default cert paths assume `/etc/letsencrypt/live/alsyedinitiative.com/`; override with `LIVEKIT_TURN_CERT_PATH` / `LIVEKIT_TURN_KEY_PATH` only if your Certbot lineage differs

If your host already has UFW enabled, prefer additive rules:

```bash
sudo ufw allow 443/udp
sudo ufw allow 5349/tcp
```

Phase 5-compatible rollout:

```bash
docker compose \
  --env-file backend/.env.hostinger.production \
  -f docker-compose.hostinger.yml \
  -f infra/hostinger/docker-compose.hostinger.resource-limits.yml \
  -f infra/hostinger/docker-compose.hostinger.resource-limits.pool.yml \
  -f infra/hostinger/docker-compose.hostinger.resource-limits.pgbouncer.yml \
  -f infra/hostinger/docker-compose.hostinger.async-workers.yml \
  -f infra/hostinger/docker-compose.hostinger.backend-pool.yml \
  -f infra/hostinger/docker-compose.hostinger.gateway-lb.yml \
  -f infra/hostinger/docker-compose.hostinger.pgbouncer.yml \
  -f infra/hostinger/docker-compose.hostinger.pgbouncer.pool.yml \
  -f infra/hostinger/docker-compose.hostinger.postgres-tuning.yml \
  up -d --no-deps livekit livekit-egress
```

Verification:

```bash
docker logs --since 5m streamx-livekit-1 2>&1 | grep -i turn
ss -lunpt | grep -E ':443 |:5349 '
```

## 1) Resource isolation on current VPS

Use compose override:

```bash
docker compose \
  --env-file backend/.env.hostinger.production \
  -f docker-compose.hostinger.yml \
  -f infra/hostinger/docker-compose.hostinger.resource-limits.yml \
  up -d --build --remove-orphans
```

This caps resource contention so `livekit`, `livekit-egress`, and `transcoder` do not starve `backend`.

For browser-host broadcasts on the single VPS profile, keep `LIVEKIT_EGRESS_CPUS` at `3.0` or higher and `LIVEKIT_EGRESS_TWIRP_TIMEOUT_SECONDS` at `60` or higher. Participant egress is the bridge between browser-published WebRTC media and RTMP output, and undersizing it or canceling the startup request too quickly can cause `StartParticipantEgress` timeouts even when the rest of the app remains healthy.

## 2) Separate realtime stack from app server (recommended)

When scaling beyond small-medium cohorts:

- Run `livekit` + `livekit-egress` (+ optional owncast) on a dedicated node.
- Keep Django/API + DB on app node.
- Keep transcoder on its own worker node if video volume grows.

Then point backend to external LiveKit endpoints via:

- `LIVEKIT_URL`
- `LIVEKIT_PUBLIC_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

## 3) Load-test progression

Run phased tests before raising advertised capacity:

1. 50 concurrent joins
2. 100 concurrent joins
3. 200 concurrent joins

Use scripts in `infra/loadtest/`.

## 4) Pass criteria example

- Join API error rate < 5%
- API p95 < 2.5s during join bursts
- No sustained recording failure spike
- No container OOM or restart loops
