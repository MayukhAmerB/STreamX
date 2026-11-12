"""Re-scan stored weekly-report files with the current virus signatures.

    manage.py rescan_report_files            # files not scanned in the last interval (+ never scanned)
    manage.py rescan_report_files --all      # every stored file that is not already quarantined
    manage.py rescan_report_files --limit 50 # one batch only

Files found infected are moved to REPORTS_QUARANTINE_ROOT (mode 000), marked
infected (downloads refuse them), recorded in the admin's quarantine list and
staff are notified. The async worker runs the same re-scan periodically.
"""

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from apps.reports.antivirus import ScannerUnavailable
from apps.reports.rescan import rescan_stored_files


class Command(BaseCommand):
    help = "Re-scan stored weekly-report files with fresh virus signatures."

    def add_arguments(self, parser):
        parser.add_argument("--all", action="store_true", help="Re-scan every stored file, however recent its scan.")
        parser.add_argument("--limit", type=int, default=0, help="Stop after one batch of this many files.")

    def handle(self, *args, **options):
        started = timezone.now()
        cutoff = started if options["all"] else None
        limit = max(0, int(options["limit"] or 0))
        totals = {}
        while True:
            try:
                stats = rescan_stored_files(cutoff=cutoff, limit=limit or None, now=timezone.now())
            except ScannerUnavailable as exc:
                raise CommandError(f"{exc.message} Nothing was changed for the files not yet scanned.") from None
            for key, value in stats.as_dict().items():
                totals[key] = value if key == "remaining" else totals.get(key, 0) + value
            progressed = stats.scanned or stats.missing or stats.refused
            if limit or not stats.remaining or not progressed:
                break
        summary = " ".join(f"{key}={value}" for key, value in totals.items())
        self.stdout.write(f"rescan_report_files {summary}")
        if totals.get("infected"):
            self.stdout.write(self.style.WARNING("Infected files were quarantined; staff have been notified."))
