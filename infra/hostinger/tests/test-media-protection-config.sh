#!/usr/bin/env bash
set -euo pipefail

# Private media must never be served from the public /media/ URL space.
#
# media.conf (the origin for every public /media/ request) is an ALLOWLIST:
# only the folders in PUBLIC_FOLDERS are aliased; everything else answers 404.
# Paid lecture files and recordings reach users only through Django views that
# check access and answer with X-Accel-Redirect to the internal
# /_protected_media/ location. The public vhosts also deny the private folders
# explicitly (defence in depth), keep /_protected_media/ internal, and never
# expose Owncast's admin on stream.*.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NGINX_DIR="$SCRIPT_DIR/../nginx"
MAIN_CONF="$NGINX_DIR/alsyedinitiative.conf"
MEDIA_CONF="$NGINX_DIR/media.conf"
OWL_CONF="$NGINX_DIR/owlcognito.conf.template"

PUBLIC_FOLDERS="course_thumbnails guide_videos national_desk profile_images"
PRIVATE_FOLDERS="lecture_videos lecture_resources streams realtime_recordings class-recording-uploads"

fail() {
  echo "media protection config: $*" >&2
  exit 1
}

# Print the body of the block that starts at the first line equal to "$2"
# (after trimming indentation), up to its closing brace.
block_body() {
  local file="$1" header="$2"
  awk -v header="$header" '
    { line = $0; sub(/^[ \t]+/, "", line) }
    !found && line == header { found = 1; depth = 1; next }
    found {
      opens = gsub(/\{/, "{", line); closes = gsub(/\}/, "}", line)
      depth += opens - closes
      if (depth <= 0) exit
      print line
    }
  ' "$file"
}

count_header() {
  local file="$1" header="$2"
  awk -v header="$header" '{ line = $0; sub(/^[ \t]+/, "", line) } line == header { n++ } END { print n + 0 }' "$file"
}

# --- media.conf: allowlist ----------------------------------------------------

catch_all="$(block_body "$MEDIA_CONF" 'location /media/ {')"
[[ -n "$catch_all" ]] || fail "media.conf must have a catch-all 'location /media/' block"
grep -qx 'return 404;' <<< "$catch_all" || fail "media.conf: the catch-all /media/ location must return 404"
! grep -Eq '^(alias|root|try_files|proxy_pass)\b' <<< "$catch_all" || fail "media.conf: the catch-all /media/ location must not serve files"

served="$(grep -E '^[[:space:]]*location \^~ /media/[^ ]+/ \{' "$MEDIA_CONF" | sed -E 's#.*/media/([^ ]+)/ \{#\1#' | while read -r folder; do
  if block_body "$MEDIA_CONF" "location ^~ /media/$folder/ {" | grep -Eq '^alias '; then echo "$folder"; fi
done | sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$served" == "$PUBLIC_FOLDERS" ]] || fail "media.conf public folders are '$served', expected exactly '$PUBLIC_FOLDERS'"

# No other way to serve files from the media root outside the allowlist and the
# protected location.
alias_count="$(grep -Ec '^[[:space:]]*(alias|root) ' "$MEDIA_CONF")"
expected_aliases=$(( $(wc -w <<< "$PUBLIC_FOLDERS") + 1 ))
[[ "$alias_count" == "$expected_aliases" ]] || fail "media.conf has $alias_count alias/root lines, expected $expected_aliases"
! grep -Eq '^[[:space:]]*location ~' "$MEDIA_CONF" || fail "media.conf must not use regex locations (they bypass the allowlist)"

for folder in $PRIVATE_FOLDERS; do
  [[ "$(block_body "$MEDIA_CONF" "location ^~ /media/$folder/ {")" == "return 404;" ]] \
    || fail "media.conf must answer 404 for /media/$folder/"
done

# --- public vhosts -------------------------------------------------------------

for folder in $PRIVATE_FOLDERS; do
  [[ "$(count_header "$MAIN_CONF" "location ^~ /media/$folder/ {")" == "2" ]] \
    || fail "alsyedinitiative.conf must answer 404 for /media/$folder/ in both server blocks"
  [[ "$(block_body "$MAIN_CONF" "location ^~ /media/$folder/ {")" == "return 404;" ]] \
    || fail "alsyedinitiative.conf: /media/$folder/ must return 404"
  grep -Fq "location ^~ /media/$folder/ { return 404; }" "$OWL_CONF" \
    || fail "owlcognito.conf.template must answer 404 for /media/$folder/"
done

# The protected location stays internal wherever it exists publicly.
[[ "$(count_header "$MAIN_CONF" 'location ^~ /_protected_media/ {')" == "2" ]] \
  || fail "alsyedinitiative.conf must define /_protected_media/ in both server blocks"
[[ "$(grep -A1 -F 'location ^~ /_protected_media/ {' "$MAIN_CONF" | grep -c 'internal;')" == "2" ]] \
  || fail "/_protected_media/ must be internal in both server blocks"
[[ "$(grep -A1 -F 'location ^~ /_protected_media/ {' "$OWL_CONF" | grep -c 'internal;')" == "1" ]] \
  || fail "/_protected_media/ must be internal in owlcognito.conf.template"

# --- stream.*: Owncast admin is never public ------------------------------------

admin_block="$(block_body "$MAIN_CONF" 'location ~* ^/(admin|api/admin)(/|$) {')"
[[ "$admin_block" == "return 404;" ]] || fail "stream.* must answer 404 for Owncast /admin and /api/admin"
stream_server_line="$(grep -n 'server_name stream\.' "$MAIN_CONF" | head -n1 | cut -d: -f1)"
admin_line="$(grep -nF 'location ~* ^/(admin|api/admin)(/|$) {' "$MAIN_CONF" | head -n1 | cut -d: -f1)"
[[ -n "$stream_server_line" && -n "$admin_line" && "$admin_line" -gt "$stream_server_line" ]] \
  || fail "the Owncast admin block must live in the stream.* server block"

echo "media protection config: ok"
