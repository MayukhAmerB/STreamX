#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "Course-library deployment stopped at line $LINENO. Database, media volumes, migrations, and host Nginx configuration were not modified." >&2' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

exec 9>/root/streamx-course-library-deploy.lock
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

topology_container="$({
  docker ps -q \
    --filter label=com.docker.compose.project=streamx \
    --filter label=com.docker.compose.service=backend-4
} | head -n1)"
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
backend_services=(
  backend
  backend-2
  backend-3
  backend-4
  payment-backend-1
  payment-backend-2
)
frontend_services=(frontend owlcognito-frontend)
services=("${backend_services[@]}" "${frontend_services[@]}")

for service in "${services[@]}"; do
  grep -Fxq "$service" <<< "$configured_services"
done

gateway_container="$({
  docker ps -q \
    --filter label=com.docker.compose.project=streamx \
    --filter label=com.docker.compose.service=gateway
} | head -n1)"
test -n "$gateway_container"
docker exec "$gateway_container" nginx -t

echo "Building only the backend pool and public frontends."
"${compose[@]}" build "${services[@]}"

echo "Validating the new backend image without changing the database."
"${compose[@]}" run --rm --no-deps -T --entrypoint python backend manage.py check
"${compose[@]}" run --rm --no-deps -T --entrypoint python backend \
  manage.py makemigrations --check --dry-run
"${compose[@]}" run --rm --no-deps -T --entrypoint python backend \
  manage.py migrate --check

echo "Replacing backend replicas one at a time."
for service in "${backend_services[@]}"; do
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 "$service"
  docker exec "$gateway_container" nginx -t
  docker exec "$gateway_container" nginx -s reload
done

echo "Replacing both frontend containers."
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 \
  "${frontend_services[@]}"

docker exec "$gateway_container" nginx -t
docker exec "$gateway_container" nginx -s reload

echo "Verifying the deployed application."
"${compose[@]}" exec -T backend python manage.py check
"${compose[@]}" exec -T backend python manage.py migrate --check
curl --fail --silent --show-error http://127.0.0.1:8088/gateway-healthz >/dev/null
curl --fail --silent --show-error http://127.0.0.1:3000/healthz >/dev/null
curl --fail --silent --show-error \
  https://api.alsyedinitiative.com/health/ready >/dev/null

owl_port="$("${compose[@]}" port owlcognito-frontend 8080 | awk -F: 'END {print $NF}')"
[[ "$owl_port" =~ ^[0-9]+$ ]]
curl --fail --silent --show-error \
  "http://127.0.0.1:${owl_port}/healthz" >/dev/null

for service in "${services[@]}"; do
  container_id="$("${compose[@]}" ps -q "$service")"
  test -n "$container_id"
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  if [[ "$status" != "healthy" && "$status" != "running" ]]; then
    echo "$service is not healthy: $status" >&2
    exit 1
  fi
done

"${compose[@]}" ps "${services[@]}"
echo "Course-library deployment verified at $current_commit."
echo "Database, media volumes, migrations, and host Nginx configuration were not changed."
