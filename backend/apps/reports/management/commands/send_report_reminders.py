"""Backstop sweep for weekly-report housekeeping.

The 24h due reminder is normally a delayed outbox event queued when a task is
published (delivered by ``process_async_jobs``). This command re-checks every
published task due within 24 hours and sends any reminder that is missing
(idempotent: notifications are keyed per task + deadline), then deletes staged
uploads that were never submitted. Safe to run from cron at any interval.
"""

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.reports.outbox_handlers import send_due_reminder
from apps.reports.services import due_reminder_targets, prune_staged_files


class Command(BaseCommand):
    help = "Send missing 24h weekly-report reminders and prune unsubmitted uploads."

    def handle(self, *args, **options):
        now = timezone.now()
        sent = 0
        for task in due_reminder_targets(now):
            if send_due_reminder(task, now) is not None:
                sent += 1
        pruned = prune_staged_files(now=now)
        self.stdout.write(f"report_reminders sent={sent} staged_pruned={pruned}")
