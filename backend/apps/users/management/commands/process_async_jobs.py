import time

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.users.async_jobs import run_pending_jobs


class Command(BaseCommand):
    help = "Process queued asynchronous jobs (email/webhook retries)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--once",
            action="store_true",
            help="Process one batch and exit.",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=20,
            help="Maximum number of jobs to claim per batch.",
        )
        parser.add_argument(
            "--poll-seconds",
            type=int,
            default=int(getattr(settings, "ASYNC_JOBS_POLL_SECONDS", 10)),
            help="Polling interval in seconds when running in watch mode.",
        )

    def handle(self, *args, **options):
        run_once = bool(options.get("once"))
        batch_size = max(1, int(options.get("batch_size") or 1))
        poll_seconds = max(1, int(options.get("poll_seconds") or 1))

        while True:
            stats = run_pending_jobs(batch_size=batch_size)
            self.stdout.write(
                "async_jobs "
                f"claimed={stats['claimed']} "
                f"succeeded={stats['succeeded']} "
                f"retried={stats['retried']} "
                f"dead={stats['dead']}"
            )
            if run_once:
                return
            time.sleep(poll_seconds)
