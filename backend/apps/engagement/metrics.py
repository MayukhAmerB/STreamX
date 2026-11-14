"""Prometheus counter for engagement hook failures (exported by /metrics).

``streamx_engagement_hook_failures_total{hook="<receiver>"}``: a non-zero
rate means engagement code failed inside another app's flow; the source
action still succeeded (the hook swallowed the error).
"""

from __future__ import annotations

import logging

logger = logging.getLogger("apps.engagement.metrics")

try:
    from prometheus_client import Counter
except ImportError:  # pragma: no cover
    Counter = None

HOOK_FAILURES = None
if Counter is not None:
    try:
        HOOK_FAILURES = Counter(
            "streamx_engagement_hook_failures_total",
            "Engagement hooks that failed inside another app's flow (the source action still succeeded).",
            labelnames=("hook",),
        )
    except ValueError:  # already registered (module reloaded)
        HOOK_FAILURES = None


def record_hook_failure(hook: str) -> None:
    if HOOK_FAILURES is None:
        return
    try:
        HOOK_FAILURES.labels(hook=str(hook or "unknown")[:64]).inc()
    except Exception:  # noqa: BLE001
        logger.debug("engagement metric failed", exc_info=True)
