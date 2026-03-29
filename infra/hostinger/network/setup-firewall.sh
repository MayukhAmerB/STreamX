#!/usr/bin/env bash
set -euo pipefail

SSH_PORT="${SSH_PORT:-22}"
WG_SUBNET="${WG_SUBNET:-10.66.66.0/24}"
RTMP_PUBLIC="${RTMP_PUBLIC:-0}"
LIVEKIT_UDP_PORT="${LIVEKIT_UDP_PORT:-7882}"
LIVEKIT_TURN_UDP_PORT="${LIVEKIT_TURN_UDP_PORT:-443}"
LIVEKIT_TURN_TLS_PORT="${LIVEKIT_TURN_TLS_PORT:-5349}"

apt-get update -y
apt-get install -y ufw

ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# SSH (rate-limited)
ufw limit "${SSH_PORT}/tcp"

# Web ingress
ufw allow 80/tcp
ufw allow 443/tcp

# LiveKit ports (meeting traffic)
ufw allow 7880/tcp
ufw allow 7881/tcp
ufw allow "${LIVEKIT_UDP_PORT}/udp"
ufw allow "${LIVEKIT_TURN_UDP_PORT}/udp"
ufw allow "${LIVEKIT_TURN_TLS_PORT}/tcp"

# WireGuard transport
ufw allow 51820/udp

# OBS RTMP ingest
if [[ "${RTMP_PUBLIC}" == "1" ]]; then
  ufw allow 1935/tcp
else
  ufw allow from "${WG_SUBNET}" to any port 1935 proto tcp
fi

ufw --force enable
ufw status verbose
