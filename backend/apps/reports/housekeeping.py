"""Weekly-report housekeeping, run hourly by the async worker.

The 24h due reminder is normally a delayed outbox event queued when a task is
published. This backstop re-checks every published task due within 24 hours
and sends any reminder that is missing (idempotent: notifications are keyed
per task + deadline), then deletes staged uploads that were never submitted.

A periodic hook publishes one deduplicated ``reports.housekeeping`` outbox event
per hour; ``manage.py send_report_reminders`` runs the same sweep by hand.
"""

from __future__ import annotations

import logging

from django.utils import timezone

from apps.core.outbox import outbox_handler, publish

logger = logging.getLogger("apps.reports.housekeeping")

EVENT_HOUSEKEEPING = "reports.housekeeping"
HOUSEKEEPING_INTERVAL_SECONDS = 3600


def run_housekeeping(now=None):
    """Send missing due reminders and prune stale staged uploads."""
    from .outbox_handlers import send_due_reminder
    from .services import due_reminder_targets, prune_staged_files

    now = now or timezone.now()
    sent = 0
    for task in due_reminder_targets(now):
        if send_due_reminder(task, now) is not None:
            sent += 1
    pruned = prune_staged_files(now=now)
    return {"reminders_sent": sent, "staged_pruned": pruned}


def schedule_housekeeping(now=None):
    now = now or timezone.now()
    bucket = int(now.timestamp()) // HOUSEKEEPING_INTERVAL_SECONDS
    return publish(EVENT_HOUSEKEEPING, {"bucket": bucket}, dedupe_key=f"reports-housekeeping:{bucket}")


@outbox_handler(EVENT_HOUSEKEEPING, max_attempts=3)
def handle_housekeeping(event):
    stats = run_housekeeping()
    if stats["reminders_sent"] or stats["staged_pruned"]:
        logger.info("reports: housekeeping %s", stats)
    return stats
