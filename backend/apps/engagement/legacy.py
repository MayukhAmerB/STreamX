"""Release-day rewards for students who studied here before the platform launch.

Owner-approved plan (``python manage.py engagement_legacy_rewards``, dry run by default):

* **Legacy student** = an active student account (not staff, admin or
  instructor) with a paid course enrolment or an approved live-class enrolment
  made before ``release_at``.
* **Active legacy student** = a legacy student who, at release, (a) still holds a
  paid enrolment with active access in a published course, and (b) had learning
  activity in the ``ENGAGEMENT_LEGACY_ACTIVE_DAYS`` (default 30) days before
  release: lecture progress, a live-class join (attendance or presence rows), a
  weekly report submission, a CTF exam start, or a sign-in.
* Every legacy student: **Founding Member** badge, and **Batch Pioneer -- Batch N**
  for each numbered batch (``Course.batch`` such as "Batch 2") enrolled before
  release. A course with no batch number earns no pioneer badge (reported, never
  guessed).
* **Founding Graduate** (certified before release: a linked, visible Hall of Fame
  entry, or an account listed in the owner's ``--graduates-file``): the badge and
  a special certificate.
* Active legacy students additionally: **Founding Operative** (top tier), the
  30-day **Founding Glow** profile frame (``ENGAGEMENT_FOUNDING_GLOW_DAYS``;
  below and distinct from the monthly champion's Golden Aura) and the legacy
  **Founding Member certificate**. Inactive legacy students get the badges only.
* Fairness: current streaks restart at release (the historical best streak is
  recorded in ``best_streak``; this week's free streak freeze is available to
  everyone), the weekly leaderboard counts only XP earned since release, and the
  all-time leaderboard keeps the history.

Idempotent: a ``LegacyGrant`` row marks a granted student; badges, achievements
and certificates are unique per user and key. Re-running grants only what is
missing. Retroactive XP itself comes from ``engagement_backfill`` (run first).
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from django.apps import apps as django_apps
from django.conf import settings
from django.db import transaction
from django.db.models import F, Max, Q, Sum
from django.utils import timezone

from . import badges as badge_catalogue
from . import rules, services, streaks
from .models import Achievement, ActivityDay, BadgeAward, EngagementSummary, LegacyGrant, XpEvent

logger = logging.getLogger("apps.engagement.legacy")

BATCH_NUMBER = re.compile(r"(\d{1,4})")
LEGACY_CERTIFICATE_KEYS = (badge_catalogue.FOUNDING_MEMBER.key, badge_catalogue.FOUNDING_GRADUATE.key)


def active_days() -> int:
    return max(1, int(getattr(settings, "ENGAGEMENT_LEGACY_ACTIVE_DAYS", 30) or 30))


def glow_days() -> int:
    return max(1, int(getattr(settings, "ENGAGEMENT_FOUNDING_GLOW_DAYS", 30) or 30))


def batch_number(label: str) -> int | None:
    match = BATCH_NUMBER.search(str(label or ""))
    if not match:
        return None
    number = int(match.group(1))
    return number if number > 0 else None


@dataclass
class Plan:
    user_id: int
    first_enrolled_at: datetime | None = None
    batches: set[int] = field(default_factory=set)
    unnumbered: set[str] = field(default_factory=set)
    current_course: bool = False
    last_activity_at: datetime | None = None
    graduate: bool = False
    active: bool = False

    @property
    def cohort(self) -> str:
        return LegacyGrant.COHORT_ACTIVE if self.active else LegacyGrant.COHORT_INACTIVE

    @property
    def badge_keys(self) -> list[str]:
        keys = [badge_catalogue.FOUNDING_MEMBER.key]
        keys += [badge_catalogue.batch_pioneer_key(number) for number in sorted(self.batches)]
        if self.graduate:
            keys.append(badge_catalogue.FOUNDING_GRADUATE.key)
        if self.active:
            keys.append(badge_catalogue.FOUNDING_OPERATIVE.key)
        return keys

    @property
    def certificate_keys(self) -> list[str]:
        keys = []
        if self.active:
            keys.append(badge_catalogue.FOUNDING_MEMBER.key)
        if self.graduate:
            keys.append(badge_catalogue.FOUNDING_GRADUATE.key)
        return keys


def _model(label):
    return django_apps.get_model(label)


def _later(a, b):
    return max(filter(None, [a, b]), default=None)


# --- eligibility ------------------------------------------------------------------------------
def legacy_user_ids(release_at: datetime, *, after_id: int = 0, limit: int | None = None) -> list[int]:
    """Legacy students (see module docstring), by ascending id."""
    user_model = _model("users.User")
    enrollment = _model("courses.Enrollment")
    live = _model("courses.LiveClassEnrollment")
    paid = enrollment.objects.filter(payment_status=enrollment.STATUS_PAID, enrolled_at__lt=release_at).values("user_id")
    approved = live.objects.filter(status=live.STATUS_APPROVED, created_at__lt=release_at).values("user_id")
    queryset = (
        user_model.objects.filter(is_active=True, is_staff=False, is_superuser=False, role=user_model.ROLE_STUDENT)
        .filter(pk__gt=after_id)
        .filter(Q(pk__in=paid) | Q(pk__in=approved))
        .order_by("pk")
        .values_list("pk", flat=True)
    )
    return list(queryset[:limit] if limit else queryset)


def build_plans(user_ids: list[int], release_at: datetime, *, graduate_ids: set[int] | None = None) -> dict[int, Plan]:
    """One ``Plan`` per legacy student; a handful of set-based queries per chunk."""
    from apps.courses.access import active_enrollment_q

    plans = {user_id: Plan(user_id) for user_id in user_ids}
    if not plans:
        return plans
    ids = list(plans)
    window_start = release_at - timedelta(days=active_days())

    enrollment = _model("courses.Enrollment")
    for row in enrollment.objects.filter(
        user_id__in=ids, payment_status=enrollment.STATUS_PAID, enrolled_at__lt=release_at
    ).select_related("course").only("user_id", "enrolled_at", "course__batch", "course__title"):
        plan = plans[row.user_id]
        plan.first_enrolled_at = min(filter(None, [plan.first_enrolled_at, row.enrolled_at]))
        number = batch_number(row.course.batch)
        if number:
            plan.batches.add(number)
        else:
            plan.unnumbered.add(row.course.title[:80])
    live = _model("courses.LiveClassEnrollment")
    for row in live.objects.filter(
        user_id__in=ids, status=live.STATUS_APPROVED, created_at__lt=release_at
    ).select_related("live_class__linked_course"):
        plan = plans[row.user_id]
        plan.first_enrolled_at = min(filter(None, [plan.first_enrolled_at, row.created_at]))
        course = getattr(row.live_class, "linked_course", None)
        if course is not None:
            number = batch_number(course.batch)
            if number:
                plan.batches.add(number)
            else:
                plan.unnumbered.add(course.title[:80])

    # (a) still enrolled in a current course: paid, access active at release, published course.
    for user_id in enrollment.objects.filter(user_id__in=ids, course__is_published=True).filter(
        active_enrollment_q(at=release_at)
    ).values_list("user_id", flat=True).distinct():
        plans[user_id].current_course = True

    # (b) learning activity in the window before release (latest timestamp per source).
    def latest(model_label, user_field, time_field, **extra):
        try:
            model = _model(model_label)
        except LookupError:
            return
        rows = (
            model.objects.filter(**{f"{user_field}__in": ids, f"{time_field}__gte": window_start, f"{time_field}__lt": release_at}, **extra)
            .values_list(user_field)
            .annotate(at=Max(time_field))
        )
        for user_id, at in rows:
            plans[user_id].last_activity_at = _later(plans[user_id].last_activity_at, at)

    latest("courses.LectureProgress", "user_id", "updated_at")
    latest("attendance.AttendanceRecord", "user_id", "first_joined_at")
    latest("engagement.LiveAttendance", "user_id", "first_seen_at")
    latest("reports.ReportSubmission", "student_id", "first_submitted_at")
    latest("ctf.CtfParticipation", "user_id", "started_at", is_staff_preview=False)
    latest("users.User", "pk", "last_login")

    graduates = set(graduate_ids or set()) | hall_of_fame_user_ids(release_at)
    for plan in plans.values():
        plan.graduate = plan.user_id in graduates
        plan.active = plan.current_course and plan.last_activity_at is not None
    return plans


def hall_of_fame_user_ids(release_at: datetime) -> set[int]:
    """Students already certified before release: visible Hall of Fame entries linked to an account."""
    try:
        entry = _model("certification.HallOfFameEntry")
    except LookupError:
        return set()
    return set(
        entry.objects.filter(user__isnull=False, is_hidden=False, created_at__lt=release_at).values_list("user_id", flat=True)
    )


def unlinked_hall_of_fame(release_at: datetime) -> list[str]:
    """Curated Hall of Fame rows with no account: listed for the owner to link (never matched by name)."""
    try:
        entry = _model("certification.HallOfFameEntry")
    except LookupError:
        return []
    rows = entry.objects.filter(user__isnull=True, is_hidden=False, created_at__lt=release_at)
    return [f"{row.batch_label or '-'}: entry #{row.pk} ({row.display_handle or 'no handle'})" for row in rows]


# --- applying ---------------------------------------------------------------------------------------
def _achievement_time(release_at: datetime, now: datetime) -> datetime:
    return min(release_at, now)


def apply_plan(plan: Plan, release_at: datetime, *, now: datetime | None = None) -> dict:
    """Grant one student's legacy rewards (idempotent). Returns what was new."""
    from .certificates import issue_for_new_achievements

    now = now or timezone.now()
    created = {"badges": [], "certificates": [], "grant": False, "glow": False}
    with transaction.atomic():
        summary = services._lock_summary(plan.user_id)
        owned = set(BadgeAward.objects.filter(user_id=plan.user_id).values_list("badge_key", flat=True))
        fresh = [key for key in plan.badge_keys if key not in owned]
        if fresh:
            BadgeAward.objects.bulk_create(
                [BadgeAward(user_id=plan.user_id, badge_key=key, awarded_at=now, note="legacy") for key in fresh],
                ignore_conflicts=True,
            )
            created["badges"] = fresh
        wanted = []
        for key in plan.certificate_keys:
            badge = badge_catalogue.get(key)
            achievement, made = Achievement.objects.get_or_create(
                user_id=plan.user_id,
                kind=Achievement.KIND_BADGE,
                key=key,
                defaults={
                    "title": badge.title,
                    "subtitle": badge.description,
                    "recipient_name": services._recipient_name(plan.user_id)[:255],
                    "earned_at": _achievement_time(release_at, now),
                },
            )
            if made:
                wanted.append((achievement.kind, achievement.key))
        if wanted:
            issue_for_new_achievements(plan.user_id, wanted)
            created["certificates"] = [key for _kind, key in wanted]

        grant = LegacyGrant.objects.select_for_update().filter(user_id=plan.user_id).first()
        glow_start = release_at  # the frame runs from release day
        if grant is None:
            grant = LegacyGrant(user_id=plan.user_id, granted_at=now)
            created["grant"] = True
        grant.cohort = plan.cohort if grant.cohort != LegacyGrant.COHORT_ACTIVE else grant.cohort  # never downgraded
        grant.release_at = release_at
        grant.first_enrolled_at = plan.first_enrolled_at
        grant.last_activity_at = _later(grant.last_activity_at, plan.last_activity_at)
        grant.batches = sorted(set(grant.batches or []) | plan.batches)
        grant.graduate = bool(grant.graduate or plan.graduate)
        grant.badges = sorted(set(grant.badges or []) | set(plan.badge_keys))
        if grant.cohort == LegacyGrant.COHORT_ACTIVE and grant.glow_ends_at is None:
            grant.glow_starts_at = glow_start
            grant.glow_ends_at = glow_start + timedelta(days=glow_days())
            created["glow"] = True
        grant.save()

        updates = _fairness_updates(summary, release_at, now)
        updates["badges_count"] = F("badges_count") + len(created["badges"])
        updates["version"] = F("version") + 1
        updates["updated_at"] = now
        EngagementSummary.objects.filter(pk=summary.pk).update(**updates)
        transaction.on_commit(lambda: _after_commit(plan.user_id))
    return created


def _fairness_updates(summary: EngagementSummary, release_at: datetime, now: datetime) -> dict:
    """Streaks restart at release (best kept); weekly figures count only post-release XP."""
    epoch = rules.ist_day(release_at)
    history = list(ActivityDay.objects.filter(user_id=summary.user_id, is_study_day=True).values_list("day", flat=True))
    best = max(int(summary.best_streak or 0), streaks.compute(history).best)
    since = streaks.compute([day for day in history if day >= epoch])
    week = rules.current_week_start(now)
    window = max(
        datetime.combine(week, datetime.min.time(), tzinfo=rules.IST),
        release_at,
    )
    recent = XpEvent.objects.filter(user_id=summary.user_id, occurred_at__gte=window, occurred_at__lte=now)
    weekly = int(recent.aggregate(total=Sum("points"))["total"] or 0)
    weekly_purchase = int(recent.filter(kind__in=rules.PURCHASE_KINDS).aggregate(total=Sum("points"))["total"] or 0)
    return {
        "best_streak": max(best, since.best),
        "current_streak": since.current,
        "last_study_day": since.last_day,
        # One free freeze for everyone on release week: the history used none of it.
        "freeze_week": since.freeze_week,
        "freeze_used_on": since.freeze_used_on,
        "week_start": week,
        "weekly_xp": weekly,
        "weekly_purchase_xp": weekly_purchase,
        "weekly_reached_at": None if weekly <= 0 else summary.weekly_reached_at,
    }


def _after_commit(user_id: int) -> None:
    try:
        summary = EngagementSummary.objects.filter(user_id=user_id).first()
        if summary is not None:
            services.after_award_commit(user_id, summary)
    except Exception:  # noqa: BLE001 - leaderboards are rebuilt hourly anyway
        logger.warning("engagement.legacy_after_commit_failed user=%s", user_id, exc_info=True)


# --- review report -------------------------------------------------------------------------------------
def describe(plans: dict[int, Plan], release_at: datetime) -> dict:
    """Counts for the owner's review (no personal data beyond user ids and handles)."""
    counts = Counter()
    unnumbered = Counter()
    for plan in plans.values():
        counts["legacy_students"] += 1
        counts["active" if plan.active else "inactive"] += 1
        counts["graduates"] += int(plan.graduate)
        counts["current_course_but_no_recent_activity"] += int(plan.current_course and plan.last_activity_at is None)
        for key in plan.badge_keys:
            counts[f"badge:{key}"] += 1
        for key in plan.certificate_keys:
            counts[f"certificate:{key}"] += 1
        counts["founding_glow"] += int(plan.active)
        for title in plan.unnumbered:
            unnumbered[title] += 1
    return {"counts": counts, "unnumbered_courses": unnumbered}


def xp_overview(user_ids: list[int], *, top: int = 20) -> dict:
    """XP distribution and top N of the given students (current summaries)."""
    rows = list(
        EngagementSummary.objects.filter(user_id__in=user_ids).values_list("user_id", "total_xp", "level", "best_streak")
    )
    buckets = Counter()
    edges = (0, 1, 250, 1000, 2500, 5000, 10000, 20000)
    for _user_id, xp, _level, _best in rows:
        label = "0"
        for low, high in zip(edges, (*edges[1:], None), strict=True):
            if xp >= low and (high is None or xp < high):
                label = f"{low}+" if high is None else f"{low}-{high - 1}"
        buckets[label] += 1
    buckets["no XP yet"] = len(set(user_ids)) - len(rows)
    leaders = sorted(rows, key=lambda row: (-row[1], row[0]))[:top]
    try:
        from apps.profiles.handles import public_handles

        names = public_handles([row[0] for row in leaders])
    except Exception:  # noqa: BLE001
        names = {}
    levels = Counter(rules.level_by_number(level).title for _u, _x, level, _b in rows)
    return {
        "buckets": buckets,
        "levels": levels,
        "top": [
            {"user_id": user_id, "handle": names.get(user_id, ""), "xp": xp, "level": rules.level_by_number(level).title,
             "best_streak": best}
            for user_id, xp, level, best in leaders
        ],
    }


__all__ = [
    "LEGACY_CERTIFICATE_KEYS",
    "Plan",
    "active_days",
    "apply_plan",
    "batch_number",
    "build_plans",
    "describe",
    "glow_days",
    "hall_of_fame_user_ids",
    "legacy_user_ids",
    "unlinked_hall_of_fame",
    "xp_overview",
]

