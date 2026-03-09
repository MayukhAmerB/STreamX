import time

from django.conf import settings
from django.core.cache import caches
from django.core.files.storage import default_storage
from django.db import connections
from django.http import JsonResponse
from django.utils import timezone

from config.metrics import build_metrics_response, get_metrics_authorization


def _check_database():
    connection = connections["default"]
    connection.ensure_connection()
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
        row = cursor.fetchone()
    if not row or row[0] != 1:
        raise RuntimeError("Database probe returned unexpected value.")


def _check_cache():
    cache = caches["default"]
    probe_key = f"health:probe:{int(time.time())}"
    cache.set(probe_key, "ok", timeout=5)
    value = cache.get(probe_key)
    cache.delete(probe_key)
    if value != "ok":
        raise RuntimeError("Cache probe set/get failed.")


def _check_storage():
    # Listing root is a low-impact permissions/read probe for configured storage backend.
    default_storage.listdir("")


def liveness_view(request):
    payload = {
        "status": "ok",
        "service": "backend",
        "app_env": getattr(settings, "APP_ENV", "unknown"),
        "time": timezone.now().isoformat(),
    }
    return JsonResponse(payload, status=200)


def readiness_view(request):
    started_at = time.monotonic()
    checks = {}
    failures = {}

    try:
        _check_database()
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001
        failures["database"] = str(exc)

    should_check_cache = bool(getattr(settings, "REDIS_URL", ""))
    if should_check_cache:
        try:
            _check_cache()
            checks["cache"] = "ok"
        except Exception as exc:  # noqa: BLE001
            failures["cache"] = str(exc)
    else:
        checks["cache"] = "skipped"

    try:
        _check_storage()
        checks["storage"] = "ok"
    except Exception as exc:  # noqa: BLE001
        failures["storage"] = str(exc)

    elapsed_ms = int((time.monotonic() - started_at) * 1000)
    status_code = 200 if not failures else 503
    payload = {
        "status": "ok" if status_code == 200 else "degraded",
        "service": "backend",
        "app_env": getattr(settings, "APP_ENV", "unknown"),
        "checks": checks,
        "failures": failures or None,
        "elapsed_ms": elapsed_ms,
        "time": timezone.now().isoformat(),
    }
    return JsonResponse(payload, status=status_code)


def metrics_view(request):
    allowed, detail = get_metrics_authorization(request)
    if not allowed:
        return JsonResponse(
            {
                "status": "forbidden",
                "detail": detail,
            },
            status=403,
        )
    return build_metrics_response()
