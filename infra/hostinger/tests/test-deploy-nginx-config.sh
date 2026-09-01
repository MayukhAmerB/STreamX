#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/../deploy-nginx-config.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

make_fake_commands() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"

  cat >"$bin_dir/nginx" <<'EOF'
#!/usr/bin/env bash
if grep -Fq invalid "$NGINX_ACTIVE_FILE"; then
  exit 1
fi
exit 0
EOF

  cat >"$bin_dir/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "reload" && "${FAIL_FIRST_RELOAD:-0}" == "1" && ! -f "$RELOAD_MARKER" ]]; then
  touch "$RELOAD_MARKER"
  exit 1
fi
exit 0
EOF
  chmod +x "$bin_dir/nginx" "$bin_dir/systemctl"
}

run_case() {
  local name="$1"
  local source_content="$2"
  local fail_first_reload="${3:-0}"
  local case_root="$TEST_ROOT/$name"
  local sites_dir="$case_root/sites-enabled"
  local backup_dir="$case_root/backups"
  local bin_dir="$case_root/bin"
  local active_file="$sites_dir/alsyedinitiative.conf"
  local source_file="$case_root/candidate.conf"

  mkdir -p "$sites_dir"
  printf 'old-config\n' >"$active_file"
  printf '%s\n' "$source_content" >"$source_file"
  make_fake_commands "$bin_dir"

  PATH="$bin_dir:$PATH" \
    NGINX_SITES_ENABLED_DIR="$sites_dir" \
    NGINX_BACKUP_ROOT="$backup_dir" \
    NGINX_ACTIVE_FILE="$active_file" \
    FAIL_FIRST_RELOAD="$fail_first_reload" \
    RELOAD_MARKER="$case_root/reload.failed" \
    "$DEPLOY_SCRIPT" "$source_file" "$active_file"
}

run_case success new-config
grep -Fxq new-config "$TEST_ROOT/success/sites-enabled/alsyedinitiative.conf"

if run_case invalid invalid-config; then
  echo "Expected invalid Nginx configuration to fail." >&2
  exit 1
fi
grep -Fxq old-config "$TEST_ROOT/invalid/sites-enabled/alsyedinitiative.conf"

if run_case reload-failure new-config 1; then
  echo "Expected failed Nginx reload to fail the deployment." >&2
  exit 1
fi
grep -Fxq old-config "$TEST_ROOT/reload-failure/sites-enabled/alsyedinitiative.conf"

stale_root="$TEST_ROOT/stale-backup"
mkdir -p "$stale_root/sites-enabled" "$stale_root/bin"
printf 'old-config\n' >"$stale_root/sites-enabled/alsyedinitiative.conf"
printf 'candidate\n' >"$stale_root/candidate.conf"
printf 'backup\n' >"$stale_root/sites-enabled/alsyedinitiative.conf.bak.previous"
make_fake_commands "$stale_root/bin"
if PATH="$stale_root/bin:$PATH" \
  NGINX_SITES_ENABLED_DIR="$stale_root/sites-enabled" \
  NGINX_BACKUP_ROOT="$stale_root/backups" \
  NGINX_ACTIVE_FILE="$stale_root/sites-enabled/alsyedinitiative.conf" \
  RELOAD_MARKER="$stale_root/reload.failed" \
  "$DEPLOY_SCRIPT" "$stale_root/candidate.conf"; then
  echo "Expected active backup detection to refuse deployment." >&2
  exit 1
fi
grep -Fxq old-config "$stale_root/sites-enabled/alsyedinitiative.conf"

echo "Nginx deployment safety tests passed."
