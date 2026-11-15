"""List graduates hidden from the Hall of Fame until they choose their own handle.

Graduates whose only handle is the automatic ``operative_xxxxxx`` one (or who
have no profile yet) are not shown on the public wall. Staff can use this list
to ask them to choose a handle; they appear automatically once they do.

    manage.py hall_of_fame_awaiting_handles            # table
    manage.py hall_of_fame_awaiting_handles --emails   # e-mail addresses only, one per line
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.certification import hall_of_fame


class Command(BaseCommand):
    help = "List Hall of Fame graduates waiting to choose a public handle (not shown on the wall yet)."

    def add_arguments(self, parser):
        parser.add_argument("--emails", action="store_true", help="Print e-mail addresses only.")
        parser.add_argument("--batch", default="", help="Only this batch label, e.g. 'Batch 3'.")

    def handle(self, *args, **options):
        rows = hall_of_fame.awaiting_handle_queryset()
        if options["batch"]:
            rows = rows.filter(batch_label=options["batch"])
        rows = list(rows)
        if options["emails"]:
            for email in sorted({row.user.email for row in rows if row.user.email}):
                self.stdout.write(email)
            return
        if not rows:
            self.stdout.write(self.style.SUCCESS("Every listed graduate has chosen a handle."))
            return
        for row in rows:
            self.stdout.write(f"#{row.pk}\t{row.batch_label or '-'}\t{row.user.email}\t{row.achievement}")
        self.stdout.write(self.style.WARNING(f"{len(rows)} graduate(s) are waiting to choose a handle."))
