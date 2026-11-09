"""Prometheus-backed dashboard sections: servers/API and live streaming.

Time series are hourly ([1h] windows evaluated every hour over the selected
range, capped at 30 days) and KPIs always describe the last hour. If any query
of a section fails, that section comes back with available=False and a short
reason; the rest of the dashboard is unaffected.
"""

import logging
import re
from dataclasses import dataclass
from datetime import timedelta

from .metrics import (
    BUCKET_HOUR,
    delta_pct,
    floor_to_local_hour,
    fold_ranked,
    hourly_starts,
    kpi,
    number,
    ranked_chart,
    section,
    timeseries_chart,
)
from .prometheus import REASON_BAD_RESPONSE, RANGE_STEP_SECONDS, InstantQuery, RangeQuery

logger = logging.getLogger(__name__)

MAX_RANGE_HOURS = 30 * 24
INFRA_PREFIX = "infra."
STREAM_PREFIX = "stream."

INFRA_NOTE = "Hourly averages from Prometheus. Figures show the last hour."
STREAM_NOTE = "Hourly figures from Prometheus. Figures show the last hour."

CPU_EXPR = '100 - avg(rate(node_cpu_seconds_total{job="node_exporter",mode="idle"}[1h])) * 100'
MEMORY_EXPR = (
    "avg(avg_over_time(((1 - node_memory_MemAvailable_bytes{job=\"node_exporter\"}"
    " / node_memory_MemTotal_bytes{job=\"node_exporter\"}) * 100)[1h:1m]))"
)
REQUESTS_EXPR = "sum(rate(streamx_http_requests_total[1h]))"
ERROR_RATE_EXPR = (
    '(sum(rate(streamx_http_requests_total{status_code=~"5.."}[1h])) or vector(0))'
    " / sum(rate(streamx_http_requests_total[1h])) * 100"
)
P95_EXPR = "histogram_quantile(0.95, sum(rate(streamx_http_request_latency_seconds_bucket[1h])) by (le)) * 1000"
BACKENDS_UP_EXPR = 'sum(up{job="streamx_backend"})'
BACKENDS_TOTAL_EXPR = 'count(up{job="streamx_backend"})'
AVAILABILITY_EXPR = "streamx:sli:http_availability:ratio_rate30d * 100"
CONTAINER_CPU_EXPR = 'sum by (name) (rate(container_cpu_usage_seconds_total{name=~"streamx-.+"}[1h]))'

OWNCAST_CPU_EXPR = 'sum(rate(container_cpu_usage_seconds_total{name="streamx-owncast-1"}[1h]))'
JOINS_EXPR = "sum by (result) (increase(streamx_realtime_join_total[1h]))"
DISCONNECTS_EXPR = 'sum(increase(streamx_realtime_connection_events_total{event="disconnected"}[1h]))'
DISCONNECTS_PREV_EXPR = (
    'sum(increase(streamx_realtime_connection_events_total{event="disconnected"}[1h] offset 1h))'
)
LIVEKIT_UP_EXPR = 'max(up{job="livekit"})'

_CONTAINER_PREFIX = "streamx-"
_CONTAINER_SUFFIX_RE = re.compile(r"-\d+$")


@dataclass(frozen=True)
class HourlyWindow:
    buckets: tuple  # aware local datetimes, start of each completed hour

    @property
    def eval_timestamps(self):
        # A [1h] window evaluated at bucket start + 1h covers exactly that bucket.
        return [int(bucket.timestamp()) + RANGE_STEP_SECONDS for bucket in self.buckets]

    @property
    def bucket_labels(self):
        return [bucket.isoformat() for bucket in self.buckets]


def build_hourly_window(range_hours, now):
    hours = max(1, min(int(range_hours), MAX_RANGE_HOURS))
    last_complete = floor_to_local_hour(now) - timedelta(hours=1)
    return HourlyWindow(buckets=hourly_starts(last_complete - timedelta(hours=hours - 1), hours))


def _range(expr, window):
    stamps = window.eval_timestamps
    return RangeQuery(expr=expr, start=stamps[0], end=stamps[-1], step=RANGE_STEP_SECONDS)


def queries_for(window):
    """All Prometheus queries the dashboard needs, keyed by section prefix."""
    return {
        "infra.cpu": InstantQuery(CPU_EXPR),
        "infra.memory": InstantQuery(MEMORY_EXPR),
        "infra.requests": InstantQuery(REQUESTS_EXPR),
        "infra.error_rate": InstantQuery(ERROR_RATE_EXPR),
        "infra.p95": InstantQuery(P95_EXPR),
        "infra.backends_up": InstantQuery(BACKENDS_UP_EXPR),
        "infra.backends_total": InstantQuery(BACKENDS_TOTAL_EXPR),
        "infra.availability": InstantQuery(AVAILABILITY_EXPR),
        "infra.containers": InstantQuery(CONTAINER_CPU_EXPR),
        "infra.cpu_range": _range(CPU_EXPR, window),
        "infra.memory_range": _range(MEMORY_EXPR, window),
        "infra.requests_range": _range(REQUESTS_EXPR, window),
        "infra.error_rate_range": _range(ERROR_RATE_EXPR, window),
        "infra.p95_range": _range(P95_EXPR, window),
        "stream.owncast_cpu": InstantQuery(OWNCAST_CPU_EXPR),
        "stream.joins": InstantQuery(JOINS_EXPR),
        "stream.disconnects": InstantQuery(DISCONNECTS_EXPR),
        "stream.disconnects_prev": InstantQuery(DISCONNECTS_PREV_EXPR),
        "stream.livekit_up": InstantQuery(LIVEKIT_UP_EXPR),
        "stream.joins_range": _range(JOINS_EXPR, window),
        "stream.disconnects_range": _range(DISCONNECTS_EXPR, window),
        "stream.owncast_cpu_range": _range(OWNCAST_CPU_EXPR, window),
    }


# ---------------------------------------------------------------------------
# Result shaping.
# ---------------------------------------------------------------------------


def _scalar(samples, digits=2):
    values = [sample.value for sample in samples or [] if sample.value is not None]
    return number(values[0], digits) if values else None


def _values(series_list, window, digits=2, match=None):
    """Align range results to the window's buckets; sum matching series, None where missing."""
    selected = [series for series in series_list or [] if match is None or match(series.labels)]
    values = []
    for stamp in window.eval_timestamps:
        points = [series.points.get(stamp) for series in selected]
        points = [point for point in points if point is not None]
        values.append(number(sum(points), digits) if points else None)
    return values


def _threshold_status(value, warning, critical):
    if value is None:
        return None, None
    if value > critical:
        return "critical", "Critical"
    if value > warning:
        return "warning", "Elevated"
    return "good", "Normal"


def _hourly_count_mark(window):
    """Columns read well up to two days of hours; beyond that a line is legible."""
    return "column" if len(window.bucket_labels) <= 48 else "line"


def container_label(name):
    label = name[len(_CONTAINER_PREFIX):] if name.startswith(_CONTAINER_PREFIX) else name
    return _CONTAINER_SUFFIX_RE.sub("", label) or name


def _is_success(labels):
    return labels.get("result") == "success"


def _is_failure(labels):
    return labels.get("result") != "success"


def _section_failure(results, errors, prefix):
    for key, reason in errors.items():
        if key.startswith(prefix):
            return reason
    return None


def infrastructure_section(results, errors, window):
    title = "Servers and API"
    description = "Host resources, API traffic and backend health."
    reason = _section_failure(results, errors, INFRA_PREFIX)
    if reason:
        return section("infrastructure", title, description, available=False, unavailable_reason=reason, note=INFRA_NOTE)
    try:
        return section(
            "infrastructure", title, description,
            kpis=_infrastructure_kpis(results, window),
            charts=_infrastructure_charts(results, window),
            note=INFRA_NOTE,
        )
    except Exception:  # noqa: BLE001 - shaping must never break the dashboard
        logger.exception("insights.infrastructure_section_failed")
        return section(
            "infrastructure", title, description,
            available=False, unavailable_reason=REASON_BAD_RESPONSE, note=INFRA_NOTE,
        )


def _infrastructure_kpis(results, window):
    cpu_trend = _values(results["infra.cpu_range"], window)
    memory_trend = _values(results["infra.memory_range"], window)
    requests_trend = _values(results["infra.requests_range"], window)
    error_trend = _values(results["infra.error_rate_range"], window)
    p95_trend = _values(results["infra.p95_range"], window, digits=0)

    cpu = _scalar(results["infra.cpu"])
    memory = _scalar(results["infra.memory"])
    error_rate = _scalar(results["infra.error_rate"])
    p95 = _scalar(results["infra.p95"], digits=0)
    availability = _scalar(results["infra.availability"], digits=3)

    backends_up = _scalar(results["infra.backends_up"], digits=0)
    backends_total = _scalar(results["infra.backends_total"], digits=0)
    if backends_total is None:
        backend_status, backend_label, backend_hint = None, None, "No backends reporting"
    elif (backends_up or 0) < backends_total:
        down = backends_total - (backends_up or 0)
        backend_status, backend_label, backend_hint = "critical", f"{down} down", f"of {backends_total}"
    else:
        backend_status, backend_label, backend_hint = "good", "All healthy", f"of {backends_total}"

    if availability is None:
        availability_status = (None, None)
    elif availability >= 99.9:
        availability_status = ("good", "Meeting target")
    elif availability >= 99.0:
        availability_status = ("warning", "Below target")
    else:
        availability_status = ("critical", "Well below target")

    return [
        kpi("host_cpu", "Host CPU", cpu, "percent", trend=cpu_trend, good_direction="down",
            **_status_kwargs(_threshold_status(cpu, 80, 90))),
        kpi("memory", "Memory used", memory, "percent", trend=memory_trend, good_direction="down",
            **_status_kwargs(_threshold_status(memory, 80, 90))),
        kpi("api_requests", "API requests per second", _scalar(results["infra.requests"]), "per_second",
            trend=requests_trend),
        kpi("error_rate", "5xx error rate", error_rate, "percent", trend=error_trend, good_direction="down",
            **_status_kwargs(_threshold_status(error_rate, 1, 5)),
            hint=None if error_rate is not None else "No API traffic in the last hour"),
        kpi("latency_p95", "p95 latency", p95, "ms", trend=p95_trend, good_direction="down",
            **_status_kwargs(_threshold_status(p95, 800, 2000))),
        kpi("healthy_backends", "Healthy backends", backends_up if backends_total is not None else None, "count",
            status=backend_status, status_label=backend_label, hint=backend_hint),
        kpi("availability_30d", "30-day availability", availability, "percent",
            status=availability_status[0], status_label=availability_status[1], hint="Target 99.9%"),
    ]


def _status_kwargs(status_pair):
    status, label = status_pair
    return {"status": status, "status_label": label}


def _infrastructure_charts(results, window):
    containers = fold_ranked(
        [
            (container_label(sample.labels.get("name", "")), sample.value)
            for sample in results["infra.containers"]
            if sample.value is not None
        ],
        digits=3,
    )
    common = {"bucket": BUCKET_HOUR, "buckets": window.bucket_labels}
    return [
        timeseries_chart(
            "cpu_memory", "CPU and memory", "Hourly average, host",
            mark="line", unit="percent", **common,
            series=[
                ("cpu", "CPU %", _values(results["infra.cpu_range"], window)),
                ("memory", "Memory %", _values(results["infra.memory_range"], window)),
            ],
            empty_message="No host metrics in this period.",
        ),
        timeseries_chart(
            "api_requests", "API requests per second", "Hourly average",
            mark="area", unit="per_second", **common,
            series=[("requests", "Requests per second", _values(results["infra.requests_range"], window))],
            empty_message="No API traffic in this period.",
        ),
        timeseries_chart(
            "latency_p95", "p95 latency", "Hourly, all API routes",
            mark="line", unit="ms", **common,
            series=[("p95", "p95 latency", _values(results["infra.p95_range"], window, digits=0))],
            empty_message="No latency data in this period.",
        ),
        timeseries_chart(
            "error_rate", "5xx error rate", "Hourly share of API responses",
            mark="line", unit="percent", **common,
            series=[("error_rate", "5xx error rate", _values(results["infra.error_rate_range"], window))],
            empty_message="No API traffic in this period.",
        ),
        ranked_chart(
            "container_cpu", "CPU by container, last hour", "Average cores used",
            unit="cores", items=containers, empty_message="No container metrics available.",
        ),
    ]


def streaming_section(results, errors, window):
    title = "Live streaming"
    description = "Owncast, LiveKit and realtime join health."
    reason = _section_failure(results, errors, STREAM_PREFIX)
    if reason:
        return section("streaming", title, description, available=False, unavailable_reason=reason, note=STREAM_NOTE)
    try:
        return _streaming_section(results, window, title, description)
    except Exception:  # noqa: BLE001 - shaping must never break the dashboard
        logger.exception("insights.streaming_section_failed")
        return section(
            "streaming", title, description,
            available=False, unavailable_reason=REASON_BAD_RESPONSE, note=STREAM_NOTE,
        )


def _join_success_pct(succeeded, failed):
    if succeeded is None and failed is None:
        return None
    attempts = (succeeded or 0) + (failed or 0)
    if attempts <= 0:
        return None
    return round((succeeded or 0) / attempts * 100, 1)


def _streaming_section(results, window, title, description):
    owncast_trend = _values(results["stream.owncast_cpu_range"], window, digits=3)
    succeeded_trend = _values(results["stream.joins_range"], window, digits=0, match=_is_success)
    failed_trend = _values(results["stream.joins_range"], window, digits=0, match=_is_failure)
    disconnect_trend = _values(results["stream.disconnects_range"], window, digits=0)

    join_samples = results["stream.joins"]
    succeeded = sum(s.value for s in join_samples if s.value is not None and _is_success(s.labels))
    failed = sum(s.value for s in join_samples if s.value is not None and _is_failure(s.labels))
    join_pct = _join_success_pct(succeeded, failed)
    join_trend = [_join_success_pct(ok, bad) for ok, bad in zip(succeeded_trend, failed_trend)]
    if join_pct is None:
        join_status = (None, None)
    elif join_pct < 80:
        join_status = ("critical", "Many joins failing")
    elif join_pct < 95:
        join_status = ("warning", "Some joins failing")
    else:
        join_status = ("good", "Normal")

    disconnects = _scalar(results["stream.disconnects"], digits=0)
    disconnects_prev = _scalar(results["stream.disconnects_prev"], digits=0)
    if disconnects is None and disconnects_prev is not None:
        disconnects = 0
    if disconnects_prev is None and disconnects is not None:
        disconnects_prev = 0
    livekit_up = _scalar(results["stream.livekit_up"], digits=0)
    if livekit_up is None:
        livekit_status = ("warning", "Not reporting")
    elif livekit_up >= 1:
        livekit_status = ("good", "Up")
    else:
        livekit_status = ("critical", "Down")

    common = {"bucket": BUCKET_HOUR, "buckets": window.bucket_labels}
    return section(
        "streaming", title, description,
        note=STREAM_NOTE,
        kpis=[
            kpi("owncast_cpu", "Owncast CPU", _scalar(results["stream.owncast_cpu"], digits=3), "cores",
                trend=owncast_trend),
            kpi("join_success", "Realtime join success", join_pct, "percent", trend=join_trend,
                good_direction="up", status=join_status[0], status_label=join_status[1],
                hint=None if join_pct is not None else "No joins in the last hour"),
            kpi("livekit_disconnects", "LiveKit disconnects", disconnects, "count",
                delta=delta_pct(disconnects, disconnects_prev), good_direction="down",
                period_label="vs previous hour", trend=disconnect_trend),
            kpi("livekit_health", "LiveKit health", livekit_up, "status",
                status=livekit_status[0], status_label=livekit_status[1]),
        ],
        charts=[
            timeseries_chart(
                "realtime_joins", "Realtime joins", "Per hour",
                mark=_hourly_count_mark(window), unit="count", **common,
                series=[("succeeded", "Succeeded", succeeded_trend), ("failed", "Failed", failed_trend)],
                empty_message="No realtime joins in this period.",
            ),
            timeseries_chart(
                "livekit_disconnects", "LiveKit disconnects", "Per hour",
                mark=_hourly_count_mark(window), unit="count", **common,
                series=[("disconnects", "Disconnects", disconnect_trend)],
                empty_message="No disconnects recorded in this period.",
            ),
            timeseries_chart(
                "owncast_cpu", "Owncast CPU", "Hourly average cores",
                mark="line", unit="cores", **common,
                series=[("owncast_cpu", "Owncast CPU", owncast_trend)],
                empty_message="No Owncast metrics in this period.",
            ),
        ],
    )
