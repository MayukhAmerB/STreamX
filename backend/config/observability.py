import contextvars
from contextlib import ExitStack
import logging
import random
import re
import time
import uuid

from django.conf import settings
from django.db import connections

from config.metrics import observe_http_request


_request_id_ctx = contextvars.ContextVar("request_id", default="-")
_request_start_ns_ctx = contextvars.ContextVar("request_start_ns", default=0)
_request_id_safe_re = re.compile(r"^[A-Za-z0-9._-]{8,128}$")


def get_request_id():
    return _request_id_ctx.get()


class RequestIDLogFilter(logging.Filter):
    def filter(self, record):
        record.request_id = get_request_id()
        return True


class _DBQueryStats:
    def __init__(self, slow_query_ms):
        self.slow_query_ms = max(1, int(slow_query_ms))
        self.count = 0
        self.total_query_ms = 0.0
        self.max_query_ms = 0.0
        self.slow_query_count = 0

    def __call__(self, execute, sql, params, many, context):
        started_at = time.perf_counter()
        try:
            return execute(sql, params, many, context)
        finally:
            elapsed_ms = (time.perf_counter() - started_at) * 1000.0
            self.count += 1
            self.total_query_ms += elapsed_ms
            if elapsed_ms > self.max_query_ms:
                self.max_query_ms = elapsed_ms
            if elapsed_ms >= self.slow_query_ms:
                self.slow_query_count += 1


class PerformanceBudgetMiddleware:
    """
    Lightweight observability middleware for endpoint latency and SQL budget tracking.
    Logs warnings when budgets are breached; no response behavior is changed.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        self.logger = logging.getLogger("ops.performance")
        self.monitoring_enabled = bool(getattr(settings, "PERF_MONITORING_ENABLED", True))
        self.db_query_tracking_enabled = bool(
            getattr(settings, "PERF_DB_QUERY_TRACKING_ENABLED", True)
        )
        self.db_query_sample_rate = float(getattr(settings, "PERF_DB_QUERY_SAMPLE_RATE", 1.0))
        self.db_query_sample_rate = max(0.0, min(1.0, self.db_query_sample_rate))
        self.slow_query_ms = int(getattr(settings, "PERF_SLOW_QUERY_MS", 120))
        self.default_budget_ms = int(getattr(settings, "PERF_DEFAULT_ENDPOINT_BUDGET_MS", 800))
        self.warn_query_count = int(getattr(settings, "PERF_WARN_QUERY_COUNT", 30))
        self.warn_query_time_ms = int(getattr(settings, "PERF_WARN_QUERY_TIME_MS", 300))
        self.log_all_requests = bool(getattr(settings, "PERF_LOG_ALL_REQUESTS", False))
        self.response_time_header = bool(
            getattr(settings, "PERF_RESPONSE_TIME_HEADER_ENABLED", getattr(settings, "DEBUG", False))
        )
        raw_path_budgets = getattr(settings, "PERF_PATH_BUDGETS", {}) or {}
        if isinstance(raw_path_budgets, dict):
            # Match longer prefixes first for deterministic path-specific budget overrides.
            self.path_budgets = sorted(
                [
                    (str(path_prefix).strip() or "/", int(budget_ms))
                    for path_prefix, budget_ms in raw_path_budgets.items()
                ],
                key=lambda item: len(item[0]),
                reverse=True,
            )
        else:
            self.path_budgets = []

    def _resolve_budget_ms(self, request_path):
        for prefix, budget_ms in self.path_budgets:
            if request_path.startswith(prefix):
                return budget_ms
        return self.default_budget_ms

    def _should_track_db_queries(self, request_path):
        if not self.db_query_tracking_enabled:
            return False
        if request_path.startswith(("/health", "/healthz", "/readyz", "/static/", "/media/")):
            return False
        if self.db_query_sample_rate >= 1.0:
            return True
        return random.random() < self.db_query_sample_rate

    @staticmethod
    def _resolve_user_id(request):
        user = getattr(request, "user", None)
        if getattr(user, "is_authenticated", False):
            return getattr(user, "id", None)
        return None

    def __call__(self, request):
        if not self.monitoring_enabled:
            return self.get_response(request)

        started_at_ns = time.monotonic_ns()
        path = str(getattr(request, "path", "") or "")
        db_stats = _DBQueryStats(self.slow_query_ms) if self._should_track_db_queries(path) else None
        response = None
        status_code = 500

        try:
            if db_stats is None:
                response = self.get_response(request)
            else:
                with ExitStack() as stack:
                    for connection in connections.all():
                        stack.enter_context(connection.execute_wrapper(db_stats))
                    response = self.get_response(request)
            status_code = int(getattr(response, "status_code", 200))
            return response
        finally:
            elapsed_ms = int((time.monotonic_ns() - started_at_ns) / 1_000_000)
            budget_ms = self._resolve_budget_ms(path)

            total_query_ms = int(db_stats.total_query_ms) if db_stats is not None else None
            max_query_ms = int(db_stats.max_query_ms) if db_stats is not None else None
            query_count = db_stats.count if db_stats is not None else None
            slow_query_count = db_stats.slow_query_count if db_stats is not None else None

            budget_exceeded = elapsed_ms > budget_ms
            query_budget_warning = bool(
                db_stats is not None
                and (
                    db_stats.count > self.warn_query_count
                    or db_stats.total_query_ms > self.warn_query_time_ms
                    or db_stats.slow_query_count > 0
                )
            )

            if self.log_all_requests or budget_exceeded or query_budget_warning:
                payload = {
                    "event": "request.profile",
                    "request_id": getattr(request, "request_id", None),
                    "method": getattr(request, "method", ""),
                    "path": path,
                    "status_code": status_code,
                    "latency_ms": elapsed_ms,
                    "latency_budget_ms": budget_ms,
                    "latency_budget_exceeded": budget_exceeded,
                    "query_count": query_count,
                    "query_time_ms": total_query_ms,
                    "max_query_ms": max_query_ms,
                    "slow_query_count": slow_query_count,
                    "user_id": self._resolve_user_id(request),
                }
                if budget_exceeded or query_budget_warning:
                    self.logger.warning("PERF_BUDGET %s", payload)
                else:
                    self.logger.info("PERF_REQUEST %s", payload)

            if response is not None and self.response_time_header:
                response["X-Response-Time-Ms"] = str(elapsed_ms)

            observe_http_request(request, status_code=status_code, elapsed_ms=elapsed_ms)


class RequestContextMiddleware:
    """
    Adds request correlation ID for traceability in logs and responses.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    @staticmethod
    def _resolve_request_id(request):
        incoming = (request.META.get("HTTP_X_REQUEST_ID", "") or "").strip()
        if incoming and _request_id_safe_re.match(incoming):
            return incoming
        return uuid.uuid4().hex

    def __call__(self, request):
        request_id = self._resolve_request_id(request)
        token_id = _request_id_ctx.set(request_id)
        token_start = _request_start_ns_ctx.set(time.monotonic_ns())
        request.request_id = request_id

        try:
            response = self.get_response(request)
        finally:
            _request_start_ns_ctx.reset(token_start)
            _request_id_ctx.reset(token_id)

        response["X-Request-ID"] = request_id
        return response
