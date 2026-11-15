"""Every engagement number in one module: XP rules, levels, caps and windows.

Change a rule here and only here. Values that are part of the owner-approved
contract are marked; the tests assert them.

XP economy v2 (owner rules A): the values marked "tunable" are read from
Django settings (``ENGAGEMENT_*``, env-backed in ``config/settings/base.py``)
at call time, so an admin can retune them by environment without a release;
the constants below are the defaults.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

FEATURE_KEY = "engagement"


def _setting(name: str, default):
    """A tunable value from settings (same type as ``default``; bad values fall back)."""
    from django.conf import settings

    value = getattr(settings, name, None)
    if value is None or value == "":
        return default
    try:
        if isinstance(default, bool):
            if isinstance(value, str):
                return value.strip().lower() in ("1", "true", "yes", "on")
            return bool(value)
        if isinstance(default, int):
            return max(0, int(value))
        if isinstance(default, float):
            return max(0.0, float(value))
    except (TypeError, ValueError):
        return default
    return value

# --- Calendar: study days and weeks follow Asia/Kolkata (IST) ---------------
IST = ZoneInfo("Asia/Kolkata")

# --- XP rules (owner-approved) -----------------------------------------------
LECTURE_COMPLETED_XP = 20
LECTURE_MIN_WATCHED_RATIO = 0.80  # >= 80 % of the lecture watched

WATCH_SECONDS_PER_XP = 300  # 1 XP per 5 minutes watched
WATCH_DAILY_XP_CAP = 60  # at most 60 watch XP per IST day
# Anti-cheat for watch time: a progress update is credited at most the wall
# clock time since the previous update (plus a little slack), never more than
# this many seconds, so seeking ahead or replaying requests earns nothing.
WATCH_MAX_CREDIT_PER_UPDATE_SECONDS = 300
WATCH_CREDIT_SLACK_SECONDS = 10

# Live classes are the heart of the programme (owner rules A): present
# (apps.attendance: 40+ live minutes) = 150 XP, joined but below the bar = 30 XP,
# the first live class ever (present or partial) = +100 once. Tunable.
LIVE_ATTENDED_XP = 150
LIVE_PARTIAL_XP = 30
FIRST_LIVE_BONUS_XP = 100
LIVE_MIN_ATTENDED_RATIO = 0.50  # fallback only: live XP follows apps.attendance (present = 40+ live minutes)
LIVE_PRESENCE_MAX_CREDIT_SECONDS = 120  # one presence ping credits at most 2 min
LIVE_PRESENCE_FIRST_CREDIT_SECONDS = 60
LIVE_FINALIZE_DELAY_SECONDS = 90  # wait for the last presence pings after the class ends

REPORT_SUBMITTED_XP = 30
REPORT_ON_TIME_BONUS_XP = 10
# Report-mark bonus (owner, Nov 2026): weekly XP comes from the reports. On top
# of the submission XP (30, or 40 on time), a graded report pays a tiered BONUS
# on its final marks normalised to 10 (rounded DOWN: 8.9/10 is tier 8), so a
# perfect report is worth two live classes. Tunable in ONE place:
# settings.ENGAGEMENT_REPORT_MARK_BONUS (env JSON, e.g. {"10": 300, "9": 200}).
# Below the lowest tier pays 0. A regrade settles the difference (sources.py).
REPORT_MARK_BONUS = {10: 300, 9: 200, 8: 130, 7: 80, 6: 40}
REPORT_GRADED_XP_PER_PERCENT = 0.5  # retired rule (marks % x 0.5): legacy ledger rows only
EXAM_XP_PER_PERCENT = 1.0  # score % x 1 (first finished attempt)
STREAK_DAILY_BONUS_XP = 5  # each study day that continues a streak

# Purchases (owner rules A, tunable): XP = round(rupees x 0.5) per successful
# charge -- each paid subscription cycle (Starter ~Rs 500 -> 250 XP, CTF Labs
# ~Rs 1,649 -> 825 XP) and each one-time purchase (course, installment or
# platform plan), the latter capped. Reversed (pro rata) when refunded.
# Payments in another currency earn nothing (the formula is in rupees).
PURCHASE_XP_PER_RUPEE = 0.5
ONE_TIME_PURCHASE_XP_CAP = 1000  # per payment
SUBSCRIPTION_XP_CAP = 0  # per charge; 0 = no cap

# Leaderboard standing (owner rules A, tunable): at each weekly close (IST
# Monday 00:00) per batch: #1 = 200, #2-3 = 120, #4-10 = 60 XP and the "Podium
# Week" badge for the top 3; at each monthly close (IST) the all-time top 10 of
# each batch = 100 XP. Students hidden from leaderboards are not ranked and earn
# no standing XP (they opted out of the competition; nobody saw them place).
WEEKLY_FIRST_XP = 200
WEEKLY_PODIUM_XP = 120  # ranks 2-3
WEEKLY_TOP10_XP = 60  # ranks 4-10
MONTHLY_TOP10_XP = 100
STANDING_TOP_N = 10
PODIUM_TOP_N = 3
# Leaderboards rank with purchase XP by default (owner decision); flip to rank
# on learning XP only. Both totals are always in the API.
LEADERBOARD_COUNT_PURCHASE_XP = True


def live_present_xp() -> int:
    return _setting("ENGAGEMENT_LIVE_PRESENT_XP", LIVE_ATTENDED_XP)


def live_partial_xp() -> int:
    return _setting("ENGAGEMENT_LIVE_PARTIAL_XP", LIVE_PARTIAL_XP)


def first_live_bonus_xp() -> int:
    return _setting("ENGAGEMENT_FIRST_LIVE_BONUS_XP", FIRST_LIVE_BONUS_XP)


def purchase_xp(rupees, *, subscription: bool) -> int:
    """XP for one successful charge of ``rupees`` (never negative, capped)."""
    from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

    try:
        amount = Decimal(str(rupees or 0))
    except (InvalidOperation, ValueError):
        return 0
    per_rupee = Decimal(str(_setting("ENGAGEMENT_PURCHASE_XP_PER_RUPEE", PURCHASE_XP_PER_RUPEE)))
    # Half up (Rs 1,649 x 0.5 = 824.5 -> 825), never banker's rounding.
    points = max(0, int((amount * per_rupee).quantize(Decimal("1"), rounding=ROUND_HALF_UP)))
    cap = (
        _setting("ENGAGEMENT_SUBSCRIPTION_XP_CAP", SUBSCRIPTION_XP_CAP)
        if subscription
        else _setting("ENGAGEMENT_ONE_TIME_PURCHASE_XP_CAP", ONE_TIME_PURCHASE_XP_CAP)
    )
    return min(points, cap) if cap else points


def weekly_standing_xp(rank: int) -> int:
    """XP for finishing a week at ``rank`` (1-based) in a batch; 0 outside the top 10."""
    rank = int(rank or 0)
    if rank == 1:
        return _setting("ENGAGEMENT_WEEKLY_FIRST_XP", WEEKLY_FIRST_XP)
    if 2 <= rank <= PODIUM_TOP_N:
        return _setting("ENGAGEMENT_WEEKLY_PODIUM_XP", WEEKLY_PODIUM_XP)
    if PODIUM_TOP_N < rank <= STANDING_TOP_N:
        return _setting("ENGAGEMENT_WEEKLY_TOP10_XP", WEEKLY_TOP10_XP)
    return 0


def monthly_standing_xp(rank: int) -> int:
    return _setting("ENGAGEMENT_MONTHLY_TOP10_XP", MONTHLY_TOP10_XP) if 1 <= int(rank or 0) <= STANDING_TOP_N else 0


def standing_awards_enabled() -> bool:
    return _setting("ENGAGEMENT_STANDING_AWARDS", True)


def leaderboard_counts_purchase_xp() -> bool:
    return _setting("ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP", LEADERBOARD_COUNT_PURCHASE_XP)


# Prize rules (owner, Nov 2026, after the first weekly close paid one student
# twice and a test account): tunable via ENGAGEMENT_PRIZE_* (settings/base.py).
#  * one prize per student per period: the batch where they placed best;
#  * only published, real batch courses compete (never unpublished, test-titled
#    or listed in ENGAGEMENT_PRIZE_EXCLUDED_COURSE_IDS);
#  * at least PRIZE_MIN_LEARNING_XP learning XP in the period (purchase and
#    standing XP never count towards it);
#  * a batch with fewer than PRIZE_SMALL_BATCH_SIZE active students pays only
#    its top PRIZE_SMALL_BATCH_TOP_N.
PRIZE_ONE_PER_STUDENT = True
PRIZE_MIN_LEARNING_XP = 150
PRIZE_SMALL_BATCH_SIZE = 30
PRIZE_SMALL_BATCH_TOP_N = 3
# A course whose title looks like a test fixture never competes.
PRIZE_TEST_TITLE_PATTERN = r"(?<![a-z0-9])(e2e|test|tests|hidden|do not publish|sandbox|dummy)(?![a-z0-9])"


def prize_one_per_student() -> bool:
    return _setting("ENGAGEMENT_PRIZE_ONE_PER_STUDENT", PRIZE_ONE_PER_STUDENT)


def prize_min_learning_xp() -> int:
    return _setting("ENGAGEMENT_PRIZE_MIN_LEARNING_XP", PRIZE_MIN_LEARNING_XP)


def prize_small_batch_size() -> int:
    return _setting("ENGAGEMENT_PRIZE_SMALL_BATCH_SIZE", PRIZE_SMALL_BATCH_SIZE)


def prize_small_batch_top_n() -> int:
    return _setting("ENGAGEMENT_PRIZE_SMALL_BATCH_TOP_N", PRIZE_SMALL_BATCH_TOP_N)


def prize_excluded_course_ids() -> frozenset[int]:
    from django.conf import settings

    raw = getattr(settings, "ENGAGEMENT_PRIZE_EXCLUDED_COURSE_IDS", "") or ""
    values = raw if isinstance(raw, (list, tuple, set, frozenset)) else str(raw).replace(";", ",").split(",")
    ids = set()
    for value in values:
        try:
            ids.add(int(str(value).strip()))
        except (TypeError, ValueError):
            continue
    return frozenset(ids)

# --- Write-behind ------------------------------------------------------------
FLUSH_INTERVAL_SECONDS = 300  # Redis counters -> DB every 5 minutes
LEADERBOARD_REBUILD_INTERVAL_SECONDS = 3600  # membership drift (enrolments) repaired hourly

# --- Read side ---------------------------------------------------------------
LEADERBOARD_DEFAULT_LIMIT = 20
LEADERBOARD_MAX_LIMIT = 100
LEADERBOARD_CACHE_SECONDS = 60
LEADERBOARD_WEEK_KEY_TTL_SECONDS = 21 * 24 * 3600  # weekly sorted sets expire after 3 weeks
ME_EXTRAS_CACHE_SECONDS = 60
ME_MAX_AGE_SECONDS = 15
LEADERBOARD_MAX_AGE_SECONDS = 60


# --- XP kinds ----------------------------------------------------------------
KIND_LECTURE_COMPLETED = "lecture_completed"
KIND_WATCH_TIME = "watch_time"
KIND_LIVE_ATTENDED = "live_attended"
KIND_REPORT_SUBMITTED = "report_submitted"
KIND_REPORT_GRADED = "report_graded"
KIND_EXAM_FINISHED = "exam_finished"
KIND_STREAK_BONUS = "streak_bonus"
KIND_MANUAL = "manual"
KIND_REVOKE = "revoke"
# XP economy v2 (owner rules A): purchases, live partial/first-live bonus and
# leaderboard standing. Purchase kinds count towards ``purchase_xp`` too.
KIND_SUBSCRIPTION_CHARGE = "subscription_charge"
KIND_COURSE_PURCHASE = "course_purchase"
KIND_PURCHASE_REFUND = "purchase_refund"
KIND_LIVE_PARTIAL = "live_partial"
KIND_FIRST_LIVE_BONUS = "first_live_bonus"
KIND_LEADERBOARD_WEEKLY = "leaderboard_weekly"
KIND_LEADERBOARD_MONTHLY = "leaderboard_monthly"
PURCHASE_KINDS = frozenset({KIND_SUBSCRIPTION_CHARGE, KIND_COURSE_PURCHASE, KIND_PURCHASE_REFUND})
STANDING_KINDS = frozenset({KIND_LEADERBOARD_WEEKLY, KIND_LEADERBOARD_MONTHLY})
# XP that is not studying: it never makes a day a study day (streaks) and the
# weekly close never ranks on standing XP itself.
NON_STUDY_KINDS = PURCHASE_KINDS | STANDING_KINDS
KIND_CHOICES = [
    (KIND_LECTURE_COMPLETED, "Lecture completed"),
    (KIND_WATCH_TIME, "Watch time"),
    (KIND_LIVE_ATTENDED, "Live class attended"),
    (KIND_REPORT_SUBMITTED, "Weekly report submitted"),
    (KIND_REPORT_GRADED, "Report graded"),
    (KIND_EXAM_FINISHED, "Exam finished"),
    (KIND_STREAK_BONUS, "Daily streak bonus"),
    (KIND_MANUAL, "Staff award"),
    (KIND_REVOKE, "Staff revocation"),
    (KIND_SUBSCRIPTION_CHARGE, "Membership payment"),
    (KIND_COURSE_PURCHASE, "Course purchase"),
    (KIND_PURCHASE_REFUND, "Purchase refunded"),
    (KIND_LIVE_PARTIAL, "Live class joined (partial)"),
    (KIND_FIRST_LIVE_BONUS, "First live class bonus"),
    (KIND_LEADERBOARD_WEEKLY, "Weekly leaderboard standing"),
    (KIND_LEADERBOARD_MONTHLY, "Monthly leaderboard standing"),
]


def lecture_xp() -> int:
    return LECTURE_COMPLETED_XP


def report_submitted_xp(*, on_time: bool) -> int:
    return REPORT_SUBMITTED_XP + (REPORT_ON_TIME_BONUS_XP if on_time else 0)


def report_mark_bonus_table() -> dict[int, int]:
    """``{score out of 10: bonus XP}`` (best first), from settings or the default.

    ``ENGAGEMENT_REPORT_MARK_BONUS`` may be a dict or a JSON object string
    (env); keys 0-10, values >= 0. An invalid value falls back to the default
    as a whole (never a half-applied table).
    """
    from django.conf import settings

    raw = getattr(settings, "ENGAGEMENT_REPORT_MARK_BONUS", None)
    if isinstance(raw, str):
        import json

        try:
            raw = json.loads(raw) if raw.strip() else None
        except ValueError:
            raw = None
    table = dict(REPORT_MARK_BONUS)
    if isinstance(raw, dict) and raw:
        try:
            parsed = {int(key): int(value) for key, value in raw.items()}
        except (TypeError, ValueError):
            parsed = {}
        if parsed and all(0 <= key <= 10 and value >= 0 for key, value in parsed.items()):
            table = parsed
    return dict(sorted(table.items(), reverse=True))


def report_score10(final_marks, max_marks) -> int:
    """The graded score normalised to 10, rounded down (0-10)."""
    from decimal import ROUND_FLOOR, Decimal, InvalidOperation

    try:
        final = Decimal(str(final_marks))
        maximum = Decimal(str(max_marks))
    except (InvalidOperation, ValueError, TypeError):
        return 0
    if maximum <= 0:
        return 0
    score = (final * 10 / maximum).quantize(Decimal("1"), rounding=ROUND_FLOOR)
    return int(min(Decimal(10), max(Decimal(0), score)))


def report_mark_bonus(score10: int) -> int:
    """Bonus XP for a report scored ``score10``/10: the best tier it reaches, else 0."""
    score10 = int(score10 or 0)
    for tier, points in report_mark_bonus_table().items():
        if score10 >= tier:
            return points
    return 0


def report_graded_xp(percent: float) -> int:
    """The report bonus for a marks percentage (100 % = 10/10)."""
    return report_mark_bonus(int(_clamp_percent(percent) // 10))


def exam_xp(percent: float) -> int:
    return max(0, int(round(_clamp_percent(percent) * EXAM_XP_PER_PERCENT)))


def watch_blocks(seconds: int) -> int:
    """Watch XP earned by ``seconds`` watched in one IST day (capped)."""
    return min(WATCH_DAILY_XP_CAP, max(0, int(seconds or 0)) // WATCH_SECONDS_PER_XP)


def _clamp_percent(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return min(100.0, max(0.0, number))


# --- Levels / ranks (owner-approved thresholds) --------------------------------
@dataclass(frozen=True)
class Level:
    number: int
    key: str
    title: str
    min_xp: int


# Thresholds re-balanced for the XP economy v2 (owner rules B). The curve:
#
#   A regular active student, one week:
#     3 live classes present (Fri/Sat/Sun)       3 x 150 = 450
#     ~3 lectures completed                        3 x 20  =  60
#     ~2 h of recordings on 3 days (24 XP/day)     3 x 24  =  72
#     weekly report on time + graded ~80 %        40 + 40  =  80
#     ~4 streak days                               4 x 5   =  20
#                                                           ----
#     learning XP                                          ~680 / week
#     + Starter membership (Rs 500/month -> 250 XP)          ~60 / week
#     (+ CTF Labs Rs 1,649 -> 825 XP/month                 ~190 / week)
#     ~ 740-870 XP a week; call it ~800.
#
#   Gaps between ranks grow 1,500 -> 3,500 XP, so at ~800 XP/week:
#     Recruit -> Operative          1,500 XP   ~2 weeks
#     Operative -> Operator         2,000 XP   ~2.5 weeks
#     Operator -> Analyst           2,500 XP   ~3 weeks
#     Analyst -> Specialist         3,000 XP   ~3.5-4 weeks
#     Specialist -> Senior Analyst  3,000 XP   ~3.5-4 weeks
#     Senior -> Lead Investigator   3,500 XP   ~4 weeks
#     Lead -> Elite Operator        3,500 XP   ~4 weeks
#   Elite Operator (19,000 XP) after ~24 weeks: about one cohort of steady work.
#   Weekly standing XP (60-200) and leaderboard months speed this up a little
#   for the most active students only.
#
# Deploy-time tunable: ENGAGEMENT_LEVEL_THRESHOLDS = JSON list of 8 ascending
# integers starting at 0 (read once at start-up; invalid lists are ignored).
DEFAULT_LEVEL_THRESHOLDS = (0, 1500, 3500, 6000, 9000, 12000, 15500, 19000)
_LEVEL_NAMES = (
    ("recruit", "Recruit"),
    ("operative", "Operative"),
    ("operator", "Operator"),
    ("analyst", "Analyst"),
    ("specialist", "Specialist"),
    ("senior_analyst", "Senior Analyst"),
    ("lead_investigator", "Lead Investigator"),
    ("elite_operator", "Elite Operator"),
)


def _level_thresholds() -> tuple[int, ...]:
    try:
        from django.conf import settings

        raw = getattr(settings, "ENGAGEMENT_LEVEL_THRESHOLDS", None)
    except Exception:  # noqa: BLE001 - settings not configured (pure imports)
        raw = None
    if isinstance(raw, str) and raw.strip():
        import json

        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    if isinstance(raw, (list, tuple)) and len(raw) == len(_LEVEL_NAMES):
        try:
            values = tuple(int(item) for item in raw)
        except (TypeError, ValueError):
            values = ()
        if values and values[0] == 0 and all(b > a for a, b in zip(values, values[1:])):
            return values
    return DEFAULT_LEVEL_THRESHOLDS


LEVELS: tuple[Level, ...] = tuple(
    Level(number, key, title, threshold)
    for number, ((key, title), threshold) in enumerate(zip(_LEVEL_NAMES, _level_thresholds()), start=1)
)

# What each rank unlocks (shown on the level chart). Honest: only what the
# platform actually does for a rank today.
LEVEL_UNLOCKS: dict[str, tuple[str, ...]] = {
    "recruit": ("Your XP, streak and batch leaderboard place",),
    "operative": ("Rank title on your profile and batch leaderboards", "Rank certificate anyone can verify"),
    "operator": ("Rank title on your profile and batch leaderboards", "Rank certificate anyone can verify"),
    "analyst": ("Rank title on your profile and batch leaderboards", "Rank certificate anyone can verify"),
    "specialist": ("Rank title on your profile and batch leaderboards", "Rank certificate anyone can verify"),
    "senior_analyst": ("Rank title on your profile and batch leaderboards", "Rank certificate anyone can verify"),
    "lead_investigator": ("Rank title on your profile and batch leaderboards", "Rank certificate anyone can verify"),
    "elite_operator": (
        "The highest rank title on your profile and batch leaderboards",
        "Rank certificate anyone can verify",
    ),
}


def level_for(total_xp: int) -> Level:
    current = LEVELS[0]
    for level in LEVELS:
        if int(total_xp or 0) >= level.min_xp:
            current = level
    return current


def next_level(total_xp: int) -> Level | None:
    for level in LEVELS:
        if int(total_xp or 0) < level.min_xp:
            return level
    return None


def level_by_number(number: int) -> Level:
    for level in LEVELS:
        if level.number == int(number or 1):
            return level
    return LEVELS[0]


def level_dict(level: Level | None) -> dict | None:
    if level is None:
        return None
    return {"number": level.number, "key": level.key, "title": level.title, "min_xp": level.min_xp}


# --- IST calendar helpers -------------------------------------------------------
def ist_now() -> datetime:
    return timezone.now().astimezone(IST)


def ist_day(value: datetime | None = None) -> date:
    value = value or timezone.now()
    if timezone.is_naive(value):
        value = timezone.make_aware(value, IST)
    return value.astimezone(IST).date()


def week_start(day: date) -> date:
    """Monday of the IST week holding ``day``."""
    return day - timedelta(days=day.weekday())


def current_week_start(now: datetime | None = None) -> date:
    return week_start(ist_day(now))


def ist_hour(value: datetime) -> int:
    return value.astimezone(IST).hour


# --- Release epoch (owner fairness rule) -------------------------------------------
# settings.ENGAGEMENT_RELEASE_AT (ISO date-time, e.g. "2026-12-01T00:00:00+05:30").
# When set: streaks only count study days from the release IST day on (the
# historical best streak is kept in best_streak), and the weekly leaderboard
# never counts activity from before release (all-time includes history).
# Empty (dev, tests): no epoch.
def release_at() -> datetime | None:
    from django.conf import settings
    from django.utils.dateparse import parse_date, parse_datetime

    raw = str(getattr(settings, "ENGAGEMENT_RELEASE_AT", "") or "").strip()
    if not raw:
        return None
    value = parse_datetime(raw)
    if value is None:
        day = parse_date(raw)
        if day is None:
            return None
        value = datetime.combine(day, datetime.min.time())
    if timezone.is_naive(value):
        value = value.replace(tzinfo=IST)
    return value


def epoch_day() -> date | None:
    value = release_at()
    return ist_day(value) if value else None


def earn_table() -> list[dict]:
    """How to earn XP (the level chart's table), from the live rule values."""
    rupee_rate = _setting("ENGAGEMENT_PURCHASE_XP_PER_RUPEE", PURCHASE_XP_PER_RUPEE)
    one_time_cap = _setting("ENGAGEMENT_ONE_TIME_PURCHASE_XP_CAP", ONE_TIME_PURCHASE_XP_CAP)
    return [
        {"key": KIND_LIVE_ATTENDED, "label": "Attend a live class (40+ live minutes)", "xp": live_present_xp()},
        {"key": KIND_LIVE_PARTIAL, "label": "Join a live class (under 40 minutes)", "xp": live_partial_xp()},
        {"key": KIND_FIRST_LIVE_BONUS, "label": "Your first live class ever (bonus, once)", "xp": first_live_bonus_xp()},
        {"key": KIND_LECTURE_COMPLETED, "label": "Complete a recorded lecture (80 %+ watched)", "xp": LECTURE_COMPLETED_XP},
        {
            "key": KIND_WATCH_TIME,
            "label": f"Watch recordings: 1 XP per {WATCH_SECONDS_PER_XP // 60} minutes (up to {WATCH_DAILY_XP_CAP} a day)",
            "xp": 1,
        },
        {"key": KIND_REPORT_SUBMITTED, "label": "Submit your weekly report (+10 on time)", "xp": REPORT_SUBMITTED_XP},
        *(
            {"key": KIND_REPORT_GRADED, "label": f"Report bonus: {score}/10" + (" (perfect report)" if score == 10 else ""), "xp": points}
            for score, points in report_mark_bonus_table().items()
            if points > 0
        ),
        {"key": KIND_EXAM_FINISHED, "label": "Finish an exam: your score %", "xp": exam_xp(100)},
        {"key": KIND_STREAK_BONUS, "label": "Each study day that continues your streak", "xp": STREAK_DAILY_BONUS_XP},
        {"key": KIND_LEADERBOARD_WEEKLY, "label": "Finish the week #1 in your batch", "xp": weekly_standing_xp(1)},
        {"key": KIND_LEADERBOARD_WEEKLY, "label": "Finish the week #2-3 (plus the Podium Week badge)", "xp": weekly_standing_xp(2)},
        {"key": KIND_LEADERBOARD_WEEKLY, "label": "Finish the week #4-10", "xp": weekly_standing_xp(4)},
        {"key": KIND_LEADERBOARD_MONTHLY, "label": "End a month in your batch's all-time top 10", "xp": monthly_standing_xp(1)},
        {
            "key": KIND_SUBSCRIPTION_CHARGE,
            "label": f"Each paid membership month: {rupee_rate:g} XP per rupee",
            "xp": purchase_xp(500, subscription=True),
            "example": "Rs 500 plan",
        },
        {
            "key": KIND_COURSE_PURCHASE,
            "label": f"A course purchase: {rupee_rate:g} XP per rupee" + (f", up to {one_time_cap:,} XP" if one_time_cap else ""),
            "xp": purchase_xp(1000, subscription=False),
            "example": "Rs 1,000 purchase",
        },
    ]
