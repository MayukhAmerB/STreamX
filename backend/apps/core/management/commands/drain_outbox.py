import time

from django.core.management.base import BaseCommand

from apps.core.worker import run_worker_tick


class Command(BaseCommand):
    help = (
        "Deliver due transactional-outbox events. Production drains the outbox "
        "from process_async_jobs; use this for manual runs and debugging."
    )

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Process one batch and exit.")
        parser.add_argument("--batch-size", type=int, default=50)
        parser.add_argument("--poll-seconds", type=int, default=2)

    def handle(self, *args, **options):
        batch_size = max(1, int(options.get("batch_size") or 1))
        poll_seconds = max(1, int(options.get("poll_seconds") or 1))
        while True:
            stats = run_worker_tick(batch_size=batch_size)
            self.stdout.write("outbox " + " ".join(f"{key}={value}" for key, value in stats.items()))
            if options.get("once"):
                return
            time.sleep(poll_seconds)
