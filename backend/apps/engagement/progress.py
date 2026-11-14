"""The /me payload: one summary row read plus small cached extras.

``me_payload(user)`` costs ONE query on a warm cache (the summary row). The
extras -- per-course progress, "continue where you left off", earned badges,
recent achievements -- are cached per user for ``ME_EXTRAS_CACHE_SECONDS``
under the summary version, so a new award shows at once and lecture progress
within a minute.
"""

from __future__ import annotations

from django.conf import settings
from django.core.cache import cache
from django.db.models import Count, Q
from django.urls import reverse

from . import badges as badge_catalogue
from . import rules
from .models import Achievement, BadgeAward, EngagementSummary
from .services import summary_snapshot


def _extras_key(user_id: int, version: int) -> str:
    return f"eng:me:x:{user_id}:{version}"


def public_verify_url(slug: str) -> str:
    """The certificate page by slug (it redirects to ``/certificates/<reference>``)."""
    base = str(getattr(settings, "FRONTEND_PUBLIC_ORIGIN", "") or getattr(settings, "FRONTEND_URL", "") or "").rstrip("/")
    return f"{base}/certificates/{slug}"


def _certificate_of(achievement: Achievement):
    """The prefetched certificate (``select_related("certificate")``), or None; never a query."""
    if "certificate" in getattr(achievement, "_state", None).fields_cache:
        return achievement._state.fields_cache["certificate"]
    return None


def achievement_dict(achievement: Achievement, *, request=None) -> dict:
    from .certificates import public_url

    issued = _certificate_of(achievement)
    card = reverse("engagement-achievement-card", kwargs={"slug": achievement.slug})
    certificate = reverse("engagement-achievement-certificate", kwargs={"slug": achievement.slug})
    api = reverse("engagement-achievement-verify", kwargs={"slug": achievement.slug})
    if request is not None:
        card, certificate, api = (request.build_absolute_uri(card), request.build_absolute_uri(certificate),
                                  request.build_absolute_uri(api))
    badge = badge_catalogue.get(achievement.key) if achievement.kind == Achievement.KIND_BADGE else None
    return {
        "slug": achievement.slug,
        "kind": achievement.kind,
        "key": achievement.key,
        "title": achievement.title,
        "subtitle": achievement.subtitle,
        "tier": badge.tier if badge else None,
        "recipient_name": achievement.recipient_name,
        "earned_at": achievement.earned_at.isoformat() if achievement.earned_at else None,
        "valid": achievement.revoked_at is None,
        "verify_url": public_url(issued.reference) if issued is not None else public_verify_url(achievement.slug),
        "verify_api_url": api,
        "share_card_url": card,
        "certificate_url": certificate,
        "reference": issued.reference if issued is not None else None,
    }


def course_progress(user_id: int) -> tuple[list[dict], dict | None]:
    """Per-course progress for the user's active courses and the lecture to resume."""
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment, Lecture, LectureProgress

    enrollments = list(
        Enrollment.objects.filter(user_id=user_id)
        .filter(active_enrollment_q())
        .select_related("course")
        .order_by("-enrolled_at")[:50]
    )
    course_ids = [row.course_id for row in enrollments]
    totals = dict(
        Lecture.objects.published()
        .filter(section__course_id__in=course_ids)
        .values("section__course_id")
        .annotate(n=Count("id"))
        .values_list("section__course_id", "n")
    ) if course_ids else {}
    done = dict(
        LectureProgress.objects.filter(
            user_id=user_id, completed=True, lecture__is_published=True, lecture__section__course_id__in=course_ids
        )
        .values("lecture__section__course_id")
        .annotate(n=Count("id"))
        .values_list("lecture__section__course_id", "n")
    ) if course_ids else {}
    courses = []
    for row in enrollments:
        total = int(totals.get(row.course_id, 0))
        completed = min(total, int(done.get(row.course_id, 0)))
        courses.append(
            {
                "course_id": row.course_id,
                "title": row.course.title,
                "batch": row.course.batch or "",
                "lectures_total": total,
                "lectures_completed": completed,
                "percent": int(round(completed * 100 / total)) if total else 0,
            }
        )
    resume = None
    if course_ids:
        latest = (
            LectureProgress.objects.filter(
                user_id=user_id, lecture__is_published=True, lecture__section__course_id__in=course_ids
            )
            .filter(Q(completed=False) | Q(last_position_seconds__gt=0))
            .select_related("lecture__section__course")
            .order_by("-updated_at")
            .first()
        )
        if latest is not None:
            lecture = latest.lecture
            resume = {
                "lecture_id": lecture.pk,
                "lecture_title": lecture.title,
                "course_id": lecture.section.course_id,
                "course_title": lecture.section.course.title,
                "module_title": lecture.section.title,
                "position_seconds": latest.resume_position_seconds(),
                "duration_seconds": latest.duration_seconds or lecture.stream_duration_seconds,
                "percent": latest.completion_percent(),
                "completed": bool(latest.completed),
                "updated_at": latest.updated_at.isoformat() if latest.updated_at else None,
            }
    return courses, resume


def _extras(user_id: int) -> dict:
    courses, resume = course_progress(user_id)
    earned = list(
        BadgeAward.objects.filter(user_id=user_id, revoked_at__isnull=True)
        .order_by("-awarded_at")
        .values_list("badge_key", "awarded_at")
    )
    badges = []
    for key, awarded_at in earned:
        badge = badge_catalogue.get(key)
        if badge:
            badges.append({**badge.as_dict(), "earned_at": awarded_at.isoformat()})
    recent = [
        achievement_dict(item)
        for item in Achievement.objects.filter(user_id=user_id, revoked_at__isnull=True)
        .select_related("certificate")
        .order_by("-earned_at", "-id")[:5]
    ]
    return {"courses": courses, "continue": resume, "badges": badges, "recent_achievements": recent}


def me_payload(user) -> dict:
    summary = EngagementSummary.objects.filter(user_id=user.pk).first()
    snapshot = summary_snapshot(summary)
    version = snapshot["version"]
    key = _extras_key(user.pk, version)
    extras = None
    try:
        extras = cache.get(key)
    except Exception:  # noqa: BLE001
        extras = None
    if extras is None:
        extras = _extras(user.pk)
        try:
            cache.set(key, extras, timeout=rules.ME_EXTRAS_CACHE_SECONDS)
        except Exception:  # noqa: BLE001
            pass
    today = rules.ist_day()
    same_week = summary is not None and summary.week_start == rules.week_start(today)
    upcoming = rules.next_level(snapshot["xp"])
    return {
        **snapshot,
        "badges": extras["badges"],
        "badges_available": len(badge_catalogue.CATALOGUE),
        "progress": extras["courses"],
        "continue": extras["continue"],
        "time": {
            "this_week_seconds": int(summary.time_week_seconds or 0) if same_week else 0,
            "total_seconds": int(summary.time_total_seconds or 0) if summary else 0,
            "week_start": rules.week_start(today).isoformat(),
        },
        "next_milestone": (
            {
                "kind": "level",
                "key": upcoming.key,
                "title": upcoming.title,
                "target_xp": upcoming.min_xp,
                "remaining_xp": upcoming.min_xp - snapshot["xp"],
            }
            if upcoming
            else None
        ),
        "recent_achievements": extras["recent_achievements"],
        "last_activity_at": summary.last_activity_at.isoformat() if summary and summary.last_activity_at else None,
    }
