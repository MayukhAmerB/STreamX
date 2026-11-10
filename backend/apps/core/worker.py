"""Core background work, run on every tick of ``manage.py process_async_jobs``."""

from __future__ import annotations

import logging

from django.core.cache import cache

from .idempotency import prune_expired
from .outbox import drain_outbox, prune_delivered

logger = logging.getLogger("apps.core.worker")

MAINTENANCE_INTERVAL_SECONDS = 600


def run_maintenance_if_due() -> dict[str, int] | None:
    """Prune expired idempotency keys / old delivered events at most every 10 min
    across all workers (``cache.add`` is the cross-process gate)."""
    try:
        due = cache.add("core:worker:maintenance", 1, timeout=MAINTENANCE_INTERVAL_SECONDS)
    except Exception:  # noqa: BLE001
        due = False
    if not due:
        return None
    return {
        "idempotency_pruned": prune_expired(),
        "outbox_pruned": prune_delivered(),
    }


def run_worker_tick(*, batch_size: int = 50) -> dict[str, int]:
    stats = drain_outbox(batch_size=batch_size)
    try:
        maintenance = run_maintenance_if_due()
    except Exception:  # noqa: BLE001 - housekeeping must never stop delivery
        logger.exception("core maintenance failed")
        maintenance = None
    if maintenance:
        stats.update(maintenance)
    return stats
