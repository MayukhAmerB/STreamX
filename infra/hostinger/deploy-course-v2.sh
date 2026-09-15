#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
trap 'echo "Deployment stopped at line $LINENO. Share the preceding error; do not run cleanup." >&2' ERR
cd /opt/alsyed/StreamX
exec 9>/root/streamx-course-v2-deploy.lock
flock -n 9
test "$(git rev-parse HEAD)" = 16a426cbc38616f0ebb9400213bd04f0a282326c
git diff --quiet
git diff --cached --quiet
config_files="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' streamx-backend-4-1)"
test -n "$config_files"
test "$config_files" != '<no value>'
IFS=',' read -r -a files <<< "$config_files"
compose=(docker compose -p streamx --env-file backend/.env.hostinger.production)
for file in "${files[@]}"; do
  test -f "$file"
  compose+=(-f "$file")
done
"${compose[@]}" config -q
configured="$("${compose[@]}" config --services)"
services=(backend backend-2 backend-3 backend-4 payment-backend-1 payment-backend-2 worker worker-2 transcoder frontend owlcognito-frontend)
for service in "${services[@]}"; do
  grep -Fxq "$service" <<< "$configured"
done
docker exec streamx-gateway-1 nginx -t
mkdir -p .hostinger-backups
backup="$(mktemp -d /opt/alsyed/StreamX/.hostinger-backups/course-v2-release-XXXXXXXX)"
echo "Recovery directory: $backup"
docker ps -aq --filter label=com.docker.compose.project=streamx |
while read -r container; do
  docker inspect --format '{{.Name}} {{.Image}}' "$container"
done > "$backup/previous-images.txt"
echo 'Building application images.'
"${compose[@]}" build "${services[@]}"
echo 'Backing up PostgreSQL without restarting it.'
docker exec streamx-postgres-1 sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/postgres.dump"
test -s "$backup/postgres.dump"
docker exec -i streamx-postgres-1 pg_restore --list < "$backup/postgres.dump" > "$backup/postgres-contents.txt"
echo 'Archiving media and recordings. This may take a while.'
for volume in streamx_backend_media streamx_recordings_data streamx_owncast_data; do
  docker volume inspect "$volume" >/dev/null
  docker run --rm --mount "type=volume,source=$volume,target=/source,readonly" --mount "type=bind,source=$backup,target=/backup" alpine:3.20 sh -c 'tar czf "/backup/$1.tar.gz" -C /source .' sh "$volume"
  gzip -t "$backup/$volume.tar.gz"
done
(
  cd "$backup"
  sha256sum postgres.dump *.tar.gz > SHA256SUMS
  sha256sum -c SHA256SUMS
)
echo 'Checking and applying forward migrations.'
"${compose[@]}" run --rm --no-deps -T --entrypoint python backend manage.py check
"${compose[@]}" run --rm --no-deps -T --entrypoint python backend manage.py makemigrations --check --dry-run
"${compose[@]}" run --rm --no-deps -T --entrypoint python backend manage.py migrate --plan
"${compose[@]}" run --rm --no-deps -T --entrypoint python backend manage.py migrate --noinput
for service in backend backend-2 backend-3 backend-4 payment-backend-1 payment-backend-2; do
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 "$service"
  docker exec streamx-gateway-1 nginx -t
  docker exec streamx-gateway-1 nginx -s reload
done
"${compose[@]}" up -d --no-deps --no-build --scale worker=2 --wait --wait-timeout 180 worker
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 worker-2 transcoder
"${compose[@]}" exec -T backend python manage.py setup_course_experience --publish
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 frontend owlcognito-frontend
docker exec streamx-gateway-1 nginx -t
docker exec streamx-gateway-1 nginx -s reload
"${compose[@]}" exec -T backend python manage.py migrate --check
curl --fail --silent --show-error http://127.0.0.1:8088/gateway-healthz
curl --fail --silent --show-error http://127.0.0.1:3000/healthz
docker ps --filter label=com.docker.compose.project=streamx --format 'table {{.Names}}\t{{.Status}}'
echo "Deployment commands completed. Backup: $backup"
echo 'Verify login, existing video playback, course cards and admin pricing.'
