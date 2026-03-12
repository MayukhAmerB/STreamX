# StreamX Network Hardening (WireGuard + Firewall + Rate Limits)

This folder contains optional hardening scripts for production VPS setup.

These scripts are **not** auto-run by deployment to avoid breaking live traffic.

## 1) WireGuard private ingress for OBS

Use this when instructors should push OBS RTMP over private VPN instead of open internet.

Run on server:

```bash
sudo bash infra/hostinger/network/setup-wireguard.sh \
  --peer-name instructor-1 \
  --peer-public-key "<instructor-public-key>" \
  --peer-ip 10.66.66.2/32
```

Server defaults:

- Interface: `wg0`
- VPN subnet: `10.66.66.0/24`
- Server VPN IP: `10.66.66.1/24`
- UDP port: `51820`

## 2) Firewall baseline (UFW)

Run on server:

```bash
sudo bash infra/hostinger/network/setup-firewall.sh
```

Default behavior:

- `deny incoming`, `allow outgoing`
- allow SSH (rate-limited), 80/443
- allow LiveKit ports (`7880/tcp`, `7881/tcp`, `7882/udp`)
- allow RTMP `1935/tcp` from WireGuard subnet only

If you intentionally want public RTMP:

```bash
sudo RTMP_PUBLIC=1 bash infra/hostinger/network/setup-firewall.sh
```

## 3) Nginx API rate limiting

Run on server:

```bash
sudo bash infra/hostinger/network/setup-nginx-rate-limits.sh
```

This installs:

- `/etc/nginx/conf.d/99-streamx-rate-zones.conf`
- `/etc/nginx/snippets/streamx_api_rate_limit.conf`

Then it patches `api.alsyedinitiative.com` server block to include the rate-limit snippet under `/api/`.

## 4) OBS bind recommendations

In `backend/.env.hostinger.production`:

```env
OWNCAST_HTTP_BIND_ADDRESS=127.0.0.1
OWNCAST_RTMP_BIND_ADDRESS=10.66.66.1
OWNCAST_OBS_STREAM_SERVER_URL=rtmp://10.66.66.1:1935/live
```

Then recreate app stack.
