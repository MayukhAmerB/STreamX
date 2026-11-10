"""Resilient outbound HTTP over the standard library (``urllib``).

Why: every upstream call (Owncast, LiveKit, Razorpay, Prometheus, webhooks)
needs the same four things, and ad-hoc ``urlopen`` calls tend to forget one:

1. a mandatory timeout (no call may block a gunicorn thread forever),
2. a total deadline across retries,
3. retries with exponential backoff + FULL jitter, only for idempotent
   requests (GET/HEAD/OPTIONS/PUT/DELETE, or a POST the caller explicitly marks
   idempotent because it carries an Idempotency-Key the upstream honours),
4. a per-upstream circuit breaker shared across workers (``apps.core.circuit``).

Usage::

    from apps.core.http import HttpClient

    owncast = HttpClient("owncast", base_url=settings.OWNCAST_ADMIN_API_BASE_URL, timeout=3)
    status = owncast.get("/api/status").json()

    razorpay = HttpClient("razorpay", base_url="https://api.razorpay.com/v1",
                          timeout=settings.RAZORPAY_HTTP_TIMEOUT_SECONDS,
                          auth=(key_id, key_secret))
    razorpay.post("/orders", json=payload)                       # never retried
    razorpay.post("/orders", json=payload, idempotent=True,       # retried: the
                  headers={"X-Idempotency-Key": key})            # upstream dedupes

Errors are ``apps.core.errors.UpstreamUnavailable`` subclasses, so a view that
lets them propagate answers 503 with ``errors.code`` = ``upstream_timeout`` /
``upstream_error`` / ``circuit_open`` and a ``Retry-After`` header.
4xx answers raise ``UpstreamHTTPError`` (status kept) and never trip the breaker.
"""

from __future__ import annotations

import base64
import json as jsonlib
import logging
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any

from config.metrics import record_upstream_request
from django.conf import settings

from .circuit import CircuitBreaker, CircuitOpenError, get_breaker
from .errors import UpstreamUnavailable

logger = logging.getLogger("apps.core.http")

IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"})
DEFAULT_RETRY_STATUSES = frozenset({502, 503, 504})
MAX_TIMEOUT_SECONDS = 120.0


class UpstreamError(UpstreamUnavailable):
    code = "upstream_error"


class UpstreamTimeout(UpstreamError):
    code = "upstream_timeout"
    default_message = "A required service did not respond in time. Please try again shortly."


class UpstreamConnectionError(UpstreamError):
    code = "upstream_unreachable"


class UpstreamHTTPError(UpstreamError):
    """Non-2xx answer. ``status_code``/``body`` describe the upstream reply.

    The *client-facing* status stays 503 for 5xx; for 4xx (our request was
    wrong) it is 502 so callers that let it propagate don't blame the client.
    """

    code = "upstream_bad_response"

    def __init__(self, message=None, *, status_code: int, body: bytes = b"", headers=None, **kwargs):
        super().__init__(message or f"Upstream answered HTTP {status_code}.", **kwargs)
        self.status_code = int(status_code)
        self.body = body or b""
        self.response_headers = dict(headers or {})
        if 400 <= self.status_code < 500:
            self.status = 502


__all__ = [
    "HttpClient",
    "HttpResponse",
    "UpstreamError",
    "UpstreamTimeout",
    "UpstreamConnectionError",
    "UpstreamHTTPError",
    "CircuitOpenError",
    "backoff_delay",
]


@dataclass
class HttpResponse:
    status_code: int
    headers: dict[str, str]
    content: bytes
    url: str
    elapsed: float = 0.0
    attempts: int = 1

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")

    def json(self) -> Any:
        if not self.content:
            return None
        return jsonlib.loads(self.content.decode("utf-8"))


def backoff_delay(attempt: int, *, base: float, cap: float, rng: Callable[[float, float], float] = random.uniform) -> float:
    """AWS "full jitter": uniform(0, min(cap, base * 2**attempt)).

    ``attempt`` is 0 for the first retry. Full jitter spreads synchronized
    retries (a whole class reconnecting at once) instead of moving the spike.
    """
    ceiling = min(float(cap), float(base) * (2 ** max(0, int(attempt))))
    return rng(0.0, max(0.0, ceiling))


def _retry_after_seconds(headers: Mapping[str, str]) -> float | None:
    raw = None
    for key, value in headers.items():
        if key.lower() == "retry-after":
            raw = value
            break
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        pass
    try:
        return max(0.0, parsedate_to_datetime(raw).timestamp() - time.time())
    except (TypeError, ValueError, IndexError):
        return None


def _is_timeout(exc: BaseException) -> bool:
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return True
    reason = getattr(exc, "reason", None)
    return isinstance(reason, (socket.timeout, TimeoutError))


@dataclass
class HttpClient:
    """Per-upstream client. Cheap to construct; holds no sockets."""

    name: str
    base_url: str = ""
    timeout: float | None = None
    max_retries: int = 2
    backoff_base: float = 0.2
    backoff_cap: float = 2.0
    deadline: float | None = None
    retry_statuses: Iterable[int] = DEFAULT_RETRY_STATUSES
    default_headers: Mapping[str, str] = field(default_factory=dict)
    auth: tuple[str, str] | None = None
    use_breaker: bool = True
    # Injection points for tests.
    opener: Callable[..., Any] | None = None
    sleep: Callable[[float], None] = time.sleep
    rng: Callable[[float, float], float] = random.uniform
    clock: Callable[[], float] = time.monotonic

    def __post_init__(self):
        if not self.name or not str(self.name).strip():
            raise ValueError("HttpClient requires an upstream name (used for metrics and the circuit breaker).")
        if self.timeout is None:
            self.timeout = float(getattr(settings, "OUTBOUND_HTTP_DEFAULT_TIMEOUT_SECONDS", 5))
        self.timeout = self._validate_timeout(self.timeout)
        self.retry_statuses = frozenset(int(code) for code in self.retry_statuses)
        self.max_retries = max(0, int(self.max_retries))

    @staticmethod
    def _validate_timeout(value) -> float:
        try:
            timeout = float(value)
        except (TypeError, ValueError):
            raise ValueError("A numeric timeout is mandatory for outbound HTTP calls.") from None
        if not (0 < timeout <= MAX_TIMEOUT_SECONDS):
            raise ValueError(f"Outbound HTTP timeout must be in (0, {MAX_TIMEOUT_SECONDS}] seconds; got {value!r}.")
        return timeout

    @property
    def breaker(self) -> CircuitBreaker:
        return get_breaker(self.name)

    # -- convenience verbs ---------------------------------------------------

    def get(self, url: str, **kwargs) -> HttpResponse:
        return self.request("GET", url, **kwargs)

    def head(self, url: str, **kwargs) -> HttpResponse:
        return self.request("HEAD", url, **kwargs)

    def post(self, url: str, **kwargs) -> HttpResponse:
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs) -> HttpResponse:
        return self.request("PUT", url, **kwargs)

    def patch(self, url: str, **kwargs) -> HttpResponse:
        return self.request("PATCH", url, **kwargs)

    def delete(self, url: str, **kwargs) -> HttpResponse:
        return self.request("DELETE", url, **kwargs)

    # -- core -----------------------------------------------------------------

    def _build_url(self, url: str, params: Mapping[str, Any] | None) -> str:
        if self.base_url and not urllib.parse.urlsplit(url).scheme:
            url = f"{self.base_url.rstrip('/')}/{url.lstrip('/')}"
        if params:
            separator = "&" if urllib.parse.urlsplit(url).query else "?"
            url = f"{url}{separator}{urllib.parse.urlencode(params, doseq=True)}"
        scheme = urllib.parse.urlsplit(url).scheme
        if scheme not in {"http", "https"}:
            raise ValueError(f"Only http(s) URLs are allowed for outbound calls; got {url!r}.")
        return url

    def _build_request(self, method, url, *, json, data, headers) -> urllib.request.Request:
        merged = {"Accept": "application/json", "User-Agent": "streamx-backend/1"}
        merged.update(self.default_headers or {})
        merged.update(headers or {})
        body = None
        if json is not None:
            body = jsonlib.dumps(json, separators=(",", ":"), default=str).encode("utf-8")
            merged.setdefault("Content-Type", "application/json")
        elif data is not None:
            if isinstance(data, Mapping):
                body = urllib.parse.urlencode(data, doseq=True).encode("utf-8")
                merged.setdefault("Content-Type", "application/x-www-form-urlencoded")
            elif isinstance(data, str):
                body = data.encode("utf-8")
            else:
                body = bytes(data)
        if self.auth:
            token = base64.b64encode(f"{self.auth[0]}:{self.auth[1]}".encode()).decode("ascii")
            merged["Authorization"] = f"Basic {token}"
        return urllib.request.Request(url, data=body, headers=merged, method=method)

    def _open(self, request: urllib.request.Request, timeout: float):
        if self.opener is not None:
            return self.opener(request, timeout=timeout)
        return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 - scheme validated above

    def _attempt(self, request: urllib.request.Request, timeout: float) -> HttpResponse:
        started = time.monotonic()
        try:
            with self._open(request, timeout) as raw:
                content = raw.read()
                status_code = int(getattr(raw, "status", None) or raw.getcode())
                headers = dict(raw.headers.items()) if getattr(raw, "headers", None) is not None else {}
        except urllib.error.HTTPError as exc:
            try:
                content = exc.read() or b""
            except Exception:  # noqa: BLE001
                content = b""
            headers = dict(exc.headers.items()) if exc.headers is not None else {}
            return HttpResponse(exc.code, headers, content, request.full_url, time.monotonic() - started)
        return HttpResponse(status_code, headers, content, request.full_url, time.monotonic() - started)

    def request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        data: Any = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
        deadline: float | None = None,
        idempotent: bool | None = None,
        max_retries: int | None = None,
        raise_for_status: bool = True,
    ) -> HttpResponse:
        method = str(method or "GET").upper()
        attempt_timeout = self._validate_timeout(timeout if timeout is not None else self.timeout)
        is_idempotent = (method in IDEMPOTENT_METHODS) if idempotent is None else bool(idempotent)
        retries = (self.max_retries if max_retries is None else max(0, int(max_retries))) if is_idempotent else 0
        total_budget = deadline if deadline is not None else self.deadline
        if total_budget is None:
            total_budget = attempt_timeout * (retries + 1) + self.backoff_cap * retries
        started = self.clock()
        full_url = self._build_url(url, params)

        last_error: UpstreamError | None = None
        for attempt in range(retries + 1):
            remaining = total_budget - (self.clock() - started)
            if remaining <= 0:
                break
            permit = self.breaker.allow() if self.use_breaker else None
            request = self._build_request(method, full_url, json=json, data=data, headers=headers)
            per_try_timeout = max(0.05, min(attempt_timeout, remaining))
            try:
                response = self._attempt(request, per_try_timeout)
            except Exception as exc:  # noqa: BLE001 - network layer
                if permit is not None:
                    permit.failure()
                outcome = "timeout" if _is_timeout(exc) else "connection_error"
                record_upstream_request(upstream=self.name, method=method, outcome=outcome)
                error_class = UpstreamTimeout if outcome == "timeout" else UpstreamConnectionError
                last_error = error_class(upstream=self.name)
                last_error.__cause__ = exc
                logger.warning(
                    "upstream %s %s %s attempt %s/%s failed: %s",
                    self.name, method, _redact(full_url), attempt + 1, retries + 1, outcome,
                )
                retry_after = None
            else:
                response.attempts = attempt + 1
                record_upstream_request(
                    upstream=self.name,
                    method=method,
                    outcome=str(response.status_code // 100) + "xx",
                    elapsed_seconds=response.elapsed,
                )
                if response.status_code >= 500 or response.status_code == 429:
                    if permit is not None and response.status_code >= 500:
                        permit.failure()
                    elif permit is not None:
                        permit.release()  # 429 = upstream alive but busy
                    retry_after = _retry_after_seconds(response.headers)
                    last_error = UpstreamHTTPError(
                        upstream=self.name,
                        status_code=response.status_code,
                        body=response.content[:2048],
                        headers=response.headers,
                        retry_after=retry_after,
                    )
                    if response.status_code not in self.retry_statuses and response.status_code != 429:
                        break
                else:
                    if permit is not None:
                        # A 4xx means the upstream is healthy and we asked badly.
                        permit.success()
                    if raise_for_status and not response.ok and response.status_code >= 400:
                        raise UpstreamHTTPError(
                            upstream=self.name,
                            status_code=response.status_code,
                            body=response.content[:2048],
                            headers=response.headers,
                        )
                    return response

            if attempt >= retries:
                break
            delay = backoff_delay(attempt, base=self.backoff_base, cap=self.backoff_cap, rng=self.rng)
            if retry_after is not None:
                delay = max(delay, min(retry_after, self.backoff_cap))
            if self.clock() - started + delay >= total_budget:
                break
            self.sleep(delay)

        if last_error is None:
            last_error = UpstreamTimeout(upstream=self.name)
        if not raise_for_status and isinstance(last_error, UpstreamHTTPError):
            return HttpResponse(
                last_error.status_code, last_error.response_headers, last_error.body, full_url, attempts=retries + 1
            )
        raise last_error


def _redact(url: str) -> str:
    """Drop query strings and credentials from URLs before logging them."""
    parts = urllib.parse.urlsplit(url)
    netloc = parts.hostname or ""
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, "", ""))
