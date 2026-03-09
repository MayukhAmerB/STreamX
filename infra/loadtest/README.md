# Realtime Join Load Testing

This folder contains phased load tests for meeting joins at:

- 50 concurrent joiners
- 100 concurrent joiners
- 200 concurrent joiners

## Prerequisites

- `k6` installed
- One active realtime session id
- One valid JWT bearer token for a user allowed to join that session

## Run all phases

```bash
cd /opt/alsyed/StreamX
export BASE_URL="https://api.alsyedinitiative.com"
export SESSION_ID="123"
export AUTH_TOKEN="eyJhbGciOi..."
export DURATION="3m"
./infra/loadtest/run-realtime-join-phases.sh
```

## Run a single phase manually

```bash
BASE_URL="https://api.alsyedinitiative.com" \
SESSION_ID="123" \
AUTH_TOKEN="eyJhbGciOi..." \
VUS=100 \
DURATION="3m" \
k6 run infra/loadtest/realtime-join.js
```

## What to watch during test

- API p95 latency (`streamx_http_request_latency_seconds`)
- Join failures by reason (`streamx_realtime_join_total{result="failure"}`)
- CPU/memory on app, livekit, egress, transcoder
- Recording failures (`streamx_realtime_recording_operations_total{result="failure"}`)
