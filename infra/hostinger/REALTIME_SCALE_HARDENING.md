# Realtime Scale Hardening Guide

This phase hardens capacity for meeting joins and recordings without changing application behavior.

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
