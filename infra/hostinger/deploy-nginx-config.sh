#!/usr/bin/env bash
set -euo pipefail

SOURCE_FILE="${1:?Usage: $0 <tracked-config> [active-config]}"
SITES_ENABLED_DIR="${NGINX_SITES_ENABLED_DIR:-/etc/nginx/sites-enabled}"
ACTIVE_FILE="${2:-$SITES_ENABLED_DIR/alsyedinitiative.conf}"
BACKUP_ROOT="${NGINX_BACKUP_ROOT:-/root/nginx-config-backups}"
WRITE_FILE="$ACTIVE_FILE"

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Source config does not exist: $SOURCE_FILE"
  exit 1
fi

if find "$SITES_ENABLED_DIR" -maxdepth 1 \( -type f -o -type l \) \
  \( -name '*.bak*' -o -name '*~' \) -print -quit | grep -q .; then
  echo "Refusing deployment: backup files are active under $SITES_ENABLED_DIR."
  echo "Move them to $BACKUP_ROOT, then rerun this command."
  exit 1
fi

install -d "$BACKUP_ROOT"
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_file="$BACKUP_ROOT/$(basename "$ACTIVE_FILE").$timestamp.bak"

if [[ -L "$ACTIVE_FILE" ]]; then
  WRITE_FILE="$(readlink -f "$ACTIVE_FILE")"
  if [[ -z "$WRITE_FILE" ]]; then
    echo "Active Nginx config is a broken symlink: $ACTIVE_FILE"
    exit 1
  fi
fi

if [[ -e "$WRITE_FILE" ]]; then
  cp -a "$WRITE_FILE" "$backup_file"
else
  backup_file=""
fi

install -m 0644 "$SOURCE_FILE" "$WRITE_FILE"

restore_previous_config() {
  if [[ -n "$backup_file" ]]; then
    install -m 0644 "$backup_file" "$WRITE_FILE"
  else
    rm -f "$WRITE_FILE"
  fi
}

if ! nginx -t; then
  restore_previous_config
  nginx -t >/dev/null 2>&1 || true
  echo "New Nginx config failed validation; previous config restored."
  exit 1
fi

if ! systemctl reload nginx || ! systemctl is-active --quiet nginx; then
  restore_previous_config
  if nginx -t; then
    systemctl reload nginx || true
  fi
  echo "Nginx reload failed; previous config restored."
  exit 1
fi
echo "Nginx config deployed safely. Backup: ${backup_file:-none}"
