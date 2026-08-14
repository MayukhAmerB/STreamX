# Realtime Join And Playback Load Testing

This folder contains phased load tests for realtime joins at:

- 50 concurrent joiners
- 100 concurrent joiners
- 200 concurrent joiners

It also contains a protected HLS playback soak test. A join-only test proves
API admission capacity; it does not prove that viewers continuously receive
playlists and media segments.

## Prerequisites

- `k6` installed
- One active realtime session id
- JWT bearer token access for users allowed to join that session

For viewer load tests, do not reuse one token across all virtual users. The join endpoint is throttled per user, so a single shared token will quickly produce misleading failures. Supply one token per viewer with `AUTH_TOKENS` or `AUTH_TOKENS_FILE`.

## Run all phases

```bash
cd /opt/alsyed/StreamX
export BASE_URL="https://api.alsyedinitiative.com"
export SESSION_ID="88"
export AUTH_TOKENS_FILE="/opt/alsyed/StreamX/infra/loadtest/viewer-tokens.txt"
export DURATION="3m"
export PREFER_BROADCAST="1"
./infra/loadtest/run-realtime-join-phases.sh
```

## Run a single phase manually

```bash
BASE_URL="https://api.alsyedinitiative.com" \
SESSION_ID="88" \
AUTH_TOKENS_FILE="/opt/alsyed/StreamX/infra/loadtest/viewer-tokens.txt" \
PREFER_BROADCAST="1" \
VUS=100 \
DURATION="3m" \
k6 run infra/loadtest/realtime-join.js
```

If you only want one token for a quick smoke test, `AUTH_TOKEN` still works:

```bash
BASE_URL="https://api.alsyedinitiative.com" \
SESSION_ID="88" \
AUTH_TOKEN="eyJhbGciOi..." \
VUS=1 \
DURATION="1m" \
k6 run infra/loadtest/realtime-join.js
```

## Run a join-only long-session test

This simulates viewers joining once and then staying connected for the rest of the test window instead of rejoining every second.

```bash
BASE_URL="https://api.alsyedinitiative.com" \
SESSION_ID="88" \
AUTH_TOKENS_FILE="/opt/alsyed/StreamX/infra/loadtest/viewer-tokens.txt" \
PREFER_BROADCAST="1" \
JOIN_ONCE="1" \
HOLD_AFTER_JOIN_SECONDS="600" \
VUS=150 \
DURATION="10m" \
k6 run infra/loadtest/realtime-join.js
```

## Prove 100-viewer protected playback

Run this only while OBS is publishing an active Owncast broadcast. It obtains
the same signed cookie as the browser, repeatedly loads the protected HLS
playlist, and downloads newly published media segments for every virtual user.

```bash
cd /opt/alsyed/StreamX

API_BASE_URL="https://api.alsyedinitiative.com" \
WEB_BASE_URL="https://alsyedinitiative.com" \
SESSION_ID="88" \
AUTH_TOKENS_FILE="/opt/alsyed/StreamX/infra/loadtest/viewer-tokens.txt" \
VUS=100 \
DURATION="30m" \
POLL_SECONDS=3 \
SEGMENTS_PER_POLL=3 \
k6 run infra/loadtest/realtime-playback.js
```

For release acceptance, repeat for 60-90 minutes using real authorized test
accounts. The test must maintain more than 99% successful checks and less than
1% playback failures without Owncast restarts, OOM events, or sustained 5xx
responses.

## Run a burst-plus-spread reconnect test

This simulates all viewers joining right away, then each viewer rejoining a fixed number of times spread across the next 10 minutes.

```bash
BASE_URL="https://api.alsyedinitiative.com" \
SESSION_ID="88" \
AUTH_TOKENS_FILE="/opt/alsyed/StreamX/infra/loadtest/viewer-tokens.txt" \
PREFER_BROADCAST="1" \
SPREAD_REJOINS_PER_USER="40" \
SPREAD_WINDOW_SECONDS="600" \
SPREAD_JITTER_SECONDS="12" \
VUS=500 \
DURATION="10m" \
k6 run infra/loadtest/realtime-join.js
```

## Supported environment variables

- `AUTH_TOKEN`: one bearer token for smoke tests or single-user runs
- `AUTH_TOKENS`: comma-separated or newline-separated bearer tokens
- `AUTH_TOKENS_FILE`: file path containing one token per line
- `PREFER_BROADCAST`: set to `1` for broadcast-viewer joins
- `DEBUG_ERRORS`: set to `1` to log failing status/body previews
- `JOIN_ONCE`: set to `1` to make each VU join only once
- `HOLD_AFTER_JOIN_SECONDS`: how long each VU should stay idle after a successful join
- `SPREAD_REJOINS_PER_USER`: after the initial join, how many additional joins each user should perform
- `SPREAD_WINDOW_SECONDS`: total time window across which those rejoins are distributed
- `SPREAD_JITTER_SECONDS`: random delay added inside each rejoin slot to avoid perfect synchronization
- `SLEEP_SECONDS`: per-iteration pause, defaults to `1`

## What to watch during test

- API p95 latency (`streamx_http_request_latency_seconds`)
- Join failures by reason (`streamx_realtime_join_total{result="failure"}`)
- CPU/memory on app, livekit, egress, transcoder
- Recording failures (`streamx_realtime_recording_operations_total{result="failure"}`)
- Nginx `X-Owncast-Segment-Cache` should transition from `MISS` to mostly `HIT`
- Owncast container restarts and OOM state must remain zero/false
- HLS manifest and segment 401/403/5xx responses
- Wi-Fi and mobile-data browser viewers must remain playing for the full soak
