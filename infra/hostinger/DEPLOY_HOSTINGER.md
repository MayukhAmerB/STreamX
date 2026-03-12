# Hostinger VPS Deployment (Docker Compose)

This uses a dedicated production compose file and does not change your local dev stack.

## 1) VPS prerequisites

```bash
apt update && apt upgrade -y
apt install -y docker.io docker-compose-plugin git nginx certbot python3-certbot-nginx
systemctl enable docker
systemctl start docker
```

## 2) Clone project

```bash
mkdir -p /opt/alsyed
cd /opt/alsyed
git clone https://github.com/YOUR_REPO.git .
```

## 3) Prepare production env

Use:

- `backend/.env.hostinger.production`

Set all placeholder values before first boot:

- `DJANGO_SECRET_KEY`
- `POSTGRES_PASSWORD`
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `OWNCAST_STREAM_KEY`
- email credentials
- domain values if not `alsyedinitiative.com`

Important:

- Hostinger deployment uses the local Docker media volume plus `/media/` reverse proxying. No GCP or GCS values are required.
- Keep LiveKit keys in sync in all three files:
  - `backend/.env.hostinger.production`
  - `infra/hostinger/livekit.yaml`
  - `infra/hostinger/egress.yaml`

## 4) Build and start stack

Always include `--env-file backend/.env.hostinger.production`:

```bash
./infra/hostinger/deploy-safe.sh
```

What this changes:

- takes a timestamped backup before rebuild
- keeps fixed Docker volume names across deployments
- starts only the VPS-nginx-friendly app stack
- removes orphaned old services during deploys

## 5) Django bootstrap

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py migrate
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py collectstatic --noinput
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py createsuperuser
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py check --deploy
```

## 6) Nginx reverse proxy + TLS

Copy provided host-nginx config. It proxies host loopback ports exposed by Docker (`127.0.0.1:3000`, `8000`, `8080`, `8090`, `7880`):

```bash
cp infra/hostinger/nginx/alsyedinitiative.conf /etc/nginx/sites-available/alsyedinitiative
ln -sf /etc/nginx/sites-available/alsyedinitiative /etc/nginx/sites-enabled/alsyedinitiative
nginx -t
systemctl reload nginx
```

Issue certificates:

```bash
certbot --nginx -d alsyedinitiative.com -d www.alsyedinitiative.com -d api.alsyedinitiative.com -d livekit.alsyedinitiative.com -d stream.alsyedinitiative.com
```

## 7) DNS + firewall

Create A records to VPS IP: `@`, `www`, `api`, `livekit`, `stream`.

Allow inbound:

- `80/tcp`, `443/tcp`
- `7880/tcp`, `7881/tcp`
- `7882/udp` (or your `LIVEKIT_UDP_PORT`)

## 8) Operations

Logs:

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml logs -f backend
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml logs -f livekit
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml logs -f owncast
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml logs -f media
```

Optional lecture streaming optimization after direct uploads:

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py transcode_lecture_streams --all-uploaded
```

Deploy updates:

```bash
git pull
./infra/hostinger/deploy-safe.sh
```

Phased rollout (recommended for scale hardening without breaking current flow):

```bash
chmod +x infra/hostinger/deploy-phases.sh
./infra/hostinger/deploy-phases.sh phase1
./infra/hostinger/deploy-phases.sh phase2
./infra/hostinger/deploy-phases.sh phase3
./infra/hostinger/deploy-phases.sh phase4
./infra/hostinger/deploy-phases.sh phase5
```

Reference: `infra/hostinger/SINGLE_VPS_SCALE_PHASES.md`

PgBouncer-specific rollout and verification:

- `infra/hostinger/PGBOUNCER_ROLLOUT.md`

Destructive fresh rebuild of the whole Docker stack:

```bash
HOSTINGER_RESET_CONFIRM=1 ./infra/hostinger/reset-fresh.sh
```

Backups:

```bash
./infra/hostinger/backup-data.sh
ls -la .hostinger-backups
```

Backup options (optional env vars):

- `HOSTINGER_BACKUP_RETENTION_DAYS` (default `14`)
- `HOSTINGER_BACKUP_RETENTION_COUNT` (default `14`)
- `HOSTINGER_BACKUP_INCLUDE_REDIS` (default `1`)
- `HOSTINGER_BACKUP_OFFSITE_COMMAND` (shell command; receives `HOSTINGER_BACKUP_DIR`)

Restore the latest backup if needed:

```bash
HOSTINGER_RESTORE_CONFIRM=1 ./infra/hostinger/restore-data.sh latest
```

Dry-run restore integrity verification (recommended before destructive restore):

```bash
HOSTINGER_RESTORE_DRY_RUN=1 ./infra/hostinger/restore-data.sh latest
```

Systemd timer for automatic daily backups:

```bash
cp infra/hostinger/systemd/hostinger-backup.service /etc/systemd/system/
cp infra/hostinger/systemd/hostinger-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hostinger-backup.timer
systemctl list-timers hostinger-backup.timer
```

Uptime probe timer (optional):

```bash
cp infra/hostinger/systemd/hostinger-uptime-alert.service /etc/systemd/system/
cp infra/hostinger/systemd/hostinger-uptime-alert.timer /etc/systemd/system/
chmod +x infra/hostinger/uptime-alert.sh
systemctl daemon-reload
systemctl enable --now hostinger-uptime-alert.timer
systemctl list-timers hostinger-uptime-alert.timer
```

Observability stack (optional Prometheus + Grafana):

```bash
docker compose -f infra/observability/docker-compose.observability.yml up -d
```

Async worker for queued emails/webhook retries (optional):

```bash
docker compose \
  --env-file backend/.env.hostinger.production \
  -f docker-compose.hostinger.yml \
  -f infra/hostinger/docker-compose.hostinger.async-workers.yml \
  up -d --build
```

Resource-limit override for realtime hardening (optional):

```bash
docker compose \
  --env-file backend/.env.hostinger.production \
  -f docker-compose.hostinger.yml \
  -f infra/hostinger/docker-compose.hostinger.resource-limits.yml \
  up -d --build --remove-orphans
```

Important:

- `docker compose down` is safe
- `docker compose down -v` deletes persistent volumes and must not be used
