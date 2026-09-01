#!/usr/bin/env bash
set -euo pipefail

SOURCE_FILE="${1:?Usage: $0 <tracked-config> [active-config]}"
ACTIVE_FILE="${2:-/etc/nginx/sites-enabled/alsyedinitiative.conf}"
BACKUP_ROOT="${NGINX_BACKUP_ROOT:-/root/nginx-config-backups}"
WRITE_FILE="$ACTIVE_FILE"

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Source config does not exist: $SOURCE_FILE"
  exit 1
fi

if find /etc/nginx/sites-enabled -maxdepth 1 \( -type f -o -type l \) \
  \( -name '*.bak*' -o -name '*~' \) -print -quit | grep -q .; then
  echo "Refusing deployment: backup files are active under /etc/nginx/sites-enabled."
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

if ! nginx -t; then
  if [[ -n "$backup_file" ]]; then
    install -m 0644 "$backup_file" "$WRITE_FILE"
  else
    rm -f "$WRITE_FILE"
  fi
  nginx -t >/dev/null 2>&1 || true
  echo "New Nginx config failed validation; previous config restored."
  exit 1
fi

systemctl reload nginx
systemctl is-active --quiet nginx
echo "Nginx config deployed safely. Backup: ${backup_file:-none}"
