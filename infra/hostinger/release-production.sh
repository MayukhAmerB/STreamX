#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
RELEASE_COMMIT="${RELEASE_COMMIT:-}"
BASE_REF="${RELEASE_BASE_REF:-HEAD^}"

log() {
  printf '[production-release] %s\n' "$*"
}

if [[ ! "$RELEASE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  log "RELEASE_COMMIT must contain the full approved 40-character Git SHA."
  exit 1
fi

current_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ "$current_commit" != "$RELEASE_COMMIT" ]]; then
  log "Refusing release: current SHA $current_commit does not match $RELEASE_COMMIT."
  exit 1
fi
if ! git -C "$REPO_ROOT" diff --quiet --ignore-submodules -- || \
   ! git -C "$REPO_ROOT" diff --cached --quiet --ignore-submodules --; then
  log "Refusing release: tracked working tree is not clean."
  exit 1
fi

log "Running migration safety gate."
"$SCRIPT_DIR/check-migration-safety.sh" "$BASE_REF"

log "Creating deployment recovery point."
"$SCRIPT_DIR/backup-data.sh"
"$SCRIPT_DIR/verify-backup.sh" latest

log "Deploying through the existing safe deployment path."
HOSTINGER_BACKUP_SCRIPT=/bin/true "$SCRIPT_DIR/deploy-safe.sh"

log "Activating the tracked Nginx config through the rollback-safe installer."
"$SCRIPT_DIR/deploy-nginx-config.sh" \
  "$REPO_ROOT/infra/hostinger/nginx/alsyedinitiative.conf"

log "Activating the tracked monitor configuration through the rollback-safe installer."
"$SCRIPT_DIR/deploy-nginx-config.sh" \
  "$REPO_ROOT/infra/hostinger/nginx/monitor-subdomain.conf" \
  /etc/nginx/sites-enabled/monitor.alsyedinitiative.com.conf

if command -v fail2ban-client >/dev/null 2>&1; then
  log "Installing the backup-safe Nginx Fail2ban action and restoring its active snippet."
  install -m 0755 \
    "$REPO_ROOT/infra/hostinger/network/fail2ban/streamx-nginx-denylist.sh" \
    /usr/local/bin/streamx-nginx-denylist
  /usr/local/bin/streamx-nginx-denylist ensure
fi

log "Running post-deployment readiness verification."
RELEASE_COMMIT="$RELEASE_COMMIT" "$SCRIPT_DIR/verify-production-readiness.sh"

log "Release completed for $RELEASE_COMMIT."
