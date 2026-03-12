import re
from typing import Tuple
import ipaddress

from django.conf import settings
from django.http import HttpResponse
from config.client_ip import resolve_client_ip

try:
    from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

    _PROMETHEUS_AVAILABLE = True
except Exception:  # noqa: BLE001
    CONTENT_TYPE_LATEST = "text/plain; version=0.0.4; charset=utf-8"
    Counter = None
    Histogram = None
    generate_latest = None
    _PROMETHEUS_AVAILABLE = False


_LABEL_SANITIZER_RE = re.compile(r"[^a-zA-Z0-9_:]+")


def _sanitize_label(value, fallback="unknown"):
    text = str(value or "").strip()
    if not text:
        return fallback
    sanitized = _LABEL_SANITIZER_RE.sub("_", text).strip("_").lower()
    return sanitized[:120] or fallback


def _request_route_label(request):
    resolver_match = getattr(request, "resolver_match", None)
    if resolver_match and getattr(resolver_match, "view_name", None):
        return _sanitize_label(resolver_match.view_name, fallback="unresolved")

    path = str(getattr(request, "path", "") or "").strip("/")
    if not path:
        return "root"
    segments = [segment for segment in path.split("/") if segment]
    trimmed = "/".join(segments[:3])
    return _sanitize_label(trimmed, fallback="path")


def _metrics_enabled():
    return bool(_PROMETHEUS_AVAILABLE and getattr(settings, "METRICS_ENABLED", True))


def _is_private_or_loopback_ip(ip_text):
    try:
        ip_obj = ipaddress.ip_address(str(ip_text or "").strip())
    except ValueError:
        return False
    return bool(ip_obj.is_private or ip_obj.is_loopback)


if _PROMETHEUS_AVAILABLE:
    HTTP_REQUEST_TOTAL = Counter(
        "streamx_http_requests_total",
        "Total HTTP requests handled by backend.",
        labelnames=("method", "route", "status_code"),
    )
    HTTP_REQUEST_LATENCY_SECONDS = Histogram(
        "streamx_http_request_latency_seconds",
        "HTTP request latency in seconds.",
        labelnames=("method", "route"),
        buckets=(0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0),
    )
    REALTIME_JOIN_TOTAL = Counter(
        "streamx_realtime_join_total",
        "Realtime join attempts by result/mode.",
        labelnames=("result", "mode", "reason"),
    )
    REALTIME_RECORDING_OP_TOTAL = Counter(
        "streamx_realtime_recording_operations_total",
        "Realtime recording operations by action/result.",
        labelnames=("action", "result", "reason"),
    )
    ASYNC_JOB_TOTAL = Counter(
        "streamx_async_jobs_total",
        "Asynchronous background job executions.",
        labelnames=("job", "result"),
    )
else:
    HTTP_REQUEST_TOTAL = None
    HTTP_REQUEST_LATENCY_SECONDS = None
    REALTIME_JOIN_TOTAL = None
    REALTIME_RECORDING_OP_TOTAL = None
    ASYNC_JOB_TOTAL = None


def observe_http_request(request, *, status_code, elapsed_ms):
    if not _metrics_enabled():
        return
    method = _sanitize_label(getattr(request, "method", "GET"), fallback="get")
    route = _request_route_label(request)
    status_label = _sanitize_label(status_code, fallback="000")
    elapsed_seconds = max(0.0, float(elapsed_ms or 0) / 1000.0)
    HTTP_REQUEST_TOTAL.labels(method=method, route=route, status_code=status_label).inc()
    HTTP_REQUEST_LATENCY_SECONDS.labels(method=method, route=route).observe(elapsed_seconds)


def record_realtime_join(*, result, mode, reason):
    if not _metrics_enabled():
        return
    REALTIME_JOIN_TOTAL.labels(
        result=_sanitize_label(result, fallback="unknown"),
        mode=_sanitize_label(mode, fallback="unknown"),
        reason=_sanitize_label(reason, fallback="unknown"),
    ).inc()


def record_realtime_recording_operation(*, action, result, reason):
    if not _metrics_enabled():
        return
    REALTIME_RECORDING_OP_TOTAL.labels(
        action=_sanitize_label(action, fallback="unknown"),
        result=_sanitize_label(result, fallback="unknown"),
        reason=_sanitize_label(reason, fallback="unknown"),
    ).inc()


def record_async_job_execution(*, job, result):
    if not _metrics_enabled():
        return
    ASYNC_JOB_TOTAL.labels(
        job=_sanitize_label(job, fallback="unknown"),
        result=_sanitize_label(result, fallback="unknown"),
    ).inc()


def get_metrics_authorization(request) -> Tuple[bool, str]:
    token = str(getattr(settings, "METRICS_AUTH_TOKEN", "") or "").strip()
    if not token:
        if bool(getattr(settings, "DEBUG", False)):
            return True, ""
        client_ip = resolve_client_ip(request)
        if _is_private_or_loopback_ip(client_ip):
            return True, ""
        return False, "Metrics token is required in production."

    provided = str(request.headers.get("X-Metrics-Token", "") or "").strip()
    if provided and provided == token:
        return True, ""

    auth_header = str(request.headers.get("Authorization", "") or "").strip()
    if auth_header.lower().startswith("bearer "):
        bearer_token = auth_header[7:].strip()
        if bearer_token and bearer_token == token:
            return True, ""

    return False, "Missing or invalid metrics token."


def build_metrics_response():
    if not _PROMETHEUS_AVAILABLE:
        return HttpResponse(
            "prometheus_client is not installed.\n",
            status=503,
            content_type="text/plain; charset=utf-8",
        )
    payload = generate_latest()
    return HttpResponse(payload, content_type=CONTENT_TYPE_LATEST)
