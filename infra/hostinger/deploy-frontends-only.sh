#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "Frontend deployment stopped at line $LINENO. Existing database, media, and Nginx configuration were not modified." >&2' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

exec 9>/root/streamx-frontend-deploy.lock
flock -n 9

RELEASE_COMMIT="${RELEASE_COMMIT:-}"
if [[ ! "$RELEASE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "RELEASE_COMMIT must contain the approved 40-character Git SHA." >&2
  exit 1
fi

current_commit="$(git rev-parse HEAD)"
if [[ "$current_commit" != "$RELEASE_COMMIT" ]]; then
  echo "Current SHA $current_commit does not match approved SHA $RELEASE_COMMIT." >&2
  exit 1
fi

git diff --quiet
git diff --cached --quiet

topology_container="$(
  docker ps -q \
    --filter label=com.docker.compose.project=streamx \
    --filter label=com.docker.compose.service=backend-4 \
  | head -n1
)"
test -n "$topology_container"

config_files="$(
  docker inspect \
    --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
    "$topology_container"
)"
test -n "$config_files"
test "$config_files" != '<no value>'

compose=(docker compose -p streamx --env-file backend/.env.hostinger.production)
IFS=',' read -r -a files <<< "$config_files"
for file in "${files[@]}"; do
  test -f "$file"
  compose+=(-f "$file")
done

"${compose[@]}" config -q
configured_services="$("${compose[@]}" config --services)"
grep -Fxq frontend <<< "$configured_services"
grep -Fxq owlcognito-frontend <<< "$configured_services"

echo "Building frontend images only."
"${compose[@]}" build frontend owlcognito-frontend

echo "Replacing frontend containers only."
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 \
  frontend owlcognito-frontend

curl --fail --silent --show-error http://127.0.0.1:3000/healthz >/dev/null

owl_port="$("${compose[@]}" port owlcognito-frontend 8080 | awk -F: 'END {print $NF}')"
[[ "$owl_port" =~ ^[0-9]+$ ]]
curl --fail --silent --show-error "http://127.0.0.1:${owl_port}/healthz" >/dev/null

"${compose[@]}" ps frontend owlcognito-frontend
echo "Frontend-only deployment verified at $current_commit."
echo "Database, media volumes, backend services, and Nginx configuration were not changed."
