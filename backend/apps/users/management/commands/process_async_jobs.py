import time

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.core.worker import run_worker_tick
from apps.users.async_jobs import run_pending_jobs


class Command(BaseCommand):
    help = "Process queued asynchronous jobs (email/webhook retries) and deliver transactional-outbox events."

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
            try:
                outbox_stats = run_worker_tick(batch_size=batch_size)
            except Exception as exc:  # noqa: BLE001 - outbox trouble must not stop AsyncJob delivery
                self.stderr.write(f"outbox drain failed: {exc!r}")
            else:
                if outbox_stats.get("claimed") or outbox_stats.get("reclaimed") or run_once:
                    self.stdout.write("outbox " + " ".join(f"{key}={value}" for key, value in outbox_stats.items()))
            if run_once:
                return
            time.sleep(poll_seconds)
