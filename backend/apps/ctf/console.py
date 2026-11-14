"""Console -> Exams: the staff workflow that replaces scp + docker exec +
Django admin (upload, dry run, batches, schedule, publish, close, results).

Views (``console_views.py``) map HTTP to these functions. Staff manage
every exam; instructors only read results for the batches they teach.
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime

from django.db import IntegrityError, transaction
from django.db.models import Avg, Count, Max, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core import textnorm
from apps.core.errors import Conflict, ValidationFailed
from apps.core.outbox import publish
from apps.courses.access import active_enrollment_q
from apps.courses.models import Course

from . import access, scheduler
from .loader import ExamFileError, load_exam
from .models import CtfAttempt, CtfExam, CtfMaterial, CtfParticipation, CtfQuestion
from .readiness import check_exam, material_status

logger = logging.getLogger("apps.ctf.console")

STATE_DRAFT = "draft"
STATE_SCHEDULED = "scheduled"
STATE_PUBLISHED = "published"
STATE_CLOSED = "closed"
STATE_CHOICES = [
    (STATE_DRAFT, "Draft"),
    (STATE_SCHEDULED, "Scheduled"),
    (STATE_PUBLISHED, "Published"),
    (STATE_CLOSED, "Closed"),
]
WRONG_CLUSTER_LIMIT = 5


def exam_state(exam):
    if exam.status == CtfExam.STATUS_DRAFT:
        return STATE_SCHEDULED if exam.auto_publish else STATE_DRAFT
    return exam.status


# ---------------------------------------------------------------------------
# Presenters
# ---------------------------------------------------------------------------
def batch_dict(course):
    return {"id": course.pk, "slug": course.slug, "title": course.title, "batch": getattr(course, "batch", "") or ""}


def _participation_counts(exam, course_ids=None):
    queryset = CtfParticipation.objects.filter(exam=exam, is_staff_preview=False)
    if course_ids is not None:
        queryset = queryset.filter(batch_course_id__in=course_ids)
    stats = queryset.aggregate(
        participants=Count("id"),
        active=Count("id", filter=Q(status=CtfParticipation.STATUS_ACTIVE)),
        submitted=Count("id", filter=Q(status=CtfParticipation.STATUS_SUBMITTED)),
        expired=Count("id", filter=Q(status=CtfParticipation.STATUS_EXPIRED)),
        average_score=Avg("score"),
        top_score=Max("score"),
    )
    average = stats["average_score"]
    return {
        "participants": int(stats["participants"] or 0),
        "active": int(stats["active"] or 0),
        "submitted": int(stats["submitted"] or 0),
        "expired": int(stats["expired"] or 0),
        "average_score": round(float(average), 1) if average is not None else None,
        "top_score": stats["top_score"],
    }


def exam_row(exam, *, user, at=None):
    now = at or timezone.now()
    question_count, total_points = scheduler.exam_totals(exam)
    staff = access.is_staff_user(user)
    readiness = check_exam(exam, at=now) if staff else None
    return {
        "slug": exam.slug,
        "title": exam.title,
        "state": exam_state(exam),
        "status": exam.status,
        "window": exam.window(now),
        "opens_at": exam.opens_at,
        "closes_at": exam.closes_at,
        "time_limit_minutes": exam.time_limit_minutes,
        "question_count": question_count,
        "total_points": total_points,
        "batches": [batch_dict(course) for course in exam.eligible_courses.all().order_by("title")],
        "ready": readiness.ready if readiness else None,
        "stats": _participation_counts(exam, access.result_course_scope(user)),
        "results_finalized_at": exam.results_finalized_at,
    }


def exam_detail(exam, *, user, at=None):
    now = at or timezone.now()
    staff = access.is_staff_user(user)
    row = exam_row(exam, user=user, at=now)
    referenced, uploaded = material_status(exam)
    uploaded_rows = {item.path: item for item in CtfMaterial.objects.filter(exam=exam)}
    questions = []
    for question in CtfQuestion.objects.filter(exam=exam, is_active=True).order_by("order", "id"):
        items = []
        for item in question.materials if isinstance(question.materials, list) else []:
            if not isinstance(item, dict) or not item.get("path"):
                continue
            material = uploaded_rows.get(str(item["path"]))
            items.append(
                {
                    "path": str(item["path"]),
                    "label": str((item.get("label") or {}).get("en") or "") if isinstance(item.get("label"), dict) else "",
                    "kind": "image" if item.get("kind") == "image" else "file",
                    "uploaded": material is not None,
                    "material_id": material.pk if material else None,
                    "size": material.size if material else None,
                }
            )
        questions.append(
            {
                "key": question.key,
                "order": question.order,
                "title": question.title_en or question.key,
                "category": question.category,
                "difficulty": question.difficulty,
                "points": question.points,
                "max_attempts": question.effective_max_attempts(exam),
                "materials": items,
            }
        )
    readiness = check_exam(exam, at=now).as_dict() if staff else None
    return {
        **row,
        "title_ur": exam.title_ur,
        "default_max_attempts": exam.default_max_attempts,
        "auto_publish": exam.auto_publish,
        "published_at": exam.published_at,
        "closed_at": exam.closed_at,
        "content_loaded_at": exam.content_loaded_at,
        "content_fingerprint": (exam.content_sha256 or "")[:16],
        "questions": questions,
        "materials": {"referenced": len(referenced), "uploaded": len([p for p in referenced if p in uploaded])},
        "readiness": readiness,
        "can_manage": staff,
        "labs_url": _labs_url(),
    }


def _labs_url():
    from .notify import labs_exam_url

    return labs_exam_url()


def results(exam, *, user):
    scope = access.result_course_scope(user)
    board = scheduler.leaderboard(exam)
    if scope is not None:
        board = board.filter(batch_course_id__in=scope)
    rows = []
    previous_key = None
    rank = 0
    for position, participation in enumerate(board, 1):
        key = (participation.score, participation.last_correct_at)
        if key != previous_key:
            rank, previous_key = position, key
        student = participation.user
        rows.append(
            {
                "rank": rank,
                "student": {"id": student.pk, "full_name": getattr(student, "full_name", "") or "", "email": student.email},
                "batch": batch_dict(participation.batch_course) if participation.batch_course else None,
                "status": participation.status,
                "score": participation.score,
                "solved_count": participation.solved_count,
                "wrong_count": participation.wrong_count,
                "attempt_count": participation.attempt_count,
                "started_at": participation.started_at,
                "deadline_at": participation.deadline_at,
                "submitted_at": participation.submitted_at,
            }
        )
    question_count, total_points = scheduler.exam_totals(exam)
    return {
        "exam": {
            "slug": exam.slug,
            "title": exam.title,
            "state": exam_state(exam),
            "question_count": question_count,
            "total_points": total_points,
        },
        "stats": _participation_counts(exam, scope),
        "participants": rows,
        "questions": question_stats(exam, scope),
    }


CLUSTER_RULES = ("nfkc", "casefold", "strip_diacritics", "strip_punctuation", "collapse_whitespace", "trim")


def _cluster_key(text):
    """Fold near-identical wrong answers together for the monitor, with the
    shared normaliser (apps.core.textnorm) used for answers and report targets."""
    folded = textnorm.normalize(str(text or ""), CLUSTER_RULES)
    return folded or str(text or "").strip()


def question_stats(exam, scope=None):
    """Per question: solve rate and the most common wrong answers."""
    attempts = CtfAttempt.objects.filter(exam=exam, participation__is_staff_preview=False)
    if scope is not None:
        attempts = attempts.filter(participation__batch_course_id__in=scope)
    per_question = {
        row["question_id"]: row
        for row in attempts.values("question_id").annotate(
            attempted=Count("participation_id", distinct=True),
            solved=Count("id", filter=Q(is_correct=True)),
        )
    }
    wrong = (
        attempts.filter(is_correct=False)
        .exclude(normalized_answer="")
        .values("question_id", "normalized_answer")
        .annotate(count=Count("id"))
        .order_by("question_id", "-count")
    )
    clusters = {}
    for row in wrong[:5000]:
        bucket = clusters.setdefault(row["question_id"], Counter())
        bucket[_cluster_key(row["normalized_answer"])] += int(row["count"])
    items = []
    for question in CtfQuestion.objects.filter(exam=exam, is_active=True).order_by("order", "id"):
        stats = per_question.get(question.pk, {})
        attempted = int(stats.get("attempted") or 0)
        solved = int(stats.get("solved") or 0)
        items.append(
            {
                "key": question.key,
                "order": question.order,
                "title": question.title_en or question.key,
                "points": question.points,
                "attempted": attempted,
                "solved": solved,
                "solve_rate": round(solved * 100.0 / attempted, 1) if attempted else None,
                "wrong_answers": [
                    {"answer": answer[:120], "count": count}
                    for answer, count in clusters.get(question.pk, Counter()).most_common(WRONG_CLUSTER_LIMIT)
                ],
            }
        )
    return items


def batch_options():
    courses = Course.objects.annotate(
        student_count=Count(
            "enrollments__user", filter=active_enrollment_q(prefix="enrollments__"), distinct=True
        )
    ).order_by("title", "id")
    return [{**batch_dict(course), "student_count": int(course.student_count or 0)} for course in courses]


# ---------------------------------------------------------------------------
# Upload (dry run and load)
# ---------------------------------------------------------------------------
def report_dict(report, *, exam):
    return {
        "slug": report.slug,
        "title": report.title,
        "exam_created": report.exam_created,
        "dry_run": report.dry_run,
        "created": report.created,
        "updated": report.updated,
        "unchanged": report.unchanged,
        "deactivated": report.deactivated,
        "removed": report.removed,
        "question_count": report.question_count,
        "total_points": report.total_points,
        "materials_referenced": report.materials_referenced,
        "eligible_courses": report.eligible_courses,
        "changed_with_attempts": list(report.changed_with_attempts),
        "opens_at": report.opens_at,
        "closes_at": report.closes_at,
        "time_limit_minutes": report.time_limit_minutes,
        "content_fingerprint": report.content_sha256[:16],
        "current_state": exam_state(exam) if exam is not None else None,
    }


def run_upload(raw, *, dry_run, allow_content_change=False):
    try:
        report = load_exam(
            raw, dry_run=dry_run, allow_content_change=allow_content_change, preserve_schedule=True
        )
    except ExamFileError as exc:
        raise ValidationFailed(
            "The exam file was not loaded. Fix the problems listed and try again.",
            code="ctf_exam_file_invalid",
            details={"problems": exc.problems[:100]},
        ) from None
    except IntegrityError:
        raise ValidationFailed(
            "The exam file's times conflict with the schedule already set (closing must be after opening).",
            code="ctf_exam_file_invalid",
            details={"problems": ["exam: closes_at must be after opens_at"]},
        ) from None
    exam = CtfExam.objects.filter(slug=report.slug).first()
    if exam is not None and exam_state(exam) == STATE_CLOSED and not dry_run:
        logger.warning("ctf exam %s: content reloaded after it closed", exam.slug)
    return report_dict(report, exam=exam), exam


# ---------------------------------------------------------------------------
# Schedule, publish, close
# ---------------------------------------------------------------------------
def _moment(value, field):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if timezone.is_aware(value) else timezone.make_aware(value)
    parsed = parse_datetime(str(value))
    if parsed is None or timezone.is_naive(parsed):
        raise ValidationFailed(
            "Use a full date and time with its UTC offset.", code="validation_failed", details={field: ["Invalid date."]}
        )
    return parsed


def _same_minute(left, right):
    if left is None or right is None:
        return left is None and right is None
    return left.replace(second=0, microsecond=0) == right.replace(second=0, microsecond=0)


def resolve_batches(ids=None, slugs=None):
    ids = [int(item) for item in (ids or [])]
    slugs = [str(item) for item in (slugs or [])]
    courses = list(Course.objects.filter(Q(pk__in=ids) | Q(slug__in=slugs)))
    found_ids = {course.pk for course in courses}
    found_slugs = {course.slug for course in courses}
    missing = [str(item) for item in ids if item not in found_ids] + [item for item in slugs if item not in found_slugs]
    if missing:
        raise ValidationFailed(
            "Unknown batch: " + ", ".join(missing[:10]), code="validation_failed", details={"batches": missing[:10]}
        )
    return courses


def update_exam(exam, data, *, at=None):
    """Staff edit of the window, time limit and batches."""
    now = at or timezone.now()
    with transaction.atomic():
        exam = CtfExam.objects.select_for_update().get(pk=exam.pk)
        if exam.status == CtfExam.STATUS_CLOSED:
            raise Conflict("This exam has closed and can no longer change.", code="ctf_exam_closed")
        published = exam.status == CtfExam.STATUS_PUBLISHED
        if "opens_at" in data:
            opens_at = _moment(data["opens_at"], "opens_at")
            # The Console edits to the minute: the same minute means "unchanged".
            if not _same_minute(opens_at, exam.opens_at):
                if published and exam.window(now) != CtfExam.WINDOW_NOT_OPEN:
                    raise Conflict("The exam is already open; its opening time cannot change.", code="ctf_exam_open")
                exam.opens_at = opens_at
        if "closes_at" in data and not _same_minute(_moment(data["closes_at"], "closes_at"), exam.closes_at):
            closes_at = _moment(data["closes_at"], "closes_at")
            if published and (closes_at is None or closes_at <= now):
                raise ValidationFailed(
                    "A published exam needs a closing time in the future.",
                    code="validation_failed",
                    details={"closes_at": ["Choose a time in the future."]},
                )
            exam.closes_at = closes_at
        if exam.opens_at and exam.closes_at and exam.closes_at <= exam.opens_at:
            raise ValidationFailed(
                "The exam must close after it opens.",
                code="validation_failed",
                details={"closes_at": ["Must be after the opening time."]},
            )
        if "time_limit_minutes" in data:
            exam.time_limit_minutes = data["time_limit_minutes"]
        if "default_max_attempts" in data and data["default_max_attempts"]:
            exam.default_max_attempts = data["default_max_attempts"]
        exam.save()
        if "batch_ids" in data or "batch_slugs" in data:
            exam.eligible_courses.set(resolve_batches(data.get("batch_ids"), data.get("batch_slugs")))
    return exam


def publish_exam(exam, *, at=None):
    """Publish now, or schedule when the opening time is in the future.
    Refused (409 with every reason) while the readiness checklist fails."""
    now = at or timezone.now()
    with transaction.atomic():
        exam = CtfExam.objects.select_for_update().get(pk=exam.pk)
        if exam.status == CtfExam.STATUS_CLOSED:
            raise Conflict("This exam has closed.", code="ctf_exam_closed")
        if exam.status == CtfExam.STATUS_PUBLISHED:
            raise Conflict("This exam is already published.", code="ctf_exam_already_published")
        readiness = check_exam(exam, at=now)
        if not readiness.ready:
            raise Conflict(
                "The exam is not ready to publish: " + "; ".join(readiness.reasons()),
                code="ctf_exam_not_ready",
                details={"reasons": readiness.reasons()},
            )
        if exam.opens_at and exam.opens_at > now:
            exam.auto_publish = True
            exam.save(update_fields=["auto_publish", "updated_at"])
        else:
            exam.status = CtfExam.STATUS_PUBLISHED
            exam.auto_publish = False
            exam.published_at = now
            exam.save(update_fields=["status", "auto_publish", "published_at", "updated_at"])
            publish(
                scheduler.EVENT_NOTIFY_PUBLISHED, {"exam_id": exam.pk}, dedupe_key=f"ctf-exam-published:{exam.pk}"
            )
    return exam


def unschedule_exam(exam):
    with transaction.atomic():
        exam = CtfExam.objects.select_for_update().get(pk=exam.pk)
        if exam.status != CtfExam.STATUS_DRAFT or not exam.auto_publish:
            raise Conflict("This exam is not scheduled.", code="ctf_exam_not_scheduled")
        exam.auto_publish = False
        exam.save(update_fields=["auto_publish", "updated_at"])
    return exam


def close_exam(exam, *, at=None):
    """Close now: answers stop, active students are expired and the results
    go to the gradebook straight away (the scheduler would within a minute)."""
    now = at or timezone.now()
    with transaction.atomic():
        exam = CtfExam.objects.select_for_update().get(pk=exam.pk)
        if exam.status != CtfExam.STATUS_PUBLISHED:
            raise Conflict("Only a published exam can be closed.", code="ctf_exam_not_published")
        exam.status = CtfExam.STATUS_CLOSED
        exam.closed_at = now
        exam.save(update_fields=["status", "closed_at", "updated_at"])
    CtfParticipation.objects.filter(exam=exam, status=CtfParticipation.STATUS_ACTIVE, is_staff_preview=False).update(
        status=CtfParticipation.STATUS_EXPIRED, updated_at=now
    )
    scheduler.finalize_exam_results(exam, now)
    exam.refresh_from_db()
    return exam


def open_exam_summary(at=None):
    """Staff Console card: exams open right now and scheduled ones."""
    now = at or timezone.now()
    from .eligibility import open_exam_filter

    open_exams = list(CtfExam.objects.filter(open_exam_filter(now)).order_by("closes_at", "id")[:5])
    scheduled = list(
        CtfExam.objects.filter(status=CtfExam.STATUS_DRAFT, auto_publish=True).order_by("opens_at", "id")[:5]
    )
    return {
        "open": [
            {
                "slug": exam.slug,
                "title": exam.title,
                "closes_at": exam.closes_at,
                "active": CtfParticipation.objects.filter(
                    exam=exam, status=CtfParticipation.STATUS_ACTIVE, is_staff_preview=False
                ).count(),
            }
            for exam in open_exams
        ],
        "scheduled": [{"slug": exam.slug, "title": exam.title, "opens_at": exam.opens_at} for exam in scheduled],
        "labs_url": _labs_url(),
        "server_time": now,
    }
