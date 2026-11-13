#!/usr/bin/env bash
set -euo pipefail

# Database-side timeouts for the application role (plan B2).
#
# Django passes statement_timeout / lock_timeout /
# idle_in_transaction_session_timeout as libpq startup "options", but PgBouncer
# (transaction pooling) discards those (IGNORE_STARTUP_PARAMETERS), so in
# production every connection otherwise runs with NO timeout. Setting them on
# the role makes PostgreSQL apply them to every new server connection, whatever
# the client sends.
#
# * Idempotent: ALTER ROLE ... SET simply overwrites the same values.
# * No restart: new server connections get the values at once. Connections
#   PgBouncer already holds keep their old values until PgBouncer recycles them
#   (server_lifetime, 1 h by default); see the deploy notes to force it.
# * pg_dump (backups) and restores set these to 0 themselves, so they are
#   unaffected.
# * Not run by release-production.sh: run it by hand once (and again after any
#   change to the values). Long migrations: see the deploy notes.
#
# Usage:
#   infra/hostinger/apply-db-role-timeouts.sh           apply (default)
#   infra/hostinger/apply-db-role-timeouts.sh --check   show the role's settings
#   infra/hostinger/apply-db-role-timeouts.sh --reset   remove them (rollback)
#
# Values (override with environment variables; integer + ms|s|min):
#   DB_ROLE_STATEMENT_TIMEOUT    default 15s
#   DB_ROLE_LOCK_TIMEOUT         default 10s
#   DB_ROLE_IDLE_IN_TX_TIMEOUT   default 30s

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"

STATEMENT_TIMEOUT="${DB_ROLE_STATEMENT_TIMEOUT:-15s}"
LOCK_TIMEOUT="${DB_ROLE_LOCK_TIMEOUT:-10s}"
IDLE_IN_TX_TIMEOUT="${DB_ROLE_IDLE_IN_TX_TIMEOUT:-30s}"

MODE="apply"
case "${1:-}" in
  "" | --apply) MODE="apply" ;;
  --check) MODE="check" ;;
  --reset) MODE="reset" ;;
  -h | --help)
    sed -n '3,33p' "$0"
    exit 0
    ;;
  *)
    echo "Unknown option: $1 (use --apply, --check or --reset)" >&2
    exit 2
    ;;
esac

log() {
  printf '[db-role-timeouts] %s\n' "$*"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

validate_duration() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[0-9]{1,6}(ms|s|min)$ ]]; then
    echo "$name must be an integer followed by ms, s or min (got '$value')." >&2
    exit 2
  fi
}

validate_duration DB_ROLE_STATEMENT_TIMEOUT "$STATEMENT_TIMEOUT"
validate_duration DB_ROLE_LOCK_TIMEOUT "$LOCK_TIMEOUT"
validate_duration DB_ROLE_IDLE_IN_TX_TIMEOUT "$IDLE_IN_TX_TIMEOUT"

# psql inside the postgres container, as the application role (POSTGRES_USER),
# reading SQL from stdin so the identifiers can be quoted with psql variables.
run_psql() {
  compose exec -T \
    -e ROLE_STATEMENT_TIMEOUT="$STATEMENT_TIMEOUT" \
    -e ROLE_LOCK_TIMEOUT="$LOCK_TIMEOUT" \
    -e ROLE_IDLE_IN_TX_TIMEOUT="$IDLE_IN_TX_TIMEOUT" \
    postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -v ON_ERROR_STOP=1 \
      -v role="$POSTGRES_USER" -v db="$POSTGRES_DB" \
      -v st="$ROLE_STATEMENT_TIMEOUT" -v lt="$ROLE_LOCK_TIMEOUT" -v it="$ROLE_IDLE_IN_TX_TIMEOUT"'
}

show_settings() {
  run_psql <<'SQL'
\echo 'Role settings (pg_db_role_setting):'
SELECT coalesce(r.rolname, '(all roles)') AS role, coalesce(d.datname, '(all databases)') AS database, s.setconfig
FROM pg_db_role_setting s
LEFT JOIN pg_roles r ON r.oid = s.setrole
LEFT JOIN pg_database d ON d.oid = s.setdatabase
WHERE r.rolname = :'role';
\echo 'Effective values on a new connection:'
SHOW statement_timeout;
SHOW lock_timeout;
SHOW idle_in_transaction_session_timeout;
SQL
}

case "$MODE" in
  apply)
    log "Setting statement_timeout=$STATEMENT_TIMEOUT lock_timeout=$LOCK_TIMEOUT idle_in_transaction_session_timeout=$IDLE_IN_TX_TIMEOUT on the application role."
    run_psql <<'SQL'
ALTER ROLE :"role" IN DATABASE :"db" SET statement_timeout = :'st';
ALTER ROLE :"role" IN DATABASE :"db" SET lock_timeout = :'lt';
ALTER ROLE :"role" IN DATABASE :"db" SET idle_in_transaction_session_timeout = :'it';
SQL
    # A fresh psql session is a new connection, so it must already see them.
    # Compared as intervals, so "15s" and "15000ms" are equal.
    verified="$(run_psql <<'SQL' | tr -d '[:space:]'
\pset tuples_only on
\pset format unaligned
SELECT current_setting('statement_timeout')::interval = :'st'::interval
   AND current_setting('lock_timeout')::interval = :'lt'::interval
   AND current_setting('idle_in_transaction_session_timeout')::interval = :'it'::interval;
SQL
)"
    if [[ "$verified" != "t" ]]; then
      echo "Verification failed: a new connection does not report the new timeouts (got '$verified'). Run with --check." >&2
      exit 1
    fi
    log "Verified on a new connection. PgBouncer picks the values up as it recycles server connections."
    ;;
  reset)
    log "Removing the role-level timeouts (rollback)."
    run_psql <<'SQL'
ALTER ROLE :"role" IN DATABASE :"db" RESET statement_timeout;
ALTER ROLE :"role" IN DATABASE :"db" RESET lock_timeout;
ALTER ROLE :"role" IN DATABASE :"db" RESET idle_in_transaction_session_timeout;
SQL
    log "Done. New connections use the server defaults again."
    ;;
  check)
    show_settings
    ;;
esac
