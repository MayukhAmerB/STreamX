"""Check that the report virus scanner answers, optionally waiting for it.

    manage.py check_antivirus                    # one PING + VERSION
    manage.py check_antivirus --wait-seconds 600 # first deploy: wait for freshclam

Exit status 0 when the scanner answers PING and reports its signature version,
1 otherwise. Used by infra/hostinger/post-deploy-smoke.sh.
"""

import time

from django.core.management.base import BaseCommand, CommandError

from apps.reports.antivirus import configured_scanner_name, scanner_status


class Command(BaseCommand):
    help = "Check the weekly-report virus scanner (clamd PING + signature version)."

    def add_arguments(self, parser):
        parser.add_argument("--wait-seconds", type=int, default=0, help="Retry until it answers or this time passes.")
        parser.add_argument("--interval", type=int, default=10, help="Seconds between retries.")

    def handle(self, *args, **options):
        wait = max(0, int(options["wait_seconds"]))
        interval = max(1, int(options["interval"]))
        deadline = time.monotonic() + wait
        attempt = 0
        while True:
            attempt += 1
            status = scanner_status()
            if status["state"] == "ok" and status["version"]:
                self.stdout.write(f"antivirus OK: scanner={status['scanner']} version={status['version']}")
                return
            remaining = deadline - time.monotonic()
            if status["state"] == "off" or remaining <= 0:
                break
            self.stdout.write(
                f"antivirus not ready yet (scanner={status['scanner']}, attempt {attempt}); "
                f"retrying for up to {int(remaining)}s more..."
            )
            self.stdout.flush()
            time.sleep(min(interval, max(0.1, remaining)))
        raise CommandError(
            f"Virus scanner {configured_scanner_name()!r} is not answering ({status['state']}); "
            "report uploads are refused until it does."
        )
