"""Prometheus gauges for class recordings and the lecture transcode queue.

Computed at scrape time from the database (a handful of small aggregate
queries), so every web replica reports the same truth and nothing has to be
pushed from the recorder or transcoder processes. Registered once on the
default registry (``register_collector``), which ``/metrics`` serves.

Series:
* ``streamx_class_recordings{state,source}``
* ``streamx_class_recording_oldest_age_seconds{state}`` (recording, finalizing, processing, failed)
* ``streamx_class_recordings_needs_review``
* ``streamx_lecture_streams{status}`` and ``streamx_lecture_transcode_exhausted``
* ``streamx_stream_recorder_last_tick_timestamp_seconds`` / ``streamx_transcoder_heartbeat_timestamp_seconds``
* ``streamx_recording_canary_last_success`` (1/0) and ``..._timestamp_seconds``
"""

import logging
import threading

from django.core.cache import cache
from django.db.models import Count, Min
from django.utils import timezone

logger = logging.getLogger("ops.realtime")
_registered = False
_lock = threading.Lock()
AGE_STATES = ("recording", "finalizing", "processing", "failed")


def _cache_float(key):
    try:
        value = cache.get(key)
    except Exception:
        return None
    if isinstance(value, dict):
        return value
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


class RecordingCollector:
    def describe(self):
        # Without describe() the registry would call collect() (database
        # queries) at registration time, i.e. during app start-up.
        return []

    def collect(self):
        try:
            from prometheus_client.core import GaugeMetricFamily
        except Exception:  # prometheus_client missing: nothing to export
            return
        try:
            yield from self._collect(GaugeMetricFamily)
        except Exception:  # a scrape must never fail because of the database
            logger.exception("RECORDING_METRICS_COLLECT_FAILED")

    def _collect(self, gauge):
        from apps.courses.models import Lecture
        from apps.courses.transcode_queue import HEARTBEAT_CACHE_KEY, max_attempts

        from .models import ClassRecording
        from .recorder import CANARY_RESULT_CACHE_KEY, LAST_TICK_CACHE_KEY

        counts = gauge("streamx_class_recordings", "Class recordings by state and source.", labels=["state", "source"])
        for row in ClassRecording.objects.values("state", "source").annotate(total=Count("id")):
            counts.add_metric([row["state"], row["source"]], row["total"])
        yield counts

        now = timezone.now()
        ages = gauge(
            "streamx_class_recording_oldest_age_seconds",
            "Age of the oldest class recording in each active or failed state (0 when none).",
            labels=["state"],
        )
        oldest = dict(
            ClassRecording.objects.filter(state__in=AGE_STATES)
            .values("state")
            .annotate(oldest=Min("updated_at"))
            .values_list("state", "oldest")
        )
        for state in AGE_STATES:
            value = oldest.get(state)
            ages.add_metric([state], max(0.0, (now - value).total_seconds()) if value else 0.0)
        yield ages

        review = gauge("streamx_class_recordings_needs_review", "Published class recordings an admin should review.")
        review.add_metric([], ClassRecording.objects.filter(needs_review=True).count())
        yield review

        streams = gauge("streamx_lecture_streams", "Lectures by HLS stream status.", labels=["status"])
        for row in Lecture.objects.values("stream_status").annotate(total=Count("id")):
            streams.add_metric([row["stream_status"]], row["total"])
        yield streams

        exhausted = gauge(
            "streamx_lecture_transcode_exhausted", "Lectures whose HLS transcode failed after every retry."
        )
        exhausted.add_metric(
            [],
            Lecture.objects.filter(stream_status=Lecture.STREAM_FAILED, stream_attempts__gte=max_attempts()).count(),
        )
        yield exhausted

        for name, key, help_text in (
            ("streamx_stream_recorder_last_tick_timestamp_seconds", LAST_TICK_CACHE_KEY,
             "Unix time of the stream recorder's last tick (leader)."),
            ("streamx_transcoder_heartbeat_timestamp_seconds", HEARTBEAT_CACHE_KEY,
             "Unix time of the transcoder's last loop."),
        ):
            value = _cache_float(key)
            if isinstance(value, float):
                metric = gauge(name, help_text)
                metric.add_metric([], value)
                yield metric

        canary = _cache_float(CANARY_RESULT_CACHE_KEY)
        if isinstance(canary, dict):
            ok = gauge("streamx_recording_canary_last_success", "1 when the last nightly recording canary passed.")
            ok.add_metric([], 1.0 if canary.get("ok") else 0.0)
            yield ok
            at = gauge("streamx_recording_canary_last_run_timestamp_seconds", "Unix time of the last canary run.")
            at.add_metric([], float(canary.get("at") or 0))
            yield at


def register_collector():
    """Idempotent; a no-op without prometheus_client."""
    global _registered
    with _lock:
        if _registered:
            return False
        try:
            from prometheus_client import REGISTRY
        except Exception:
            return False
        try:
            REGISTRY.register(RecordingCollector())
        except ValueError:  # already registered (module reloaded)
            pass
        _registered = True
        return True
