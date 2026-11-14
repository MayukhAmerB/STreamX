"""Per-batch leaderboards (a batch is a course; members = active enrolments).

Hot path (production, Redis): one sorted set per (batch, period)::

    eng:lb:<course id>:all            all-time, score from total_xp
    eng:lb:<course id>:w:<YYYYMMDD>   IST week (Monday), expires after 3 weeks

The score packs XP and the tie-break into one double so ties go to whoever
reached the total first: ``xp * 2**32 + (2**32 - 1 - seconds since 2020)``.
The worker writes the absolute score with ``ZADD`` after each award (an
absolute write is idempotent, unlike ``ZINCRBY``, so an outbox retry can never
double count). Reads are ``ZREVRANGE`` (top N) + ``ZREVRANK``/``ZCOUNT`` (my
rank): O(log n). Opted-out users are never in the set; their own rank is
``ZCOUNT(score, +inf)``.

A missing set (Redis flushed, new week, new batch) is rebuilt from
``EngagementSummary`` by ONE worker under a ``DistributedLock``; the others
answer from the database meanwhile (indexed: ``eng_sum_alltime_idx`` /
``eng_sum_weekly_idx``). Without Redis the database path is the only path.
Responses are cached 60 s (``get_or_compute``) under a per-batch generation
that every XP change bumps.

Purchase XP (owner rules A): boards rank on total XP including purchase XP
while ``ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP`` is on (default) and on
learning XP only (``total - purchase_xp``) when it is off. The sorted sets of
the learning-only ranking live under their own keys (``...:lx``), so flipping
the setting never reads stale scores: the new sets are rebuilt on first read.
"""

from __future__ import annotations

import logging
from datetime import date, datetime

from django.core.cache import cache
from django.db.models import F, Q
from django.utils import timezone

from apps.core.concurrency import DistributedLock, get_or_compute

from . import rules
from .buffer import redis_client
from .models import EngagementSettings, EngagementSummary

logger = logging.getLogger("apps.engagement.leaderboard")

PERIOD_WEEK = "week"
PERIOD_ALL = "all"
PERIODS = (PERIOD_WEEK, PERIOD_ALL)

_TIME_SPACE = 2**32
_EPOCH_TS = 1577836800  # 2020-01-01T00:00:00Z
ALL_TIME_READY_TTL = 2 * 3600


# --- membership -------------------------------------------------------------------
def member_batch_ids(user_id: int) -> list[int]:
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment

    return sorted(
        set(
            Enrollment.objects.filter(user_id=user_id)
            .filter(active_enrollment_q())
            .values_list("course_id", flat=True)
        )
    )


def _members_q(batch_id: int) -> Q:
    from apps.courses.access import active_enrollment_q

    return (
        Q(user__enrollments__course_id=batch_id)
        & active_enrollment_q(prefix="user__enrollments__")
        & Q(user__is_active=True, user__is_staff=False, user__is_superuser=False)
    )


def _visible_q() -> Q:
    return ~Q(user__engagement_settings__leaderboard_display=EngagementSettings.DISPLAY_HIDDEN)


# --- scores -------------------------------------------------------------------------
def encode(xp: int, reached_at: datetime | None) -> float:
    xp = max(0, int(xp or 0))
    seconds = int(reached_at.timestamp()) - _EPOCH_TS if reached_at else _TIME_SPACE - 1
    seconds = min(_TIME_SPACE - 1, max(0, seconds))
    return float(xp * _TIME_SPACE + (_TIME_SPACE - 1 - seconds))


def decode_xp(score: float) -> int:
    return int(float(score) // _TIME_SPACE)


def _week_tag(week: date) -> str:
    return week.strftime("%Y%m%d")


def _variant() -> str:
    return "" if rules.leaderboard_counts_purchase_xp() else ":lx"


def zkey(batch_id: int, period: str, week: date | None = None) -> str:
    if period == PERIOD_ALL:
        return f"eng:lb:{int(batch_id)}:all{_variant()}"
    return f"eng:lb:{int(batch_id)}:w:{_week_tag(week or rules.current_week_start())}{_variant()}"


def _ready_key(key: str) -> str:
    return f"{key}:ready"


def _score_fields(summary, period: str, week: date) -> tuple[int, datetime | None]:
    with_purchases = rules.leaderboard_counts_purchase_xp()
    if period == PERIOD_ALL:
        xp = int(summary.total_xp or 0)
        if not with_purchases:
            xp -= int(getattr(summary, "purchase_xp", 0) or 0)
        return xp, summary.xp_reached_at
    if summary.week_start != week:
        return 0, None
    xp = int(summary.weekly_xp or 0)
    if not with_purchases:
        xp -= int(getattr(summary, "weekly_purchase_xp", 0) or 0)
    return xp, summary.weekly_reached_at


def ranked_fields(period: str) -> tuple[str, str]:
    """(annotation name used for ranking, reached-at field) for the current setting."""
    return ("ranked_xp", "xp_reached_at") if period == PERIOD_ALL else ("ranked_xp", "weekly_reached_at")


def _ranked_expression(period: str):
    if period == PERIOD_ALL:
        return F("total_xp") if rules.leaderboard_counts_purchase_xp() else F("total_xp") - F("purchase_xp")
    return F("weekly_xp") if rules.leaderboard_counts_purchase_xp() else F("weekly_xp") - F("weekly_purchase_xp")


# --- generation (response cache invalidation) ----------------------------------------
def _generation(batch_id: int) -> int:
    try:
        return int(cache.get(f"eng:lbgen:{batch_id}") or 0)
    except Exception:  # noqa: BLE001
        return 0


def bump_generation(batch_ids) -> None:
    for batch_id in batch_ids:
        key = f"eng:lbgen:{batch_id}"
        try:
            if not cache.add(key, 1, timeout=None):
                cache.incr(key)
        except Exception:  # noqa: BLE001
            logger.debug("leaderboard generation bump failed", exc_info=True)


# --- writes (worker, after commit) ------------------------------------------------------
def on_summary_changed(user_id: int, summary=None, *, visible: bool | None = None, batch_ids=None) -> None:
    """Push the user's current scores to every batch they belong to."""
    batch_ids = list(batch_ids) if batch_ids is not None else member_batch_ids(user_id)
    if not batch_ids:
        return
    bump_generation(batch_ids)
    client = redis_client()
    if client is None:
        return
    if summary is None:
        summary = EngagementSummary.objects.filter(user_id=user_id).first()
    if visible is None:
        visible = not EngagementSettings.objects.filter(
            user_id=user_id, leaderboard_display=EngagementSettings.DISPLAY_HIDDEN
        ).exists()
    week = rules.current_week_start()
    try:
        pipe = client.pipeline(transaction=False)
        for batch_id in batch_ids:
            for period in PERIODS:
                key = zkey(batch_id, period, week)
                xp, reached = _score_fields(summary, period, week) if summary else (0, None)
                if visible and xp > 0:
                    pipe.zadd(key, {str(user_id): encode(xp, reached)})
                else:
                    pipe.zrem(key, str(user_id))
                if period == PERIOD_WEEK:
                    pipe.expire(key, rules.LEADERBOARD_WEEK_KEY_TTL_SECONDS)
        pipe.execute()
    except Exception:  # noqa: BLE001 - the set is rebuildable; never fail the award
        logger.warning("engagement.leaderboard.write_failed user=%s", user_id, exc_info=True)


def remove_member(user_id: int, batch_ids) -> None:
    """The user left these batches (enrolment expired/refunded)."""
    batch_ids = list(batch_ids)
    bump_generation(batch_ids)
    client = redis_client()
    if client is None or not batch_ids:
        return
    week = rules.current_week_start()
    try:
        pipe = client.pipeline(transaction=False)
        for batch_id in batch_ids:
            for period in PERIODS:
                pipe.zrem(zkey(batch_id, period, week), str(user_id))
        pipe.execute()
    except Exception:  # noqa: BLE001
        logger.warning("engagement.leaderboard.remove_failed user=%s", user_id, exc_info=True)


# --- database path ---------------------------------------------------------------------
def db_queryset(batch_id: int, period: str, week: date | None = None, *, include_hidden: bool = False):
    week = week or rules.current_week_start()
    queryset = EngagementSummary.objects.filter(_members_q(batch_id))
    if not include_hidden:
        queryset = queryset.filter(_visible_q())
    queryset = queryset.annotate(ranked_xp=_ranked_expression(period))
    if period == PERIOD_ALL:
        queryset = queryset.filter(ranked_xp__gt=0).order_by("-ranked_xp", "xp_reached_at", "user_id")
    else:
        queryset = queryset.filter(week_start=week, ranked_xp__gt=0).order_by(
            "-ranked_xp", "weekly_reached_at", "user_id"
        )
    # No DISTINCT: an enrolment is unique per (user, course) and the settings
    # join is one-to-one, so every member appears once.
    return queryset


def _db_rank(batch_id: int, period: str, week: date, xp: int, reached: datetime | None) -> int:
    queryset = EngagementSummary.objects.filter(_members_q(batch_id)).filter(_visible_q())
    queryset = queryset.annotate(ranked_xp=_ranked_expression(period))
    xp_field, reached_field = ranked_fields(period)
    if period != PERIOD_ALL:
        queryset = queryset.filter(week_start=week)
    better = Q(**{f"{xp_field}__gt": xp})
    if reached is not None:
        better |= Q(**{xp_field: xp, f"{reached_field}__lt": reached})
    return queryset.filter(better).count() + 1


# --- redis path ------------------------------------------------------------------------
def rebuild(batch_id: int, period: str, week: date | None = None) -> int:
    """Rebuild one sorted set from the summary table (atomic swap). Returns members."""
    client = redis_client()
    if client is None:
        return 0
    week = week or rules.current_week_start()
    key = zkey(batch_id, period, week)
    temp = f"{key}:rebuild"
    rows = list(
        db_queryset(batch_id, period, week).values_list(
            "user_id", "ranked_xp", "xp_reached_at", "ranked_xp", "weekly_reached_at"
        )
    )
    pipe = client.pipeline(transaction=False)
    pipe.delete(temp)
    mapping = {}
    for user_id, total, reached, weekly, weekly_reached in rows:
        score = encode(total, reached) if period == PERIOD_ALL else encode(weekly, weekly_reached)
        mapping[str(user_id)] = score
        if len(mapping) >= 1000:
            pipe.zadd(temp, mapping)
            mapping = {}
    if mapping:
        pipe.zadd(temp, mapping)
    ttl = ALL_TIME_READY_TTL if period == PERIOD_ALL else rules.LEADERBOARD_WEEK_KEY_TTL_SECONDS
    if rows:
        pipe.rename(temp, key)
        if period == PERIOD_WEEK:
            pipe.expire(key, rules.LEADERBOARD_WEEK_KEY_TTL_SECONDS)
    else:
        pipe.delete(key)
    pipe.set(_ready_key(key), "1", ex=ttl)
    pipe.execute()
    bump_generation([batch_id])
    return len(rows)


def _redis_ready(client, batch_id: int, period: str, week: date) -> bool:
    key = zkey(batch_id, period, week)
    try:
        if client.exists(_ready_key(key)):
            return True
    except Exception:  # noqa: BLE001
        return False
    lock = DistributedLock(f"eng:lb:rebuild:{key}", ttl=60, blocking_timeout=0)
    try:
        if not lock.acquire(blocking=False):
            return False  # another worker is rebuilding: answer from the database
    except Exception:  # noqa: BLE001
        return False
    try:
        rebuild(batch_id, period, week)
        return True
    except Exception:  # noqa: BLE001
        logger.warning("engagement.leaderboard.rebuild_failed key=%s", key, exc_info=True)
        return False
    finally:
        lock.release()


# --- reads -------------------------------------------------------------------------------
def top(batch_id: int, period: str, limit: int, week: date | None = None) -> tuple[list[tuple[int, int]], int, str]:
    """[(user_id, xp)] best first, the participant count and the source used."""
    week = week or rules.current_week_start()
    client = redis_client()
    if client is not None and _redis_ready(client, batch_id, period, week):
        key = zkey(batch_id, period, week)
        try:
            pipe = client.pipeline(transaction=False)
            pipe.zrevrange(key, 0, limit - 1, withscores=True)
            pipe.zcard(key)
            rows, total = pipe.execute()
            result = []
            for member, score in rows:
                member = member.decode() if isinstance(member, bytes) else member
                result.append((int(member), decode_xp(score)))
            return result, int(total or 0), "redis"
        except Exception:  # noqa: BLE001
            logger.warning("engagement.leaderboard.read_failed; using the database", exc_info=True)
    queryset = db_queryset(batch_id, period, week)
    rows = list(queryset.values_list("user_id", "ranked_xp")[:limit])
    return [(int(user_id), int(xp)) for user_id, xp in rows], queryset.count(), "db"


def rank_of(batch_id: int, period: str, user_id: int, summary, *, visible: bool, week: date | None = None) -> int | None:
    week = week or rules.current_week_start()
    if summary is None:
        return None
    xp, reached = _score_fields(summary, period, week)
    if xp <= 0:
        return None
    client = redis_client()
    if client is not None and _redis_ready(client, batch_id, period, week):
        key = zkey(batch_id, period, week)
        try:
            if visible:
                position = client.zrevrank(key, str(user_id))
                if position is not None:
                    return int(position) + 1
            score = encode(xp, reached)
            return int(client.zcount(key, f"({score}", "+inf")) + 1
        except Exception:  # noqa: BLE001
            logger.warning("engagement.leaderboard.rank_failed; using the database", exc_info=True)
    return _db_rank(batch_id, period, week, xp, reached)


def cached_board(batch_id: int, period: str, limit: int, builder) -> dict:
    """Shared (viewer-independent) part of a board, cached 60 s per generation."""
    week = rules.current_week_start()
    key = f"eng:lb:{batch_id}:{period}:{_week_tag(week)}:{limit}:g{_generation(batch_id)}{_variant()}"
    return get_or_compute(key, rules.LEADERBOARD_CACHE_SECONDS, lambda: builder(batch_id, period, limit, week))


def rebuild_all(batch_ids=None) -> dict[str, int]:
    """Rebuild every batch's sets (management command and hourly worker hook)."""
    from apps.courses.models import Course

    stats = {"batches": 0, "members": 0}
    if redis_client() is None:
        return stats
    ids = list(batch_ids) if batch_ids is not None else list(Course.objects.values_list("pk", flat=True))
    week = rules.current_week_start()
    for batch_id in ids:
        for period in PERIODS:
            lock = DistributedLock(f"eng:lb:rebuild:{zkey(batch_id, period, week)}", ttl=120, blocking_timeout=0)
            if not lock.acquire(blocking=False):
                continue
            try:
                stats["members"] += rebuild(batch_id, period, week)
            finally:
                lock.release()
        stats["batches"] += 1
    return stats
