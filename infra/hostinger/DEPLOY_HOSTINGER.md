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
- never requires Docker `edge-nginx`

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

Backups:

```bash
./infra/hostinger/backup-data.sh
ls -la .hostinger-backups
```

Restore the latest backup if needed:

```bash
HOSTINGER_RESTORE_CONFIRM=1 ./infra/hostinger/restore-data.sh latest
```

Systemd timer for automatic daily backups:

```bash
cp infra/hostinger/systemd/hostinger-backup.service /etc/systemd/system/
cp infra/hostinger/systemd/hostinger-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hostinger-backup.timer
systemctl list-timers hostinger-backup.timer
```

Important:

- `docker compose down` is safe
- `docker compose down -v` deletes persistent volumes and must not be used
