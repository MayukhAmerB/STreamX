"""Void the prizes of a closed period that the current prize rules would not pay. DRY RUN unless ``--apply``.

    python manage.py engagement_void_prizes --period 2026-W46            # review
    python manage.py engagement_void_prizes --period 2026-W46 --apply    # reverse + revoke
    python manage.py engagement_void_prizes --period 2026-10             # a monthly close

Every prize of the period is listed (user id, handle, batch, XP, kept/voided,
reason). A voided prize gets a reversing ledger row and an audit entry
("Prize voided: rule change"); its Podium Week badge is revoked. History is
never deleted, and a second run changes nothing. See ``apps.engagement.prize_void``.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.engagement import prize_void


class Command(BaseCommand):
    help = "Review (default) or void (--apply) a closed period's prizes under the current prize rules."

    def add_arguments(self, parser):
        parser.add_argument("--period", required=True, help="ISO week (2026-W46), its Monday (2026-11-09) or a month (2026-10).")
        parser.add_argument("--apply", action="store_true", help="Void. Without it nothing is written.")

    def handle(self, *args, **options):
        try:
            report = prize_void.void_prizes(options["period"], apply=bool(options["apply"]))
        except ValueError as error:
            raise CommandError(str(error)) from error
        self.stdout.write(prize_void.render(report))
