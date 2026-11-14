"""Give every student a public handle (owner's privacy rule: handle only).

DRY RUN unless ``--apply``::

    python manage.py generate_missing_handles                    # counts + a sample, writes nothing
    python manage.py generate_missing_handles --apply            # chunked, throttled, idempotent
    python manage.py generate_missing_handles --apply --chunk-size 500 --sleep 0.5
    python manage.py generate_missing_handles --revert --apply   # undo: delete untouched auto-created profiles

Accounts without a ``StudentProfile`` get one with their automatic handle
(``apps.profiles.handles.derived_handle``: ``operative_<6 chars>``, a keyed
HMAC of the account id, never derived from the name or e-mail; the same handle
public surfaces already show for the account). The profile stays unpublished
(private) and the student is prompted once to customise the handle. Staff and
admin accounts are skipped unless ``--include-staff``.

``--revert`` deletes only profiles this command created that the student never
touched (still automatic, never published, draft never saved, no images).

``profiles_assign_handles`` is the older name of this command (same code).
"""

from __future__ import annotations

import time

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from apps.profiles import handles
from apps.profiles.models import ProfileAuditLog, StudentProfile
from apps.profiles.services import create_auto_profile


class Command(BaseCommand):
    help = "Create profiles with automatic, non-identifying handles for accounts that have none (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write. Without it nothing is changed.")
        parser.add_argument("--chunk-size", type=int, default=1000)
        parser.add_argument("--sleep", type=float, default=0.2, help="Seconds to pause between chunks.")
        parser.add_argument("--include-staff", action="store_true", help="Also staff and admin accounts.")
        parser.add_argument("--revert", action="store_true", help="Delete untouched profiles this command created.")

    def handle(self, *args, **options):
        apply = bool(options["apply"])
        if options["revert"]:
            return self._revert(apply)
        chunk = max(1, min(int(options["chunk_size"]), 10000))
        users = get_user_model().objects.filter(student_profile__isnull=True, is_active=True)
        if not options["include_staff"]:
            users = users.filter(is_staff=False, is_superuser=False)
        pending = users.count()
        self.stdout.write(f"{'APPLY' if apply else 'DRY RUN'}: {pending} account(s) without a handle.")
        if not apply:
            for user_id in users.order_by("pk").values_list("pk", flat=True)[:5]:
                self.stdout.write(f"  e.g. account {user_id} -> @{handles.derived_handle(user_id)}")
            self.stdout.write(self.style.WARNING("Dry run: nothing was written. Re-run with --apply."))
            return
        created = failed = last_id = 0
        while True:
            batch = list(users.filter(pk__gt=last_id).order_by("pk")[:chunk])
            if not batch:
                break
            for user in batch:
                try:
                    create_auto_profile(user, source="command")
                except Exception as exc:  # noqa: BLE001 - one bad account must not stop the run
                    failed += 1
                    self.stderr.write(f"  account {user.pk}: {exc}")
                    continue
                created += 1
            last_id = batch[-1].pk
            self.stdout.write(f"  up to account {last_id}: {created} handle(s) assigned")
            if options["sleep"] > 0:
                time.sleep(options["sleep"])
        self.stdout.write(self.style.SUCCESS(f"Assigned {created} automatic handle(s)."))
        if failed:
            self.stdout.write(self.style.ERROR(f"{failed} account(s) failed; re-run the command (it is idempotent)."))

    def _revert(self, apply: bool):
        created_ids = ProfileAuditLog.objects.filter(action=ProfileAuditLog.ACTION_AUTO_CREATED).values("profile_id")
        untouched = StudentProfile.objects.filter(
            pk__in=created_ids, handle_auto=True, published_at__isnull=True, draft_version=0, images__isnull=True
        ).distinct()
        count = untouched.count()
        if not apply:
            self.stdout.write(f"DRY RUN: {count} untouched auto-created profile(s) would be deleted.")
            return
        deleted = 0
        for profile in untouched.iterator(chunk_size=500):
            profile.delete()
            deleted += 1
        self.stdout.write(self.style.SUCCESS(f"Deleted {deleted} untouched auto-created profile(s)."))
