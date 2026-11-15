"""The only way XP, streaks, badges and achievements change.

``award_many(user_id, items)`` runs in ONE transaction under the user's
``EngagementSummary`` row lock (``select_for_update``), so every award for a
user is serialised:

1. drop items whose idempotency key is already in the ledger;
2. insert the new ``XpEvent`` rows;
3. add XP to the ``ActivityDay`` rows (IST days); a first positive XP of a day
   makes it a study day -> streaks are recomputed from the study days and a
   daily streak bonus is added for each new day that continues a streak;
4. update the summary with ``F()`` (total, weekly, version, badges);
5. evaluate the badges the awarded kinds can trigger; create ``Achievement``
   rows for new badges, levels reached and courses completed;
6. after commit: push the new scores to the leaderboards.

Everything is idempotent: replaying the same items is a no-op.
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from apps.core import features
from apps.core.errors import NotFound, ValidationFailed

from . import badges as badge_catalogue
from . import leaderboard, rules, streaks
from .badges import AwardedItem, BadgeContext
from .models import (
    Achievement,
    ActivityDay,
    BadgeAward,
    EngagementAuditLog,
    EngagementSettings,
    EngagementSummary,
    XpEvent,
)

logger = logging.getLogger("apps.engagement.services")


def is_enabled() -> bool:
    return features.is_enabled(rules.FEATURE_KEY)


def require_enabled() -> None:
    features.require(rules.FEATURE_KEY)


@dataclass
class AwardResult:
    skipped: bool = False
    events: list[XpEvent] = field(default_factory=list)
    total_xp: int = 0
    level: int = 1
    leveled_up: bool = False
    old_level: int = 1
    # Every event happened before release day (the backfill): no level-up
    # notification or celebration for history (the journey screen covers it).
    historical: bool = False
    badges: list[str] = field(default_factory=list)
    achievements: list[Achievement] = field(default_factory=list)

    @property
    def points(self) -> int:
        return sum(event.points for event in self.events)


# --- summary row ------------------------------------------------------------------
def _lock_summary(user_id: int) -> EngagementSummary:
    summary = EngagementSummary.objects.select_for_update().filter(user_id=user_id).first()
    if summary is not None:
        return summary
    try:
        with transaction.atomic():
            EngagementSummary.objects.create(user_id=user_id)
    except IntegrityError:
        pass
    return EngagementSummary.objects.select_for_update().get(user_id=user_id)


def _day_anchor(day: date) -> datetime:
    """Noon IST of ``day`` (a stable timestamp for day-scoped events)."""
    return datetime.combine(day, time(12, 0), tzinfo=rules.IST)


# --- award --------------------------------------------------------------------------
def award_many(user_id: int, items: list[AwardedItem], *, force: bool = False, now: datetime | None = None) -> AwardResult:
    """Award ``items`` to one user. ``force`` ignores the feature switch (tests only)."""
    if not force and not is_enabled():
        return AwardResult(skipped=True)
    unique: dict[str, AwardedItem] = {}
    for item in items:
        if item.key and item.key not in unique:
            unique[item.key] = item
    if not unique:
        return AwardResult()
    now = now or timezone.now()
    with transaction.atomic():
        summary = _lock_summary(user_id)
        result = _apply(summary, list(unique.values()), now)
        if result.events:
            snapshot = _summary_copy(summary)
            transaction.on_commit(lambda: after_award_commit(user_id, snapshot))
        if result.leveled_up and not result.historical:
            old, new = result.old_level, result.level
            transaction.on_commit(lambda: notify_level_up(user_id, old, new))
    return result


def settle_report_bonus(submission, *, extra: list[AwardedItem] | None = None, force: bool = False) -> AwardResult:
    """Pay (or take back) the report-mark bonus difference for one graded report.

    The ledger is read under the student's summary row lock, so two regrade
    events delivered at once settle in turn: the second sees the first's row
    and pays only what is still owed (the unique ledger key also guards it).
    ``extra`` items (the submission XP) are awarded in the same transaction.
    """
    from . import sources

    if not force and not is_enabled():
        return AwardResult(skipped=True)
    with transaction.atomic():
        _lock_summary(submission.student_id)
        items = [item for item in (extra or []) if item is not None]
        bonus = sources.report_graded_item(submission)
        if bonus is not None:
            items.append(bonus)
        if not items:
            return AwardResult()
        return award_many(submission.student_id, items, force=force)


def notify_level_up(user_id: int, old_level: int, new_level: int) -> None:
    """In-app notification for a new rank (after commit; never raises)."""
    try:
        from apps.notifications.services import create_notification

        level = rules.level_by_number(new_level)
        create_notification(
            kind="level_up",
            title=f"You reached {level.title}",
            body=f"Level {level.number} at {level.min_xp:,} XP. See what's next on the level chart.",
            recipients=[user_id],
            event_key=f"engagement-level-up:{int(user_id)}:{level.key}",
            action_url="/levels",
        )
    except Exception:  # noqa: BLE001 - a notification never affects the award
        logger.warning("engagement.level_up_notify_failed user=%s", user_id, exc_info=True)


def acknowledge_level(user_id: int) -> int:
    """The student saw the level-up moment: ``level_seen`` catches up (monotonic)."""
    from django.db.models import Value
    from django.db.models.functions import Greatest

    total = EngagementSummary.objects.filter(user_id=user_id).values_list("total_xp", flat=True).first()
    if total is None:
        return 1
    level = rules.level_for(total).number
    EngagementSummary.objects.filter(user_id=user_id).update(level_seen=Greatest(F("level_seen"), Value(level)))
    return level


SNAPSHOT_CACHE_SECONDS = 7 * 24 * 3600


def snapshot_cache_key(user_id: int) -> str:
    return f"eng:snap:{int(user_id)}"


def after_award_commit(user_id: int, snapshot: EngagementSummary) -> None:
    """Leaderboards + the cached {xp, level, streak} used by the X-Engagement header."""
    try:
        cache.set(snapshot_cache_key(user_id), summary_snapshot(snapshot), timeout=SNAPSHOT_CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        logger.warning("engagement.snapshot_cache_failed user=%s", user_id, exc_info=True)
    leaderboard.on_summary_changed(user_id, snapshot)


def award(user_id: int, item: AwardedItem, **kwargs) -> AwardResult:
    return award_many(user_id, [item], **kwargs)


def _summary_copy(summary: EngagementSummary) -> EngagementSummary:
    copy = EngagementSummary(user_id=summary.user_id)
    for name in (
        "total_xp", "level", "xp_reached_at", "week_start", "weekly_xp", "weekly_reached_at",
        "current_streak", "best_streak", "last_study_day", "freeze_week", "badges_count", "version",
        "time_week_seconds", "time_total_seconds", "last_activity_at",
        "purchase_xp", "weekly_purchase_xp", "level_seen",
    ):
        setattr(copy, name, getattr(summary, name))
    return copy


def _existing_keys(keys) -> set[str]:
    return set(XpEvent.objects.filter(idempotency_key__in=list(keys)).values_list("idempotency_key", flat=True))


def _insert(summary, items: list[AwardedItem], now: datetime) -> list[XpEvent]:
    existing = _existing_keys(item.key for item in items)
    fresh = [item for item in items if item.key not in existing]
    if not fresh:
        return []
    for item in fresh:
        item.occurred_at = item.occurred_at or now
    events = [
        XpEvent(
            user_id=summary.user_id,
            kind=item.kind,
            source_type=item.source_type,
            source_id=str(item.source_id or "")[:40],
            points=int(item.points),
            occurred_at=item.occurred_at,
            created_at=now,
            idempotency_key=item.key[:120],
        )
        for item in fresh
    ]
    XpEvent.objects.bulk_create(events)
    return events


def _apply(summary: EngagementSummary, items: list[AwardedItem], now: datetime) -> AwardResult:
    result = AwardResult()
    events = _insert(summary, items, now)
    if not events:
        result.total_xp, result.level = summary.total_xp, summary.level
        return result
    inserted = {event.idempotency_key for event in events}
    fresh_items = [item for item in items if item.key[:120] in inserted]
    new_days = _apply_days(summary.user_id, events)
    study_days: list[date] = []
    if new_days:
        study_days = list(
            ActivityDay.objects.filter(user_id=summary.user_id, is_study_day=True).values_list("day", flat=True)
        )
        # Fairness: streaks start fresh on release day (best_streak keeps history).
        epoch = rules.epoch_day()
        state = streaks.compute([day for day in study_days if epoch is None or day >= epoch])
        summary.current_streak = state.current
        summary.best_streak = max(int(summary.best_streak or 0), state.best)
        summary.last_study_day = state.last_day
        summary.freeze_week = state.freeze_week
        summary.freeze_used_on = state.freeze_used_on
        earliest = min(new_days)
        bonus_items = [
            AwardedItem(
                kind=rules.KIND_STREAK_BONUS,
                points=rules.STREAK_DAILY_BONUS_XP,
                key=f"streak:{summary.user_id}:{day.isoformat()}",
                source_type=XpEvent.SOURCE_DAY,
                source_id=day.isoformat(),
                occurred_at=_day_anchor(day) if day != rules.ist_day(now) else now,
            )
            for day in sorted(state.continuing_days)
            if day >= earliest
        ]
        if bonus_items:
            bonus_events = _insert(summary, bonus_items, now)
            if bonus_events:
                _apply_days(summary.user_id, bonus_events)
                events.extend(bonus_events)
                fresh_items.extend(item for item in bonus_items if item.key in {e.idempotency_key for e in bonus_events})
    result.events = events
    _update_totals(summary, events, now)
    old_level = int(summary.level or 1)
    summary.level = rules.level_for(summary.total_xp).number
    result.leveled_up = summary.level > old_level
    result.old_level = old_level
    release = rules.release_at()
    result.historical = release is not None and all(event.occurred_at < release for event in events)
    purchase_delta = sum(event.points for event in events if event.kind in rules.PURCHASE_KINDS)
    level_seen = int(getattr(summary, "level_seen", 1) or 1)
    if result.historical:
        level_seen = max(level_seen, summary.level)
    course_completions = _course_completions(summary.user_id, fresh_items)
    new_badges = _evaluate_badges(summary, fresh_items, new_days, study_days, course_completions)
    achievements = _milestone_achievements(summary.user_id, old_level, summary.level, new_badges, course_completions, now)
    if new_badges:
        summary.badges_count = int(summary.badges_count or 0) + len(new_badges)
    EngagementSummary.objects.filter(pk=summary.pk).update(
        total_xp=F("total_xp") + sum(event.points for event in events),
        level=summary.level,
        xp_reached_at=summary.xp_reached_at,
        week_start=summary.week_start,
        weekly_xp=summary.weekly_xp if summary._weekly_reset else F("weekly_xp") + summary._weekly_delta,
        purchase_xp=F("purchase_xp") + purchase_delta,
        weekly_purchase_xp=(
            summary.weekly_purchase_xp if summary._weekly_reset else F("weekly_purchase_xp") + summary._weekly_purchase_delta
        ),
        level_seen=level_seen,
        weekly_reached_at=summary.weekly_reached_at,
        time_week_seconds=summary.time_week_seconds,
        current_streak=summary.current_streak,
        best_streak=summary.best_streak,
        last_study_day=summary.last_study_day,
        freeze_week=summary.freeze_week,
        freeze_used_on=summary.freeze_used_on,
        badges_count=F("badges_count") + len(new_badges),
        last_activity_at=summary.last_activity_at,
        version=F("version") + 1,
        updated_at=now,
    )
    summary.version = int(summary.version or 0) + 1
    summary.purchase_xp = int(summary.purchase_xp or 0) + purchase_delta
    summary.level_seen = level_seen
    result.total_xp = summary.total_xp
    result.level = summary.level
    result.badges = new_badges
    result.achievements = achievements
    return result


def _apply_days(user_id: int, events: list[XpEvent]) -> list[date]:
    per_day: dict[date, int] = defaultdict(int)
    first_at: dict[date, datetime] = {}
    for event in events:
        day = rules.ist_day(event.occurred_at)
        per_day[day] += int(event.points)
        # Paying or placing on a board is not studying: it never makes a study day.
        if event.points > 0 and event.kind not in rules.NON_STUDY_KINDS and (
            day not in first_at or event.occurred_at < first_at[day]
        ):
            first_at[day] = event.occurred_at
    existing = {row.day: row for row in ActivityDay.objects.filter(user_id=user_id, day__in=list(per_day))}
    new_study_days = []
    to_create = []
    for day, points in per_day.items():
        row = existing.get(day)
        positive = day in first_at
        if row is None:
            to_create.append(
                ActivityDay(
                    user_id=user_id,
                    day=day,
                    xp=points,
                    is_study_day=positive,
                    first_activity_at=first_at.get(day),
                )
            )
            if positive:
                new_study_days.append(day)
            continue
        updates = {"xp": F("xp") + points}
        if positive and not row.is_study_day:
            updates["is_study_day"] = True
            updates["first_activity_at"] = first_at[day]
            new_study_days.append(day)
        ActivityDay.objects.filter(pk=row.pk).update(**updates)
    if to_create:
        ActivityDay.objects.bulk_create(to_create)
    return sorted(new_study_days)


def _roll_week(summary: EngagementSummary, week: date) -> bool:
    if summary.week_start != week:
        summary.week_start = week
        summary.weekly_xp = 0
        summary.weekly_purchase_xp = 0
        summary.weekly_reached_at = None
        summary.time_week_seconds = 0
        return True
    return False


def _update_totals(summary: EngagementSummary, events: list[XpEvent], now: datetime) -> None:
    week = rules.current_week_start(now)
    summary._weekly_reset = _roll_week(summary, week)
    total_delta = sum(event.points for event in events)
    epoch = rules.epoch_day()
    weekly_delta = sum(
        event.points
        for event in events
        if rules.week_start(rules.ist_day(event.occurred_at)) == week
        and (epoch is None or rules.ist_day(event.occurred_at) >= epoch)
    )
    summary.total_xp = int(summary.total_xp or 0) + total_delta
    summary.weekly_xp = int(summary.weekly_xp or 0) + weekly_delta
    summary._weekly_delta = weekly_delta
    weekly_purchase_delta = sum(
        event.points
        for event in events
        if event.kind in rules.PURCHASE_KINDS
        and rules.week_start(rules.ist_day(event.occurred_at)) == week
        and (epoch is None or rules.ist_day(event.occurred_at) >= epoch)
    )
    summary.weekly_purchase_xp = int(summary.weekly_purchase_xp or 0) + weekly_purchase_delta
    summary._weekly_purchase_delta = weekly_purchase_delta
    # "Reached" = when the newest contributing activity happened (capped at now),
    # never earlier than the stored value: the leaderboard tie-break.
    latest_positive = min(now, max((event.occurred_at for event in events if event.points > 0), default=now))
    if total_delta > 0:
        summary.xp_reached_at = max(filter(None, [summary.xp_reached_at, latest_positive]))
    if weekly_delta > 0:
        summary.weekly_reached_at = max(filter(None, [summary.weekly_reached_at, latest_positive]))
    latest = max(
        (event.occurred_at for event in events if event.points > 0 and event.kind not in rules.NON_STUDY_KINDS),
        default=None,
    )
    if latest and (summary.last_activity_at is None or latest > summary.last_activity_at):
        summary.last_activity_at = latest


# --- badges & achievements ---------------------------------------------------------------
def _course_completions(user_id: int, items: list[AwardedItem]) -> dict[int, datetime | None]:
    """Courses this award completed -> when (the latest lecture completion: the
    real completion date, also for backfilled history)."""
    lecture_ids = [int(item.source_id) for item in items if item.kind == rules.KIND_LECTURE_COMPLETED and item.source_id]
    if not lecture_ids:
        return {}
    from django.db.models import Count, Max

    from apps.courses.models import Lecture

    course_ids = set(Lecture.objects.filter(pk__in=lecture_ids).values_list("section__course_id", flat=True))
    completed: dict[int, datetime | None] = {}
    for course_id in sorted(course_ids):
        published = [str(pk) for pk in Lecture.objects.published().filter(section__course_id=course_id).values_list("pk", flat=True)]
        if not published:
            continue
        row = XpEvent.objects.filter(
            user_id=user_id, kind=rules.KIND_LECTURE_COMPLETED, source_id__in=published
        ).aggregate(done=Count("id"), at=Max("occurred_at"))
        if int(row["done"] or 0) >= len(published):
            completed[course_id] = row["at"]
    return completed


def _evaluate_badges(summary, items, new_days, study_days, course_completions) -> list[str]:
    kinds = {item.kind for item in items}
    candidates = badge_catalogue.candidates(kinds, new_study_day=bool(new_days))
    if not candidates:
        return []
    owned = set(BadgeAward.objects.filter(user_id=summary.user_id).values_list("badge_key", flat=True))
    candidates = [badge for badge in candidates if badge.key not in owned]
    if not candidates:
        return []
    memo: dict = {}

    def count_kind(kind):
        if ("k", kind) not in memo:
            memo[("k", kind)] = XpEvent.objects.filter(user_id=summary.user_id, kind=kind).count()
        return memo[("k", kind)]

    def count_kind_min_points(kind, points):
        if ("p", kind, points) not in memo:
            memo[("p", kind, points)] = XpEvent.objects.filter(
                user_id=summary.user_id, kind=kind, points__gte=points
            ).count()
        return memo[("p", kind, points)]

    context = BadgeContext(
        user_id=summary.user_id,
        summary=summary,
        items=items,
        new_study_days=list(new_days),
        study_days=list(study_days),
        count_kind=count_kind,
        count_kind_min_points=count_kind_min_points,
        course_completions=course_completions,
    )
    earned = []
    for badge in candidates:
        try:
            if badge.check(context):
                earned.append(badge.key)
        except Exception:  # noqa: BLE001 - one broken criterion must not block XP
            logger.exception("engagement.badge_check_failed badge=%s", badge.key)
    if earned:
        now = timezone.now()
        BadgeAward.objects.bulk_create(
            [BadgeAward(user_id=summary.user_id, badge_key=key, awarded_at=now) for key in earned],
            ignore_conflicts=True,
        )
    return earned


def _recipient_name(user_id: int) -> str:
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.filter(pk=user_id).only("full_name", "email").first()
    if user is None:
        return ""
    # The real name only: never the e-mail (or part of it) on a public card.
    return (user.full_name or "").strip()


def _milestone_achievements(user_id, old_level, new_level, new_badges, course_completions, now) -> list[Achievement]:
    wanted = []
    for number in range(int(old_level) + 1, int(new_level) + 1):
        level = rules.level_by_number(number)
        wanted.append((Achievement.KIND_LEVEL, level.key, f"Reached {level.title}", f"Level {level.number} · {level.min_xp:,} XP"))
    for key in new_badges:
        badge = badge_catalogue.get(key)
        if badge:
            wanted.append((Achievement.KIND_BADGE, badge.key, badge.title, badge.description))
    earned_at = {}
    if course_completions:
        from apps.courses.models import Course

        titles = dict(Course.objects.filter(pk__in=list(course_completions)).values_list("pk", "title"))
        for course_id in course_completions:
            wanted.append((Achievement.KIND_COURSE, str(course_id), "Course completed", titles.get(course_id, "")[:200]))
            completed_at = course_completions.get(course_id) if isinstance(course_completions, dict) else None
            # Dated on the real completion (the certificate's issue date follows).
            earned_at[(Achievement.KIND_COURSE, str(course_id))] = min(now, completed_at) if completed_at else now
    if not wanted:
        return []
    name = _recipient_name(user_id)
    existing = set(
        Achievement.objects.filter(user_id=user_id, kind__in={kind for kind, *_ in wanted}).values_list("kind", "key")
    )
    rows = [
        Achievement(
            user_id=user_id, kind=kind, key=key, title=title[:160], subtitle=subtitle[:200], recipient_name=name[:255],
            earned_at=earned_at.get((kind, key), now),
        )
        for kind, key, title, subtitle in wanted
        if (kind, key) not in existing
    ]
    if rows:
        Achievement.objects.bulk_create(rows, ignore_conflicts=True)
        # Each achievement is certified (reference number, name snapshot) in this
        # same transaction; a failure there is isolated and retried on first use.
        from .certificates import issue_for_new_achievements

        issue_for_new_achievements(user_id, [(row.kind, row.key) for row in rows])
    return rows


# --- time spent (write-behind flush) -----------------------------------------------------------
def apply_time(user_id: int, per_day_seconds: dict[date, int], *, kind: str, now: datetime | None = None) -> None:
    """Add watched/live seconds per IST day (under the summary lock)."""
    now = now or timezone.now()
    per_day_seconds = {day: int(seconds) for day, seconds in per_day_seconds.items() if int(seconds) > 0}
    if not per_day_seconds:
        return
    column = "watch_seconds" if kind == "watch" else "live_seconds"
    week = rules.current_week_start(now)
    with transaction.atomic():
        summary = _lock_summary(user_id)
        existing = {row.day: row for row in ActivityDay.objects.filter(user_id=user_id, day__in=list(per_day_seconds))}
        create = []
        for day, seconds in per_day_seconds.items():
            if day in existing:
                ActivityDay.objects.filter(pk=existing[day].pk).update(**{column: F(column) + seconds})
            else:
                create.append(ActivityDay(user_id=user_id, day=day, **{column: seconds}))
        if create:
            ActivityDay.objects.bulk_create(create)
        reset = _roll_week(summary, week)
        this_week = sum(seconds for day, seconds in per_day_seconds.items() if rules.week_start(day) == week)
        total = sum(per_day_seconds.values())
        updates = {
            "time_total_seconds": F("time_total_seconds") + total,
            "version": F("version") + 1,
            "updated_at": now,
        }
        if reset:
            updates.update(
                week_start=week, weekly_xp=0, weekly_purchase_xp=0, weekly_reached_at=None, time_week_seconds=this_week
            )
        else:
            updates["time_week_seconds"] = F("time_week_seconds") + this_week
        EngagementSummary.objects.filter(pk=summary.pk).update(**updates)


def set_backfill_watch(user_id: int, per_day_seconds: dict[date, int], *, now: datetime | None = None) -> int:
    """Backfill: store estimated watch seconds per day (set, never added: re-runs
    are no-ops). Time totals grow by the change of the counted value. Returns the
    seconds added to the user's total."""
    now = now or timezone.now()
    per_day_seconds = {day: int(seconds) for day, seconds in per_day_seconds.items() if int(seconds) > 0}
    if not per_day_seconds:
        return 0
    week = rules.current_week_start(now)
    added_total = added_week = 0
    with transaction.atomic():
        summary = _lock_summary(user_id)
        existing = {row.day: row for row in ActivityDay.objects.filter(user_id=user_id, day__in=list(per_day_seconds))}
        create = []
        for day, estimate in per_day_seconds.items():
            row = existing.get(day)
            if row is None:
                create.append(ActivityDay(user_id=user_id, day=day, backfill_watch_seconds=estimate))
                delta = estimate
            else:
                if estimate <= int(row.backfill_watch_seconds or 0):
                    continue
                before = row.counted_watch_seconds
                ActivityDay.objects.filter(pk=row.pk).update(backfill_watch_seconds=estimate)
                delta = max(int(row.watch_seconds or 0), estimate) - before
            added_total += delta
            if rules.week_start(day) == week:
                added_week += delta
        if create:
            ActivityDay.objects.bulk_create(create)
        if added_total:
            reset = _roll_week(summary, week)
            updates = {"time_total_seconds": F("time_total_seconds") + added_total, "version": F("version") + 1}
            if reset:
                updates.update(
                    week_start=week, weekly_xp=0, weekly_purchase_xp=0, weekly_reached_at=None, time_week_seconds=added_week
                )
            else:
                updates["time_week_seconds"] = F("time_week_seconds") + added_week
            EngagementSummary.objects.filter(pk=summary.pk).update(**updates)
    return added_total


def award_watch_xp(user_id: int, days, *, now: datetime | None = None, force: bool = False) -> AwardResult:
    """Pay watch XP for ``days`` from their counted seconds (idempotent, capped per day)."""
    if not force and not is_enabled():
        return AwardResult(skipped=True)
    now = now or timezone.now()
    today = rules.ist_day(now)
    total = AwardResult()
    with transaction.atomic():
        summary = _lock_summary(user_id)
        rows = list(ActivityDay.objects.filter(user_id=user_id, day__in=list(days)).order_by("day"))
        items = []
        for row in rows:
            earned = rules.watch_blocks(row.counted_watch_seconds)
            if earned <= int(row.watch_xp_awarded or 0):
                continue
            items.append(
                AwardedItem(
                    kind=rules.KIND_WATCH_TIME,
                    points=earned - int(row.watch_xp_awarded or 0),
                    key=f"watch:{user_id}:{row.day.isoformat()}:{earned}",
                    source_type=XpEvent.SOURCE_DAY,
                    source_id=row.day.isoformat(),
                    occurred_at=now if row.day == today else _day_anchor(row.day),
                    ctx={"daily_cap_reached": earned >= rules.WATCH_DAILY_XP_CAP},
                )
            )
            ActivityDay.objects.filter(pk=row.pk).update(watch_xp_awarded=earned)
        if items:
            total = _apply(summary, items, now)
            if total.events:
                snapshot = _summary_copy(summary)
                transaction.on_commit(lambda: after_award_commit(user_id, snapshot))
    return total


# --- read helpers --------------------------------------------------------------------------------
def summary_snapshot(summary: EngagementSummary | None, *, today: date | None = None) -> dict:
    """``{xp, level, next_level, streak}`` from one summary row (no queries)."""
    today = today or rules.ist_day()
    total = int(getattr(summary, "total_xp", 0) or 0)
    level = rules.level_for(total)
    upcoming = rules.next_level(total)
    streak = streaks.effective(
        current=int(getattr(summary, "current_streak", 0) or 0),
        best=int(getattr(summary, "best_streak", 0) or 0),
        last_day=getattr(summary, "last_study_day", None),
        freeze_week=getattr(summary, "freeze_week", None),
        today=today,
    )
    week = rules.week_start(today)
    same_week = summary is not None and summary.week_start == week
    weekly = int(summary.weekly_xp or 0) if same_week else 0
    purchase = int(getattr(summary, "purchase_xp", 0) or 0)
    weekly_purchase = int(getattr(summary, "weekly_purchase_xp", 0) or 0) if same_week else 0
    seen = int(getattr(summary, "level_seen", 0) or 0) if summary is not None else level.number
    seen = max(1, min(seen or level.number, level.number)) if summary is not None else level.number
    return {
        "xp": total,
        "weekly_xp": weekly,
        # Both totals, always (ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP picks the ranked one).
        "purchase_xp": purchase,
        "xp_without_purchases": total - purchase,
        "weekly_purchase_xp": weekly_purchase,
        "weekly_xp_without_purchases": weekly - weekly_purchase,
        # The UI shows the level-up moment once while pending, then POSTs me/level-seen/.
        "level_up": {
            "pending": summary is not None and level.number > seen,
            "from_level": rules.level_dict(rules.level_by_number(seen)),
        },
        "level": rules.level_dict(level),
        "next_level": rules.level_dict(upcoming),
        "xp_to_next_level": (upcoming.min_xp - total) if upcoming else 0,
        "level_progress": _level_progress(total, level, upcoming),
        "streak": {
            "current": streak.current,
            "best": streak.best,
            "alive": streak.alive,
            "studied_today": streak.studied_today,
            "freeze_available": streak.freeze_available,
            "freeze_covering": streak.freeze_covering.isoformat() if streak.freeze_covering else None,
            "last_study_day": summary.last_study_day.isoformat() if summary is not None and summary.last_study_day else None,
        },
        "badges_count": int(getattr(summary, "badges_count", 0) or 0),
        "version": int(getattr(summary, "version", 0) or 0),
    }


def _level_progress(total: int, level, upcoming) -> float:
    if upcoming is None:
        return 1.0
    span = upcoming.min_xp - level.min_xp
    return round(max(0.0, min(1.0, (total - level.min_xp) / span)), 4) if span > 0 else 1.0


# --- settings ------------------------------------------------------------------------------------
def get_settings(user) -> EngagementSettings:
    row = EngagementSettings.objects.filter(user_id=user.pk).first()
    return row or EngagementSettings(user_id=user.pk)


def update_settings(user, *, leaderboard_display: str) -> EngagementSettings:
    valid = {value for value, _label in EngagementSettings.DISPLAY_CHOICES}
    if leaderboard_display not in valid:
        raise ValidationFailed(details={"leaderboard_display": [f"Choose one of: {', '.join(sorted(valid))}."]})
    with transaction.atomic():
        row, _created = EngagementSettings.objects.select_for_update().get_or_create(user_id=user.pk)
        changed = row.leaderboard_display != leaderboard_display
        row.leaderboard_display = leaderboard_display
        row.save(update_fields=["leaderboard_display", "updated_at"])
        if changed:
            visible = leaderboard_display != EngagementSettings.DISPLAY_HIDDEN
            transaction.on_commit(lambda: leaderboard.on_summary_changed(user.pk, None, visible=visible))
    return row


# --- badges granted by jobs ------------------------------------------------------------------------
def grant_badge(user_id: int, badge_key: str, *, note: str = "", at: datetime | None = None, achievement: bool = True) -> bool:
    """Grant a job-awarded badge once (weekly close "Podium Week", legacy run).

    Idempotent: returns False when the user already holds it (revoked awards
    stay revoked: staff decisions win). With ``achievement`` the badge also
    gets its shareable Achievement and certificate, like an earned badge.
    """
    badge = badge_catalogue.get(badge_key)
    if badge is None:
        raise ValidationFailed(details={"badge_key": ["Unknown badge."]})
    at = at or timezone.now()
    with transaction.atomic():
        summary = _lock_summary(user_id)
        if BadgeAward.objects.filter(user_id=user_id, badge_key=badge.key).exists():
            return False
        BadgeAward.objects.create(user_id=user_id, badge_key=badge.key, awarded_at=at, note=note[:200])
        if achievement:
            row, created = Achievement.objects.get_or_create(
                user_id=user_id,
                kind=Achievement.KIND_BADGE,
                key=badge.key,
                defaults={
                    "title": badge.title[:160],
                    "subtitle": badge.description[:200],
                    "recipient_name": _recipient_name(user_id)[:255],
                    "earned_at": at,
                },
            )
            if created:
                from .certificates import issue_for_new_achievements

                issue_for_new_achievements(user_id, [(row.kind, row.key)])
        EngagementSummary.objects.filter(pk=summary.pk).update(
            badges_count=F("badges_count") + 1, version=F("version") + 1, updated_at=timezone.now()
        )
    return True


# --- staff actions (audited) ------------------------------------------------------------------------
def _audit(*, actor, target_user_id, action, reason, points=None, badge_key="", xp_event=None, request=None):
    request_id = str(getattr(request, "request_id", "") or "")[:64] if request is not None else ""
    EngagementAuditLog.objects.create(
        actor=actor if getattr(actor, "pk", None) else None,
        actor_email=str(getattr(actor, "email", "") or "")[:254],
        target_user_id=target_user_id,
        action=action,
        points=points,
        badge_key=badge_key,
        xp_event=xp_event,
        reason=reason[:300],
        request_id=request_id,
    )
    try:
        from config.audit import log_security_event

        log_security_event(
            f"engagement.{action}", request, target_user_id=target_user_id, points=points, badge_key=badge_key
        )
    except Exception:  # noqa: BLE001 - logging only
        logger.debug("engagement audit log line failed", exc_info=True)


def _clean_reason(reason) -> str:
    text = " ".join(str(reason or "").split())
    if len(text) < 3:
        raise ValidationFailed(details={"reason": ["Give a short reason (at least 3 characters)."]})
    return text[:300]


def staff_award_xp(*, actor, user_id: int, points: int, reason: str, request=None) -> XpEvent:
    require_enabled()
    reason = _clean_reason(reason)
    try:
        points = int(points)
    except (TypeError, ValueError):
        points = 0
    if points == 0 or abs(points) > 10000:
        raise ValidationFailed(details={"points": ["Use a whole number between -10000 and 10000 (not 0)."]})
    _require_user(user_id)
    with transaction.atomic():
        item = AwardedItem(
            kind=rules.KIND_MANUAL,
            points=points,
            key=f"manual:{uuid.uuid4().hex}",
            source_type=XpEvent.SOURCE_STAFF,
            source_id=str(getattr(actor, "pk", "") or ""),
        )
        result = award(user_id, item)
        event = result.events[0]
        _audit(actor=actor, target_user_id=user_id, action=EngagementAuditLog.ACTION_AWARD_XP, reason=reason,
               points=points, xp_event=event, request=request)
    return event


def staff_revoke_xp(*, actor, event_id: int, reason: str, request=None) -> XpEvent:
    require_enabled()
    reason = _clean_reason(reason)
    original = XpEvent.objects.filter(pk=event_id).first()
    if original is None:
        raise NotFound("XP event not found.", code="xp_event_not_found")
    if original.kind == rules.KIND_REVOKE:
        raise ValidationFailed(details={"event_id": ["A revocation cannot be revoked; award XP instead."]})
    with transaction.atomic():
        item = AwardedItem(
            kind=rules.KIND_REVOKE,
            points=-int(original.points),
            key=f"revoke:{original.pk}",
            source_type=XpEvent.SOURCE_XP_EVENT,
            source_id=str(original.pk),
            occurred_at=original.occurred_at,
        )
        result = award(original.user_id, item)
        event = result.events[0] if result.events else XpEvent.objects.get(idempotency_key=item.key)
        if result.events:
            _audit(actor=actor, target_user_id=original.user_id, action=EngagementAuditLog.ACTION_REVOKE_XP,
                   reason=reason, points=event.points, xp_event=event, request=request)
    return event


def staff_set_badge(*, actor, user_id: int, badge_key: str, award_it: bool, reason: str, request=None) -> BadgeAward:
    require_enabled()
    reason = _clean_reason(reason)
    badge = badge_catalogue.get(badge_key)
    if badge is None:
        raise ValidationFailed(details={"badge_key": ["Unknown badge."]})
    _require_user(user_id)
    now = timezone.now()
    with transaction.atomic():
        summary = _lock_summary(user_id)
        row = BadgeAward.objects.select_for_update().filter(user_id=user_id, badge_key=badge.key).first()
        delta = 0
        if award_it:
            if row is None:
                row = BadgeAward.objects.create(user_id=user_id, badge_key=badge.key, awarded_at=now, note="staff")
                delta = 1
            elif row.revoked_at is not None:
                row.revoked_at = None
                row.save(update_fields=["revoked_at"])
                delta = 1
            achievement, _ = Achievement.objects.get_or_create(
                user_id=user_id,
                kind=Achievement.KIND_BADGE,
                key=badge.key,
                defaults={"title": badge.title, "subtitle": badge.description, "recipient_name": _recipient_name(user_id)},
            )
            if achievement.revoked_at is not None:
                Achievement.objects.filter(pk=achievement.pk).update(revoked_at=None)
            from .certificates import issue_for_new_achievements

            issue_for_new_achievements(user_id, [(achievement.kind, achievement.key)])
            action = EngagementAuditLog.ACTION_AWARD_BADGE
        else:
            if row is None or row.revoked_at is not None:
                raise NotFound("This user does not hold that badge.", code="badge_not_held")
            row.revoked_at = now
            row.save(update_fields=["revoked_at"])
            Achievement.objects.filter(user_id=user_id, kind=Achievement.KIND_BADGE, key=badge.key).update(revoked_at=now)
            delta = -1
            action = EngagementAuditLog.ACTION_REVOKE_BADGE
        if delta:
            EngagementSummary.objects.filter(pk=summary.pk).update(
                badges_count=F("badges_count") + delta, version=F("version") + 1, updated_at=now
            )
        _audit(actor=actor, target_user_id=user_id, action=action, reason=reason, badge_key=badge.key, request=request)
    return row


def _require_user(user_id):
    from django.contrib.auth import get_user_model

    if not get_user_model().objects.filter(pk=user_id).exists():
        raise NotFound("User not found.", code="user_not_found")
