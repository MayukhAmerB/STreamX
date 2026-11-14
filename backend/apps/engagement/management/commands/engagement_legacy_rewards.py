"""Grant the release-day legacy rewards (see ``apps.engagement.legacy``). DRY RUN unless ``--apply``.

    # review first (staging, on a production copy, after engagement_backfill --apply there):
    python manage.py engagement_legacy_rewards --release-at 2026-12-01T00:00:00+05:30 --report /tmp/legacy-review.txt
    # release day:
    python manage.py engagement_legacy_rewards --apply --report /data/legacy-applied.txt
    # optional: accounts certified before release that are not in the Hall of Fame (one e-mail per line)
    python manage.py engagement_legacy_rewards --graduates-file graduates.txt

The release moment comes from ``--release-at`` or ``ENGAGEMENT_RELEASE_AT``.
The report lists counts, the XP distribution and top 20 (handles only),
active vs inactive, badges and certificates to issue, courses without a batch
number and Hall of Fame entries not linked to an account. Safe to re-run:
granted students are skipped where nothing is missing. ``--apply`` works in
chunks with a pause between them, one short transaction per student.
"""

from __future__ import annotations

import time
from collections import Counter
from datetime import datetime

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.engagement import legacy, rules
from apps.engagement.models import LegacyGrant


class Command(BaseCommand):
    help = "Review (default) or grant (--apply) the legacy rewards for students enrolled before release day."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Grant. Without it nothing is written except the report.")
        parser.add_argument("--release-at", default="", help="ISO date-time with offset; default ENGAGEMENT_RELEASE_AT.")
        parser.add_argument("--report", default="", help="Write the review report to this file (also printed).")
        parser.add_argument("--graduates-file", default="", help="Extra certified accounts: one e-mail per line.")
        parser.add_argument("--chunk-size", type=int, default=500)
        parser.add_argument("--sleep", type=float, default=0.5, help="Seconds to pause between chunks.")
        parser.add_argument("--allow-before-release", action="store_true",
                            help="Allow --apply before the release moment (staging rehearsals only).")

    def _release_at(self, raw: str) -> datetime:
        if raw:
            value = parse_datetime(raw.strip())
            if value is None or timezone.is_naive(value):
                raise CommandError("--release-at must be an ISO date-time with an offset, e.g. 2026-12-01T00:00:00+05:30.")
            return value
        value = rules.release_at()
        if value is None:
            raise CommandError("Set ENGAGEMENT_RELEASE_AT or pass --release-at.")
        return value

    def _graduates(self, path: str) -> tuple[set[int], list[str]]:
        if not path:
            return set(), []
        try:
            with open(path, encoding="utf-8") as handle:
                emails = [line.strip().lower() for line in handle if line.strip() and not line.startswith("#")]
        except OSError as exc:
            raise CommandError(f"Cannot read {path}: {exc.strerror or exc}") from None
        found = dict(
            get_user_model().objects.filter(email__in=emails).values_list("email", "pk")
        )
        found = {email.lower(): pk for email, pk in found.items()}
        missing = [email for email in emails if email not in found]
        return set(found.values()), missing

    def handle(self, *args, **options):
        release_at = self._release_at(options["release_at"])
        apply = bool(options["apply"])
        now = timezone.now()
        if apply and release_at > now and not options["allow_before_release"]:
            raise CommandError("The release moment is in the future; run --apply on release day (or pass --allow-before-release on staging).")
        graduate_ids, missing_graduates = self._graduates(options["graduates_file"])
        chunk_size = max(1, min(int(options["chunk_size"]), 5000))
        lines: list[str] = []
        say = lines.append
        say(f"Legacy rewards {'APPLY' if apply else 'DRY RUN'} at {now.isoformat()}")
        say(f"Release moment: {release_at.isoformat()} · active window: {legacy.active_days()} days · "
            f"Founding Glow: {legacy.glow_days()} days")

        totals = Counter()
        unnumbered = Counter()
        all_ids: list[int] = []
        last_id = 0
        chunks = 0
        while True:
            ids = legacy.legacy_user_ids(release_at, after_id=last_id, limit=chunk_size)
            if not ids:
                break
            plans = legacy.build_plans(ids, release_at, graduate_ids=graduate_ids)
            summary = legacy.describe(plans, release_at)
            totals.update(summary["counts"])
            unnumbered.update(summary["unnumbered_courses"])
            all_ids.extend(ids)
            if apply:
                for plan in plans.values():
                    created = legacy.apply_plan(plan, release_at, now=now)
                    totals["granted_new_students"] += int(created["grant"])
                    totals["granted_new_badges"] += len(created["badges"])
                    totals["granted_new_certificates"] += len(created["certificates"])
                    totals["granted_new_glows"] += int(created["glow"])
            last_id = ids[-1]
            chunks += 1
            self.stdout.write(f"  chunk {chunks}: up to user id {last_id} ({len(all_ids)} legacy students)")
            if options["sleep"] > 0 and len(ids) == chunk_size:
                time.sleep(options["sleep"])

        say("")
        say("Students")
        for key in ("legacy_students", "active", "inactive", "graduates", "current_course_but_no_recent_activity", "founding_glow"):
            say(f"  {key}: {totals[key]}")
        already = LegacyGrant.objects.filter(user_id__in=all_ids).count() if all_ids else 0
        say(f"  already granted before this run: {already if not apply else '(see granted_new_*)'}")
        say("")
        say("Badges to hold")
        for key in sorted(k for k in totals if k.startswith("badge:")):
            say(f"  {key[6:]}: {totals[key]}")
        say("Certificates to hold (issued once, dated on the release moment)")
        for key in sorted(k for k in totals if k.startswith("certificate:")):
            say(f"  {key[12:]}: {totals[key]}")
        if apply:
            say("Written in this run")
            for key in ("granted_new_students", "granted_new_badges", "granted_new_certificates", "granted_new_glows"):
                say(f"  {key}: {totals[key]}")

        overview = legacy.xp_overview(all_ids)
        say("")
        say("XP distribution (legacy students; run engagement_backfill --apply first for retroactive XP)")
        for label, count in sorted(overview["buckets"].items(), key=lambda item: item[0]):
            say(f"  {label}: {count}")
        say("Levels")
        for label, count in overview["levels"].most_common():
            say(f"  {label}: {count}")
        say("Top 20 by XP (handles only)")
        for rank, row in enumerate(overview["top"], start=1):
            say(f"  {rank:>2}. @{row['handle'] or row['user_id']} · {row['xp']} XP · {row['level']} · best streak {row['best_streak']}")

        say("")
        say("Needs the owner's attention")
        if unnumbered:
            say("  Courses with no batch number (no Batch Pioneer badge until Course.batch says e.g. 'Batch 3'):")
            for title, count in unnumbered.most_common():
                say(f"    {title}: {count} student(s)")
        unlinked = legacy.unlinked_hall_of_fame(release_at)
        if unlinked:
            say("  Hall of Fame entries with no linked account (link them in the admin to grant Founding Graduate):")
            for row in unlinked:
                say(f"    {row}")
        if missing_graduates:
            say(f"  Graduate e-mails with no account: {len(missing_graduates)}")
        if not (unnumbered or unlinked or missing_graduates):
            say("  nothing")
        if not apply:
            say("")
            say("Dry run: nothing was granted. Re-run with --apply on release day.")

        report = "\n".join(lines) + "\n"
        self.stdout.write(report)
        if options["report"]:
            try:
                with open(options["report"], "w", encoding="utf-8") as handle:
                    handle.write(report)
            except OSError as exc:
                raise CommandError(f"Cannot write {options['report']}: {exc.strerror or exc}") from None
            self.stdout.write(self.style.SUCCESS(f"Report written to {options['report']}"))
