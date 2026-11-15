"""Repair live-class attendance after an outage. DRY RUN unless ``--apply``.

    python manage.py attendance_repair                       # dry run: what would change
    python manage.py attendance_repair --apply               # void + re-finalise (idempotent)
    python manage.py attendance_repair --tracking-since 2026-11-16T10:00:00+05:30 --apply
    python manage.py attendance_repair --from-course-id 28   # batches below course 28 are voided
    python manage.py attendance_repair --session 224 --session 225 --apply

Two steps, both safe to run again and again:

1. **Void classes attendance does not apply to.** A class that went on air
   before ``ATTENDANCE_TRACKING_SINCE`` (or ``--tracking-since``) has no
   presence data, and a class of a batch below ``ATTENDANCE_FROM_COURSE_ID``
   (or ``--from-course-id``) is never judged; either may have been finalised
   with the whole batch marked absent. Its roster-only rows (never joined, no
   presence, no staff override) are deleted, any other finalised row is
   un-finalised and its summary is removed, so it no longer counts on any
   attendance page. A class with a staff override or an audit entry is left
   alone and listed for manual review.
2. **Re-finalise tracked classes.** Every ended class of a tracked batch that
   went on air at or after the cut-off and ended after ``--since`` (default:
   14 days ago) is finalised again from the stored presence: the Redis buffer
   is flushed first, absent rows are added for non-joiners, statuses and
   counts are recomputed. Staff overrides are never touched.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from apps.attendance import access, buffer, conf, flush, services
from apps.attendance.models import AttendanceAudit, AttendanceRecord, SessionAttendance


def _parse_moment(raw: str, *, option: str):
    raw = str(raw or "").strip()
    if not raw:
        return None
    value = parse_datetime(raw)
    if value is None:
        day = parse_date(raw)
        value = datetime(day.year, day.month, day.day) if day else None
    if value is None:
        raise CommandError(f"{option}: use an ISO date or datetime, e.g. 2026-11-16T10:00:00+05:30.")
    if timezone.is_naive(value):
        from zoneinfo import ZoneInfo

        value = timezone.make_aware(value, ZoneInfo(conf.TIMEZONE_NAME))
    return value


class Command(BaseCommand):
    help = "Void attendance attendance does not apply to and re-finalise tracked classes (dry run by default)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write. Without it nothing is changed.")
        parser.add_argument(
            "--tracking-since",
            default="",
            help="Cut-off for this run (default: ATTENDANCE_TRACKING_SINCE). Classes on air before it are voided.",
        )
        parser.add_argument(
            "--from-course-id",
            type=int,
            default=None,
            help="Batch rule for this run (default: ATTENDANCE_FROM_COURSE_ID; 0 = every course). "
            "Classes of lower course ids are voided.",
        )
        parser.add_argument(
            "--since",
            default="",
            help="Re-finalise classes that ended at/after this ISO date/datetime (default: 14 days ago).",
        )
        parser.add_argument("--session", type=int, action="append", default=[], help="Only these session ids.")
        parser.add_argument("--skip-void", action="store_true")
        parser.add_argument("--skip-refinalize", action="store_true")
        parser.add_argument("--force", action="store_true", help="Run even while the attendance switch is off.")

    def handle(self, *args, **options):
        apply = bool(options["apply"])
        if not access.enabled() and not options["force"]:
            raise CommandError("The attendance switch is off. Turn it on, or pass --force.")
        cutoff = _parse_moment(options["tracking_since"], option="--tracking-since") or conf.tracking_since()
        since = _parse_moment(options["since"], option="--since") or (timezone.now() - timedelta(days=14))
        only = {int(pk) for pk in options["session"] or []}
        first_course = options["from_course_id"]
        if first_course is None:
            first_course = conf.from_course_id()
        self.first_course = first_course if first_course and first_course > 0 else None

        mode = "APPLY" if apply else "DRY RUN (nothing is written; add --apply)"
        self.stdout.write(f"attendance_repair: {mode}")
        self.stdout.write(f"  presence buffer: {'redis (shared)' if buffer.uses_redis() else 'in-process (NOT shared)'}")
        pending = buffer.pending_snapshot()
        self.stdout.write(f"  buffered presence pairs waiting for a flush: {len(pending)}")
        self.stdout.write(f"  tracking since: {cutoff.isoformat() if cutoff else '(no cut-off)'}")
        batches = f"course id >= {self.first_course}" if self.first_course else "(every course)"
        self.stdout.write(f"  tracked batches: {batches}")
        self.stdout.write(f"  re-finalise classes ended since: {since.isoformat()}")

        voided = review = 0
        if not options["skip_void"]:
            voided, review = self._void(cutoff, only, apply)
        refinalised = 0
        if not options["skip_refinalize"]:
            refinalised = self._refinalise(cutoff, since, only, pending, apply)
        verb = "done" if apply else "would be done"
        self.stdout.write(
            self.style.SUCCESS(f"Summary ({verb}): voided={voided} needs_review={review} refinalised={refinalised}")
        )

    def _tracked(self, course_id) -> bool:
        if self.first_course is None:
            return True
        return course_id is not None and int(course_id) >= self.first_course

    # --- step 1 ------------------------------------------------------------------------------
    def _void(self, cutoff, only, apply) -> tuple[int, int]:
        from apps.realtime.models import RealtimeSession

        if cutoff is None and self.first_course is None:
            self.stdout.write("Void: skipped (no tracking cut-off and no batch rule).")
            return 0, 0
        summaries = {
            row["session_ref_id"]: row
            for row in SessionAttendance.objects.values("session_ref_id", "class_start", "course_id")
        }
        finalised_records: dict[int, int | None] = {}
        for session_id, course_id in (
            AttendanceRecord.objects.filter(finalized_at__isnull=False)
            .values_list("session_ref_id", "course_id")
            .distinct()
        ):
            if course_id is not None or session_id not in finalised_records:
                finalised_records[session_id] = course_id
        session_ids = set(summaries) | set(finalised_records)
        if only:
            session_ids &= only
        sessions = {
            row["pk"]: row
            for row in RealtimeSession.objects.filter(pk__in=session_ids).values(
                "pk", "started_at", "linked_course_id", "linked_live_class__linked_course_id"
            )
        }
        voided = review = 0
        for session_id in sorted(session_ids):
            row = sessions.get(session_id) or {}
            summary = summaries.get(session_id) or {}
            started_at = row.get("started_at") or summary.get("class_start")
            course_id = (
                row.get("linked_course_id")
                or row.get("linked_live_class__linked_course_id")
                or summary.get("course_id")
                or finalised_records.get(session_id)
            )
            reasons = []
            if cutoff is not None and started_at is not None and started_at < cutoff:
                reasons.append("before tracking")
            if not self._tracked(course_id):
                reasons.append(f"batch {course_id} not tracked")
            if not reasons:
                continue
            why = ", ".join(reasons)
            on_air = started_at.isoformat() if started_at else "unknown"
            records = AttendanceRecord.objects.filter(session_ref_id=session_id)
            protected = records.filter(manual_override=True).count()
            audited = AttendanceAudit.objects.filter(record__session_ref_id=session_id).count()
            if protected or audited:
                review += 1
                self.stdout.write(
                    self.style.WARNING(
                        f"Void: session {session_id} (on air {on_air}, {why}) has {protected} staff "
                        f"override(s) / {audited} audit entr(ies): left alone, review it by hand."
                    )
                )
                continue
            untouched = records.filter(
                source=AttendanceRecord.SOURCE_ROSTER, seconds_present=0, first_joined_at__isnull=True
            )
            n_untouched = untouched.count()
            n_other = records.filter(finalized_at__isnull=False).count() - untouched.filter(
                finalized_at__isnull=False
            ).count()
            has_summary = session_id in summaries
            self.stdout.write(
                f"Void: session {session_id} (on air {on_air}, {why}): "
                f"delete {n_untouched} roster-only row(s), un-finalise {n_other} other row(s), "
                f"{'delete' if has_summary else 'no'} summary."
            )
            voided += 1
            if not apply:
                continue
            with transaction.atomic():
                untouched.delete()
                AttendanceRecord.objects.filter(session_ref_id=session_id, finalized_at__isnull=False).update(
                    finalized_at=None, on_air_seconds=0, percent=0, updated_at=timezone.now()
                )
                SessionAttendance.objects.filter(session_ref_id=session_id).delete()
        return voided, review

    # --- step 2 ------------------------------------------------------------------------------
    def _refinalise(self, cutoff, since, only, pending, apply) -> int:
        from apps.realtime.models import RealtimeSession

        settle = timezone.now() - timedelta(seconds=conf.finalize_delay_seconds())
        sessions = RealtimeSession.objects.filter(
            status=RealtimeSession.STATUS_ENDED,
            started_at__isnull=False,
            ended_at__isnull=False,
            ended_at__gte=since,
            ended_at__lte=settle,
        )
        if cutoff is not None:
            sessions = sessions.filter(started_at__gte=cutoff)
        if self.first_course is not None:
            sessions = sessions.filter(
                Q(linked_course_id__gte=self.first_course)
                | Q(linked_course__isnull=True, linked_live_class__linked_course_id__gte=self.first_course)
            )
        if only:
            sessions = sessions.filter(pk__in=only)
        rows = list(sessions.order_by("ended_at").values("pk", "title", "started_at", "ended_at"))
        if not rows:
            self.stdout.write("Re-finalise: no ended tracked classes in the window.")
            return 0
        summaries = {
            row.session_ref_id: row
            for row in SessionAttendance.objects.filter(session_ref_id__in=[r["pk"] for r in rows])
        }
        buffered: dict[int, int] = {}
        for session_id, _user_id in pending:
            buffered[session_id] = buffered.get(session_id, 0) + 1
        if apply:
            stats = flush.flush()
            self.stdout.write(f"Re-finalise: flushed the presence buffer first {stats}.")
        done = 0
        for row in rows:
            summary = summaries.get(row["pk"])
            before = (
                f"present={summary.present_count} partial={summary.partial_count} absent={summary.absent_count}"
                if summary and summary.finalized_at
                else "not finalised"
            )
            presence_rows = (
                AttendanceRecord.objects.filter(session_ref_id=row["pk"])
                .exclude(source=AttendanceRecord.SOURCE_ROSTER)
                .count()
            )
            line = (
                f"Re-finalise: session {row['pk']} '{str(row['title'])[:50]}' "
                f"{row['started_at'].isoformat()} -> {row['ended_at'].isoformat()}: {before}; "
                f"stored presence rows={presence_rows} buffered pairs={buffered.get(row['pk'], 0)}"
            )
            if not apply:
                self.stdout.write(line)
                done += 1
                continue
            result = services.finalize_session(row["pk"], flush_first=False)
            if result is None:
                self.stdout.write(f"{line} -> skipped")
                continue
            done += 1
            self.stdout.write(
                f"{line} -> present={result.present_count} partial={result.partial_count} "
                f"absent={result.absent_count} excused={result.excused_count}"
            )
        return done
