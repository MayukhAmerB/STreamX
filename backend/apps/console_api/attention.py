"""Admin "needs attention" queues (plan §4.4, Appendix A.3).

OWNER: WS-G. Shared by ``GET /api/admin/attention/`` and the Django back
office index (WS-E calls :func:`get_queues` server-side), so both rooms show
the same numbers.

Each of the 11 queues is one bounded aggregate (count + oldest) over existing
fields; the whole payload costs at most ~20 SQL queries and is cached per
viewer for ``ADMIN_ATTENTION_CACHE_SECONDS`` (30 s). Any admin action taken
through the Console services calls :func:`bump_version`, so the acting admin
sees the new count at once.

Permission-aware: a queue backed by Django models the viewer may not view
keeps its place (the contract lists all queues in order) with ``count: null``
and ``oldest_at: null``; the Console and the Django index hide those tiles.
Console-native work (grading, recordings, exams) is open to all staff, as in
the Console itself.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Callable

from django.conf import settings
from django.core.cache import cache
from django.db import DatabaseError
from django.db.models import Count, Min, Q
from django.utils import timezone

from apps.core import features

from .permissions import is_staff_user

logger = logging.getLogger(__name__)

QUEUE_KEYS = (
    "enrolment_requests",
    "reports_to_grade",
    "recordings_to_review",
    "uploads_failed",
    "payments_to_action",
    "exams_to_publish",
    "leads",
    "flagged_content",
    "quarantined_files",
    "system_issues",
    # hackpath WS-STAFF (additive, appended so the first ten keep their order):
    # paid platform plans ship disabled until the owner confirms an INR price.
    "plans_awaiting_price",
)
SEVERITIES = ("normal", "high")
FEATURES_HREF = "/console/admin/settings/features"
CACHE_PREFIX = "admin:attention:v1"
VERSION_KEY = f"{CACHE_PREFIX}:version"
# A queue whose oldest item waited longer than this is "high".
HIGH_AFTER = timedelta(hours=48)
# Queues where any waiting item is "high" (something is broken or money is due).
ALWAYS_HIGH = frozenset({"uploads_failed", "payments_to_action", "quarantined_files", "system_issues"})
QUARANTINE_WINDOW = timedelta(days=7)
EXAMS_CLOSING_WINDOW = timedelta(hours=24)
AGENT_OFFLINE_AFTER = timedelta(minutes=10)
LIVE_TODAY_LIMIT = 5


@dataclass(frozen=True)
class QueueSpec:
    key: str
    label: str
    href: str
    action_label: str


QUEUES = {
    spec.key: spec
    for spec in (
        QueueSpec("enrolment_requests", "Enrolment requests", "/console/admin/requests", "Review"),
        QueueSpec("reports_to_grade", "Reports to grade", "/console/admin/grading", "Open queue"),
        QueueSpec("recordings_to_review", "Recordings to review", "/console/admin/recordings?filter=needs_review", "Review"),
        QueueSpec("uploads_failed", "Failed uploads and processing", "/console/admin/recordings?filter=failed", "Open"),
        QueueSpec("payments_to_action", "Payments to action", "/admin/payments/payment/", "Open"),
        QueueSpec("exams_to_publish", "Exams to publish or closing soon", "/console/admin/exams", "Open"),
        QueueSpec("leads", "Join forms and leads", "/admin/courses/publicenrollmentlead/", "Open"),
        QueueSpec("flagged_content", "Questions and comments", "/console/admin/community?tab=questions", "Answer"),
        QueueSpec("quarantined_files", "Quarantined files", "/admin/reports/reportquarantinerecord/", "Open"),
        QueueSpec("system_issues", "System issues", "/console/admin/system/health", "Open"),
        QueueSpec(
            "plans_awaiting_price",
            "Plans waiting for price confirmation",
            "/admin/payments/platformplan/",
            "Confirm prices",
        ),
    )
}


# ---------------------------------------------------------------- helpers


def _now():
    return timezone.now()


def _agg(queryset, date_field: str):
    """(count, oldest) in one query."""
    row = queryset.aggregate(n=Count("pk"), oldest=Min(date_field))
    return int(row["n"] or 0), row["oldest"]


def _merge(*parts):
    """Sum counts and keep the earliest oldest of (count, oldest) pairs; a
    ``None`` part (not permitted) is skipped; all ``None`` → ``None``."""
    seen = [part for part in parts if part is not None]
    if not seen:
        return None
    count = sum(part[0] for part in seen)
    oldest = min((part[1] for part in seen if part[1] is not None), default=None)
    return count, oldest


def _perm(user, *perms) -> bool:
    return any(user.has_perm(perm) for perm in perms)


# --------------------------------------------------------------- queues


def _enrolment_requests(user, now):
    from apps.courses.models import Enrollment, LiveClassEnrollment

    course = live = None
    if _perm(user, "courses.view_enrollment"):
        course = _agg(Enrollment.objects.filter(payment_status=Enrollment.STATUS_PENDING), "enrolled_at")
    if _perm(user, "courses.view_liveclassenrollment"):
        live = _agg(LiveClassEnrollment.objects.filter(status=LiveClassEnrollment.STATUS_PENDING), "created_at")
    return _merge(course, live)


def _reports_to_grade(user, now):
    from apps.reports.models import ReportSubmission

    # The grading queue's "awaiting" filter (reports.views SubmissionQueueView).
    return _agg(ReportSubmission.objects.filter(status__in=ReportSubmission.AWAITING_GRADING), "submitted_at")


def _recording_counts(now):
    """Both recording queues from ClassRecording in one query (memoised per call)."""
    from apps.realtime.recording.models import ClassRecording

    failed = Q(state=ClassRecording.STATE_FAILED)
    review = Q(needs_review=True) & ~failed
    return ClassRecording.objects.aggregate(
        review_n=Count("pk", filter=review),
        review_oldest=Min("created_at", filter=review),
        failed_n=Count("pk", filter=failed),
        failed_oldest=Min("updated_at", filter=failed),
    )


def _recordings_to_review(user, now, *, shared):
    row = shared.setdefault("recordings", _recording_counts(now))
    return int(row["review_n"] or 0), row["review_oldest"]


def _uploads_failed(user, now, *, shared):
    from apps.recording_uploads.models import RecordingUpload

    row = shared.setdefault("recordings", _recording_counts(now))
    recordings = (int(row["failed_n"] or 0), row["failed_oldest"])
    uploads = _agg(RecordingUpload.objects.filter(status=RecordingUpload.STATUS_FAILED), "updated_at")
    return _merge(recordings, uploads)


def _payments_to_action(user, now):
    from apps.payments.models import Payment

    if not _perm(user, "payments.view_payment"):
        return None
    return _agg(
        Payment.objects.filter(
            status=Payment.STATUS_PAID,
            provisioning_status__in=(
                Payment.PROVISION_AWAITING_ADMIN,
                Payment.PROVISION_FAILED,
                Payment.PROVISION_DUPLICATE,
            ),
        ),
        "created_at",
    )


def _exams_to_publish(user, now):
    from apps.ctf.models import CtfExam

    ready_drafts = Q(status=CtfExam.STATUS_DRAFT, auto_publish=False, content_loaded_at__isnull=False)
    closing = Q(status=CtfExam.STATUS_PUBLISHED, closes_at__gt=now, closes_at__lte=now + EXAMS_CLOSING_WINDOW)
    return _agg(CtfExam.objects.filter(ready_drafts | closing), "created_at")


def _leads(user, now):
    from apps.courses.models import PublicEnrollmentLead
    from apps.join_requests.models import JoinApplication

    joins = leads = None
    if _perm(user, "join_requests.view_joinapplication"):
        joins = _agg(JoinApplication.objects.filter(status=JoinApplication.STATUS_NEW), "created_at")
    if _perm(user, "courses.view_publicenrollmentlead"):
        leads = _agg(PublicEnrollmentLead.objects.filter(status=PublicEnrollmentLead.STATUS_NEW), "created_at")
    return _merge(joins, leads)


def _flagged_content(user, now):
    from apps.courses.experience_models import CourseReview
    from apps.courses.models import LectureQuestion

    questions = _agg(LectureQuestion.objects.filter(status=LectureQuestion.STATUS_NEW), "created_at")
    reviews = None
    if _perm(user, "courses.view_coursereview"):
        reviews = _agg(CourseReview.objects.filter(status=CourseReview.STATUS_PENDING), "created_at")
    return _merge(questions, reviews)


def _quarantined_files(user, now):
    from apps.reports.models import ReportQuarantineRecord

    if not _perm(user, "reports.view_reportquarantinerecord"):
        return None
    return _agg(ReportQuarantineRecord.objects.filter(created_at__gte=now - QUARANTINE_WINDOW), "created_at")


def _system_issues(user, now):
    from apps.core.models import OutboxEvent
    from apps.realtime.models import ServerResourceProfile
    from apps.users.models import AsyncJob

    outbox = jobs = agent = None
    if _perm(user, "core.view_outboxevent"):
        outbox = _agg(OutboxEvent.objects.filter(status=OutboxEvent.STATUS_DEAD), "created_at")
    if _perm(user, "users.view_asyncjob"):
        jobs = _agg(AsyncJob.objects.filter(status=AsyncJob.STATUS_DEAD), "updated_at")
    if _perm(user, "realtime.view_serverresourceprofile"):
        seen = ServerResourceProfile.objects.filter(pk=1).values_list("agent_last_seen_at", flat=True).first()
        offline = bool(seen and now - seen > AGENT_OFFLINE_AFTER)
        agent = (1, seen) if offline else (0, None)
    return _merge(outbox, jobs, agent)


def _plans_awaiting_price(user, now):
    """Platform plans whose INR price the owner has not confirmed yet (one query).

    Uses the payments service (``platform_plans.pending_confirmation_count``)
    so the Console and the back office count the same way. ``None`` (hidden)
    when the viewer may not view plans or the payments service is absent."""
    if not _perm(user, "payments.view_platformplan"):
        return None
    try:
        from apps.payments.platform_plans import pending_confirmation_count
    except ImportError:  # pragma: no cover - payments app without platform plans
        return None
    return int(pending_confirmation_count()), None


_COUNTERS: dict[str, Callable] = {
    "enrolment_requests": _enrolment_requests,
    "reports_to_grade": _reports_to_grade,
    "recordings_to_review": _recordings_to_review,
    "uploads_failed": _uploads_failed,
    "payments_to_action": _payments_to_action,
    "exams_to_publish": _exams_to_publish,
    "leads": _leads,
    "flagged_content": _flagged_content,
    "quarantined_files": _quarantined_files,
    "system_issues": _system_issues,
    "plans_awaiting_price": _plans_awaiting_price,
}
_SHARED = frozenset({"recordings_to_review", "uploads_failed"})


def _severity(key: str, count, oldest, now) -> str:
    if not count:
        return "normal"
    if key in ALWAYS_HIGH:
        return "high"
    if oldest is not None and now - oldest > HIGH_AFTER:
        return "high"
    return "normal"


def _queue(key: str, result, now) -> dict:
    spec = QUEUES[key]
    count, oldest = result if result is not None else (None, None)
    return {
        "key": key,
        "label": spec.label,
        "count": count,
        "oldest_at": oldest.isoformat() if (oldest is not None and count) else None,
        "severity": _severity(key, count, oldest, now),
        "href": spec.href,
        "action_label": spec.action_label,
    }


def build_queues(user, now=None) -> list[dict]:
    now = now or _now()
    shared: dict = {}
    queues = []
    for key in QUEUE_KEYS:
        counter = _COUNTERS[key]
        try:
            result = counter(user, now, shared=shared) if key in _SHARED else counter(user, now)
        except DatabaseError:
            logger.exception("attention queue %s failed", key)
            result = None
        queues.append(_queue(key, result, now))
    return queues


# ----------------------------------------------------------- live today


def live_today(now=None) -> list[dict]:
    """Sessions on air now, then today's scheduled ones (class days only)."""
    from apps.realtime.models import RealtimeSession
    from apps.realtime.schedule import get_live_class_schedule_snapshot

    now = now or _now()
    schedule = get_live_class_schedule_snapshot(now)
    starts_today = None
    next_start = schedule.get("next_start")
    if next_start:
        from datetime import datetime

        parsed = datetime.fromisoformat(next_start)
        local_now = timezone.localtime(now, parsed.tzinfo)
        if parsed.date() == local_now.date():
            starts_today = parsed
    statuses = [RealtimeSession.STATUS_LIVE]
    if starts_today is not None:
        statuses.append(RealtimeSession.STATUS_SCHEDULED)
    rows = list(
        RealtimeSession.objects.filter(status__in=statuses)
        .order_by("-updated_at")
        .values("id", "title", "status", "started_at")[: LIVE_TODAY_LIMIT * 2]
    )
    rows.sort(key=lambda row: row["status"] != RealtimeSession.STATUS_LIVE)  # live first, stable
    items = []
    for row in rows[:LIVE_TODAY_LIMIT]:
        live = row["status"] == RealtimeSession.STATUS_LIVE
        when = row["started_at"] if live else starts_today
        items.append(
            {
                "id": row["id"],
                "title": row["title"],
                "starts_at": when.isoformat() if when else None,
                "state": "live" if live else "scheduled",
                "href": f"/console/admin/classes/{row['id']}/studio",
            }
        )
    return items


def platform_switches() -> list[dict]:
    return [
        {"key": feature.key, "label": feature.label, "enabled": features.is_enabled(feature.key), "href": FEATURES_HREF}
        for feature in features.registered_features()
    ]


# --------------------------------------------------------------- cache


def _cache_seconds() -> int:
    return max(0, int(getattr(settings, "ADMIN_ATTENTION_CACHE_SECONDS", 30)))


def _version() -> int:
    try:
        return int(cache.get(VERSION_KEY) or 0)
    except Exception:  # noqa: BLE001 - a cache outage only costs a recount
        return 0


def bump_version() -> None:
    """Forget every cached attention payload (after an admin action)."""
    try:
        cache.incr(VERSION_KEY)
    except ValueError:
        cache.set(VERSION_KEY, 1, None)
    except Exception:  # noqa: BLE001
        logger.warning("attention cache version bump failed", exc_info=True)


def _cache_key(user) -> str:
    return f"{CACHE_PREFIX}:{_version()}:{user.pk}"


def get_queues(user, *, use_cache: bool = True) -> dict:
    """The attention payload for ``user`` (Appendix A.3 shape). Staff only;
    anyone else gets every queue hidden (``count: null``)."""
    if not is_staff_user(user):
        now = _now()
        return {
            "queues": [_queue(key, None, now) for key in QUEUE_KEYS],
            "live_today": [],
            "switches": [],
            "generated_at": now.isoformat(),
        }
    seconds = _cache_seconds() if use_cache else 0
    key = _cache_key(user) if seconds else None
    if key:
        try:
            cached = cache.get(key)
        except Exception:  # noqa: BLE001
            cached = None
        if cached:
            cached["switches"] = platform_switches()
            return cached
    now = _now()
    try:
        today = live_today(now)
    except DatabaseError:
        logger.exception("attention live_today failed")
        today = []
    payload = {
        "queues": build_queues(user, now),
        "live_today": today,
        "switches": platform_switches(),
        "generated_at": now.isoformat(),
    }
    if key:
        try:
            cache.set(key, payload, seconds)
        except Exception:  # noqa: BLE001
            pass
    return payload


def waiting_total(payload: dict) -> int:
    """How many things need the admin (sum of visible counts)."""
    return sum(int(queue["count"] or 0) for queue in payload.get("queues", []))
