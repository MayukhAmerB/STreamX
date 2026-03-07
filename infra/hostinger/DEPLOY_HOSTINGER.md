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

- Production settings currently enforce object storage via `USE_GCS_MEDIA_STORAGE=1`.
- Configure valid GCS values in `backend/.env.hostinger.production` or app boot will fail (secure-by-default).
- Keep LiveKit keys in sync in all three files:
  - `backend/.env.hostinger.production`
  - `infra/hostinger/livekit.yaml`
  - `infra/hostinger/egress.yaml`

## 4) Build and start stack

Always include `--env-file backend/.env.hostinger.production`:

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml build
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml up -d
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml ps
```

## 5) Django bootstrap

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py migrate
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py collectstatic --noinput
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py createsuperuser
```

## 6) Nginx reverse proxy + TLS

Copy provided config:

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
```

Deploy updates:

```bash
git pull
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml build
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml up -d
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml exec backend python manage.py migrate
```
