import json
import os

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Flush the database and load the end-to-end seed data (DEBUG or E2E=1 only)."

    def add_arguments(self, parser):
        parser.add_argument("--no-flush", action="store_true", help="Seed into the current (empty) database.")
        parser.add_argument("--manifest", default="", help="Also write the manifest JSON to this file.")

    def handle(self, *args, **options):
        if not (settings.DEBUG or os.environ.get("E2E", "").strip() == "1"):
            raise CommandError("seed_e2e refuses to run unless DEBUG is on or E2E=1 (it deletes every row).")
        if str(getattr(settings, "APP_ENV", "")).lower() in {"prod", "production"}:
            raise CommandError("seed_e2e never runs with APP_ENV=production.")
        from apps.e2e_support.seeding import seed

        if not options["no_flush"]:
            call_command("flush", interactive=False, verbosity=0)
        manifest = seed()
        text = json.dumps(manifest, indent=2, sort_keys=True)
        if options["manifest"]:
            with open(options["manifest"], "w", encoding="utf-8") as handle:
                handle.write(text)
        self.stdout.write(text)
