"""Backstop sweep for weekly-report housekeeping.

The async worker already runs this every hour (the ``reports.housekeeping``
periodic hook, see ``apps/reports/housekeeping.py``). This command runs the
same sweep by hand: it sends any missing 24h due reminder (idempotent:
notifications are keyed per task + deadline), then deletes staged uploads that
were never submitted. Safe to run from cron at any interval.
"""

from django.core.management.base import BaseCommand

from apps.reports.housekeeping import run_housekeeping


class Command(BaseCommand):
    help = "Send missing 24h weekly-report reminders and prune unsubmitted uploads."

    def handle(self, *args, **options):
        stats = run_housekeeping()
        self.stdout.write(f"report_reminders sent={stats['reminders_sent']} staged_pruned={stats['staged_pruned']}")
