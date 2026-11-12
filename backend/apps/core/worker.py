"""Core background work, run on every tick of ``manage.py process_async_jobs``."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable

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


_periodic_hooks: dict[str, tuple[int, Callable[[], object]]] = {}
_periodic_lock = threading.Lock()


def register_periodic(name: str, *, interval_seconds: int, func: Callable[[], object]) -> None:
    """Run ``func`` from the worker at most every ``interval_seconds`` across
    all workers (``cache.add`` gate). Apps register in ``AppConfig.ready``.
    Hooks must be cheap -- typically they only ``publish`` a deduplicated
    outbox event that does the real work."""
    with _periodic_lock:
        _periodic_hooks[str(name)] = (max(1, int(interval_seconds)), func)


def run_periodic_hooks() -> list[str]:
    ran = []
    with _periodic_lock:
        hooks = list(_periodic_hooks.items())
    for name, (interval, func) in hooks:
        try:
            due = cache.add(f"core:worker:periodic:{name}", 1, timeout=interval)
        except Exception:  # noqa: BLE001
            due = False
        if not due:
            continue
        try:
            func()
            ran.append(name)
        except Exception:  # noqa: BLE001 - one hook must never stop delivery
            logger.exception("periodic hook %s failed", name)
    return ran


def run_worker_tick(*, batch_size: int = 50) -> dict[str, int]:
    stats = drain_outbox(batch_size=batch_size)
    try:
        maintenance = run_maintenance_if_due()
    except Exception:  # noqa: BLE001 - housekeeping must never stop delivery
        logger.exception("core maintenance failed")
        maintenance = None
    if maintenance:
        stats.update(maintenance)
    run_periodic_hooks()
    return stats
