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

Prize rules (owner, Nov 2026; tunable ``ENGAGEMENT_PRIZE_*``, see rules.py):
only published, real batch courses compete; a student needs 150+ learning XP
in the period (purchase and standing XP never count); a student wins once per
period, in the batch where they placed best (the others rank without them);
a batch with fewer than 30 active students pays only its top 3. ``plan_week``
/ ``plan_month`` compute this without writing (the closes and
``manage.py engagement_void_prizes`` share it).

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
from dataclasses import dataclass, field
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
def all_batch_ids() -> list[int]:
    """Every course with an active enrolment (eligible to compete or not)."""
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment

    return sorted(set(Enrollment.objects.filter(active_enrollment_q()).values_list("course_id", flat=True)))


def batch_eligibility(course) -> tuple[bool, str]:
    """``(competes, reason)``: only published, real batch courses compete (owner prize rules)."""
    import re

    if course is None:
        return False, "course not found"
    if course.pk in rules.prize_excluded_course_ids():
        return False, "course excluded (ENGAGEMENT_PRIZE_EXCLUDED_COURSE_IDS)"
    if not getattr(course, "is_published", False):
        return False, "course not published"
    if re.search(rules.PRIZE_TEST_TITLE_PATTERN, f"{course.title} {course.batch}", flags=re.IGNORECASE):
        return False, "test or hidden course"
    return True, ""


def batch_ids() -> list[int]:
    """The batches that compete for prizes."""
    from apps.courses.models import Course

    courses = Course.objects.in_bulk(all_batch_ids())
    return [pk for pk in sorted(courses) if batch_eligibility(courses[pk])[0]]


def _active_members(batch_id: int) -> set[int]:
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment

    return set(
        Enrollment.objects.filter(course_id=batch_id)
        .filter(active_enrollment_q())
        .filter(user__is_active=True, user__is_staff=False, user__is_superuser=False)
        .values_list("user_id", flat=True)
    )


def ranked_members(batch_id: int) -> list[int]:
    """Active, non-staff, visible members of the batch now."""
    members = _active_members(batch_id)
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


def ranking(
    member_ids, start: datetime | None, end: datetime, *, exclude: Q | None = None, limit: int | None
) -> list[tuple[int, int]]:
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
        .order_by("-xp", "last", "user_id")
    )
    if limit is not None:
        rows = rows[:limit]
    return [(int(row["user_id"]), int(row["xp"])) for row in rows]


def learning_xp(user_ids, start: datetime, end: datetime) -> dict[int, int]:
    """Learning XP per user in ``[start, end)``: never purchase or standing XP."""
    if not user_ids:
        return {}
    rows = (
        XpEvent.objects.filter(user_id__in=list(user_ids), occurred_at__gte=start, occurred_at__lt=end)
        .exclude(kind__in=rules.NON_STUDY_KINDS)
        .values("user_id")
        .annotate(xp=Sum("points"))
    )
    return {int(row["user_id"]): int(row["xp"] or 0) for row in rows}


# --- the prize plan (pure: no writes) -------------------------------------------------------------------
@dataclass(frozen=True)
class Prize:
    batch_id: int
    user_id: int
    rank: int
    xp: int
    points: int

    @property
    def podium(self) -> bool:
        return self.rank <= rules.PODIUM_TOP_N


@dataclass
class PrizePlan:
    """Who a period's close pays under the prize rules, and why anyone else is not paid."""

    kind: str  # "week" | "month"
    period: date
    prizes: list[Prize] = field(default_factory=list)
    eligible: dict[int, tuple[bool, str]] = field(default_factory=dict)
    members: dict[int, set[int]] = field(default_factory=dict)
    raw: dict[int, list[tuple[int, int]]] = field(default_factory=dict)
    learning: dict[int, int] = field(default_factory=dict)
    home: dict[int, tuple[int, int]] = field(default_factory=dict)  # user -> (batch, position)
    paid_places: dict[int, int] = field(default_factory=dict)
    active_counts: dict[int, int] = field(default_factory=dict)

    def prize_for(self, batch_id: int, user_id: int) -> Prize | None:
        for prize in self.prizes:
            if prize.batch_id == batch_id and prize.user_id == user_id:
                return prize
        return None

    def podium_users(self) -> set[int]:
        return {prize.user_id for prize in self.prizes if prize.podium}

    def explain(self, batch_id: int, user_id: int) -> str:
        """Why ``user_id`` wins nothing in ``batch_id`` under the rules ("" when they do)."""
        if self.prize_for(batch_id, user_id) is not None:
            return ""
        competes, reason = self.eligible.get(batch_id, (False, "course has no active enrolments"))
        if not competes:
            return reason
        if user_id not in self.members.get(batch_id, set()):
            return "not ranked in this batch (left it, hidden, or staff)"
        if user_id not in {uid for uid, _xp in self.raw.get(batch_id, [])}:
            return "no XP in the period"
        minimum = rules.prize_min_learning_xp()
        learned = self.learning.get(user_id, 0)
        if learned < minimum:
            return f"{learned} learning XP in the period (minimum {minimum})"
        home = self.home.get(user_id)
        if home is not None and home[0] != batch_id and rules.prize_one_per_student():
            return f"one prize per student: placed best in batch {home[0]}"
        places = self.paid_places.get(batch_id, rules.STANDING_TOP_N)
        if places < rules.STANDING_TOP_N:
            return f"small batch ({self.active_counts.get(batch_id, 0)} active students): only the top {places} are paid"
        return f"outside the top {places}"


def _plan(kind: str, period: date) -> PrizePlan:
    from apps.courses.models import Course

    if kind == "week":
        start, end = week_window(period)
        release = rules.release_at()
        if release is not None and release > start:
            start = release  # nothing from before release day counts
        rank_start, exclude, points_for = start, None, rules.weekly_standing_xp
    else:
        start, end = month_window(period)
        # All-time board; this month's own awards never count towards it (re-runs rank the same).
        rank_start = None
        exclude = Q(kind=rules.KIND_LEADERBOARD_MONTHLY, occurred_at__gte=start)
        points_for = rules.monthly_standing_xp
    plan = PrizePlan(kind=kind, period=period)
    courses = Course.objects.in_bulk(all_batch_ids())
    for batch_id in sorted(courses):
        plan.eligible[batch_id] = batch_eligibility(courses[batch_id])
        plan.active_counts[batch_id] = len(_active_members(batch_id))
        members = ranked_members(batch_id)
        plan.members[batch_id] = set(members)
        plan.raw[batch_id] = ranking(members, rank_start, end, exclude=exclude, limit=None)
    ranked_users = {uid for rows in plan.raw.values() for uid, _xp in rows}
    plan.learning = learning_xp(ranked_users, start, end)
    minimum = rules.prize_min_learning_xp()
    qualified: dict[int, list[tuple[int, int]]] = {}
    for batch_id, rows in plan.raw.items():
        if not plan.eligible[batch_id][0]:
            continue
        qualified[batch_id] = [(uid, xp) for uid, xp in rows if plan.learning.get(uid, 0) >= minimum]
        for position, (uid, _xp) in enumerate(qualified[batch_id], start=1):
            best = plan.home.get(uid)
            if best is None or (position, batch_id) < (best[1], best[0]):
                plan.home[uid] = (batch_id, position)
    small_size, small_top = rules.prize_small_batch_size(), rules.prize_small_batch_top_n()
    for batch_id, rows in qualified.items():
        if rules.prize_one_per_student():
            rows = [(uid, xp) for uid, xp in rows if plan.home.get(uid, (batch_id, 0))[0] == batch_id]
        places = rules.STANDING_TOP_N
        if small_size and plan.active_counts.get(batch_id, 0) < small_size:
            places = min(places, small_top)
        plan.paid_places[batch_id] = places
        for rank, (uid, xp) in enumerate(rows[:places], start=1):
            points = points_for(rank)
            if points > 0:
                plan.prizes.append(Prize(batch_id=batch_id, user_id=uid, rank=rank, xp=xp, points=points))
    return plan


def plan_week(week: date) -> PrizePlan:
    return _plan("week", week)


def plan_month(month: date) -> PrizePlan:
    return _plan("month", month)


# --- closes -------------------------------------------------------------------------------------------
def week_award_key(batch_id: int, week: date, user_id: int) -> str:
    return f"lb-week:{batch_id}:{week.isoformat()}:{user_id}"


def month_award_key(batch_id: int, month: date, user_id: int) -> str:
    return f"lb-month:{batch_id}:{month.strftime('%Y-%m')}:{user_id}"


def close_week(week: date) -> dict:
    """Award the standing XP and podium badges of one closed IST week (all batches)."""
    _start, end = week_window(week)
    stamp = end - timedelta(seconds=1)
    plan = plan_week(week)
    stats = {"batches": len({prize.batch_id for prize in plan.prizes}), "awards": 0, "xp": 0, "badges": 0}
    for prize in plan.prizes:
        item = AwardedItem(
            kind=rules.KIND_LEADERBOARD_WEEKLY,
            points=prize.points,
            key=week_award_key(prize.batch_id, week, prize.user_id),
            source_type=SOURCE_LEADERBOARD,
            source_id=f"{prize.batch_id}:{week.isoformat()}",
            occurred_at=stamp,
            ctx={"rank": prize.rank, "batch_id": prize.batch_id},
        )
        result = services.award(prize.user_id, item)
        if result.events:
            stats["awards"] += 1
            stats["xp"] += result.points
        if prize.podium and services.grant_badge(
            prize.user_id, PODIUM_BADGE, note=f"week {week.isoformat()} batch {prize.batch_id}", at=stamp
        ):
            stats["badges"] += 1
    return stats


def close_month(month: date) -> dict:
    """Award 100 XP to each batch's all-time top 10 as of the month's end (prize rules apply)."""
    _start, end = month_window(month)
    tag = month.strftime("%Y-%m")
    stamp = end - timedelta(seconds=1)
    plan = plan_month(month)
    stats = {"batches": len({prize.batch_id for prize in plan.prizes}), "awards": 0, "xp": 0}
    for prize in plan.prizes:
        item = AwardedItem(
            kind=rules.KIND_LEADERBOARD_MONTHLY,
            points=prize.points,
            key=month_award_key(prize.batch_id, month, prize.user_id),
            source_type=SOURCE_LEADERBOARD,
            source_id=f"{prize.batch_id}:{tag}",
            occurred_at=stamp,
            ctx={"rank": prize.rank, "batch_id": prize.batch_id},
        )
        result = services.award(prize.user_id, item)
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
