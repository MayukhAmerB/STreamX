from django.core.management.base import BaseCommand, CommandError

from apps.realtime.recording.verification import run_verification


class Command(BaseCommand):
    help = (
        "Prove the class-recording pipeline with the real ffmpeg on this machine: a simulated Owncast HLS "
        "feed (live, offline tail, reconnect, stop) is captured and finalized by the recorder's own code, then "
        "the Host Studio, OBS MKV and import paths run too. Leaves no trace: all rows are rolled back and all "
        "files live in a temporary directory. Safe inside the running stream-recorder container (own temp "
        "dirs, own 127.0.0.1 ports, no leader lock). Takes about a minute."
    )

    def add_arguments(self, parser):
        parser.add_argument("--keep-temp", action="store_true", help="Keep the temporary files for inspection.")

    def handle(self, *args, **options):
        self.stdout.write("Class recording pipeline verification (real ffmpeg)")
        report = run_verification(keep_temp=options["keep_temp"], write=self._line)
        passed = sum(1 for status, _n, _d in report.lines if status == "PASS")
        failed = sum(1 for status, _n, _d in report.lines if status == "FAIL")
        if report.passed:
            self.stdout.write(self.style.SUCCESS(f"RESULT: PASS ({passed} checks passed)"))
            return
        raise CommandError(f"RESULT: FAIL ({failed} failed, {passed} passed)")

    def _line(self, text):
        if text.startswith("[FAIL]"):
            self.stdout.write(self.style.ERROR(text))
        elif text.startswith("[WARN]"):
            self.stdout.write(self.style.WARNING(text))
        else:
            self.stdout.write(text)
