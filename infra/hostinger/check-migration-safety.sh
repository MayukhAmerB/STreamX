#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
BASE_REF="${1:-HEAD^}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

log() {
  printf '[migration-safety] %s\n' "$*"
}

git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF^{commit}" >/dev/null
compose config -q

log "Checking that models have committed migrations."
compose run --rm \
  -e RUN_MIGRATIONS=0 \
  -e RUN_COLLECTSTATIC=0 \
  backend python manage.py makemigrations --check --dry-run

mapfile -t changed_migrations < <(
  git -C "$REPO_ROOT" diff --name-only --diff-filter=ACMR \
    "$BASE_REF"...HEAD -- 'backend/apps/*/migrations/*.py'
)

if (( ${#changed_migrations[@]} == 0 )); then
  log "No changed migrations between $BASE_REF and HEAD."
  exit 0
fi

log "Changed migrations:"
printf '  %s\n' "${changed_migrations[@]}"

risky_pattern='migrations\.(DeleteModel|RemoveField|RenameField|RenameModel|RunSQL|RunPython)\b'
risky_files=()
for relative_path in "${changed_migrations[@]}"; do
  if grep -Eq "$risky_pattern" "$REPO_ROOT/$relative_path"; then
    risky_files+=("$relative_path")
  fi
done

if (( ${#risky_files[@]} > 0 )) && [[ "${MIGRATION_RISK_ACCEPTED:-0}" != "1" ]]; then
  log "Potentially destructive or data-changing operations require explicit review:"
  printf '  %s\n' "${risky_files[@]}"
  log "After backup and rollback review, rerun with MIGRATION_RISK_ACCEPTED=1."
  exit 1
fi

log "Migration safety gate passed. Review the deployment migration plan before release."
