"""Outbox handlers of apps.payments (autodiscovered by CoreConfig.ready)."""

from __future__ import annotations

import logging

from apps.core.outbox import outbox_handler

from .reconciliation import EVENT_RECONCILE, enabled, reconcile_stuck_payments

logger = logging.getLogger("apps.payments.reconciliation")


@outbox_handler(EVENT_RECONCILE, max_attempts=3)
def handle_reconcile(event):
    """One periodic reconciliation batch (the switch is re-read at run time)."""
    if not enabled():
        return
    report = reconcile_stuck_payments(apply=True)
    if report.captured or report.superseded or report.needs_review or report.errors:
        logger.warning("payments.reconcile_batch %s", {k: v for k, v in report.as_dict().items() if k != "rows"})
