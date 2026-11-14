"""The student identity block: one order, everywhere a submission is saved or shown.

Owner rule. Whenever we save or show a student's submission data (weekly
reports, exam and CTF attempts and participations, the gradebook, attendance
exports, admin lists, CSV exports, grader views) the student block comes first
and always in this order:

1. ``roll_number``: the canonical ``AL-SYD-<user id, 5 digits>``;
2. ``real_name``: the account's full name;
3. ``handle``: the student's profile handle (the snapshot taken at submission
   time on a record, otherwise the most recent one; ``None`` -> shown as "—"),
   with ``handle_most_recent`` next to it when the two differ;
4. ``stats``: XP and rank (only while the ``engagement`` switch is on),
   attendance % (40-minute live rule), reports submitted and their graded
   average, and the exam score;
5. then the record's own fields.

Everything here is bulk: ``identity_blocks`` answers for any number of users
with a fixed number of queries (one per data source), so list views and
streamed exports stay free of N+1 queries.

Real names are staff/self data. Public surfaces (leaderboards, /u/<handle>)
keep using handles only; never put this block on a public endpoint.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Iterable
from decimal import Decimal
from typing import Any

from django.apps import apps as django_apps
from django.db import transaction

ROLL_PREFIX = "AL-SYD-"
EMPTY = "—"

# CSV / table header, in the owner's order. Record-specific columns follow.
IDENTITY_HEADER = [
    "Roll number",
    "Real name",
    "Handle",
    "Handle (most recent)",
    "XP",
    "Rank",
    "Attendance %",
    "Reports submitted",
    "Reports graded average %",
    "Exam score %",
]

# Model fields that hold the submission-time snapshot (additive, nullable).
SNAPSHOT_FIELDS = ("student_roll_number", "student_name_snapshot", "student_handle_snapshot")


# --- the three identity values --------------------------------------------------------------
def _user_id(user_or_id) -> int | None:
    if user_or_id is None:
        return None
    if isinstance(user_or_id, int):
        return user_or_id
    if isinstance(user_or_id, dict):  # presenter dicts: {"id": ..., "full_name": ...}
        user_or_id = user_or_id.get("id")
        return int(user_or_id) if user_or_id is not None else None
    value = getattr(user_or_id, "pk", None)
    if value is None:
        value = getattr(user_or_id, "id", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def roll_number(user_or_id) -> str:
    """``AL-SYD-00042`` for user 42 (the format printed on ID cards and reviews)."""
    user_id = _user_id(user_or_id)
    return f"{ROLL_PREFIX}{int(user_id or 0):05d}"


def real_name(user) -> str:
    if isinstance(user, dict):
        return str(user.get("full_name") or "").strip()
    return str(getattr(user, "full_name", "") or "").strip()


def handles_for(user_ids: Iterable[int]) -> dict[int, str]:
    """Most recent profile handle per user (one query; users without a profile are absent)."""
    ids = {int(item) for item in user_ids if item is not None}
    if not ids or not django_apps.is_installed("apps.profiles"):
        return {}
    model = django_apps.get_model("profiles", "StudentProfile")
    return dict(model.objects.filter(user_id__in=ids).values_list("user_id", "handle"))


def current_handle(user_or_id) -> str | None:
    user_id = _user_id(user_or_id)
    return handles_for([user_id]).get(user_id) if user_id else None


def snapshot_values(user, *, handle: str | None | type(Ellipsis) = ...) -> dict[str, Any]:
    """The values to store on a record at submission time."""
    if handle is ...:
        handle = current_handle(user)
    return {
        "student_roll_number": roll_number(user),
        "student_name_snapshot": real_name(user)[:255],
        "student_handle_snapshot": (handle or None),
    }


def apply_snapshot(instance, user, *, overwrite: bool = False, handle=...) -> list[str]:
    """Set the snapshot fields on ``instance`` (not saved). Returns the changed field names.

    By default an existing snapshot is kept: the snapshot records who the
    student was when they *first* submitted that record.
    """
    if not all(hasattr(instance, name) for name in SNAPSHOT_FIELDS):
        return []
    if not overwrite and getattr(instance, "student_roll_number", None):
        return []
    changed = []
    for name, value in snapshot_values(user, handle=handle).items():
        if getattr(instance, name, None) != value:
            setattr(instance, name, value)
            changed.append(name)
    return changed


def snapshot_of(instance) -> dict[str, Any] | None:
    """The stored snapshot on a record, or ``None`` before it was taken/backfilled."""
    roll = getattr(instance, "student_roll_number", None)
    if not roll:
        return None
    return {
        "roll_number": roll,
        "real_name": getattr(instance, "student_name_snapshot", None) or "",
        "handle": getattr(instance, "student_handle_snapshot", None) or None,
    }


# --- stats (bulk) ---------------------------------------------------------------------------
def _feature_on(key: str) -> bool:
    try:
        from apps.core import features

        return features.is_enabled(key)
    except Exception:  # noqa: BLE001 - stats are informative and never break a view
        return False


def _percent(part, whole) -> float | None:
    try:
        whole = Decimal(str(whole))
        if not whole:
            return None
        return float(round(Decimal(str(part)) * 100 / whole, 1))
    except Exception:  # noqa: BLE001
        return None


def empty_stats() -> dict[str, Any]:
    return {
        "xp": None,
        "rank": None,
        "attendance_percent": None,
        "attendance_attended": 0,
        "attendance_total": 0,
        "reports_submitted": 0,
        "reports_graded": 0,
        "reports_graded_average": None,
        "exam_score": None,
        "exams_taken": 0,
    }


def _engagement(ids, stats) -> None:
    if not django_apps.is_installed("apps.engagement") or not _feature_on("engagement"):
        return
    from apps.engagement.models import EngagementSummary
    from apps.engagement.rules import level_for

    for user_id, total_xp in EngagementSummary.objects.filter(user_id__in=ids).values_list("user_id", "total_xp"):
        stats[user_id]["xp"] = int(total_xp or 0)
        stats[user_id]["rank"] = level_for(int(total_xp or 0)).title
    for user_id in ids:  # engagement on, but no activity yet: 0 XP at the first level
        if stats[user_id]["xp"] is None:
            stats[user_id]["xp"] = 0
            stats[user_id]["rank"] = level_for(0).title


def _attendance(ids, stats, course_id) -> None:
    if not django_apps.is_installed("apps.attendance") or not _feature_on("attendance"):
        return
    from django.db.models import Count

    from apps.attendance import policy
    from apps.attendance.models import AttendanceRecord

    rows = AttendanceRecord.objects.filter(user_id__in=ids, finalized_at__isnull=False)
    if course_id:
        rows = rows.filter(course_id=course_id)
    counts: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for row in rows.values("user_id", "status").annotate(n=Count("id")).order_by():
        counts[row["user_id"]][row["status"]] += row["n"]
    for user_id, by_status in counts.items():
        attended = sum(n for status, n in by_status.items() if policy.counts_as_attended(status))
        total = sum(n for status, n in by_status.items() if policy.counts_in_total(status))
        stats[user_id]["attendance_attended"] = attended
        stats[user_id]["attendance_total"] = total
        stats[user_id]["attendance_percent"] = round(100.0 * attended / total, 1) if total else None


def _reports(ids, stats, course_id, include_unreleased) -> None:
    from django.db.models import Count, Q

    from apps.reports.models import ReportGrade, ReportSubmission, ReportTask

    submissions = ReportSubmission.objects.filter(student_id__in=ids).exclude(
        status=ReportSubmission.STATUS_NOT_SUBMITTED
    )
    if course_id:
        submissions = submissions.filter(task__course_id=course_id)
    for row in submissions.values("student_id").annotate(n=Count("id")).order_by():
        stats[row["student_id"]]["reports_submitted"] = row["n"]

    grades = ReportGrade.objects.filter(
        submission__student_id__in=ids,
        submission__status=ReportSubmission.STATUS_GRADED,
        final_marks__isnull=False,
    )
    if course_id:
        grades = grades.filter(submission__task__course_id=course_id)
    if not include_unreleased:  # the student's own view: only marks they can already see
        grades = grades.filter(
            Q(submission__task__marks_visibility=ReportTask.MARKS_ON_GRADE)
            | Q(submission__task__marks_released_at__isnull=False)
        )
    percents: dict[int, list[float]] = defaultdict(list)
    for student_id, final_marks, max_marks in grades.values_list(
        "submission__student_id", "final_marks", "submission__task__max_marks"
    ):
        value = _percent(final_marks, max_marks)
        if value is not None:
            percents[student_id].append(value)
    for student_id, values in percents.items():
        stats[student_id]["reports_graded"] = len(values)
        stats[student_id]["reports_graded_average"] = round(sum(values) / len(values), 1)


def _exams(ids, stats, course_id) -> None:
    from apps.ctf.models import CtfExamResult

    results = CtfExamResult.objects.filter(user_id__in=ids)
    if course_id:
        results = results.filter(batch_course_id=course_id)
    percents: dict[int, list[float]] = defaultdict(list)
    for user_id, score, total in results.values_list("user_id", "score", "total_points"):
        value = _percent(score, total)
        if value is not None:
            percents[user_id].append(value)
    for user_id, values in percents.items():
        stats[user_id]["exams_taken"] = len(values)
        stats[user_id]["exam_score"] = round(sum(values) / len(values), 1)


def stats_for(user_ids: Iterable[int], *, course_id=None, include_unreleased: bool = True) -> dict[int, dict]:
    """Stats for many users at once (at most ~6 queries whatever the number of users).

    ``course_id`` scopes attendance, reports and exams to one batch (an export
    of that batch). ``include_unreleased=False`` hides report marks the student
    cannot see yet (use it for the student's own header).
    """
    ids = sorted({int(item) for item in user_ids if item is not None})
    stats = {user_id: empty_stats() for user_id in ids}
    if not ids:
        return stats
    for loader in (
        lambda: _engagement(ids, stats),
        lambda: _attendance(ids, stats, course_id),
        lambda: _reports(ids, stats, course_id, include_unreleased),
        lambda: _exams(ids, stats, course_id),
    ):
        try:
            # A savepoint, so a failing source (a table missing mid-deploy) never
            # poisons the caller's transaction.
            with transaction.atomic():
                loader()
        except Exception:  # noqa: BLE001 - stats must never break a grader view or an export
            logging.getLogger(__name__).exception("identity stats source failed")
    return stats


# --- the block -------------------------------------------------------------------------------
def identity_block(user, *, snapshot=None, handle_now=..., stats=None) -> dict[str, Any]:
    """One student's block, keys in the owner's order.

    ``snapshot`` is ``snapshot_of(record)`` for a record-bound block;
    ``handle_now`` the most recent handle (looked up when not given).
    """
    user_id = _user_id(user)
    if handle_now is ...:
        handle_now = current_handle(user_id)
    handle_now = handle_now or None
    if snapshot:
        handle = snapshot.get("handle") or None
        block = {
            "roll_number": snapshot.get("roll_number") or roll_number(user_id),
            "real_name": snapshot.get("real_name") or real_name(user),
            "handle": handle,
        }
    else:
        handle = handle_now
        block = {"roll_number": roll_number(user_id), "real_name": real_name(user), "handle": handle}
    block["handle_most_recent"] = handle_now
    block["handle_changed"] = bool(snapshot) and handle != handle_now
    block["stats"] = stats if stats is not None else None
    block["snapshot"] = bool(snapshot)
    block["user_id"] = user_id
    return block


def identity_blocks(
    pairs: Iterable[tuple[Any, Any]],
    *,
    with_stats: bool = True,
    course_id=None,
    include_unreleased: bool = True,
) -> list[dict[str, Any]]:
    """Blocks for ``(user, record_or_None)`` pairs, in the same order, bulk-loaded."""
    pairs = list(pairs)
    ids = [_user_id(user) for user, _record in pairs]
    # Callers may pass bare ids or presenter dicts without a name: load those names in one query.
    missing = {
        _user_id(user)
        for user, _record in pairs
        if isinstance(user, int) or (isinstance(user, dict) and "full_name" not in user)
    }
    if missing:
        names = dict(
            django_apps.get_model("users", "User").objects.filter(pk__in=missing).values_list("pk", "full_name")
        )
        pairs = [
            (
                {"id": _user_id(user), "full_name": names.get(_user_id(user), "")}
                if _user_id(user) in missing
                else user,
                record,
            )
            for user, record in pairs
        ]
    handles = handles_for(ids)
    stats = stats_for(ids, course_id=course_id, include_unreleased=include_unreleased) if with_stats else {}
    return [
        identity_block(
            user,
            snapshot=snapshot_of(record) if record is not None else None,
            handle_now=handles.get(_user_id(user)),
            stats=stats.get(_user_id(user)) if with_stats else None,
        )
        for user, record in pairs
    ]


def block_for_user(user, *, record=None, course_id=None, include_unreleased: bool = True) -> dict[str, Any]:
    return identity_blocks([(user, record)], course_id=course_id, include_unreleased=include_unreleased)[0]


def _cell(value) -> Any:
    return EMPTY if value is None or value == "" else value


def identity_cells(block: dict[str, Any]) -> list[Any]:
    """The ``IDENTITY_HEADER`` cells for one block (``—`` for missing values)."""
    stats = block.get("stats") or {}
    return [
        block["roll_number"],
        block["real_name"] or EMPTY,
        _cell(block.get("handle")),
        _cell(block.get("handle_most_recent")),
        _cell(stats.get("xp")),
        _cell(stats.get("rank")),
        _cell(stats.get("attendance_percent")),
        stats.get("reports_submitted", 0),
        _cell(stats.get("reports_graded_average")),
        _cell(stats.get("exam_score")),
    ]


def chunked_blocks(items, user_of, record_of=None, *, size: int = 500, **kwargs):
    """Yield ``(item, block)`` for a (streamed) iterable, loading blocks per chunk."""
    chunk: list = []
    for item in items:
        chunk.append(item)
        if len(chunk) >= size:
            yield from _emit(chunk, user_of, record_of, kwargs)
            chunk = []
    if chunk:
        yield from _emit(chunk, user_of, record_of, kwargs)


def _emit(chunk, user_of, record_of, kwargs):
    blocks = identity_blocks([(user_of(item), record_of(item) if record_of else None) for item in chunk], **kwargs)
    yield from zip(chunk, blocks, strict=True)
