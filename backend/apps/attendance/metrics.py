"""Prometheus counters for attendance (exported by /metrics).

``streamx_attendance_hook_failures_total{hook}``: attendance code failed
inside another app's flow (join, session end, engagement presence); the
source action still succeeded because the hook swallowed the error.
``streamx_attendance_flush_rows_total``: (session, student) pairs written by
the write-behind flush.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("apps.attendance.metrics")

try:
    from prometheus_client import Counter
except ImportError:  # pragma: no cover
    Counter = None

HOOK_FAILURES = None
FLUSH_ROWS = None
if Counter is not None:
    try:
        HOOK_FAILURES = Counter(
            "streamx_attendance_hook_failures_total",
            "Attendance hooks that failed inside another app's flow (the source action still succeeded).",
            labelnames=("hook",),
        )
        FLUSH_ROWS = Counter(
            "streamx_attendance_flush_rows_total",
            "Attendance (session, student) rows written by the write-behind flush.",
        )
    except ValueError:  # already registered (module reloaded)
        HOOK_FAILURES = None
        FLUSH_ROWS = None


def record_hook_failure(hook: str) -> None:
    if HOOK_FAILURES is None:
        return
    try:
        HOOK_FAILURES.labels(hook=str(hook or "unknown")[:64]).inc()
    except Exception:  # noqa: BLE001
        logger.debug("attendance metric failed", exc_info=True)


def record_flush_rows(count: int) -> None:
    if FLUSH_ROWS is None or not count:
        return
    try:
        FLUSH_ROWS.inc(int(count))
    except Exception:  # noqa: BLE001
        logger.debug("attendance metric failed", exc_info=True)
