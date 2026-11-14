"""Retroactively award XP from existing data. DRY RUN unless ``--apply``.

    python manage.py engagement_backfill                      # dry run: what would be awarded
    python manage.py engagement_backfill --apply              # award (idempotent, resumable)
    python manage.py engagement_backfill --apply --resume     # continue after the last finished chunk
    python manage.py engagement_backfill --apply --after-user-id 42000 --chunk-size 1000 --sleep 1

Sources: completed lectures (>= 80 % watched), estimated watch time (furthest
position per lecture, on the IST day it was last updated, capped 60 XP/day),
weekly reports submitted (+ on time), graded reports with released marks,
finalised CTF exam results, live classes with reliable join logs only
(finalised apps.attendance records measured from presence pings or join events
-- present or partial, plus the first-live bonus -- and finalised engagement
presence rows for classes attendance never tracked; staff-entered or overridden
records and classes without logs earn nothing: never guessed), and successful
payments (subscription charges and one-time purchases, net of refunds).
With ENGAGEMENT_RELEASE_AT set, history earns no streak bonuses and never
counts on the weekly leaderboard (streaks start fresh on release day).

Safe while the site is live: users are processed in primary-key chunks, each
user in its own short transaction under the same row lock and idempotency
keys as the live awarding, with a pause between chunks. Streak bonuses,
badges, level and course achievements follow from the awarded history.
"""

from __future__ import annotations

import time
from collections import Counter, defaultdict

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management.base import BaseCommand, CommandError

from apps.engagement import rules, services, sources
from apps.engagement.models import ActivityDay, XpEvent

CHECKPOINT_KEY = "eng:backfill:checkpoint"
KINDS = ("lectures", "watch", "reports", "exams", "live", "purchases")


class Command(BaseCommand):
    help = "Backfill engagement XP from existing lecture progress, reports and exam results (dry run by default)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write. Without it nothing is changed.")
        parser.add_argument("--chunk-size", type=int, default=2000)
        parser.add_argument("--sleep", type=float, default=0.5, help="Seconds to pause between chunks.")
        parser.add_argument("--after-user-id", type=int, default=0)
        parser.add_argument("--resume", action="store_true", help="Start after the last finished chunk.")
        parser.add_argument("--max-chunks", type=int, default=0, help="Stop after this many chunks (0 = all).")
        parser.add_argument("--kinds", default=",".join(KINDS), help=f"Comma list of {', '.join(KINDS)}.")
        parser.add_argument("--force", action="store_true", help="Award even while the engagement switch is off.")

    def handle(self, *args, **options):
        apply = bool(options["apply"])
        kinds = {kind.strip() for kind in str(options["kinds"]).split(",") if kind.strip()}
        unknown = kinds - set(KINDS)
        if unknown:
            raise CommandError(f"Unknown kinds: {', '.join(sorted(unknown))}")
        if apply and not options["force"] and not services.is_enabled():
            raise CommandError("The engagement switch is off; turn it on or pass --force.")
        chunk_size = max(1, min(int(options["chunk_size"]), 10000))
        last_id = int(options["after_user_id"] or 0)
        if options["resume"]:
            last_id = max(last_id, int(cache.get(CHECKPOINT_KEY) or 0))
        totals = Counter()
        points = Counter()
        chunks = 0
        user_model = get_user_model()
        self.stdout.write(f"{'APPLY' if apply else 'DRY RUN'}: users after id {last_id}, chunks of {chunk_size}, kinds {sorted(kinds)}")
        while True:
            user_ids = list(user_model.objects.filter(pk__gt=last_id).order_by("pk").values_list("pk", flat=True)[:chunk_size])
            if not user_ids:
                break
            items_by_user, watch_by_user = self._collect(user_ids, kinds)
            self._process(items_by_user, watch_by_user, apply=apply, totals=totals, points=points, force=options["force"])
            last_id = user_ids[-1]
            chunks += 1
            totals["users_scanned"] += len(user_ids)
            if apply:
                cache.set(CHECKPOINT_KEY, last_id, timeout=30 * 24 * 3600)
            self.stdout.write(f"  chunk {chunks}: up to user id {last_id} ({totals['users_scanned']} users scanned)")
            if options["max_chunks"] and chunks >= options["max_chunks"]:
                break
            if options["sleep"] > 0:
                time.sleep(options["sleep"])
        self.stdout.write("Summary (new events only; existing keys skipped):")
        for kind in sorted(points):
            self.stdout.write(f"  {kind}: {totals[kind]} event(s), {points[kind]} XP")
        self.stdout.write(f"  watch seconds (estimated, new): {totals['watch_seconds']}")
        self.stdout.write(f"  users with new XP: {totals['users_with_xp']}; users scanned: {totals['users_scanned']}")
        self.stdout.write(f"  last user id: {last_id} (resume with --after-user-id {last_id} or --resume)")
        if not apply:
            self.stdout.write(self.style.WARNING("Dry run: nothing was written. Re-run with --apply."))

    # --- collection --------------------------------------------------------------------------
    def _collect(self, user_ids, kinds):
        items = defaultdict(list)
        watch = defaultdict(lambda: defaultdict(int))
        if kinds & {"lectures", "watch"}:
            from apps.courses.models import LectureProgress

            rows = LectureProgress.objects.filter(user_id__in=user_ids).select_related("lecture").only(
                "user_id", "lecture_id", "max_position_seconds", "last_position_seconds", "duration_seconds",
                "completed", "completed_at", "updated_at", "lecture__stream_duration_seconds",
            )
            for progress in rows.iterator(chunk_size=2000):
                if "lectures" in kinds:
                    item = sources.lecture_item(progress)
                    if item:
                        items[progress.user_id].append(item)
                if "watch" in kinds:
                    duration = int(progress.duration_seconds or 0) or int(progress.lecture.stream_duration_seconds or 0)
                    seconds = int(progress.max_position_seconds or 0)
                    if duration:
                        seconds = min(seconds, duration)
                    if seconds > 0 and progress.updated_at:
                        watch[progress.user_id][rules.ist_day(progress.updated_at)] += seconds
        if "reports" in kinds:
            from apps.reports.models import ReportSubmission

            rows = ReportSubmission.objects.filter(student_id__in=user_ids, first_submitted_at__isnull=False).select_related(
                "task", "grade"
            )
            for submission in rows.iterator(chunk_size=2000):
                for item in (sources.report_submitted_item(submission), sources.report_graded_item(submission)):
                    if item:
                        items[submission.student_id].append(item)
        if "exams" in kinds:
            from apps.ctf.models import CtfExamResult

            results = list(CtfExamResult.objects.filter(user_id__in=user_ids).select_related("participation"))
            exam_ids = {row.exam_id for row in results}
            peers = defaultdict(list)
            for exam_id, batch_id, rank in CtfExamResult.objects.filter(exam_id__in=exam_ids).values_list(
                "exam_id", "batch_course_id", "rank"
            ):
                peers[(exam_id, batch_id)].append(int(rank or 0))
            for user_id, item in sources.exam_items(results, peer_ranks=peers):
                items[user_id].append(item)
        if "live" in kinds:
            self._collect_live(user_ids, items)
        if "purchases" in kinds:
            from apps.payments.models import Payment

            rows = Payment.objects.filter(
                user_id__in=user_ids, status__in=(Payment.STATUS_PAID, Payment.STATUS_REFUNDED)
            )
            for payment in rows.iterator(chunk_size=2000):
                item = sources.payment_item(payment)
                if item is None:
                    continue
                items[payment.user_id].append(item)
                refund = sources.refund_item(payment, already_reversed=0)
                if refund is not None:
                    items[payment.user_id].append(refund)
        return items, watch

    def _collect_live(self, user_ids, items):
        """Live XP only from reliable join logs (see the module docstring)."""
        from apps.engagement.models import LiveAttendance
        from apps.realtime.models import RealtimeSession

        try:
            from apps.attendance.models import AttendanceRecord
        except ImportError:  # pragma: no cover - attendance is installed in this project
            AttendanceRecord = None
        joined_first: dict[int, tuple] = {}
        tracked: set[tuple[int, int]] = set()

        def note_join(user_id, session):
            current = joined_first.get(user_id)
            if current is None or (session.ended_at, session.pk) < (current.ended_at, current.pk):
                joined_first[user_id] = session

        if AttendanceRecord is not None:
            records = AttendanceRecord.objects.filter(
                user_id__in=user_ids,
                finalized_at__isnull=False,
                manual_override=False,
                source__in=(AttendanceRecord.SOURCE_PRESENCE, AttendanceRecord.SOURCE_JOIN),
                session__status=RealtimeSession.STATUS_ENDED,
                session__started_at__isnull=False,
                session__ended_at__isnull=False,
            ).select_related("session")
            for record in records.iterator(chunk_size=2000):
                session = record.session
                tracked.add((record.user_id, session.pk))
                if record.status == AttendanceRecord.STATUS_PRESENT:
                    item = sources.live_item_present(record, session)
                elif record.status == AttendanceRecord.STATUS_PARTIAL and record.first_joined_at:
                    item = sources.live_item_partial(record, session)
                else:
                    item = None
                if item is not None:
                    items[record.user_id].append(item)
                    note_join(record.user_id, session)
        presence = list(
            LiveAttendance.objects.filter(user_id__in=user_ids, finalized_at__isnull=False, seconds__gt=0)
        )
        sessions = RealtimeSession.objects.in_bulk(
            {row.session_id for row in presence}
        )
        for row in presence:
            session = sessions.get(row.session_id)
            if session is None or (row.user_id, row.session_id) in tracked or not session.started_at or not session.ended_at:
                continue
            item = sources.live_item(row, session)
            if item is not None:
                items[row.user_id].append(item)
                note_join(row.user_id, session)
        for user_id, session in joined_first.items():
            items[user_id].append(sources.first_live_item(user_id, session))

    # --- processing ----------------------------------------------------------------------------
    def _process(self, items_by_user, watch_by_user, *, apply, totals, points, force):
        all_keys = [item.key for items in items_by_user.values() for item in items]
        existing = set()
        for start in range(0, len(all_keys), 1000):
            existing |= set(
                XpEvent.objects.filter(idempotency_key__in=all_keys[start:start + 1000]).values_list("idempotency_key", flat=True)
            )
        day_rows = defaultdict(dict)
        if watch_by_user:
            for row in ActivityDay.objects.filter(user_id__in=list(watch_by_user)):
                day_rows[row.user_id][row.day] = row
        for user_id in sorted(set(items_by_user) | set(watch_by_user)):
            new_items = sorted(
                (item for item in items_by_user.get(user_id, []) if item.key not in existing),
                key=lambda item: item.occurred_at,
            )
            for item in new_items:
                totals[item.kind] += 1
                points[item.kind] += item.points
            watch_days = watch_by_user.get(user_id, {})
            watch_xp = 0
            for day, estimate in watch_days.items():
                row = day_rows[user_id].get(day)
                measured = int(row.watch_seconds or 0) if row else 0
                before = row.counted_watch_seconds if row else 0
                after = max(measured, estimate, before)
                totals["watch_seconds"] += max(0, after - before)
                watch_xp += max(0, rules.watch_blocks(after) - (int(row.watch_xp_awarded or 0) if row else 0))
            if watch_xp > 0:
                totals[rules.KIND_WATCH_TIME] += 1
                points[rules.KIND_WATCH_TIME] += watch_xp
            if new_items or watch_xp > 0:
                totals["users_with_xp"] += 1
            if not apply:
                continue
            if watch_days:
                services.set_backfill_watch(user_id, watch_days)
            if new_items:
                services.award_many(user_id, new_items, force=force)
            if watch_days:
                services.award_watch_xp(user_id, list(watch_days), force=force)
