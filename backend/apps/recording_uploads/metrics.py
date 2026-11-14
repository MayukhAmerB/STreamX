"""Prometheus gauges for recording uploads (computed at scrape time from the database).

* ``streamx_recording_uploads{status}``
* ``streamx_recording_upload_received_bytes``  bytes received by unfinished uploads
* ``streamx_recording_upload_oldest_active_age_seconds``
"""

import logging
import threading

from django.db.models import Count, Min, Sum
from django.utils import timezone

logger = logging.getLogger("ops.recording_uploads")
_registered = False
_lock = threading.Lock()


class RecordingUploadCollector:
    def describe(self):
        return []

    def collect(self):
        try:
            from prometheus_client.core import GaugeMetricFamily
        except Exception:  # noqa: BLE001 - prometheus_client missing
            return
        try:
            yield from self._collect(GaugeMetricFamily)
        except Exception:  # noqa: BLE001 - a scrape must never fail because of the database
            logger.exception("RECORDING_UPLOAD_METRICS_COLLECT_FAILED")

    def _collect(self, gauge):
        from .models import RecordingUpload

        counts = gauge("streamx_recording_uploads", "Recording uploads by status.", labels=["status"])
        seen = dict(RecordingUpload.objects.values("status").annotate(total=Count("pk")).values_list("status", "total"))
        for status, _label in RecordingUpload.STATUS_CHOICES:
            counts.add_metric([status], seen.get(status, 0))
        yield counts
        active = RecordingUpload.objects.filter(status__in=RecordingUpload.ACTIVE_STATUSES)
        totals = active.aggregate(received=Sum("received_bytes"), oldest=Min("created_at"))
        received = gauge("streamx_recording_upload_received_bytes", "Bytes received by unfinished uploads.")
        received.add_metric([], float(totals["received"] or 0))
        yield received
        oldest = gauge(
            "streamx_recording_upload_oldest_active_age_seconds", "Age of the oldest unfinished upload (0 when none)."
        )
        value = totals["oldest"]
        oldest.add_metric([], max(0.0, (timezone.now() - value).total_seconds()) if value else 0.0)
        yield oldest


def register_collector():
    """Idempotent; a no-op without prometheus_client."""
    global _registered
    with _lock:
        if _registered:
            return False
        try:
            from prometheus_client import REGISTRY
        except Exception:  # noqa: BLE001
            return False
        try:
            REGISTRY.register(RecordingUploadCollector())
        except ValueError:
            pass
        _registered = True
        return True
