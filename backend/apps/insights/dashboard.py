"""Assembles the admin dashboard payload and caches it per range."""

import logging
from concurrent.futures import ThreadPoolExecutor

from django.core.cache import cache
from django.utils import timezone

from . import infrastructure, metrics
from .prometheus import PrometheusClient

logger = logging.getLogger(__name__)

CACHE_TIMEOUT_SECONDS = 60
CACHE_KEY_PREFIX = "insights:dashboard:v1:"


def build_dashboard(range_key, now=None):
    now = now or timezone.now()
    window = metrics.build_window(range_key, now)
    hourly_window = infrastructure.build_hourly_window(window.spec.hours, now)

    # Prometheus is queried on worker threads while the database aggregations
    # run here; neither side waits on the other.
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="prometheus-batch") as executor:
        prometheus_batch = executor.submit(
            PrometheusClient().run_many, infrastructure.queries_for(hourly_window)
        )
        app_sections = [
            metrics.business_section(window),
            metrics.learning_section(window),
            metrics.outreach_section(window),
        ]
        results, errors = prometheus_batch.result()

    return {
        "range": window.spec.key,
        "range_label": window.spec.label,
        "generated_at": now.isoformat(),
        "sections": [
            *app_sections,
            infrastructure.infrastructure_section(results, errors, hourly_window),
            infrastructure.streaming_section(results, errors, hourly_window),
        ],
    }


def cache_key(range_key):
    return f"{CACHE_KEY_PREFIX}{range_key}"


def get_dashboard(range_key):
    key = cache_key(range_key)
    try:
        cached = cache.get(key)
    except Exception:  # noqa: BLE001 - a cache outage must not break the dashboard
        logger.warning("insights.cache_read_failed", exc_info=True)
        cached = None
    if cached is not None:
        return cached

    payload = build_dashboard(range_key)
    try:
        cache.set(key, payload, CACHE_TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001
        logger.warning("insights.cache_write_failed", exc_info=True)
    return payload
