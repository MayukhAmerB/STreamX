# OwlCognito Deployment

OwlCognito is a second branded React frontend. It uses the existing StreamX
Django API, PostgreSQL database, Redis cache, payment services, course access,
and live-class services. Do not create a second database and do not run a
database reset for this deployment.

## Before You Start

1. Point the OwlCognito domain's `A` record to the existing VPS IP address.
2. Keep the record DNS-only until the first certificate is issued, or use a
   Cloudflare origin certificate workflow already approved for the domain.
3. Replace `app.owlcognito.example` below with the real purchased domain.

## Configure The Existing Production Environment

From `/opt/alsyed/StreamX`, back up the current environment file and add the
new domain without replacing existing allowed origins:

```bash
set -euo pipefail
cd /opt/alsyed/StreamX

ENV_FILE=./backend/.env.hostinger.production
DOMAIN=app.owlcognito.example
STAMP=$(date +%Y%m%d-%H%M%S)

cp -a "$ENV_FILE" "/root/.env.hostinger.production.before-owlcognito-$STAMP.bak"

python3 - "$ENV_FILE" "$DOMAIN" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
domain = sys.argv[2].strip().lower()
origin = f"https://{domain}"
updates = {
    "OWLCOGNITO_DOMAIN": domain,
    "OWLCOGNITO_FRONTEND_PORT": "3002",
}
append_values = {
    "ALLOWED_HOSTS": domain,
    "CORS_ALLOWED_ORIGINS": origin,
    "CSRF_TRUSTED_ORIGINS": origin,
}

lines = path.read_text(encoding="utf-8").splitlines()
found = set()
result = []
for line in lines:
    key, separator, value = line.partition("=")
    if separator and key in updates:
        result.append(f"{key}={updates[key]}")
        found.add(key)
        continue
    if separator and key in append_values:
        values = [item.strip() for item in value.split(",") if item.strip()]
        if append_values[key] not in values:
            values.append(append_values[key])
        result.append(f"{key}={','.join(values)}")
        found.add(key)
        continue
    result.append(line)

for key, value in updates.items():
    if key not in found:
        result.append(f"{key}={value}")
for key, value in append_values.items():
    if key not in found:
        result.append(f"{key}={value}")

path.write_text("\n".join(result) + "\n", encoding="utf-8")
PY
```

## Build The OwlCognito Frontend

This rebuilds only the new frontend and the existing backend pool so it loads
the additive host/origin configuration. It does not run migrations because no
schema change is required.

```bash
set -euo pipefail
cd /opt/alsyed/StreamX

ENV_FILE=./backend/.env.hostinger.production
COMPOSE=(
  docker compose
  --env-file "$ENV_FILE"
  -f docker-compose.hostinger.yml
  -f infra/hostinger/docker-compose.hostinger.resource-limits.yml
  -f infra/hostinger/docker-compose.hostinger.resource-limits.pool.yml
  -f infra/hostinger/docker-compose.hostinger.resource-limits.pgbouncer.yml
  -f infra/hostinger/docker-compose.hostinger.async-workers.yml
  -f infra/hostinger/docker-compose.hostinger.backend-pool.yml
  -f infra/hostinger/docker-compose.hostinger.gateway-lb.yml
  -f infra/hostinger/docker-compose.hostinger.pgbouncer.yml
  -f infra/hostinger/docker-compose.hostinger.pgbouncer.pool.yml
  -f infra/hostinger/docker-compose.hostinger.postgres-tuning.yml
)

"${COMPOSE[@]}" config -q
"${COMPOSE[@]}" up -d --build owlcognito-frontend backend backend-2 backend-3 backend-4 gateway
"${COMPOSE[@]}" ps owlcognito-frontend backend backend-2 backend-3 backend-4 gateway
curl -fsS http://127.0.0.1:3002/ >/dev/null
```

## Install Nginx And TLS

Install the HTTP bootstrap configuration first. It allows Certbot's ACME
challenge but deliberately does not serve the application before TLS exists.

```bash
set -euo pipefail
cd /opt/alsyed/StreamX

DOMAIN=$(grep '^OWLCOGNITO_DOMAIN=' backend/.env.hostinger.production | cut -d= -f2-)
PORT=$(grep '^OWLCOGNITO_FRONTEND_PORT=' backend/.env.hostinger.production | cut -d= -f2-)
test -n "$DOMAIN"
test -n "$PORT"

sudo sed \
  -e "s|__OWLCOGNITO_DOMAIN__|$DOMAIN|g" \
  infra/hostinger/nginx/owlcognito.bootstrap.conf.template \
  | sudo tee /etc/nginx/sites-available/owlcognito >/dev/null
sudo ln -sfn /etc/nginx/sites-available/owlcognito /etc/nginx/sites-enabled/owlcognito
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d "$DOMAIN"

sudo sed \
  -e "s|__OWLCOGNITO_DOMAIN__|$DOMAIN|g" \
  -e "s|__OWLCOGNITO_FRONTEND_PORT__|$PORT|g" \
  infra/hostinger/nginx/owlcognito.conf.template \
  | sudo tee /etc/nginx/sites-available/owlcognito >/dev/null
sudo nginx -t
sudo systemctl reload nginx
```

## Verify

```bash
set -euo pipefail
cd /opt/alsyed/StreamX
DOMAIN=$(grep '^OWLCOGNITO_DOMAIN=' backend/.env.hostinger.production | cut -d= -f2-)

curl -fsSI --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/"
curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health/live"
curl -fsS https://"$DOMAIN"/health/live
docker inspect streamx-owlcognito-frontend-1 --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
```

Browser validation must include login, logout, a course catalog request, an
authorized course launch, a payment checkout creation, and a live-class page.
The OwlCognito frontend shares accounts and entitlements with the original
platform by design.
