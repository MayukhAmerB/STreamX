"""Settings for the local end-to-end stack (``e2e/stack.mjs``). Never production.

Loaded only with ``DJANGO_SETTINGS_MODULE=config.settings.e2e`` AND ``E2E=1``.
It extends the development settings and points every external service at the
local stubs the stack starts (Owncast, LiveKit, clamd, YouTube fixture). It
adds the ``apps.e2e_support`` app (seed command, control API, test clock,
fake ffmpeg runner) and the ``/api/__e2e__/`` routes through its own URLconf,
so ``config/urls.py`` and every production code path stay untouched.

Everything here is a configuration value the production code already reads;
nothing in ``apps/`` checks for E2E.
"""

import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

if os.environ.get("E2E", "").strip() != "1":
    raise ImproperlyConfigured("config.settings.e2e requires E2E=1 (local end-to-end stack only).")
if os.environ.get("APP_ENV", "").strip().lower() in {"prod", "production"}:
    raise ImproperlyConfigured("config.settings.e2e must never run with APP_ENV=production.")

_DATA_DIR = Path(os.environ.get("E2E_DATA_DIR", "") or (Path(__file__).resolve().parents[2] / ".e2e-data")).resolve()


def _port(name, default):
    return int(os.environ.get(name, "") or default)


E2E_PORTS = {
    "django": _port("E2E_DJANGO_PORT", 18000),
    "gateway": _port("E2E_GATEWAY_PORT", 18080),
    "web": _port("E2E_WEB_PORT", 4273),
    "labs": _port("E2E_LABS_PORT", 8092),
    "owncast": _port("E2E_OWNCAST_PORT", 18081),
    "livekit": _port("E2E_LIVEKIT_PORT", 18082),
    "clamd": _port("E2E_CLAMD_PORT", 13310),
}
_WEB_ORIGIN = f"http://localhost:{E2E_PORTS['web']}"
_LABS_ORIGIN = f"http://localhost:{E2E_PORTS['labs']}"
_OWNCAST = f"http://localhost:{E2E_PORTS['owncast']}"
_LIVEKIT = f"http://localhost:{E2E_PORTS['livekit']}"
# Server-to-server calls use the IPv4 literal: on Windows "localhost" tries ::1
# first and a refused connect costs ~2 s per call.
_OWNCAST_INTERNAL = f"http://127.0.0.1:{E2E_PORTS['owncast']}"
_LIVEKIT_INTERNAL = f"http://127.0.0.1:{E2E_PORTS['livekit']}"

# base.py reads these from the environment while it is evaluated.
_ENV_DEFAULTS = {
    "DEBUG": "1",
    "APP_ENV": "development",
    "REPORTS_PRIVATE_ROOT": str(_DATA_DIR / "private_media"),
    "REPORTS_QUARANTINE_ROOT": str(_DATA_DIR / "private_quarantine"),
    "RECORDING_UPLOAD_STAGING_ROOT": str(_DATA_DIR / "private_media" / ".recording-uploads"),
    # ffprobe/ffmpeg of the resumable upload worker: a fake that checks the
    # container signature and stream-copies bytes (no binary runs).
    "RECORDING_UPLOAD_MEDIA_RUNNER": "apps.e2e_support.fakes.FakeUploadMediaRunner",
    # Free space is not what the journeys test (the dev disk may be full-ish).
    "RECORDING_UPLOAD_MIN_FREE_BYTES": "0",
    "RECORDING_UPLOAD_WAIT_POLL_SECONDS": "1",
    "REPORTS_ANTIVIRUS_SCANNER": "clamd",
    "CLAMD_HOST": "127.0.0.1",
    "CLAMD_PORT": str(E2E_PORTS["clamd"]),
    "CLAMD_CONNECT_TIMEOUT_SECONDS": "2",
    "CLAMD_TIMEOUT_SECONDS": "10",
    "REPORTS_MIN_FREE_BYTES": "0",
    "LIVE_RECONCILER_MODE": "enforce",
    "RECORDING_AUTO_ALL_BROADCASTS": "1",
    # Owner decision: meetings are never auto-recorded (broadcasts only).
    "RECORDING_AUTO_MEETINGS": "0",
    "RECORDING_INSTANT_PUBLISH": "1",
    "RECORDING_CANARY_ENABLED": "0",
    "RECORDING_IMPORT_SCAN_INTERVAL_SECONDS": "0",
    "REALTIME_PRECLASS_PROBE_ENABLED": "0",
    "REALTIME_AUTO_RESOURCE_PROFILE": "0",
    # Shortened grace periods (E2E only): the journeys advance the test clock
    # past them instead of waiting.
    "REALTIME_ABANDONED_END_MINUTES": "2",
    "REALTIME_OWNCAST_OFFLINE_GRACE_SECONDS": "20",
    "REALTIME_HOST_GRACE_SECONDS": "20",
    "STREAM_RECORDER_HLS_FILTER": "0",
    "STREAM_RECORDER_MIN_FREE_BYTES": "0",
    "STREAM_RECORDER_FINALIZE_SPACE_FACTOR": "1.0",
    "STREAM_RECORDER_NICE": "0",
    "STREAM_RECORDER_SOURCE_URL": f"{_OWNCAST_INTERNAL}/hls/stream.m3u8",
    "STREAM_RECORDER_WORK_DIR": str(_DATA_DIR / "recordings" / "class-recordings"),
    "LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT": str(_DATA_DIR / "recordings"),
    "LIVEKIT_URL": _LIVEKIT.replace("http://", "ws://"),
    "LIVEKIT_SERVER_URL": _LIVEKIT_INTERNAL,
    "LIVEKIT_PUBLIC_URL": _LIVEKIT.replace("http://", "ws://"),
    "LIVEKIT_API_KEY": "e2e-key",
    "LIVEKIT_API_SECRET": "e2e-secret-e2e-secret-e2e-secret-0001",
    "LIVEKIT_EGRESS_TWIRP_TIMEOUT_SECONDS": "5",
    "OWNCAST_BASE_URL": _OWNCAST_INTERNAL,
    "OWNCAST_ADMIN_API_BASE_URL": _OWNCAST_INTERNAL,
    "OWNCAST_STREAM_PUBLIC_BASE_URL": _OWNCAST,
    "OWNCAST_CHAT_PUBLIC_BASE_URL": _OWNCAST,
    "OWNCAST_ADMIN_PASSWORD": "e2e-owncast-admin",
    "OWNCAST_STREAM_KEY": "e2e-stream-key",
    "OWNCAST_RTMP_TARGET": "rtmp://localhost:1935/live/e2e-stream-key",
    "OWNCAST_OBS_STREAM_SERVER_URL": "rtmp://localhost:1935/live",
    "CTF_ANSWER_PEPPER": "e2e-pepper-0123456789abcdef0123456789abcdef",
    "CTF_LABS_EXAM_URL": f"{_LABS_ORIGIN}/#exam",
    "CTF_SCHEDULER_ENABLED": "1",
    "REPORTS_SCHEDULER_ENABLED": "1",
    "YOUTUBE_LIVE_CHECK_ENABLED": "0",
    "TURNSTILE_ENABLED": "0",
    "EMAIL_BACKEND": "django.core.mail.backends.locmem.EmailBackend",
    "FRONTEND_URL": _WEB_ORIGIN,
    "DJANGO_SECRET_KEY": "e2e-only-secret-key-not-for-production-0123456789",
}
for _key, _value in _ENV_DEFAULTS.items():
    os.environ.setdefault(_key, _value)
# Always the stack's own SQLite file and the in-process cache: an inherited
# DATABASE_URL or REDIS_URL must never point the journeys at a real database.
os.environ["DATABASE_URL"] = "sqlite:///" + str(_DATA_DIR / "e2e.sqlite3").replace("\\", "/")
os.environ["REDIS_URL"] = ""

from .dev import *  # noqa: E402,F401,F403
from .dev import (  # noqa: E402
    CSRF_TRUSTED_ORIGINS,
    CORS_ALLOWED_ORIGINS,
    CTF_LABS_ORIGINS,
    DATABASES,
    INSTALLED_APPS,
    REST_FRAMEWORK,
)

E2E_ENABLED = True
E2E_DATA_DIR = str(_DATA_DIR)
E2E_FIXTURES_DIR = os.environ.get("E2E_FIXTURES_DIR", "").strip() or str(
    Path(__file__).resolve().parents[3] / "e2e" / "fixtures"
)
# Shared secret for the /api/__e2e__/ control API (set by the stack).
E2E_CONTROL_TOKEN = os.environ.get("E2E_CONTROL_TOKEN", "").strip() or "e2e-local-control"
# Optional initial test clock: an ISO instant ("2026-11-15T23:50:00+05:30").
E2E_FROZEN_NOW = os.environ.get("E2E_FROZEN_NOW", "").strip()
E2E_LIVEKIT_STUB_URL = _LIVEKIT
E2E_OWNCAST_STUB_URL = _OWNCAST

INSTALLED_APPS = [*INSTALLED_APPS, "apps.e2e_support.apps.E2ESupportConfig"]
ROOT_URLCONF = "config.e2e_urls"

# dev.py rewrites public URLs to the LAN IP; the stack is localhost only.
FRONTEND_URL = _WEB_ORIGIN
OWNCAST_STREAM_PUBLIC_BASE_URL = _OWNCAST
OWNCAST_CHAT_PUBLIC_BASE_URL = _OWNCAST
LIVEKIT_URL = os.environ["LIVEKIT_URL"]
LIVEKIT_PUBLIC_URL = os.environ["LIVEKIT_PUBLIC_URL"]
LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT = os.environ["LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT"]
ALLOWED_HOSTS = ["localhost", "127.0.0.1"]

MEDIA_ROOT = _DATA_DIR / "media"
# Behave like production behind nginx: protected files leave Django only as
# X-Accel-Redirect (the stack's gateway plays nginx, e2e/stubs/gateway.mjs).
COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT = True

_e2e_origins = [_WEB_ORIGIN, f"http://127.0.0.1:{E2E_PORTS['web']}", _LABS_ORIGIN]
CSRF_TRUSTED_ORIGINS = list(dict.fromkeys([*CSRF_TRUSTED_ORIGINS, *_e2e_origins]))
CORS_ALLOWED_ORIGINS = list(dict.fromkeys([*CORS_ALLOWED_ORIGINS, _WEB_ORIGIN]))
CTF_LABS_ORIGINS = list(dict.fromkeys([*CTF_LABS_ORIGINS, _LABS_ORIGIN]))

# SQLite under a threaded dev server: WAL + immediate transactions + a long
# busy timeout instead of "database is locked".
DATABASES["default"]["OPTIONS"] = {
    **DATABASES["default"].get("OPTIONS", {}),
    "timeout": 30,
    "transaction_mode": "IMMEDIATE",
    "init_command": "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
}
DATABASES["default"]["CONN_MAX_AGE"] = 0

# One browser makes every request from 127.0.0.1: keep the per-user and
# per-IP budgets out of the journeys' way (throttling itself is unit-tested).
REST_FRAMEWORK = {
    **REST_FRAMEWORK,
    "DEFAULT_THROTTLE_RATES": {key: "100000/hour" for key in REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})},
}

FFMPEG_BINARY = "e2e-fake-ffmpeg"
FFPROBE_BINARY = "e2e-fake-ffprobe"

# The test clock must be installed before any model module binds
# ``timezone.now``; apps.e2e_support.clock patches django.utils.timezone.now.
from apps.e2e_support import clock as _e2e_clock  # noqa: E402

_e2e_clock.install(initial=E2E_FROZEN_NOW)

# Engagement (apps.engagement) is ON by default in production; E2E pins it on explicitly.
FEATURE_DEFAULT_OVERRIDES = {**FEATURE_DEFAULT_OVERRIDES, "engagement": FEATURE_DEFAULT_OVERRIDES.get("engagement", True)}

# Student profiles (apps.profiles) are ON by default in production; E2E pins them on explicitly.
FEATURE_DEFAULT_OVERRIDES = {
    **FEATURE_DEFAULT_OVERRIDES,
    "public_profiles": FEATURE_DEFAULT_OVERRIDES.get("public_profiles", True),
}

# The Monthly CTF is ON by default in production; E2E pins it OFF so each spec
# opts in (monthly-ctf.spec.mjs sets it through the features fixture).
FEATURE_DEFAULT_OVERRIDES = {
    **FEATURE_DEFAULT_OVERRIDES,
    "monthly_ctf": FEATURE_DEFAULT_OVERRIDES.get("monthly_ctf", False),
}
