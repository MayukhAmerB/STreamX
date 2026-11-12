"""Liveness and readiness probes.

* Liveness (``/health/live``, ``/healthz``): the process can serve a request.
  No I/O at all, so a slow database never gets healthy containers restarted
  by Docker's healthcheck or pulled out of the gateway pool.
* Readiness (``/health/ready``, ``/readyz``): this replica can do useful work.
  Hard checks (any failure -> HTTP 503): database, cache (when Redis is
  configured), media storage listing, migrations applied, free disk on
  MEDIA_ROOT. Soft checks never fail readiness: low-disk warning, the
  circuit-breaker state of upstreams (Owncast, LiveKit, Razorpay...), read
  from the cache only, and the ``HEALTH_SOFT_PROBES`` (e.g. a 1 s, memoised
  clamd PING): a dependency restart shows as a warning, never as a 503.

The readiness result is memoised per process for
``HEALTH_READINESS_CACHE_SECONDS`` (default 3s) behind a lock, so a burst of
probes (uptime checks + smoke tests + load balancers) costs one round of I/O
per worker process instead of one per request.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
import time
from pathlib import Path

from django.conf import settings
from django.core.cache import caches
from django.core.files.storage import default_storage
from django.db import DEFAULT_DB_ALIAS, connections
from django.utils import timezone
from django.utils.module_loading import import_string

from .circuit import breaker_states

logger = logging.getLogger("apps.core.health")

_cache_lock = threading.Lock()
_cached_result: tuple[float, int, dict] | None = None
_migrations_verified_at: float | None = None
MIGRATIONS_RECHECK_SECONDS = 300


def _public_error(exc: BaseException) -> str:
    """Detailed text locally; class name only in production (no hosts/SQL)."""
    if getattr(settings, "DEBUG", False):
        return str(exc) or type(exc).__name__
    return type(exc).__name__


def check_database() -> None:
    connection = connections[DEFAULT_DB_ALIAS]
    connection.ensure_connection()
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
        row = cursor.fetchone()
    if not row or row[0] != 1:
        raise RuntimeError("Database probe returned unexpected value.")


def check_cache() -> None:
    cache = caches["default"]
    probe_key = f"health:probe:{os.getpid()}:{threading.get_ident()}"
    cache.set(probe_key, "ok", timeout=5)
    value = cache.get(probe_key)
    cache.delete(probe_key)
    if value != "ok":
        raise RuntimeError("Cache probe set/get failed.")


def check_storage() -> None:
    # Listing root is a low-impact permissions/read probe for the storage backend.
    default_storage.listdir("")


def check_migrations() -> None:
    """Fail while the database lags behind the code's migrations.

    Loading the migration graph costs ~100ms, so once verified it is only
    re-checked every MIGRATIONS_RECHECK_SECONDS.
    """
    global _migrations_verified_at
    now = time.monotonic()
    if _migrations_verified_at is not None and now - _migrations_verified_at < MIGRATIONS_RECHECK_SECONDS:
        return
    from django.db.migrations.executor import MigrationExecutor

    connection = connections[DEFAULT_DB_ALIAS]
    executor = MigrationExecutor(connection)
    targets = executor.loader.graph.leaf_nodes()
    plan = executor.migration_plan(targets)
    if plan:
        pending = sorted({f"{migration.app_label}.{migration.name}" for migration, _backwards in plan})
        raise RuntimeError(f"{len(pending)} unapplied migration(s): {', '.join(pending[:5])}")
    _migrations_verified_at = now


def media_disk_status() -> tuple[str, dict]:
    """("ok"|"warn"|"fail"|"skipped", details) for free space on MEDIA_ROOT."""
    media_root = Path(str(getattr(settings, "MEDIA_ROOT", "") or ""))
    if not str(media_root) or not media_root.exists():
        return "skipped", {"reason": "MEDIA_ROOT does not exist"}
    usage = shutil.disk_usage(media_root)
    min_free = int(getattr(settings, "HEALTH_MEDIA_MIN_FREE_BYTES", 512 * 1024 * 1024))
    warn_free = int(getattr(settings, "HEALTH_MEDIA_WARN_FREE_BYTES", 5 * 1024 * 1024 * 1024))
    details = {
        "free_bytes": usage.free,
        "total_bytes": usage.total,
        "free_percent": round(usage.free * 100.0 / usage.total, 1) if usage.total else None,
    }
    if usage.free < min_free:
        return "fail", details
    if usage.free < warn_free:
        return "warn", details
    return "ok", details


def _run_hard_check(name, func, checks, failures):
    try:
        func()
    except Exception as exc:  # noqa: BLE001
        failures[name] = _public_error(exc)
        logger.warning("readiness check %s failed: %s", name, exc)
    else:
        checks[name] = "ok"


def compute_readiness() -> tuple[int, dict]:
    started_at = time.monotonic()
    checks: dict[str, str] = {}
    failures: dict[str, str] = {}
    warnings: dict[str, object] = {}

    _run_hard_check("database", check_database, checks, failures)
    if bool(getattr(settings, "REDIS_URL", "")):
        _run_hard_check("cache", check_cache, checks, failures)
    else:
        checks["cache"] = "skipped"
    _run_hard_check("storage", check_storage, checks, failures)
    if "database" in failures:
        checks["migrations"] = "skipped"
    else:
        _run_hard_check("migrations", check_migrations, checks, failures)

    try:
        disk_state, disk_details = media_disk_status()
    except Exception as exc:  # noqa: BLE001
        disk_state, disk_details = "warn", {"error": _public_error(exc)}
    if disk_state == "fail":
        failures["media_disk"] = "Free space on MEDIA_ROOT is below HEALTH_MEDIA_MIN_FREE_BYTES."
    else:
        checks["media_disk"] = disk_state if disk_state != "warn" else "ok"
        if disk_state == "warn":
            warnings["media_disk"] = "Free space on MEDIA_ROOT is below HEALTH_MEDIA_WARN_FREE_BYTES."

    try:
        upstreams = breaker_states()
    except Exception:  # noqa: BLE001
        upstreams = {}
    degraded_upstreams = sorted(name for name, state in upstreams.items() if state.get("state") != "closed")
    if degraded_upstreams:
        warnings["upstreams"] = f"Circuit not closed for: {', '.join(degraded_upstreams)}"
    for name, probe_state in run_soft_probes().items():
        upstreams[name] = {**dict(upstreams.get(name) or {}), **probe_state}
        if probe_state.get("probe") not in ("ok", "off"):
            warnings[name] = f"{name} is {probe_state.get('probe')}"

    status_code = 200 if not failures else 503
    payload = {
        "status": "ok" if status_code == 200 else "degraded",
        "service": "backend",
        "app_env": getattr(settings, "APP_ENV", "unknown"),
        "checks": checks,
        "failures": failures or None,
        "warnings": warnings or None,
        # Byte counts only locally; the public endpoint reports a percentage.
        "disk": disk_details if getattr(settings, "DEBUG", False) else {
            "free_percent": disk_details.get("free_percent")
        },
        "upstreams": upstreams,
        "elapsed_ms": int((time.monotonic() - started_at) * 1000),
        "time": timezone.now().isoformat(),
        "cached": False,
    }
    return status_code, payload


def run_soft_probes() -> dict[str, dict]:
    """``HEALTH_SOFT_PROBES``: {name: dotted callable -> (state, details)}."""
    results = {}
    for name, dotted in dict(getattr(settings, "HEALTH_SOFT_PROBES", {}) or {}).items():
        try:
            state, details = import_string(dotted)()
        except Exception as exc:  # noqa: BLE001 - a soft probe never breaks readiness
            logger.warning("soft readiness probe %s failed: %s", name, exc)
            state, details = "error", {"error": _public_error(exc)}
        results[name] = {"probe": str(state), **dict(details or {})}
    return results


def readiness(*, use_cache: bool = True) -> tuple[int, dict]:
    """Memoised readiness. Concurrent callers wait for the in-flight probe."""
    global _cached_result
    ttl = float(getattr(settings, "HEALTH_READINESS_CACHE_SECONDS", 3))
    if use_cache and ttl > 0:
        cached = _cached_result
        if cached is not None and time.monotonic() - cached[0] < ttl:
            return cached[1], {**cached[2], "cached": True}
    with _cache_lock:
        cached = _cached_result
        if use_cache and ttl > 0 and cached is not None and time.monotonic() - cached[0] < ttl:
            return cached[1], {**cached[2], "cached": True}
        status_code, payload = compute_readiness()
        _cached_result = (time.monotonic(), status_code, payload)
        return status_code, payload


def reset_readiness_cache() -> None:
    """Test helper: forget memoised readiness and migration verification."""
    global _cached_result, _migrations_verified_at
    with _cache_lock:
        _cached_result = None
        _migrations_verified_at = None


def liveness() -> dict:
    return {
        "status": "ok",
        "service": "backend",
        "app_env": getattr(settings, "APP_ENV", "unknown"),
        "time": timezone.now().isoformat(),
    }
