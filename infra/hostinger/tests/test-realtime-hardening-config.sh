#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.hostinger.yml"
LIVEKIT_TEMPLATE="$REPO_ROOT/infra/hostinger/livekit.yaml"
EGRESS_TEMPLATE="$REPO_ROOT/infra/hostinger/egress.yaml"
PROMETHEUS_CONFIG="$REPO_ROOT/infra/observability/prometheus/prometheus.yml"
FIREWALL_SCRIPT="$REPO_ROOT/infra/hostinger/network/setup-firewall.sh"
FAIL2BAN_SCRIPT="$REPO_ROOT/infra/hostinger/network/fail2ban/streamx-nginx-denylist.sh"
CONNECTION_POLICY="$REPO_ROOT/frontend/src/utils/realtimeConnection.js"
DEPLOY_PHASES="$REPO_ROOT/infra/hostinger/deploy-phases.sh"
READINESS_SCRIPT="$REPO_ROOT/infra/hostinger/verify-production-readiness.sh"
DASHBOARD="$REPO_ROOT/infra/observability/grafana/dashboards/streamx-realtime-overview.json"
ALERTS="$REPO_ROOT/infra/observability/prometheus/alerts.yml"

! grep -Eq '^[[:space:]]*keys:[[:space:]]*$' "$LIVEKIT_TEMPLATE"
! grep -Eq '^[[:space:]]*(api_key|api_secret):' "$EGRESS_TEMPLATE"
! git -C "$REPO_ROOT" ls-files --error-unmatch backend/.env.hostinger.production >/dev/null 2>&1
! git -C "$REPO_ROOT" ls-files --error-unmatch backend/.env.production.final >/dev/null 2>&1
grep -Fq 'prometheus_port: 6789' "$LIVEKIT_TEMPLATE"
grep -Fq '${LIVEKIT_RUNTIME_CONFIG_PATH:-/etc/streamx/livekit.yaml}:/etc/livekit.yaml:ro' "$COMPOSE_FILE"
grep -Fq '${LIVEKIT_EGRESS_RUNTIME_CONFIG_PATH:-/etc/streamx/egress.yaml}:/out/egress.yaml:ro' "$COMPOSE_FILE"
grep -Fq '127.0.0.1:7880:7880/tcp' "$COMPOSE_FILE"
! grep -Fq '      - "7880:7880/tcp"' "$COMPOSE_FILE"
grep -Fq 'job_name: livekit' "$PROMETHEUS_CONFIG"
grep -Fq 'livekit:6789' "$PROMETHEUS_CONFIG"
grep -Fq 'POST http://127.0.0.1:9090/-/reload' "$DEPLOY_PHASES"
grep -Fq 'including LiveKit, are present and healthy' "$READINESS_SCRIPT"
grep -Fq 'max(up{job=\"livekit\"}) or vector(0)' "$DASHBOARD"
grep -Fq 'absent(up{job="livekit"}) or max(up{job="livekit"}) == 0' "$ALERTS"
! grep -Eq '^ufw allow 7880/tcp$' "$FIREWALL_SCRIPT"
grep -Fq '$streamx_fail2ban_block_auth_request' "$FAIL2BAN_SCRIPT"
! grep -Fq 'if ($streamx_fail2ban_banned)' "$FAIL2BAN_SCRIPT"
grep -Fq 'preferRelayTransport: Boolean(forceRelayTransport)' "$CONNECTION_POLICY"
! grep -Fq 'preferRelayTransport = Boolean(mobileListener' "$CONNECTION_POLICY"

echo "Realtime hardening configuration tests passed."
