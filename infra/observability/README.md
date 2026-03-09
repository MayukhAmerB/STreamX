# StreamX Observability (Phase 1)

This stack adds:

- Sentry error reporting (backend)
- Prometheus metrics scraping
- Grafana dashboards for API latency, join failures, and recording failures
- Uptime alert probe via systemd timer

## 1) Backend environment variables

Add these to `backend/.env.hostinger.production` (or your production env source):

```env
METRICS_ENABLED=1
METRICS_AUTH_TOKEN=
SENTRY_DSN=
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.05
SENTRY_SEND_PII=0
```

If `METRICS_AUTH_TOKEN` is set, call `/metrics` with either:

- `X-Metrics-Token: <token>`
- `Authorization: Bearer <token>`

## 2) Start Prometheus + Grafana (optional stack)

From repo root:

```bash
docker compose \
  -f infra/observability/docker-compose.observability.yml \
  up -d
```

URLs (host-local):

- Prometheus: `http://127.0.0.1:9090`
- Grafana: `http://127.0.0.1:3001`

Default dashboard is auto-provisioned:

- `StreamX API + Realtime Overview`

## 3) Enable uptime alerts

Install timer units:

```bash
cp infra/hostinger/systemd/hostinger-uptime-alert.service /etc/systemd/system/
cp infra/hostinger/systemd/hostinger-uptime-alert.timer /etc/systemd/system/
chmod +x infra/hostinger/uptime-alert.sh
systemctl daemon-reload
systemctl enable --now hostinger-uptime-alert.timer
systemctl status hostinger-uptime-alert.timer
```

Optional webhook integration:

```bash
export UPTIME_ALERT_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

You can also set:

- `UPTIME_ALERT_BACKEND_URL`
- `UPTIME_ALERT_FRONTEND_URL`
- `UPTIME_ALERT_BACKEND_HOST_HEADER`
- `UPTIME_ALERT_REPEAT_EVERY`
