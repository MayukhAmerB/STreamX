"""Verify the private report storage: present, writable, and mounted
noexec,nosuid,nodev (Linux), together with the quarantine directory.

    manage.py check_report_storage --require-noexec   # what post-deploy-smoke.sh runs

Exit status 1 on any problem.
"""

import os
import tempfile

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.reports.storage import mount_flags


class Command(BaseCommand):
    help = "Check the weekly-report private storage and quarantine directories."

    def add_arguments(self, parser):
        parser.add_argument(
            "--require-noexec",
            action="store_true",
            help="Fail unless both directories sit on a noexec,nosuid,nodev filesystem (Linux only).",
        )

    def handle(self, *args, **options):
        problems = []
        roots = {
            "REPORTS_PRIVATE_ROOT": settings.REPORTS_PRIVATE_ROOT,
            "REPORTS_QUARANTINE_ROOT": settings.REPORTS_QUARANTINE_ROOT,
        }
        for name, root in roots.items():
            root = os.path.abspath(str(root))
            if not os.path.isdir(root):
                problems.append(f"{name} ({root}) does not exist.")
                continue
            try:
                with tempfile.NamedTemporaryFile(dir=root, prefix=".probe-", delete=True):
                    pass
            except OSError as exc:
                problems.append(f"{name} ({root}) is not writable: {type(exc).__name__}.")
            flags = mount_flags(root)
            if flags is None:
                message = f"{name} ({root}): mount flags cannot be read on this platform."
                if options["require_noexec"]:
                    problems.append(message)
                else:
                    self.stdout.write(message)
                continue
            missing = [flag for flag, present in flags.items() if not present]
            if missing:
                message = f"{name} ({root}) is not mounted with: {', '.join(missing)}."
                if options["require_noexec"]:
                    problems.append(message)
                else:
                    self.stdout.write(self.style.WARNING(message))
            else:
                self.stdout.write(f"{name} ({root}): noexec,nosuid,nodev OK")
        if problems:
            raise CommandError(" ".join(problems))
        self.stdout.write("report storage OK")
