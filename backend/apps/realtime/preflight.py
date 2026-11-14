"""Pre-class readiness probe (Phase 2).

At T-10 min before each weekly class (Fri-Sun 19:00 IST) the
``realtime.preclass_probe`` hook checks, with short timeouts:

* owncast        Owncast ``/api/status`` answers (ingest + HLS origin)
* livekit        the LiveKit HTTP port answers (``:7880``)
* egress         the egress health port answers (``LIVEKIT_EGRESS_HEALTH_URL``,
                 egress.yaml ``health_port`` 7981); skipped when unset
* recorder_disk  free space under the recorder work root
* clamav         clamd answers PING (report uploads)

The result is cached for the host: the Host Studio token response and
``GET /api/realtime/preflight/`` carry it, and the studio shows a warning
when anything is red. A red probe is logged at ERROR (alerting) and counted
in ``streamx_live_preflight_failures_total``.
"""

from __future__ import annotations

import logging
import socket
import time
from datetime import datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

logger = logging.getLogger("ops.realtime")

LATEST_KEY = "realtime:preflight:latest"
PROBE_LEAD = timedelta(minutes=10)
PROBE_TIMEOUT_SECONDS = 3
RESULT_TTL_SECONDS = 3 * 3600

try:  # pragma: no cover
    from prometheus_client import Counter

    PREFLIGHT_FAILURES_TOTAL = Counter(
        "streamx_live_preflight_failures_total",
        "Pre-class probe checks that failed.",
        labelnames=("check",),
    )
except Exception:  # noqa: BLE001
    PREFLIGHT_FAILURES_TOTAL = None


def probe_enabled() -> bool:
    return bool(getattr(settings, "REALTIME_PRECLASS_PROBE_ENABLED", True))


def _http_ok(url: str) -> tuple[bool, str]:
    try:
        with urlopen(Request(url, method="GET"), timeout=PROBE_TIMEOUT_SECONDS) as response:
            return 200 <= response.status < 500, f"HTTP {response.status}"
    except HTTPError as exc:
        # The port answered; 4xx still proves the service is up.
        return exc.code < 500, f"HTTP {exc.code}"
    except (URLError, OSError, ValueError) as exc:
        return False, str(getattr(exc, "reason", exc))[:200]


def check_owncast() -> dict:
    from .services import _get_owncast_status_base_candidates

    candidates = _get_owncast_status_base_candidates()
    if not candidates:
        return {"name": "owncast", "ok": None, "detail": "Owncast is not configured.", "skipped": True}
    ok, detail = _http_ok(f"{candidates[0]}/api/status")
    return {"name": "owncast", "ok": ok, "detail": detail}


def check_livekit() -> dict:
    from .services import _get_livekit_server_base_urls, is_livekit_configured

    if not is_livekit_configured():
        return {"name": "livekit", "ok": None, "detail": "LiveKit is not configured.", "skipped": True}
    bases = _get_livekit_server_base_urls()
    if not bases:
        return {"name": "livekit", "ok": False, "detail": "No LiveKit server URL."}
    ok, detail = _http_ok(f"{bases[0]}/")
    return {"name": "livekit", "ok": ok, "detail": detail}


def check_egress() -> dict:
    url = str(getattr(settings, "LIVEKIT_EGRESS_HEALTH_URL", "") or "").strip()
    if not url:
        return {"name": "egress", "ok": None, "detail": "LIVEKIT_EGRESS_HEALTH_URL is not set.", "skipped": True}
    ok, detail = _http_ok(url)
    return {"name": "egress", "ok": ok, "detail": detail}


def check_recorder_disk() -> dict:
    from .recording import config as recording_config
    from .recording.publisher import free_disk_bytes

    try:
        root = recording_config.work_root()
        needed = int(recording_config.min_free_bytes())
    except Exception as exc:  # noqa: BLE001
        return {"name": "recorder_disk", "ok": None, "detail": str(exc)[:200], "skipped": True}
    free = free_disk_bytes(root)
    if free is None:
        return {"name": "recorder_disk", "ok": None, "detail": f"{root} is not readable here.", "skipped": True}
    ok = free >= needed
    return {
        "name": "recorder_disk",
        "ok": ok,
        "detail": f"{free // (1024 ** 3)} GB free (needs {max(1, needed // (1024 ** 3))} GB).",
    }


def check_clamav() -> dict:
    host = str(getattr(settings, "CLAMD_HOST", "") or "").strip()
    port = int(getattr(settings, "CLAMD_PORT", 3310) or 3310)
    if not host:
        return {"name": "clamav", "ok": None, "detail": "ClamAV is not configured.", "skipped": True}
    try:
        with socket.create_connection((host, port), timeout=PROBE_TIMEOUT_SECONDS) as conn:
            conn.settimeout(PROBE_TIMEOUT_SECONDS)
            conn.sendall(b"zPING\0")
            reply = conn.recv(32)
    except OSError as exc:
        return {"name": "clamav", "ok": False, "detail": str(exc)[:200]}
    ok = reply.strip(b"\0").strip() == b"PONG"
    return {"name": "clamav", "ok": ok, "detail": "PONG" if ok else f"unexpected reply {reply[:16]!r}"}


CHECKS = (check_owncast, check_livekit, check_egress, check_recorder_disk, check_clamav)


def run_preflight(*, now=None, checks=None) -> dict:
    started = time.monotonic()
    results = []
    for check in checks if checks is not None else CHECKS:
        try:
            results.append(check())
        except Exception as exc:  # noqa: BLE001 - one broken check must not hide the others
            results.append({"name": getattr(check, "__name__", "check"), "ok": False, "detail": str(exc)[:200]})
    failed = [row["name"] for row in results if row.get("ok") is False]
    payload = {
        "checked_at": (now or timezone.now()).isoformat(),
        "ok": not failed,
        "failed": failed,
        "checks": results,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }
    try:
        cache.set(LATEST_KEY, payload, timeout=RESULT_TTL_SECONDS)
    except Exception:  # noqa: BLE001
        pass
    if failed:
        logger.error("live.preflight failed checks=%s", ",".join(failed))
        if PREFLIGHT_FAILURES_TOTAL is not None and getattr(settings, "METRICS_ENABLED", True):
            for name in failed:
                try:
                    PREFLIGHT_FAILURES_TOTAL.labels(check=name).inc()
                except Exception:  # noqa: BLE001
                    pass
    else:
        logger.info("live.preflight ok elapsed_ms=%s", payload["elapsed_ms"])
    return payload


def latest_preflight() -> dict | None:
    try:
        value = cache.get(LATEST_KEY)
    except Exception:  # noqa: BLE001
        return None
    return value if isinstance(value, dict) else None


def preclass_probe_due(now=None) -> str | None:
    """The class date (ISO) when ``now`` is inside the T-10..T-0 window, else None."""
    from .schedule import LIVE_CLASS_START_TIME, LIVE_CLASS_TIMEZONE, LIVE_CLASS_WEEKDAYS

    local = (now or timezone.now()).astimezone(LIVE_CLASS_TIMEZONE)
    if local.weekday() not in LIVE_CLASS_WEEKDAYS:
        return None
    start = datetime.combine(local.date(), LIVE_CLASS_START_TIME, tzinfo=LIVE_CLASS_TIMEZONE)
    if start - PROBE_LEAD <= local < start:
        return local.date().isoformat()
    return None


def schedule_preclass_probe(now=None) -> dict | None:
    """``realtime.preclass_probe`` (60 s): run once per class at T-10 min."""
    if not probe_enabled():
        return None
    class_date = preclass_probe_due(now)
    if not class_date:
        return None
    try:
        first = cache.add(f"realtime:preflight:done:{class_date}", 1, timeout=6 * 3600)
    except Exception:  # noqa: BLE001
        first = False
    if not first:
        return None
    return run_preflight(now=now)
