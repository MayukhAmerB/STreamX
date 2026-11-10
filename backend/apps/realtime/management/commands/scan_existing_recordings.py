from django.core.management.base import BaseCommand

from apps.realtime.recording import importer


class Command(BaseCommand):
    help = (
        "List class videos already on the server (lecture_videos, realtime_recordings, staged OBS uploads, "
        "/recordings, recorder work folders) that no lecture or class recording uses, as Imported (unassigned) "
        "class recordings. Never moves or deletes a file; safe to run repeatedly."
    )

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Only report what would be listed.")
        parser.add_argument("--no-probe", action="store_true", help="Skip ffprobe (durations stay blank).")
        parser.add_argument(
            "--min-age",
            type=int,
            default=importer.DEFAULT_MIN_AGE_SECONDS,
            help="Skip files modified within this many seconds (default 600: they may still be written).",
        )
        parser.add_argument("--limit", type=int, default=None, help="Stop after listing this many new recordings.")

    def handle(self, *args, **options):
        report = importer.scan_existing_recordings(
            probe=not options["no_probe"],
            min_age_seconds=max(0, int(options["min_age"])),
            limit=options["limit"],
            dry_run=options["dry_run"],
        )
        for label, root, exists in report.roots:
            self.stdout.write(f"  {'scanned' if exists else 'missing'}  {label}: {root}")
        if report.dry_run:
            for item in report.created:
                self.stdout.write(f"  would list: {item}")
        self.stdout.write(self.style.SUCCESS(("[dry run] " if report.dry_run else "") + report.summary()))
