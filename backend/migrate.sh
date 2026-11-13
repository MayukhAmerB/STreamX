#!/bin/sh
# Applies Django migrations on a DIRECT PostgreSQL connection with the
# statement timeout lifted. Every deploy path calls this instead of
# `python manage.py migrate` (entrypoint.sh, infra/hostinger/deploy-*.sh).
#
# Why: production sets statement/lock timeouts on the database role
# (infra/hostinger/apply-db-role-timeouts.sh), because PgBouncer drops the libpq
# "options" Django sends. Through PgBouncer those role defaults would also
# cancel a long index build or data backfill mid-deploy. On a direct connection
# the libpq options are honoured and override the role defaults, so here:
#   statement_timeout = MIGRATE_STATEMENT_TIMEOUT_MS (default 0: none)
#   lock_timeout      = MIGRATE_LOCK_TIMEOUT_MS      (default 60000)
# The direct URL is DATABASE_MIGRATE_URL when set; otherwise DATABASE_URL with a
# "@pgbouncer[:port]/" host rewritten to "@postgres:5432/" (the compose
# service). Other URLs (SQLite, a direct managed database) are used unchanged.
# Arguments are passed to `manage.py migrate` (for example --noinput).
set -eu

direct_url="${DATABASE_MIGRATE_URL:-}"
if [ -z "$direct_url" ] && [ -n "${DATABASE_URL:-}" ]; then
  direct_url="$(printf '%s' "$DATABASE_URL" | sed -E 's#@pgbouncer(:[0-9]+)?/#@postgres:5432/#')"
fi
if [ -n "$direct_url" ]; then
  DATABASE_URL="$direct_url"
  export DATABASE_URL
fi

DATABASE_STATEMENT_TIMEOUT_MS="${MIGRATE_STATEMENT_TIMEOUT_MS:-0}"
DATABASE_LOCK_TIMEOUT_MS="${MIGRATE_LOCK_TIMEOUT_MS:-60000}"
DATABASE_BEHIND_POOLER=0
export DATABASE_STATEMENT_TIMEOUT_MS DATABASE_LOCK_TIMEOUT_MS DATABASE_BEHIND_POOLER

case "${DATABASE_URL:-}" in
  *@pgbouncer*) echo "[migrate] warning: still connecting through PgBouncer; set DATABASE_MIGRATE_URL to a direct URL." >&2 ;;
esac

echo "[migrate] direct connection, statement_timeout=${DATABASE_STATEMENT_TIMEOUT_MS}ms lock_timeout=${DATABASE_LOCK_TIMEOUT_MS}ms" >&2
exec python manage.py migrate "$@"
