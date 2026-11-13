#!/usr/bin/env bash
set -euo pipefail

# apply-db-role-timeouts.sh against a fake `docker`: it must send idempotent
# ALTER ROLE ... SET statements (quoted through psql variables), verify on a new
# connection, offer a RESET rollback, and refuse malformed values.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/../apply-db-role-timeouts.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/bin"
cat >"$TEST_ROOT/bin/docker" <<'FAKE'
#!/usr/bin/env bash
{
  echo "ARGS: $*"
  cat
  echo "---"
} >>"$FAKE_DOCKER_LOG"
# The verification query answers "t" unless told otherwise.
echo "${FAKE_VERIFY_RESULT:-t}"
FAKE
chmod +x "$TEST_ROOT/bin/docker"
touch "$TEST_ROOT/env" "$TEST_ROOT/compose.yml"

run() {
  PATH="$TEST_ROOT/bin:$PATH" \
    FAKE_DOCKER_LOG="$TEST_ROOT/docker.log" \
    HOSTINGER_ENV_FILE="$TEST_ROOT/env" \
    HOSTINGER_COMPOSE_FILE="$TEST_ROOT/compose.yml" \
    bash "$TARGET" "$@"
}

fail() {
  echo "db role timeouts: $*" >&2
  exit 1
}

# Apply with the plan's defaults.
: >"$TEST_ROOT/docker.log"
run >/dev/null || fail "apply failed"
log="$(cat "$TEST_ROOT/docker.log")"
grep -Fq "ALTER ROLE :\"role\" IN DATABASE :\"db\" SET statement_timeout = :'st';" <<<"$log" || fail "missing statement_timeout"
grep -Fq "ALTER ROLE :\"role\" IN DATABASE :\"db\" SET lock_timeout = :'lt';" <<<"$log" || fail "missing lock_timeout"
grep -Fq "ALTER ROLE :\"role\" IN DATABASE :\"db\" SET idle_in_transaction_session_timeout = :'it';" <<<"$log" || fail "missing idle_in_transaction_session_timeout"
grep -Fq "ROLE_STATEMENT_TIMEOUT=15s" <<<"$log" || fail "statement_timeout default must be 15s"
grep -Fq "ROLE_LOCK_TIMEOUT=10s" <<<"$log" || fail "lock_timeout default must be 10s"
grep -Fq "ROLE_IDLE_IN_TX_TIMEOUT=30s" <<<"$log" || fail "idle_in_transaction_session_timeout default must be 30s"
grep -Fq "current_setting('statement_timeout')::interval = :'st'::interval" <<<"$log" || fail "missing verification"
grep -Fq "exec -T" <<<"$log" || fail "must exec in the postgres container"
! grep -Eiq 'restart|ALTER SYSTEM|pg_reload_conf' <<<"$log" || fail "must not restart or reconfigure the server"

# Verification failure is reported.
: >"$TEST_ROOT/docker.log"
if FAKE_VERIFY_RESULT=f run >/dev/null 2>&1; then
  fail "a failed verification must exit non-zero"
fi

# Rollback.
: >"$TEST_ROOT/docker.log"
run --reset >/dev/null || fail "reset failed"
grep -Fq 'RESET statement_timeout;' "$TEST_ROOT/docker.log" || fail "reset must RESET statement_timeout"
grep -Fq 'RESET idle_in_transaction_session_timeout;' "$TEST_ROOT/docker.log" || fail "reset must RESET idle_in_transaction_session_timeout"

# Malformed values never reach psql.
: >"$TEST_ROOT/docker.log"
if DB_ROLE_STATEMENT_TIMEOUT="15s'; DROP TABLE x; --" run >/dev/null 2>&1; then
  fail "a malformed value must be refused"
fi
[[ ! -s "$TEST_ROOT/docker.log" ]] || fail "a malformed value must not call docker"

# Not wired into the release automatically.
! grep -Fq 'apply-db-role-timeouts' "$SCRIPT_DIR/../release-production.sh" || fail "release-production.sh must not run it automatically"

# Migrations never run through PgBouncer with the role timeouts: backend/migrate.sh
# switches to a direct postgres:5432 connection and lifts statement_timeout.
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
MIGRATE="$REPO_ROOT/backend/migrate.sh"
[[ -f "$MIGRATE" ]] || fail "backend/migrate.sh is missing"
cat >"$TEST_ROOT/bin/python" <<'FAKE'
#!/usr/bin/env bash
echo "ARGS=$* URL=${DATABASE_URL:-} ST=${DATABASE_STATEMENT_TIMEOUT_MS:-} LT=${DATABASE_LOCK_TIMEOUT_MS:-} POOLER=${DATABASE_BEHIND_POOLER:-}"
FAKE
chmod +x "$TEST_ROOT/bin/python"
out="$(PATH="$TEST_ROOT/bin:$PATH" DATABASE_URL='postgresql://u:p@pgbouncer:5432/db' sh "$MIGRATE" --noinput 2>/dev/null)"
[[ "$out" == "ARGS=manage.py migrate --noinput URL=postgresql://u:p@postgres:5432/db ST=0 LT=60000 POOLER=0" ]] \
  || fail "migrate.sh must migrate directly with the timeouts lifted (got: $out)"
out="$(PATH="$TEST_ROOT/bin:$PATH" DATABASE_URL='postgresql://u:p@pgbouncer:5432/db' DATABASE_MIGRATE_URL='postgresql://u:p@db.internal:5432/db' sh "$MIGRATE" 2>/dev/null)"
grep -Fq 'URL=postgresql://u:p@db.internal:5432/db' <<<"$out" || fail "DATABASE_MIGRATE_URL must win"
for deploy in "$REPO_ROOT/backend/entrypoint.sh" "$SCRIPT_DIR/../deploy-phases.sh" "$SCRIPT_DIR/../deploy-course-v2.sh"; do
  ! grep -Eq 'manage\.py migrate( --noinput)?[[:space:]]*$' "$deploy" || fail "$(basename "$deploy") must apply migrations through migrate.sh"
  grep -Fq 'migrate.sh' "$deploy" || fail "$(basename "$deploy") must call migrate.sh"
done

echo "db role timeouts: ok"
