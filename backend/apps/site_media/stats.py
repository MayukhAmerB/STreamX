"""Public website figures for ``GET /api/site/stats/`` (landing and About pages).

Every figure is counted from real records, never typed in:

``students_enrolled``
    Distinct active student accounts (not staff, admins or instructors) with a
    paid course enrolment or an approved live-class enrolment.
``live_classes_delivered``
    Live sessions that actually went on air and ended after at least
    ``MIN_DELIVERED_MINUTES`` minutes (test and never-started rooms excluded).
``recorded_hours``
    Whole hours (rounded down) of published lectures in published courses that
    have a measured stream duration.
``certificates_issued``
    Engagement certificates with a reference number that are still valid (the
    certificate, and the achievement or Monthly CTF reward it certifies, are
    not revoked).
``ctf_cases``
    Published practice challenges and lab cases (OSINT directory and members'
    labs), Monthly CTF cases that have opened, and published or closed CTF
    examinations.
``average_rating`` / ``rating_count``
    Mean of the published course reviews, rounded *down* to one decimal, only
    once there are at least ``MIN_REVIEWS_FOR_RATING`` of them.

A figure under its minimum (``MINIMUMS``) is sent as ``null`` and the website
hides it: a small number is not shown at all rather than shown small. The
payload holds counts only, no personal data. It is computed at most once per
``CACHE_SECONDS`` (shared cache) for every visitor; a failing source only
blanks its own figure.
"""

from __future__ import annotations

import logging
import math
from datetime import timedelta

from django.apps import apps as django_apps
from django.core.cache import cache
from django.db.models import Avg, Count, Exists, F, OuterRef, Sum
from django.utils import timezone

logger = logging.getLogger("apps.site_media.stats")

CACHE_KEY = "site:stats:v1"
CACHE_SECONDS = 10 * 60
# A payload with a failed source is kept only briefly, so a blip heals quickly.
DEGRADED_CACHE_SECONDS = 60
MIN_DELIVERED_MINUTES = 10
MIN_REVIEWS_FOR_RATING = 10
# Hide a figure until it reaches this value (inclusive).
MINIMUMS = {
    "students_enrolled": 25,
    "live_classes_delivered": 10,
    "recorded_hours": 10,
    "certificates_issued": 10,
    "ctf_cases": 5,
}
STAT_KEYS = (
    "students_enrolled",
    "live_classes_delivered",
    "recorded_hours",
    "certificates_issued",
    "ctf_cases",
    "average_rating",
    "rating_count",
)


def _model(label: str):
    return django_apps.get_model(label)


def students_enrolled() -> int:
    user_model = _model("users.User")
    enrollment = _model("courses.Enrollment")
    live_enrollment = _model("courses.LiveClassEnrollment")
    paid = enrollment.objects.filter(user=OuterRef("pk"), payment_status=enrollment.STATUS_PAID)
    approved = live_enrollment.objects.filter(user=OuterRef("pk"), status=live_enrollment.STATUS_APPROVED)
    return (
        user_model.objects.filter(
            is_active=True, is_staff=False, is_superuser=False, role=user_model.ROLE_STUDENT
        )
        .filter(Exists(paid) | Exists(approved))
        .count()
    )


def live_classes_delivered() -> int:
    session = _model("realtime.RealtimeSession")
    return (
        session.objects.filter(
            status=session.STATUS_ENDED,
            started_at__isnull=False,
            ended_at__isnull=False,
            ended_at__gte=F("started_at") + timedelta(minutes=MIN_DELIVERED_MINUTES),
        )
        .exclude(end_reason="never_started")
        .count()
    )


def recorded_hours() -> int:
    lecture = _model("courses.Lecture")
    total = (
        lecture.objects.filter(
            is_published=True,
            section__course__is_published=True,
            stream_duration_seconds__isnull=False,
        ).aggregate(total=Sum("stream_duration_seconds"))["total"]
        or 0
    )
    return int(total) // 3600


def certificates_issued() -> int:
    certificate = _model("engagement.Certificate")
    return (
        certificate.objects.filter(reference__isnull=False, revoked_at__isnull=True)
        .exclude(achievement__revoked_at__isnull=False)
        .exclude(ctf_reward__revoked_at__isnull=False)
        .count()
    )


def ctf_cases() -> int:
    challenge = _model("osint_labs.OsintChallenge")
    season = _model("ctf.CtfSeason")
    exam = _model("ctf.CtfExam")
    return (
        challenge.objects.filter(is_published=True).count()
        + season.objects.filter(status__in=season.LIVE_STATUSES).count()
        + exam.objects.filter(status__in=(exam.STATUS_PUBLISHED, exam.STATUS_CLOSED)).count()
    )


def course_rating() -> tuple[float | None, int]:
    review = _model("courses.CourseReview")
    row = review.objects.filter(status=review.STATUS_APPROVED).aggregate(avg=Avg("rating"), count=Count("id"))
    count = int(row["count"] or 0)
    if count < MIN_REVIEWS_FOR_RATING or row["avg"] is None:
        return None, count
    # Rounded down: 4.66 is shown as 4.6, never as 4.7.
    return math.floor(float(row["avg"]) * 10 + 1e-9) / 10, count


COUNTERS = {
    "students_enrolled": students_enrolled,
    "live_classes_delivered": live_classes_delivered,
    "recorded_hours": recorded_hours,
    "certificates_issued": certificates_issued,
    "ctf_cases": ctf_cases,
}


def compute_stats() -> dict:
    """Raw figures (``None`` when a source failed); no minimums applied."""
    raw: dict = {}
    for key, counter in COUNTERS.items():
        try:
            raw[key] = int(counter())
        except Exception:  # noqa: BLE001 - one broken source blanks only its own figure
            logger.exception("site_stats.source_failed", extra={"stat": key})
            raw[key] = None
    try:
        raw["average_rating"], raw["rating_count"] = course_rating()
    except Exception:  # noqa: BLE001
        logger.exception("site_stats.source_failed", extra={"stat": "average_rating"})
        raw["average_rating"], raw["rating_count"] = None, None
    return raw


def public_stats(raw: dict) -> dict:
    """Apply the minimums: a figure below its minimum becomes ``None`` (hidden)."""
    stats = {}
    for key, minimum in MINIMUMS.items():
        value = raw.get(key)
        stats[key] = value if isinstance(value, int) and value >= minimum else None
    rating = raw.get("average_rating")
    stats["average_rating"] = rating if rating is not None else None
    stats["rating_count"] = raw.get("rating_count") if rating is not None else None
    return stats


def build_payload() -> tuple[dict, bool]:
    """``(payload, complete)``; ``complete`` is False when a source failed."""
    raw = compute_stats()
    complete = all(raw.get(key) is not None for key in COUNTERS) and raw.get("rating_count") is not None
    stats = public_stats(raw)
    payload = {
        "stats": stats,
        "available": any(value is not None for value in stats.values()),
        "generated_at": timezone.now().isoformat(),
    }
    return payload, complete


def get_payload() -> dict:
    """The cached payload (one computation per ``CACHE_SECONDS`` for everyone)."""
    try:
        cached = cache.get(CACHE_KEY)
    except Exception:  # noqa: BLE001 - the cache is an optimisation only
        cached = None
    if isinstance(cached, dict) and isinstance(cached.get("stats"), dict):
        return cached
    payload, complete = build_payload()
    try:
        cache.set(CACHE_KEY, payload, CACHE_SECONDS if complete else DEGRADED_CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        logger.warning("site_stats.cache_unavailable")
    return payload


def invalidate() -> None:
    try:
        cache.delete(CACHE_KEY)
    except Exception:  # noqa: BLE001
        pass


__all__ = ["CACHE_SECONDS", "MINIMUMS", "MIN_REVIEWS_FOR_RATING", "STAT_KEYS", "get_payload", "invalidate"]
