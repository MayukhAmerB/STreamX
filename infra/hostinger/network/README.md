# StreamX Network Hardening (WireGuard + Firewall + Rate Limits + Fail2ban)

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
- allow LiveKit ports (`7880/tcp`, `7881/tcp`, `7882/udp`, `443/udp`, `5349/tcp`)
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

## 4) Fail2ban

Fail2ban is free and open source. In this repo it is set up as an optional host-level hardening layer for:

- SSH brute-force attempts
- repeated failed auth hits on `/api/auth/login/`, password-reset routes, and Django admin login
- common opportunistic probe traffic like `wp-login.php`, `.env`, `xmlrpc.php`, `phpmyadmin`, and similar scans

Because the site is behind Cloudflare, install the real-client-IP nginx config first so fail2ban bans the attacker IP, not Cloudflare edge IPs.

Run on server:

```bash
sudo bash infra/hostinger/network/setup-fail2ban.sh
```

Safe behavior:

- does not touch Docker containers or app compose services
- uses UFW for `sshd` and an nginx denylist for proxied web traffic
- installs Cloudflare real-IP restore for host nginx
- installs a daily timer to refresh trusted Cloudflare proxy ranges
- creates custom jails under `/etc/fail2ban/jail.d/streamx.local`

Useful commands:

```bash
sudo fail2ban-client status
sudo fail2ban-client status sshd
sudo fail2ban-client status streamx-auth-abuse
sudo fail2ban-client status streamx-probe-abuse
sudo journalctl -u fail2ban --no-pager -n 100
```

If UFW is not active yet, either run the firewall baseline first or bootstrap it in one step:

```bash
sudo BOOTSTRAP_UFW=1 bash infra/hostinger/network/setup-fail2ban.sh
```

## 5) OBS bind recommendations

In `backend/.env.hostinger.production`:

```env
OWNCAST_HTTP_BIND_ADDRESS=127.0.0.1
OWNCAST_RTMP_BIND_ADDRESS=10.66.66.1
OWNCAST_OBS_STREAM_SERVER_URL=rtmp://10.66.66.1:1935/live
```

Then recreate app stack.
