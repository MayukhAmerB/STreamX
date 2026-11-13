#!/usr/bin/env bash
set -euo pipefail

# Every container the production compose files define must cap its json-file
# logs (50 MB x 5 files), or container logs can fill the disk.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"

files=(
  "$REPO_ROOT/docker-compose.hostinger.yml"
  "$REPO_ROOT/infra/observability/docker-compose.observability.yml"
)
for file in "$REPO_ROOT"/infra/hostinger/docker-compose.hostinger.*.yml; do
  files+=("$file")
done

for file in "${files[@]}"; do
  # Services (2-space keys under "services:") that define a container
  # (image or build) but have no "logging: *default-logging".
  uncapped="$(awk '
    /^services:/ { in_services = 1; next }
    /^[^ #]/ { in_services = 0 }
    function flush() { if (name != "" && defines && !capped) print name }
    in_services && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { flush(); name = $1; defines = 0; capped = 0; next }
    in_services && /^    (image|build):/ { defines = 1 }
    in_services && /^    logging: \*default-logging$/ { capped = 1 }
    END { flush() }
  ' "$file")"
  [[ -z "$uncapped" ]] || {
    echo "$file: services without the default-logging cap: $uncapped" >&2
    exit 1
  }
  grep -Eq '^    (image|build):' "$file" || continue
  grep -Eq '^x-logging: &default-logging$' "$file" || { echo "$file: missing x-logging anchor" >&2; exit 1; }
  grep -Fq '    max-size: "50m"' "$file" || { echo "$file: log max-size must be 50m" >&2; exit 1; }
  grep -Fq '    max-file: "5"' "$file" || { echo "$file: log max-file must be 5" >&2; exit 1; }
done

echo "compose log caps: ok"
