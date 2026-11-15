#!/usr/bin/env bash
set -euo pipefail

# Private media folders must never be served from the public /media/ URL space.
# Staff and enrolled students reach these files only through Django views that
# answer with X-Accel-Redirect to the internal /_protected_media/ location.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NGINX_DIR="$SCRIPT_DIR/../nginx"
MAIN_CONF="$NGINX_DIR/alsyedinitiative.conf"
MEDIA_CONF="$NGINX_DIR/media.conf"

count_blocks() {
  local file="$1" folder="$2"
  grep -A1 -F "location ^~ /media/$folder/ {" "$file" | grep -c 'return 404;' || true
}

for folder in lecture_videos streams class-recording-uploads; do
  # media.conf is the origin for every public /media/ request.
  [[ "$(count_blocks "$MEDIA_CONF" "$folder")" == "1" ]] || {
    echo "media.conf must answer 404 for /media/$folder/" >&2
    exit 1
  }
  # Both public server blocks of the main site block it too (defence in depth).
  [[ "$(count_blocks "$MAIN_CONF" "$folder")" == "2" ]] || {
    echo "alsyedinitiative.conf must answer 404 for /media/$folder/ in both server blocks" >&2
    exit 1
  }
done

# The protected location stays internal in the public configuration.
[[ "$(grep -A1 -F 'location ^~ /_protected_media/ {' "$MAIN_CONF" | grep -c 'internal;')" == "2" ]] || {
  echo "/_protected_media/ must be internal in both server blocks" >&2
  exit 1
}

echo "media protection config: ok"
