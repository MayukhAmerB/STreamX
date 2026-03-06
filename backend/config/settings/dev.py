from .base import *  # noqa
import socket
from urllib.parse import urlparse

DEBUG = True
APP_ENV = "development"
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"]

_primary_lan_ip = ""
_probe_socket = None
try:
    _probe_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    _probe_socket.connect(("8.8.8.8", 80))
    _primary_lan_ip = (_probe_socket.getsockname()[0] or "").strip()
except OSError:
    _primary_lan_ip = ""
finally:
    if _probe_socket:
        _probe_socket.close()

_lan_ips = []
try:
    _lan_ips = socket.gethostbyname_ex(socket.gethostname())[2]
except OSError:
    _lan_ips = []
_lan_ips = [ip for ip in _lan_ips if ip and not ip.startswith("127.") and ip != "0.0.0.0"]
if _primary_lan_ip and _primary_lan_ip not in _lan_ips:
    _lan_ips = [_primary_lan_ip, *_lan_ips]
elif _primary_lan_ip and _primary_lan_ip in _lan_ips:
    _lan_ips = [_primary_lan_ip, *[ip for ip in _lan_ips if ip != _primary_lan_ip]]
ALLOWED_HOSTS = list(dict.fromkeys([*ALLOWED_HOSTS, *_lan_ips]))

# Development cookies and TLS settings
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
CSRF_COOKIE_HTTPONLY = False
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
TRUST_X_FORWARDED_FOR = False

# Vite dev ports can shift when one is occupied (5173 -> 5174/5175...).
_dev_frontend_ports = [5173, 5174, 5175, 5176, 5177, 5178]
_dev_frontend_hosts = ["localhost", "127.0.0.1", *_lan_ips]
_dev_frontend_origins = [
    f"http://{host}:{port}" for host in _dev_frontend_hosts for port in _dev_frontend_ports
]
CORS_ALLOWED_ORIGINS = list(dict.fromkeys([*CORS_ALLOWED_ORIGINS, *_dev_frontend_origins]))
CSRF_TRUSTED_ORIGINS = list(dict.fromkeys([*CSRF_TRUSTED_ORIGINS, *_dev_frontend_origins]))


def _replace_localhost_host(url, host, default_scheme, default_port):
    raw = str(url or "").strip()
    parsed = urlparse(raw)
    scheme = parsed.scheme or default_scheme
    netloc = parsed.netloc or parsed.path
    current_host = netloc.split(":", 1)[0] if netloc else ""
    current_port = netloc.split(":", 1)[1] if ":" in netloc else str(default_port)
    if current_host in {"", "localhost", "127.0.0.1", "0.0.0.0"}:
        return f"{scheme}://{host}:{current_port}"
    return raw

# Realtime dev defaults so Host Studio works without a local backend/.env.
if not LIVEKIT_URL:
    LIVEKIT_URL = "ws://localhost:7880"
if not LIVEKIT_API_KEY:
    LIVEKIT_API_KEY = "devkey"
if not LIVEKIT_API_SECRET:
    LIVEKIT_API_SECRET = "secret"
if not OWNCAST_BASE_URL:
    OWNCAST_BASE_URL = "http://127.0.0.1:8080"
if not OWNCAST_RTMP_TARGET:
    # Egress publishes from Docker, so use the Owncast service hostname.
    OWNCAST_RTMP_TARGET = "rtmp://owncast:1935/live/alsyedacademydevstream"

# In local network testing, always prefer LAN links over localhost for shareable URLs.
if _lan_ips:
    _selected_lan_ip = _lan_ips[0]
    FRONTEND_URL = _replace_localhost_host(FRONTEND_URL, _selected_lan_ip, "http", 5173)
    if not LIVEKIT_PUBLIC_URL:
        LIVEKIT_PUBLIC_URL = _replace_localhost_host(LIVEKIT_URL, _selected_lan_ip, "ws", 7880)
    if not OWNCAST_STREAM_PUBLIC_BASE_URL:
        OWNCAST_STREAM_PUBLIC_BASE_URL = _replace_localhost_host(
            OWNCAST_BASE_URL,
            _selected_lan_ip,
            "http",
            8080,
        )
    if not OWNCAST_CHAT_PUBLIC_BASE_URL:
        OWNCAST_CHAT_PUBLIC_BASE_URL = _replace_localhost_host(
            OWNCAST_BASE_URL,
            _selected_lan_ip,
            "http",
            8080,
        )

# Keep MEDIA_PUBLIC_BASE_URL empty in local dev so API returns same-origin /media URLs.
# Frontend Vite proxies /media -> backend, which avoids LAN-interface mismatches.
