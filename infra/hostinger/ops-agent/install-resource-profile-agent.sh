#!/usr/bin/env bash
# Install the resource profile agent that backs the admin "Server profile" bar.
# Run as root on the Docker host from the repository checkout.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
BACKEND_ENV="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
AGENT_ENV=/etc/streamx/resource-profile-agent.env
UNIT_SRC="$REPO_ROOT/infra/hostinger/systemd/streamx-resource-profile-agent.service"

log() { printf '[install-resource-profile-agent] %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || { log "Run as root."; exit 1; }
[[ -f "$BACKEND_ENV" ]] || { log "Missing $BACKEND_ENV"; exit 1; }
command -v docker >/dev/null || { log "docker is required."; exit 1; }

token="$(grep '^OPS_AGENT_TOKEN=' "$BACKEND_ENV" | tail -n1 | cut -d= -f2- || true)"
backend_needs_restart=0
if [[ -z "${token// }" ]]; then
  token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  printf '\nOPS_AGENT_TOKEN=%s\n' "$token" >> "$BACKEND_ENV"
  backend_needs_restart=1
  log "Generated OPS_AGENT_TOKEN in $BACKEND_ENV."
fi

install -d -m 0750 /etc/streamx
umask 077
cat > "$AGENT_ENV" <<ENV
STREAMX_OPS_TOKEN=$token
STREAMX_OPS_API=http://127.0.0.1:8000/api/internal/ops/resource-profile/
STREAMX_API_HOSTNAME=${API_HOSTNAME:-api.alsyedinitiative.com}
STREAMX_COMPOSE_PROJECT=streamx
STREAMX_PROFILE_DIR=$REPO_ROOT/infra/hostinger/resource-profiles
STREAMX_ENV_FILE=$BACKEND_ENV
ENV
chmod 0600 "$AGENT_ENV"

install -m 0644 "$UNIT_SRC" /etc/systemd/system/streamx-resource-profile-agent.service
systemctl daemon-reload
systemctl enable --now streamx-resource-profile-agent.service
log "Agent installed and started. Logs: journalctl -u streamx-resource-profile-agent -f"

if [[ "$backend_needs_restart" -eq 1 ]]; then
  log "Recreate the backend containers between classes so they read OPS_AGENT_TOKEN, e.g.:"
  log "  docker compose --env-file $BACKEND_ENV -f docker-compose.hostinger.yml [overrides...] up -d --no-deps backend backend-2 backend-3 backend-4"
fi
