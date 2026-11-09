#!/usr/bin/env bash
set -euo pipefail

WG_IFACE="${WG_IFACE:-wg0}"
WG_PORT="${WG_PORT:-51820}"
WG_NET="${WG_NET:-10.66.66.0/24}"
WG_SERVER_IP="${WG_SERVER_IP:-10.66.66.1/24}"
PUBLIC_NIC="${PUBLIC_NIC:-eth0}"
PEER_NAME=""
PEER_IP=""
PEER_PUBLIC_KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --peer-name)
      PEER_NAME="${2:-}"
      shift 2
      ;;
    --peer-ip)
      PEER_IP="${2:-}"
      shift 2
      ;;
    --peer-public-key)
      PEER_PUBLIC_KEY="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PEER_NAME" || -z "$PEER_IP" || -z "$PEER_PUBLIC_KEY" ]]; then
  cat >&2 <<'USAGE'
Usage:
  sudo bash infra/hostinger/network/setup-wireguard.sh \
    --peer-name <name> \
    --peer-ip <10.66.66.x/32> \
    --peer-public-key <base64-public-key>
USAGE
  exit 1
fi

apt-get update -y
apt-get install -y wireguard wireguard-tools qrencode

install -d -m 700 /etc/wireguard

SERVER_PRIVATE_KEY_FILE="/etc/wireguard/${WG_IFACE}_private.key"
SERVER_PUBLIC_KEY_FILE="/etc/wireguard/${WG_IFACE}_public.key"

if [[ ! -s "$SERVER_PRIVATE_KEY_FILE" ]]; then
  umask 077
  wg genkey | tee "$SERVER_PRIVATE_KEY_FILE" | wg pubkey > "$SERVER_PUBLIC_KEY_FILE"
fi

SERVER_PRIVATE_KEY="$(cat "$SERVER_PRIVATE_KEY_FILE")"
SERVER_PUBLIC_KEY="$(cat "$SERVER_PUBLIC_KEY_FILE")"

WG_CONF="/etc/wireguard/${WG_IFACE}.conf"
if [[ ! -f "$WG_CONF" ]]; then
  cat >"$WG_CONF" <<EOF
[Interface]
Address = ${WG_SERVER_IP}
ListenPort = ${WG_PORT}
PrivateKey = ${SERVER_PRIVATE_KEY}
SaveConfig = true
PostUp = iptables -A FORWARD -i ${WG_IFACE} -j ACCEPT; iptables -A FORWARD -o ${WG_IFACE} -j ACCEPT; iptables -t nat -A POSTROUTING -o ${PUBLIC_NIC} -j MASQUERADE
PostDown = iptables -D FORWARD -i ${WG_IFACE} -j ACCEPT; iptables -D FORWARD -o ${WG_IFACE} -j ACCEPT; iptables -t nat -D POSTROUTING -o ${PUBLIC_NIC} -j MASQUERADE
EOF
fi

if ! grep -q "### streamx-peer:${PEER_NAME}" "$WG_CONF"; then
  cat >>"$WG_CONF" <<EOF

### streamx-peer:${PEER_NAME}
[Peer]
PublicKey = ${PEER_PUBLIC_KEY}
AllowedIPs = ${PEER_IP}
EOF
fi

cat >/etc/sysctl.d/99-streamx-wireguard.conf <<EOF
net.ipv4.ip_forward=1
EOF
sysctl --system >/dev/null

systemctl enable --now "wg-quick@${WG_IFACE}"
systemctl restart "wg-quick@${WG_IFACE}"

cat <<EOF
WireGuard configured.
Interface: ${WG_IFACE}
Server public key: ${SERVER_PUBLIC_KEY}
Peer added: ${PEER_NAME} (${PEER_IP})

Set instructor OBS server URL to:
  rtmp://$(echo "${WG_SERVER_IP}" | cut -d/ -f1):1935/live
EOF
