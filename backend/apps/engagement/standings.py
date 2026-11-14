"""Leaderboard standing XP (owner rules A): the weekly and monthly closes.

Weekly close (IST week, Monday 00:00): in every batch, the week's learning
board is ranked from the XP ledger (events that happened in the week; standing
XP itself never counts; purchase XP counts only while
``ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP`` is on; nothing from before the
release epoch). #1 = 200 XP, #2-3 = 120 XP, #4-10 = 60 XP, and the top 3 get
the "Podium Week" badge (once ever).

Monthly close (IST calendar month): the all-time top 10 of every batch as of
the month's end = 100 XP each.

Who is ranked: active, non-staff members of the batch at close time who did
not hide themselves from leaderboards (a hidden student opted out of the
competition and nobody saw them place, so they earn no standing XP). Ties go
to whoever scored their last point of the period first, then the lower id.

Idempotent: the ledger keys are per (week | month, batch, user), the badge is
unique per user, so a retry, a second worker or a re-run after a cache flush
never pays twice. Standing XP is dated at the last second of the period (it
belongs to the closed period, so it never inflates the new week's board) and
never makes a study day. The job runs from the worker (``apps.py`` hourly hook
-> outbox event), looks back over the last two closed weeks and months (a
missed run catches up) and skips periods that ended before release day.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from django.core.cache import cache
from django.db.models import Max, Q, Sum
from django.utils import timezone

from apps.core.concurrency import DistributedLock

from . import rules, services
from .badges import AwardedItem
from .models import EngagementSettings, XpEvent

logger = logging.getLogger("apps.engagement.standings")

SOURCE_LEADERBOARD = "leaderboard"
LOOKBACK_PERIODS = 2
DONE_TTL_SECONDS = 70 * 24 * 3600
PODIUM_BADGE = "podium_week"


# --- calendar ------------------------------------------------------------------------------------
def _ist_midnight(day: date) -> datetime:
    return datetime.combine(day, datetime.min.time(), tzinfo=rules.IST)


def week_window(week: date) -> tuple[datetime, datetime]:
    return _ist_midnight(week), _ist_midnight(week + timedelta(days=7))


def month_window(month: date) -> tuple[datetime, datetime]:
    first = month.replace(day=1)
    following = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    return _ist_midnight(first), _ist_midnight(following)


def closed_weeks(now: datetime | None = None) -> list[date]:
    current = rules.current_week_start(now)
    return [current - timedelta(days=7 * n) for n in range(LOOKBACK_PERIODS, 0, -1)]


def closed_months(now: datetime | None = None) -> list[date]:
    first = rules.ist_day(now).replace(day=1)
    months = []
    for _ in range(LOOKBACK_PERIODS):
        first = (first - timedelta(days=1)).replace(day=1)
        months.append(first)
    return sorted(months)


def _after_release(end: datetime) -> bool:
    release = rules.release_at()
    return release is None or end > release


# --- ranking --------------------------------------------------------------------------------------
def batch_ids() -> list[int]:
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment

    return sorted(set(Enrollment.objects.filter(active_enrollment_q()).values_list("course_id", flat=True)))


def ranked_members(batch_id: int) -> list[int]:
    """Active, non-staff, visible members of the batch now."""
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment

    members = set(
        Enrollment.objects.filter(course_id=batch_id)
        .filter(active_enrollment_q())
        .filter(user__is_active=True, user__is_staff=False, user__is_superuser=False)
        .values_list("user_id", flat=True)
    )
    hidden = set(
        EngagementSettings.objects.filter(
            user_id__in=members, leaderboard_display=EngagementSettings.DISPLAY_HIDDEN
        ).values_list("user_id", flat=True)
    )
    return sorted(members - hidden)


def _excluded_kinds() -> set[str]:
    excluded = set(rules.STANDING_KINDS)
    if not rules.leaderboard_counts_purchase_xp():
        excluded |= set(rules.PURCHASE_KINDS)
    return excluded


def ranking(member_ids, start: datetime | None, end: datetime, *, exclude: Q | None = None, limit: int) -> list[tuple[int, int]]:
    """[(user_id, xp)] best first over the ledger window ``[start, end)``."""
    if not member_ids:
        return []
    queryset = XpEvent.objects.filter(user_id__in=list(member_ids), occurred_at__lt=end).exclude(kind__in=_excluded_kinds())
    if start is not None:
        queryset = queryset.filter(occurred_at__gte=start)
    if exclude is not None:
        queryset = queryset.exclude(exclude)
    rows = (
        queryset.values("user_id")
        .annotate(xp=Sum("points"), last=Max("occurred_at"))
        .filter(xp__gt=0)
        .order_by("-xp", "last", "user_id")[:limit]
    )
    return [(int(row["user_id"]), int(row["xp"])) for row in rows]


# --- closes -------------------------------------------------------------------------------------------
def close_week(week: date) -> dict:
    """Award the standing XP and podium badges of one closed IST week (all batches)."""
    start, end = week_window(week)
    release = rules.release_at()
    if release is not None and release > start:
        start = release  # nothing from before release day counts
    stamp = end - timedelta(seconds=1)
    stats = {"batches": 0, "awards": 0, "xp": 0, "badges": 0}
    for batch_id in batch_ids():
        rows = ranking(ranked_members(batch_id), start, end, limit=rules.STANDING_TOP_N)
        if not rows:
            continue
        stats["batches"] += 1
        for rank, (user_id, _xp) in enumerate(rows, start=1):
            points = rules.weekly_standing_xp(rank)
            if points > 0:
                item = AwardedItem(
                    kind=rules.KIND_LEADERBOARD_WEEKLY,
                    points=points,
                    key=f"lb-week:{batch_id}:{week.isoformat()}:{user_id}",
                    source_type=SOURCE_LEADERBOARD,
                    source_id=f"{batch_id}:{week.isoformat()}",
                    occurred_at=stamp,
                    ctx={"rank": rank, "batch_id": batch_id},
                )
                result = services.award(user_id, item)
                if result.events:
                    stats["awards"] += 1
                    stats["xp"] += result.points
            if rank <= rules.PODIUM_TOP_N:
                if services.grant_badge(user_id, PODIUM_BADGE, note=f"week {week.isoformat()} batch {batch_id}", at=stamp):
                    stats["badges"] += 1
    return stats


def close_month(month: date) -> dict:
    """Award 100 XP to each batch's all-time top 10 as of the month's end."""
    start, end = month_window(month)
    tag = month.strftime("%Y-%m")
    stamp = end - timedelta(seconds=1)
    # This month's own awards never count towards it (re-runs rank the same).
    exclude = Q(kind=rules.KIND_LEADERBOARD_MONTHLY, occurred_at__gte=start)
    stats = {"batches": 0, "awards": 0, "xp": 0}
    for batch_id in batch_ids():
        rows = ranking(ranked_members(batch_id), None, end, exclude=exclude, limit=rules.STANDING_TOP_N)
        if not rows:
            continue
        stats["batches"] += 1
        for rank, (user_id, _xp) in enumerate(rows, start=1):
            points = rules.monthly_standing_xp(rank)
            if points <= 0:
                continue
            item = AwardedItem(
                kind=rules.KIND_LEADERBOARD_MONTHLY,
                points=points,
                key=f"lb-month:{batch_id}:{tag}:{user_id}",
                source_type=SOURCE_LEADERBOARD,
                source_id=f"{batch_id}:{tag}",
                occurred_at=stamp,
                ctx={"rank": rank, "batch_id": batch_id},
            )
            result = services.award(user_id, item)
            if result.events:
                stats["awards"] += 1
                stats["xp"] += result.points
    return stats


def run_due(now: datetime | None = None) -> dict:
    """Close every due week and month not closed yet (one worker at a time)."""
    stats = {"weeks": 0, "months": 0}
    if not services.is_enabled() or not rules.standing_awards_enabled():
        return stats
    lock = DistributedLock("eng:standings:run", ttl=1800, blocking_timeout=0)
    try:
        if not lock.acquire(blocking=False):
            return stats
    except Exception:  # noqa: BLE001
        return stats
    try:
        for week in closed_weeks(now):
            if _run_once(f"eng:standings:w:{week.isoformat()}", week_window(week)[1], lambda w=week: close_week(w)):
                stats["weeks"] += 1
        for month in closed_months(now):
            tag = month.strftime("%Y-%m")
            if _run_once(f"eng:standings:m:{tag}", month_window(month)[1], lambda m=month: close_month(m)):
                stats["months"] += 1
    finally:
        lock.release()
    return stats


def _run_once(marker: str, end: datetime, func) -> bool:
    if not _after_release(end):
        return False
    try:
        if cache.get(marker):
            return False
    except Exception:  # noqa: BLE001
        pass
    result = func()
    logger.info("engagement.standings %s %s", marker, result)
    try:
        cache.set(marker, 1, timeout=DONE_TTL_SECONDS)
    except Exception:  # noqa: BLE001
        pass
    return True


def publish_due() -> None:
    """Hourly worker hook: one deduplicated outbox event per hour."""
    from apps.core.outbox import publish

    from .signals import EVENT_STANDINGS

    bucket = int(timezone.now().timestamp()) // 3600
    publish(EVENT_STANDINGS, {}, dedupe_key=f"eng-standings:{bucket}")
