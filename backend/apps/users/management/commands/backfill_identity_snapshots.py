"""Fill the student identity snapshot on records saved before it existed.

    python manage.py backfill_identity_snapshots            # dry run: counts only
    python manage.py backfill_identity_snapshots --apply    # write, in chunks

Only rows whose ``student_roll_number`` is still empty are touched, so the
command is idempotent and safe to re-run (and to run while the site is live).
Rows are written with ``bulk_update`` on the three snapshot columns only: no
``save()``, no signals, no ``updated_at`` bump. A backfilled snapshot holds the
name and handle as they are at backfill time (the best record we have).
"""

from __future__ import annotations

import time

from django.apps import apps as django_apps
from django.core.management.base import BaseCommand
from django.db import transaction

from apps.users import identity

TARGETS = (
    ("reports", "ReportSubmission", "student_id"),
    ("ctf", "CtfParticipation", "user_id"),
    ("ctf", "CtfExamResult", "user_id"),
    ("ctf", "CtfSeasonEntry", "user_id"),
)


class Command(BaseCommand):
    help = "Backfill roll number, real name and handle snapshots on submission records (dry run by default)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write the snapshots (default: dry run).")
        parser.add_argument("--chunk-size", type=int, default=1000)
        parser.add_argument("--sleep", type=float, default=0.0, help="Seconds to pause between chunks.")
        parser.add_argument("--model", action="append", default=[], help="Only this model (e.g. ReportSubmission).")

    def handle(self, *args, apply=False, chunk_size=1000, sleep=0.0, model=(), **options):
        chunk_size = max(1, min(int(chunk_size or 1000), 5000))
        wanted = {item.lower() for item in model}
        total = 0
        for app_label, model_name, user_field in TARGETS:
            if wanted and model_name.lower() not in wanted:
                continue
            try:
                model_class = django_apps.get_model(app_label, model_name)
            except LookupError:
                continue
            pending = model_class.objects.filter(student_roll_number__isnull=True)
            count = pending.count()
            total += count
            self.stdout.write(f"{app_label}.{model_name}: {count} row(s) without a snapshot")
            if not apply or not count:
                continue
            done = self._backfill(model_class, user_field, chunk_size, sleep)
            self.stdout.write(self.style.SUCCESS(f"  wrote {done} snapshot(s)"))
        if not apply:
            self.stdout.write(f"Dry run: {total} row(s) would be filled. Re-run with --apply to write.")

    def _backfill(self, model_class, user_field, chunk_size, sleep) -> int:
        user_model = django_apps.get_model("users", "User")
        done = 0
        last_id = 0
        while True:
            rows = list(
                model_class.objects.filter(student_roll_number__isnull=True, pk__gt=last_id)
                .order_by("pk")
                .only("pk", user_field, *identity.SNAPSHOT_FIELDS)[:chunk_size]
            )
            if not rows:
                return done
            last_id = rows[-1].pk
            user_ids = {getattr(row, user_field) for row in rows}
            users = {user.pk: user for user in user_model.objects.filter(pk__in=user_ids).only("pk", "full_name")}
            handles = identity.handles_for(user_ids)
            for row in rows:
                user_id = getattr(row, user_field)
                user = users.get(user_id)
                row.student_roll_number = identity.roll_number(user_id)
                row.student_name_snapshot = identity.real_name(user)[:255] if user else ""
                row.student_handle_snapshot = handles.get(user_id) or None
            with transaction.atomic():
                model_class.objects.bulk_update(rows, list(identity.SNAPSHOT_FIELDS), batch_size=500)
            done += len(rows)
            self.stdout.write(f"  ... up to id {last_id}")
            if sleep:
                time.sleep(sleep)
