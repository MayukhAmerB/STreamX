"""Declarative badge catalogue.

Each badge names the XP kinds that can trigger it and a criterion evaluated by
``services`` right after XP is awarded (same transaction, under the user's
summary row lock). Criteria use the awarded items' context, the updated
summary row, or small indexed counts on the user's own ledger rows, memoised
per evaluation. Awards are idempotent (``BadgeAward`` is unique per user and
badge) and timestamped.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from . import rules

TIER_BRONZE = "bronze"
TIER_SILVER = "silver"
TIER_GOLD = "gold"
TIER_PLATINUM = "platinum"
TIERS = (TIER_BRONZE, TIER_SILVER, TIER_GOLD, TIER_PLATINUM)

# Pseudo-trigger: a new study day was recorded in this award.
TRIGGER_STUDY_DAY = "study_day"
TRIGGER_ANY = "any"

ACTIVITY_KINDS = frozenset(
    {
        rules.KIND_LECTURE_COMPLETED,
        rules.KIND_LIVE_ATTENDED,
        rules.KIND_REPORT_SUBMITTED,
        rules.KIND_REPORT_GRADED,
        rules.KIND_EXAM_FINISHED,
    }
)


@dataclass
class AwardedItem:
    """One XP item handed to ``services.award_many``."""

    kind: str
    points: int
    key: str
    source_type: str
    source_id: str = ""
    occurred_at: Any = None
    ctx: dict = field(default_factory=dict)


@dataclass
class BadgeContext:
    user_id: int
    summary: Any
    items: list[AwardedItem]
    new_study_days: list[date]
    study_days: list[date]
    count_kind: Callable[[str], int]
    count_kind_min_points: Callable[[str, int], int]
    course_completions: dict  # course id -> completion time (truthy when any)

    @property
    def kinds(self) -> set[str]:
        return {item.kind for item in self.items}

    def items_of(self, *kinds: str) -> list[AwardedItem]:
        return [item for item in self.items if item.kind in kinds]


@dataclass(frozen=True)
class Badge:
    key: str
    title: str
    description: str
    tier: str
    triggers: frozenset[str]
    check: Callable[[BadgeContext], bool] = field(compare=False, repr=False)

    def as_dict(self) -> dict:
        return {"key": self.key, "title": self.title, "description": self.description, "tier": self.tier}


# --- criteria helpers -----------------------------------------------------------
def _count_at_least(kind: str, n: int):
    return lambda ctx: ctx.count_kind(kind) >= n


def _streak_at_least(n: int):
    return lambda ctx: int(ctx.summary.current_streak or 0) >= n or int(ctx.summary.best_streak or 0) >= n


def _xp_at_least(n: int):
    return lambda ctx: int(ctx.summary.total_xp or 0) >= n


def _hour_between(start: int, end: int):
    def check(ctx: BadgeContext) -> bool:
        for item in ctx.items:
            if item.kind in ACTIVITY_KINDS and item.occurred_at is not None:
                if start <= rules.ist_hour(item.occurred_at) < end:
                    return True
        return False

    return check


def _percent_at_least(threshold: float, *kinds: str):
    def check(ctx: BadgeContext) -> bool:
        return any(float(item.ctx.get("percent") or 0) >= threshold for item in ctx.items_of(*kinds))

    return check


def _on_time_reports(n: int):
    return lambda ctx: ctx.count_kind_min_points(rules.KIND_REPORT_SUBMITTED, rules.report_submitted_xp(on_time=True)) >= n


def _high_marks_reports(n: int):
    return lambda ctx: ctx.count_kind_min_points(rules.KIND_REPORT_GRADED, rules.report_graded_xp(90)) >= n


def _batch_top_3(ctx: BadgeContext) -> bool:
    return any(0 < int(item.ctx.get("batch_rank") or 0) <= 3 for item in ctx.items_of(rules.KIND_EXAM_FINISHED))


def _course_finisher(ctx: BadgeContext) -> bool:
    return bool(ctx.course_completions)


def _deep_focus(ctx: BadgeContext) -> bool:
    return any(item.ctx.get("daily_cap_reached") for item in ctx.items_of(rules.KIND_WATCH_TIME))


def _weekend_warrior(ctx: BadgeContext) -> bool:
    days = set(ctx.study_days)
    for day in ctx.new_study_days:
        if day.weekday() == 5 and day + timedelta(days=1) in days:
            return True
        if day.weekday() == 6 and day - timedelta(days=1) in days:
            return True
    return False


def _comeback(ctx: BadgeContext) -> bool:
    ordered = sorted(set(ctx.study_days))
    for day in ctx.new_study_days:
        earlier = [value for value in ordered if value < day]
        if earlier and (day - earlier[-1]).days >= 8:
            return True
    return False


L = rules
CATALOGUE: tuple[Badge, ...] = (
    Badge("first_lecture", "First Lecture", "Complete your first lecture.", TIER_BRONZE,
          frozenset({L.KIND_LECTURE_COMPLETED}), _count_at_least(L.KIND_LECTURE_COMPLETED, 1)),
    Badge("lecture_10", "Ten Down", "Complete 10 lectures.", TIER_SILVER,
          frozenset({L.KIND_LECTURE_COMPLETED}), _count_at_least(L.KIND_LECTURE_COMPLETED, 10)),
    Badge("lecture_50", "Half Century", "Complete 50 lectures.", TIER_GOLD,
          frozenset({L.KIND_LECTURE_COMPLETED}), _count_at_least(L.KIND_LECTURE_COMPLETED, 50)),
    Badge("course_finisher", "Course Finisher", "Complete every lecture of a course.", TIER_GOLD,
          frozenset({L.KIND_LECTURE_COMPLETED}), _course_finisher),
    Badge("deep_focus", "Deep Focus", "Reach the daily watch-time XP cap.", TIER_SILVER,
          frozenset({L.KIND_WATCH_TIME}), _deep_focus),
    Badge("night_owl", "Night Owl", "Earn XP between midnight and 4 am (IST).", TIER_BRONZE,
          ACTIVITY_KINDS, _hour_between(0, 4)),
    Badge("early_bird", "Early Bird", "Earn XP between 5 am and 7 am (IST).", TIER_BRONZE,
          ACTIVITY_KINDS, _hour_between(5, 7)),
    Badge("streak_3", "On a Roll", "Keep a 3-day study streak.", TIER_BRONZE,
          frozenset({TRIGGER_STUDY_DAY}), _streak_at_least(3)),
    Badge("streak_7", "Week Warrior", "Keep a 7-day study streak.", TIER_SILVER,
          frozenset({TRIGGER_STUDY_DAY}), _streak_at_least(7)),
    Badge("streak_30", "Unbreakable", "Keep a 30-day study streak.", TIER_GOLD,
          frozenset({TRIGGER_STUDY_DAY}), _streak_at_least(30)),
    Badge("streak_100", "Centurion", "Keep a 100-day study streak.", TIER_PLATINUM,
          frozenset({TRIGGER_STUDY_DAY}), _streak_at_least(100)),
    Badge("weekend_warrior", "Weekend Warrior", "Study on both Saturday and Sunday of a week.", TIER_BRONZE,
          frozenset({TRIGGER_STUDY_DAY}), _weekend_warrior),
    Badge("comeback", "Comeback", "Return to study after a week or more away.", TIER_BRONZE,
          frozenset({TRIGGER_STUDY_DAY}), _comeback),
    Badge("first_report", "First Report", "Submit your first weekly report.", TIER_BRONZE,
          frozenset({L.KIND_REPORT_SUBMITTED}), _count_at_least(L.KIND_REPORT_SUBMITTED, 1)),
    Badge("report_ranger", "Report Ranger", "Submit 10 weekly reports.", TIER_SILVER,
          frozenset({L.KIND_REPORT_SUBMITTED}), _count_at_least(L.KIND_REPORT_SUBMITTED, 10)),
    Badge("punctual", "Punctual", "Submit 5 weekly reports on time.", TIER_SILVER,
          frozenset({L.KIND_REPORT_SUBMITTED}), _on_time_reports(5)),
    Badge("sharp_analyst", "Sharp Analyst", "Score 90% or more on 5 graded reports.", TIER_GOLD,
          frozenset({L.KIND_REPORT_GRADED}), _high_marks_reports(5)),
    Badge("perfect_score", "Perfect Score", "Score 100% on a graded report or an exam.", TIER_GOLD,
          frozenset({L.KIND_REPORT_GRADED, L.KIND_EXAM_FINISHED}),
          _percent_at_least(100.0, L.KIND_REPORT_GRADED, L.KIND_EXAM_FINISHED)),
    Badge("first_exam", "First Exam", "Finish your first exam.", TIER_BRONZE,
          frozenset({L.KIND_EXAM_FINISHED}), _count_at_least(L.KIND_EXAM_FINISHED, 1)),
    Badge("exam_ace", "Exam Ace", "Score 90% or more in an exam.", TIER_GOLD,
          frozenset({L.KIND_EXAM_FINISHED}), _percent_at_least(90.0, L.KIND_EXAM_FINISHED)),
    Badge("batch_top_3", "Batch Top 3", "Finish an exam in the top 3 of your batch.", TIER_PLATINUM,
          frozenset({L.KIND_EXAM_FINISHED}), _batch_top_3),
    Badge("first_live", "First Live Class", "Attend your first live class.", TIER_BRONZE,
          frozenset({L.KIND_LIVE_ATTENDED}), _count_at_least(L.KIND_LIVE_ATTENDED, 1)),
    Badge("live_regular", "Live Regular", "Attend 10 live classes.", TIER_SILVER,
          frozenset({L.KIND_LIVE_ATTENDED}), _count_at_least(L.KIND_LIVE_ATTENDED, 10)),
    Badge("live_devotee", "Live Devotee", "Attend 25 live classes.", TIER_GOLD,
          frozenset({L.KIND_LIVE_ATTENDED}), _count_at_least(L.KIND_LIVE_ATTENDED, 25)),
    Badge("xp_1000", "Thousand Club", "Earn 1,000 XP.", TIER_SILVER,
          frozenset({TRIGGER_ANY}), _xp_at_least(1000)),
    Badge("xp_5000", "Five Thousand", "Earn 5,000 XP.", TIER_GOLD,
          frozenset({TRIGGER_ANY}), _xp_at_least(5000)),
)

def _never(_ctx: BadgeContext) -> bool:
    return False


# Granted by jobs, never by the per-award evaluation (no triggers):
# the weekly leaderboard close and the release-day legacy run.
PODIUM_WEEK = Badge("podium_week", "Podium Week", "Finish a week in the top 3 of your batch leaderboard.", TIER_GOLD,
                    frozenset(), _never)
CATALOGUE = (*CATALOGUE, PODIUM_WEEK)

# Legacy badges (owner's release plan): not earnable any more, so they are not
# listed in the catalogue; they resolve through ``get`` for their holders.
FOUNDING_MEMBER = Badge("founding_member", "Founding Member", "Studied here before the platform launch.", TIER_GOLD,
                        frozenset(), _never)
FOUNDING_OPERATIVE = Badge(
    "founding_operative", "Founding Operative",
    "A founding student still active at launch: the highest legacy distinction.", TIER_PLATINUM, frozenset(), _never,
)
FOUNDING_GRADUATE = Badge("founding_graduate", "Founding Graduate", "Certified before the platform launch.", TIER_PLATINUM,
                          frozenset(), _never)
LEGACY_BADGES: tuple[Badge, ...] = (FOUNDING_OPERATIVE, FOUNDING_GRADUATE, FOUNDING_MEMBER)
BATCH_PIONEER_PREFIX = "batch_pioneer_"

BY_KEY: dict[str, Badge] = {badge.key: badge for badge in (*CATALOGUE, *LEGACY_BADGES)}
assert len(BY_KEY) == len(CATALOGUE) + len(LEGACY_BADGES), "badge keys must be unique"


def batch_pioneer_key(batch_number: int) -> str:
    return f"{BATCH_PIONEER_PREFIX}{int(batch_number)}"


def batch_pioneer(batch_number: int) -> Badge:
    number = int(batch_number)
    return Badge(
        batch_pioneer_key(number), f"Batch Pioneer — Batch {number}",
        f"One of the students of Batch {number}, before the platform launch.", TIER_SILVER, frozenset(), _never,
    )


def is_legacy(key: str) -> bool:
    key = str(key or "")
    return key in {badge.key for badge in LEGACY_BADGES} or key.startswith(BATCH_PIONEER_PREFIX)


def get(key: str) -> Badge | None:
    key = str(key or "")
    badge = BY_KEY.get(key)
    if badge is not None:
        return badge
    if key.startswith(BATCH_PIONEER_PREFIX):
        number = key[len(BATCH_PIONEER_PREFIX):]
        if number.isdigit() and 0 < int(number) < 10000:
            return batch_pioneer(int(number))
    return None


def candidates(kinds: set[str], *, new_study_day: bool) -> list[Badge]:
    triggers = set(kinds) | {TRIGGER_ANY}
    if new_study_day:
        triggers.add(TRIGGER_STUDY_DAY)
    return [badge for badge in CATALOGUE if badge.triggers & triggers]
