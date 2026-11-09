"""Minimal server-side client for the Prometheus HTTP API.

Only the admin dashboard uses this, and only from the server: Prometheus stays
on the private Docker network and is never exposed to the browser. Every
failure is reduced to a short human reason so callers can mark a dashboard
section unavailable without leaking the Prometheus URL or a stack trace.
"""

import json
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from django.conf import settings

logger = logging.getLogger(__name__)

RANGE_STEP_SECONDS = 3600
MAX_WORKERS = 8
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

REASON_NOT_CONFIGURED = "Prometheus is not configured on this server."
REASON_UNREACHABLE = "Prometheus could not be reached."
REASON_TIMEOUT = "Prometheus did not respond in time."
REASON_HTTP_ERROR = "Prometheus returned an error."
REASON_BAD_RESPONSE = "Prometheus returned an unexpected response."


class PrometheusError(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Sample:
    labels: dict
    value: object  # float or None


@dataclass(frozen=True)
class Series:
    labels: dict
    points: dict = field(default_factory=dict)  # unix timestamp (int) -> float or None


@dataclass(frozen=True)
class InstantQuery:
    expr: str


@dataclass(frozen=True)
class RangeQuery:
    expr: str
    start: float
    end: float
    step: int = RANGE_STEP_SECONDS


def _to_float(raw):
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise PrometheusError(REASON_BAD_RESPONSE) from None
    return value if math.isfinite(value) else None


def _parse_labels(item):
    labels = item.get("metric") if isinstance(item, dict) else None
    return {str(k): str(v) for k, v in labels.items()} if isinstance(labels, dict) else {}


def _parse_pair(pair):
    if not isinstance(pair, (list, tuple)) or len(pair) != 2:
        raise PrometheusError(REASON_BAD_RESPONSE)
    try:
        timestamp = int(round(float(pair[0])))
    except (TypeError, ValueError):
        raise PrometheusError(REASON_BAD_RESPONSE) from None
    return timestamp, _to_float(pair[1])


def parse_instant(data):
    """Return a list of Sample from the `data` object of an instant query."""
    if not isinstance(data, dict):
        raise PrometheusError(REASON_BAD_RESPONSE)
    result_type = data.get("resultType")
    result = data.get("result")
    if result_type == "scalar":
        return [Sample(labels={}, value=_parse_pair(result)[1])]
    if result_type != "vector" or not isinstance(result, list):
        raise PrometheusError(REASON_BAD_RESPONSE)
    samples = []
    for item in result:
        if not isinstance(item, dict):
            raise PrometheusError(REASON_BAD_RESPONSE)
        samples.append(Sample(labels=_parse_labels(item), value=_parse_pair(item.get("value"))[1]))
    return samples


def parse_range(data):
    """Return a list of Series from the `data` object of a range query."""
    if not isinstance(data, dict) or data.get("resultType") != "matrix":
        raise PrometheusError(REASON_BAD_RESPONSE)
    result = data.get("result")
    if not isinstance(result, list):
        raise PrometheusError(REASON_BAD_RESPONSE)
    series = []
    for item in result:
        values = item.get("values") if isinstance(item, dict) else None
        if not isinstance(values, list):
            raise PrometheusError(REASON_BAD_RESPONSE)
        series.append(Series(labels=_parse_labels(item), points=dict(_parse_pair(pair) for pair in values)))
    return series


class PrometheusClient:
    def __init__(self, base_url=None, timeout=None):
        raw_url = settings.PROMETHEUS_URL if base_url is None else base_url
        self.base_url = str(raw_url or "").strip().rstrip("/")
        self.timeout = float(timeout if timeout is not None else settings.PROMETHEUS_TIMEOUT_SECONDS)

    @property
    def configured(self):
        return urlsplit(self.base_url).scheme in {"http", "https"}

    def _get(self, endpoint, params):
        if not self.configured:
            raise PrometheusError(REASON_NOT_CONFIGURED)
        request = Request(
            f"{self.base_url}/api/v1/{endpoint}?{urlencode(params)}",
            headers={"Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                body = response.read(_MAX_RESPONSE_BYTES + 1)
        except HTTPError:
            raise PrometheusError(REASON_HTTP_ERROR) from None
        except URLError as exc:
            reason = REASON_TIMEOUT if isinstance(exc.reason, TimeoutError) else REASON_UNREACHABLE
            raise PrometheusError(reason) from None
        except TimeoutError:
            raise PrometheusError(REASON_TIMEOUT) from None
        except (OSError, ValueError):
            raise PrometheusError(REASON_UNREACHABLE) from None
        if len(body) > _MAX_RESPONSE_BYTES:
            raise PrometheusError(REASON_BAD_RESPONSE)
        try:
            payload = json.loads(body)
        except ValueError:
            raise PrometheusError(REASON_BAD_RESPONSE) from None
        if not isinstance(payload, dict):
            raise PrometheusError(REASON_BAD_RESPONSE)
        if payload.get("status") != "success":
            raise PrometheusError(REASON_HTTP_ERROR)
        return payload.get("data")

    def query(self, expr, at=None):
        params = {"query": expr}
        if at is not None:
            params["time"] = f"{float(at):.3f}"
        return parse_instant(self._get("query", params))

    def query_range(self, expr, start, end, step=RANGE_STEP_SECONDS):
        params = {
            "query": expr,
            "start": f"{float(start):.3f}",
            "end": f"{float(end):.3f}",
            "step": str(int(step)),
        }
        return parse_range(self._get("query_range", params))

    def run(self, spec):
        if isinstance(spec, RangeQuery):
            return self.query_range(spec.expr, spec.start, spec.end, spec.step)
        return self.query(spec.expr)

    def run_many(self, queries):
        """Run {key: InstantQuery|RangeQuery} concurrently.

        Returns (results, errors): results maps key -> parsed result, errors maps
        key -> short human reason. Never raises for Prometheus failures.
        """
        if not queries:
            return {}, {}
        if not self.configured:
            return {}, {key: REASON_NOT_CONFIGURED for key in queries}

        executor = ThreadPoolExecutor(
            max_workers=min(MAX_WORKERS, len(queries)),
            thread_name_prefix="prometheus",
        )
        futures = {key: executor.submit(self.run, spec) for key, spec in queries.items()}
        # Waves of bounded workers can each take up to `timeout`; cap the total
        # wait so a slow Prometheus can never hold the admin request for long.
        deadline = time.monotonic() + self.timeout * 2
        done, _not_done = wait(list(futures.values()), timeout=max(0.0, deadline - time.monotonic()))
        executor.shutdown(wait=False, cancel_futures=True)

        results, errors = {}, {}
        for key, future in futures.items():
            if future not in done or future.cancelled():
                errors[key] = REASON_TIMEOUT
                continue
            exc = future.exception()
            if exc is None:
                results[key] = future.result()
            elif isinstance(exc, PrometheusError):
                errors[key] = exc.reason
            else:
                errors[key] = REASON_BAD_RESPONSE
        if errors:
            logger.warning(
                "prometheus.queries_failed failed=%s total=%s reasons=%s",
                len(errors),
                len(queries),
                sorted(set(errors.values())),
            )
        return results, errors
