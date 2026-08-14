# StreamX Broadcast Reliability Runbook

This runbook is the production acceptance path for a 100-viewer Owncast
broadcast. Code deployment alone is not proof of network reliability.

## Required traffic layout

- `alsyedinitiative.com`: proxied HTTPS frontend and protected same-origin HLS.
- `api.alsyedinitiative.com`: proxied HTTPS API.
- `stream.alsyedinitiative.com`: proxied HTTPS/WebSocket Owncast chat and embed traffic.
- `ingest.alsyedinitiative.com`: DNS-only RTMP ingest on TCP 1935.

Do not orange-cloud the RTMP ingest hostname. Standard Cloudflare proxying is
for supported HTTP/HTTPS ports and WebSockets; OBS should continue publishing
directly to `rtmp://ingest.alsyedinitiative.com:1935/live`.

## Deploy the protected HLS cache and frontend recovery

Set all realtime authorization lifetimes to three hours. This covers a
90-minute class plus reconnects without allowing a token to expire mid-session.
The stream reliability Compose override raises Owncast's open-file limit for
the HLS and WebSocket connections created by 100 concurrent viewers.

```bash
cd /opt/alsyed/StreamX || exit 1
set -euo pipefail

ENV_FILE=./backend/.env.hostinger.production
STAMP=$(date +%Y%m%d-%H%M%S)

set_env() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sudo sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" | sudo tee -a "$ENV_FILE" >/dev/null
  fi
}

set_env REALTIME_JOIN_TOKEN_TTL_SECONDS 10800
set_env OWNCAST_CHAT_BRIDGE_TTL_SECONDS 10800
set_env OWNCAST_STREAM_ACCESS_TTL_SECONDS 10800

sudo install -d -o www-data -g www-data \
  /var/cache/nginx/owncast_hls \
  /var/cache/nginx/owncast_stream_access

COMPOSE=(
  docker compose
  --env-file "$ENV_FILE"
  -f docker-compose.hostinger.yml
  -f infra/hostinger/docker-compose.hostinger.resource-limits.yml
  -f infra/hostinger/docker-compose.hostinger.resource-limits.pool.yml
  -f infra/hostinger/docker-compose.hostinger.resource-limits.pgbouncer.yml
  -f infra/hostinger/docker-compose.hostinger.async-workers.yml
  -f infra/hostinger/docker-compose.hostinger.backend-pool.yml
  -f infra/hostinger/docker-compose.hostinger.gateway-lb.yml
  -f infra/hostinger/docker-compose.hostinger.pgbouncer.yml
  -f infra/hostinger/docker-compose.hostinger.pgbouncer.pool.yml
  -f infra/hostinger/docker-compose.hostinger.postgres-tuning.yml
  -f infra/hostinger/docker-compose.hostinger.stream-reliability.yml
)

"${COMPOSE[@]}" config -q

# Recreate Owncast between classes because this briefly interrupts the stream.
"${COMPOSE[@]}" \
  up -d --no-deps --force-recreate owncast

"${COMPOSE[@]}" \
  up -d --build --no-deps frontend backend backend-2 backend-3 backend-4

echo "===== WAIT FOR UPDATED SERVICES ====="
for attempt in $(seq 1 30); do
  backend_health=$(docker inspect streamx-backend-1 \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    2>/dev/null || true)
  owncast_health=$(docker inspect streamx-owncast-1 \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    2>/dev/null || true)
  frontend_health=$(docker inspect streamx-frontend-1 \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    2>/dev/null || true)

  if [ "$backend_health" = healthy ] && \
     [ "$owncast_health" = healthy ] && \
     [ "$frontend_health" = healthy ]; then
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    echo "Updated services did not become healthy; Nginx was not changed."
    exit 1
  fi
  sleep 5
done

echo "===== ACTIVATE TRACKED NGINX CONFIG ====="
NGINX_TARGET=/etc/nginx/sites-enabled/alsyedinitiative.conf
NGINX_BACKUP="/root/alsyedinitiative.conf.$STAMP.bak"
sudo cp -a "$NGINX_TARGET" "$NGINX_BACKUP"
sudo cp infra/hostinger/nginx/alsyedinitiative.conf "$NGINX_TARGET"

if ! sudo nginx -t; then
  sudo cp "$NGINX_BACKUP" "$NGINX_TARGET"
  sudo nginx -t
  echo "Tracked Nginx configuration failed; previous configuration restored."
  exit 1
fi

sudo systemctl reload nginx
```

## Verify origin behavior

With an authorized browser already playing, inspect playlist and segment
requests in DevTools. Playlists must return `200` with `Cache-Control: no-store`.
Repeated segment URLs must return `X-Owncast-Segment-Cache: HIT` after the first
request.

```bash
sudo nginx -t
systemctl is-active nginx
docker inspect streamx-owncast-1 \
  --format 'status={{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
docker exec streamx-owncast-1 sh -c 'printf "owncast nofile="; ulimit -n'
```

## Acceptance test

1. Start OBS using the DNS-only ingest hostname and constant stream key.
2. Create/start the linked broadcast session.
3. Run `infra/loadtest/realtime-playback.js` with 100 unique authorized tokens.
4. Keep two physical viewers open for the whole test: one on Wi-Fi and one on mobile data.
5. Run for at least 60 minutes before declaring the incident resolved.

Accept only when:

- playback checks exceed 99%;
- playback failures remain below 1%;
- no viewer is returned to Join Live during a transient request failure;
- both physical networks keep video and chat connected;
- Owncast has zero restarts and is not OOM-killed;
- Nginx segment cache is predominantly `HIT`;
- backend, Nginx, and Owncast logs show no sustained 401/403/5xx burst.

## Rollback

If `nginx -t` fails, do not reload. Restore the timestamped Nginx backup. The
frontend can be rolled back independently by deploying the previous Git commit;
the database is not changed by this reliability rollout.
