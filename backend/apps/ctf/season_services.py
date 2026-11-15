"""Monthly OSINT CTF: business rules (seasons, answers, ranking, rewards).

Ranking (lower is better), never shared::

    score_seconds = solve_seconds + wrong_attempts x season.wrong_attempt_penalty_seconds
    order by score_seconds, solved_at, id

``solve_seconds`` is measured from the season's ``opens_at`` (the same clock
for everyone), so speed counts and every wrong answer before the solve costs
the penalty (10 minutes by default). Ties go to the earliest solve.

Rewards (granted once, at finalisation, unique per season/user/kind):

==========  ===================================================================
#1          Golden Aura (cosmetic, until the end of the following month) +
            permanent "Season Champion · <Month YYYY>" trophy
top 3       golden-white podium frame (cosmetic, same window) + gold / silver /
            bronze trophy (permanent)
top 10      Finalist badge + Hall of Fame feature + shareable certificate
            (public verification slug)
solvers     XP (via the engagement ledger, idempotent) + "Monthly Operative"
            badge carrying the consecutive-month streak
first       "First Blood" title (cosmetic, same window): the earliest solve
==========  ===================================================================

Disqualified entries are excluded from every reward. Cosmetics are read through
``active_cosmetics`` (one indexed query, cached per user, invalidated by a
generation counter on finalise/revoke).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime

from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.core import features
from apps.core.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from apps.core.outbox import publish

from . import answers
from .features import FEATURE_KEY
from .season_identity import attach_handles, certificate_name, public_name, real_names_enabled
from .season_models import (
    CtfSeason,
    CtfSeasonAttempt,
    CtfSeasonAudit,
    CtfSeasonEntry,
    IST,
    CtfSeasonReward,
    add_months,
    month_label,
    month_start,
    new_verify_slug,
)

logger = logging.getLogger("apps.ctf.seasons")

QUESTION_KEY = "flag"
MAX_ANSWER_LENGTH = 512
LEADERBOARD_DEFAULT = 25
LEADERBOARD_MAX = 100
TOP_PODIUM = 3
TOP_FINALISTS = 10
COSMETICS_CACHE_SECONDS = 300
LEADERBOARD_CACHE_SECONDS = 20
STREAK_LOOKBACK_MONTHS = 36
EVENT_DELIVER_XP = "ctf.season.deliver_xp"
TIERS = {1: CtfSeasonReward.TIER_GOLD, 2: CtfSeasonReward.TIER_SILVER, 3: CtfSeasonReward.TIER_BRONZE}
TIER_LABELS = {"gold": "Gold", "silver": "Silver", "bronze": "Bronze"}


# ---------------------------------------------------------------------------
# Switch, roles, audit
# ---------------------------------------------------------------------------
def is_enabled() -> bool:
    return features.is_enabled(FEATURE_KEY)


def require_enabled() -> None:
    features.require(FEATURE_KEY)


def is_staff_user(user) -> bool:
    return bool(user and getattr(user, "is_authenticated", False) and (user.is_staff or user.is_superuser))


def is_participant(user) -> bool:
    """Every registered, active, non-staff account plays (no membership needed)."""
    return bool(user and getattr(user, "is_authenticated", False) and user.is_active and not is_staff_user(user))


def audit(season, actor, action: str, **detail) -> CtfSeasonAudit:
    actor = actor if actor is not None and getattr(actor, "is_authenticated", False) else None
    return CtfSeasonAudit.objects.create(season=season, actor=actor, action=action, detail=detail)


# ---------------------------------------------------------------------------
# Answers
# ---------------------------------------------------------------------------
def _answer_scope(season: CtfSeason) -> str:
    # Bound into the HMAC so a season digest can never be replayed for an exam question.
    return f"season:{season.slug}"


def set_answers(season: CtfSeason, accepted: list[str], *, rules=None, actor=None) -> CtfSeason:
    """Replace the accepted answers (stored only as peppered digests)."""
    cleaned = [str(item).strip() for item in accepted or [] if str(item or "").strip()]
    if not cleaned:
        raise ValidationFailed("Add at least one accepted answer.", details={"answers": ["Required."]})
    rules = answers.validate_rules(rules or list(answers.DEFAULT_RULES))
    try:
        digests = answers.hash_answers(_answer_scope(season), QUESTION_KEY, cleaned, rules)
    except ValueError as exc:
        raise ValidationFailed(str(exc), details={"answers": [str(exc)]}) from None
    season.answer_rules = list(rules)
    season.answer_hashes = digests
    season.answer_key_id = answers.answer_key_id()
    season.save(update_fields=["answer_rules", "answer_hashes", "answer_key_id", "updated_at"])
    audit(season, actor, "answers", count=len(digests))
    return season


def answers_problem(season: CtfSeason) -> str:
    if not season.answer_hashes:
        return "No accepted answer is set."
    try:
        if season.answer_key_id and season.answer_key_id != answers.answer_key_id():
            return "The answer pepper changed since the answers were saved; enter the answers again."
    except Exception as exc:  # noqa: BLE001 - CtfNotConfigured in production
        return str(getattr(exc, "message", "") or exc)
    return ""


def check_answer(season: CtfSeason, submitted: str) -> tuple[bool, str]:
    problem = answers_problem(season)
    if problem:
        raise Conflict("This month's challenge cannot check answers right now.", code="season_answers_unavailable")
    return answers.verify(_answer_scope(season), QUESTION_KEY, submitted, season.answer_rules or None, season.answer_hashes)


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------
def season_or_404(slug: str, *, include_drafts: bool = False) -> CtfSeason:
    queryset = CtfSeason.objects.all()
    if not include_drafts:
        queryset = queryset.exclude(status=CtfSeason.STATUS_DRAFT)
    season = queryset.filter(slug=str(slug or "")[:64]).first()
    if season is None:
        raise NotFound("Season not found.", code="season_not_found")
    return season


def phase_of(season: CtfSeason | None, now: datetime) -> str:
    if season is None:
        return "none"
    if season.status == CtfSeason.STATUS_FINALISED:
        return "results"
    if season.status == CtfSeason.STATUS_CLOSED or season.closes_at <= now:
        return "closed"
    if season.status == CtfSeason.STATUS_OPEN and season.opens_at <= now:
        return "open"
    return "upcoming"


def current_season(now: datetime | None = None) -> CtfSeason | None:
    """The open season, else the next scheduled one, else the latest with results."""
    now = now or timezone.now()
    live = (
        CtfSeason.objects.filter(status=CtfSeason.STATUS_OPEN, opens_at__lte=now, closes_at__gt=now)
        .order_by("closes_at", "id")
        .first()
    )
    if live is not None:
        return live
    upcoming = (
        CtfSeason.objects.filter(status__in=(CtfSeason.STATUS_SCHEDULED, CtfSeason.STATUS_OPEN), closes_at__gt=now)
        .order_by("opens_at", "id")
        .first()
    )
    if upcoming is not None:
        return upcoming
    return (
        CtfSeason.objects.filter(status__in=(CtfSeason.STATUS_CLOSED, CtfSeason.STATUS_FINALISED))
        .order_by("-closes_at", "-id")
        .first()
    )


# ---------------------------------------------------------------------------
# Scheduling (admin)
# ---------------------------------------------------------------------------
def schedule_problems(season: CtfSeason, now: datetime | None = None) -> list[str]:
    now = now or timezone.now()
    problems = []
    if not (season.brief or "").strip() or not (season.question or "").strip():
        problems.append("Write the brief and the question.")
    problem = answers_problem(season)
    if problem:
        problems.append(problem)
    if season.closes_at <= season.opens_at:
        problems.append("The season must close after it opens.")
    if season.closes_at <= now:
        problems.append("The closing time is already in the past.")
    overlapping = (
        CtfSeason.objects.filter(
            status__in=(CtfSeason.STATUS_SCHEDULED, CtfSeason.STATUS_OPEN),
            opens_at__lt=season.closes_at,
            closes_at__gt=season.opens_at,
        )
        .exclude(pk=season.pk)
        .values_list("slug", flat=True)
        .first()
    )
    if overlapping:
        problems.append(f"Its window overlaps season {overlapping}; one monthly challenge runs at a time.")
    return problems


def schedule(season: CtfSeason, *, actor=None, now: datetime | None = None) -> CtfSeason:
    with transaction.atomic():
        season = CtfSeason.objects.select_for_update().get(pk=season.pk)
        if season.status != CtfSeason.STATUS_DRAFT:
            raise Conflict("Only a draft can be scheduled.", code="season_not_draft")
        problems = schedule_problems(season, now)
        if problems:
            raise ValidationFailed(" ".join(problems), details={"season": problems})
        season.status = CtfSeason.STATUS_SCHEDULED
        season.save(update_fields=["status", "updated_at"])
        audit(season, actor, "schedule", opens_at=season.opens_at.isoformat(), closes_at=season.closes_at.isoformat())
    return season


def unschedule(season: CtfSeason, *, actor=None) -> CtfSeason:
    with transaction.atomic():
        season = CtfSeason.objects.select_for_update().get(pk=season.pk)
        if season.status != CtfSeason.STATUS_SCHEDULED:
            raise Conflict("Only a scheduled season that has not opened can go back to draft.", code="season_not_scheduled")
        season.status = CtfSeason.STATUS_DRAFT
        season.save(update_fields=["status", "updated_at"])
        audit(season, actor, "unschedule")
    return season


def open_due(now: datetime | None = None) -> int:
    now = now or timezone.now()
    opened = 0
    for season in CtfSeason.objects.filter(
        status=CtfSeason.STATUS_SCHEDULED, opens_at__lte=now, closes_at__gt=now
    ).only("id"):
        changed = CtfSeason.objects.filter(pk=season.pk, status=CtfSeason.STATUS_SCHEDULED).update(
            status=CtfSeason.STATUS_OPEN, opened_at=now, updated_at=now
        )
        if changed:
            opened += 1
            audit(season, None, "open")
    return opened


def close_due(now: datetime | None = None) -> int:
    """Open (or scheduled but never opened) seasons whose window has passed."""
    now = now or timezone.now()
    closed = 0
    for season in CtfSeason.objects.filter(
        status__in=(CtfSeason.STATUS_OPEN, CtfSeason.STATUS_SCHEDULED), closes_at__lte=now
    ).only("id", "status"):
        changed = CtfSeason.objects.filter(
            pk=season.pk, status__in=(CtfSeason.STATUS_OPEN, CtfSeason.STATUS_SCHEDULED)
        ).update(status=CtfSeason.STATUS_CLOSED, closed_at=now, updated_at=now)
        if changed:
            closed += 1
            audit(season, None, "close")
            _bump_leaderboard(season.pk)
    return closed


# ---------------------------------------------------------------------------
# Playing
# ---------------------------------------------------------------------------
def _entry_for_update(season: CtfSeason, user, now: datetime) -> CtfSeasonEntry:
    entry = CtfSeasonEntry.objects.select_for_update().filter(season=season, user=user).first()
    if entry is not None:
        return entry
    try:
        with transaction.atomic():
            from apps.users.identity import snapshot_values

            CtfSeasonEntry.objects.create(season=season, user=user, started_at=now, **snapshot_values(user))
    except IntegrityError:
        pass
    return CtfSeasonEntry.objects.select_for_update().get(season=season, user=user)


def entry_payload(season: CtfSeason, entry: CtfSeasonEntry | None) -> dict:
    attempts = entry.attempts if entry else 0
    return {
        "joined": entry is not None,
        "solved": bool(entry and entry.solved_at),
        "solved_at": entry.solved_at if entry else None,
        "solve_seconds": entry.solve_seconds if entry else None,
        "score_seconds": entry.score_seconds if entry else None,
        "attempts": attempts,
        "wrong_attempts": entry.wrong_attempts if entry else 0,
        "attempts_left": max(0, season.max_attempts - attempts),
        "disqualified": bool(entry and entry.disqualified),
        "rank": rank_of(entry) if entry and entry.solved_at and not entry.disqualified else None,
    }


def submit_answer(season: CtfSeason, user, submitted, *, now: datetime | None = None) -> dict:
    require_enabled()
    now = now or timezone.now()
    text = str(submitted or "").strip()
    if not text:
        raise ValidationFailed("Type your answer first.", details={"answer": ["Required."]})
    if len(text) > MAX_ANSWER_LENGTH:
        raise ValidationFailed("That answer is too long.", details={"answer": [f"At most {MAX_ANSWER_LENGTH} characters."]})
    if is_staff_user(user):
        # Staff preview: the answer is checked but nothing is recorded or ranked.
        correct, _normalized = check_answer(season, text)
        return {"correct": correct, "practice": True, "already_solved": False, **entry_payload(season, None)}
    if not is_participant(user):
        raise PermissionDenied("Sign in with a student account to play.", code="season_not_participant")
    if not (season.status == CtfSeason.STATUS_OPEN and season.opens_at <= now < season.closes_at):
        raise Conflict("This month's challenge is not open.", code="season_not_open")
    with transaction.atomic():
        entry = _entry_for_update(season, user, now)
        if entry.disqualified:
            raise PermissionDenied("Your entry for this season was withdrawn by an admin.", code="season_entry_disqualified")
        if entry.solved_at is not None:
            return {"correct": True, "practice": False, "already_solved": True, **entry_payload(season, entry)}
        if entry.attempts >= season.max_attempts:
            raise Conflict("You have used every attempt for this season.", code="season_attempts_exhausted")
        correct, normalized = check_answer(season, text)
        CtfSeasonAttempt.objects.create(
            season=season, entry=entry, user=user, normalized_answer=normalized[:200], is_correct=correct, created_at=now
        )
        entry.attempts += 1
        fields = ["attempts", "updated_at"]
        if correct:
            entry.solved_at = now
            entry.solve_seconds = max(0, int((now - season.opens_at).total_seconds()))
            entry.score_seconds = entry.solve_seconds + entry.wrong_attempts * season.wrong_attempt_penalty_seconds
            fields += ["solved_at", "solve_seconds", "score_seconds"]
        else:
            entry.wrong_attempts += 1
            fields.append("wrong_attempts")
        entry.save(update_fields=fields)
        if correct:
            transaction.on_commit(lambda: _bump_leaderboard(season.pk))
    return {"correct": correct, "practice": False, "already_solved": False, **entry_payload(season, entry)}


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------
def standings_queryset(season: CtfSeason):
    return CtfSeasonEntry.objects.filter(season=season, solved_at__isnull=False, disqualified=False).order_by(
        "score_seconds", "solved_at", "id"
    )


def rank_of(entry: CtfSeasonEntry) -> int | None:
    if entry is None or entry.solved_at is None or entry.disqualified:
        return None
    if entry.final_rank:
        return entry.final_rank
    ahead = (
        CtfSeasonEntry.objects.filter(season_id=entry.season_id, solved_at__isnull=False, disqualified=False)
        .filter(
            Q(score_seconds__lt=entry.score_seconds)
            | Q(score_seconds=entry.score_seconds, solved_at__lt=entry.solved_at)
            | Q(score_seconds=entry.score_seconds, solved_at=entry.solved_at, id__lt=entry.id)
        )
        .count()
    )
    return ahead + 1


def _leaderboard_generation(season_id: int) -> int:
    try:
        return int(cache.get(f"ctf:season:{season_id}:lbgen") or 0)
    except Exception:  # noqa: BLE001
        return 0


def _bump_leaderboard(season_id: int) -> None:
    key = f"ctf:season:{season_id}:lbgen"
    try:
        if not cache.add(key, 1, timeout=None):
            cache.incr(key)
    except Exception:  # noqa: BLE001 - the cache is an optimisation only
        logger.warning("ctf.season.leaderboard_cache_unavailable")


def _first_blood_entry_id(season: CtfSeason) -> int | None:
    row = (
        CtfSeasonEntry.objects.filter(season=season, solved_at__isnull=False, disqualified=False)
        .order_by("solved_at", "id")
        .values_list("id", flat=True)
        .first()
    )
    return row


def _row(entry, rank, *, first_blood_id, real_names, cosmetics, viewer_id):
    return {
        "rank": rank,
        "name": public_name(entry.user, real_names=real_names),
        "solved_at": entry.solved_at,
        "solve_seconds": entry.solve_seconds,
        "wrong_attempts": entry.wrong_attempts,
        "attempts": entry.attempts,
        "score_seconds": entry.score_seconds,
        "first_blood": entry.id == first_blood_id,
        "is_me": bool(viewer_id and entry.user_id == viewer_id),
        "cosmetics": cosmetics.get(entry.user_id, EMPTY_COSMETICS),
    }


def leaderboard(season: CtfSeason, viewer=None, *, limit: int = LEADERBOARD_DEFAULT, now: datetime | None = None) -> dict:
    """Top ``limit`` rows (handles only) plus the viewer's own row."""
    now = now or timezone.now()
    limit = max(1, min(int(limit or LEADERBOARD_DEFAULT), LEADERBOARD_MAX))
    viewer_id = viewer.pk if viewer is not None and getattr(viewer, "is_authenticated", False) else None
    generation = _leaderboard_generation(season.pk)
    real_names = real_names_enabled()
    key = f"ctf:season:{season.pk}:lb:{generation}:{limit}:{int(real_names)}"
    try:
        shared = cache.get(key)
    except Exception:  # noqa: BLE001
        shared = None
    if shared is None:
        entries = list(standings_queryset(season).select_related("user", "user__student_profile")[:limit])
        attach_handles([entry.user for entry in entries])
        first_blood_id = _first_blood_entry_id(season) if entries else None
        cosmetics = active_cosmetics([entry.user_id for entry in entries], now=now)
        rows = [
            {
                **_row(entry, index + 1, first_blood_id=first_blood_id, real_names=real_names, cosmetics=cosmetics, viewer_id=None),
                "user_id": entry.user_id,
            }
            for index, entry in enumerate(entries)
        ]
        total = standings_queryset(season).count() if len(entries) >= limit else len(entries)
        participants = CtfSeasonEntry.objects.filter(season=season).count()
        shared = {"rows": rows, "solvers": total, "participants": participants}
        try:
            cache.set(key, shared, timeout=LEADERBOARD_CACHE_SECONDS)
        except Exception:  # noqa: BLE001
            pass
    rows = []
    me_in_rows = False
    for row in shared["rows"]:
        public_row = {name: value for name, value in row.items() if name != "user_id"}
        public_row["is_me"] = bool(viewer_id and row["user_id"] == viewer_id)
        me_in_rows = me_in_rows or public_row["is_me"]
        rows.append(public_row)
    me = None
    if viewer_id and not me_in_rows:
        entry = CtfSeasonEntry.objects.filter(season=season, user_id=viewer_id).select_related("user", "user__student_profile").first()
        if entry is not None and entry.solved_at and not entry.disqualified:
            attach_handles([entry.user])
            first_blood_id = _first_blood_entry_id(season)
            me = _row(
                entry,
                rank_of(entry),
                first_blood_id=first_blood_id,
                real_names=real_names,
                cosmetics=active_cosmetics([viewer_id], now=now),
                viewer_id=viewer_id,
            )
    elif viewer_id:
        me = next((row for row in rows if row["is_me"]), None)
    return {
        "season": season.slug,
        "final": season.status == CtfSeason.STATUS_FINALISED,
        "solvers": shared["solvers"],
        "participants": shared["participants"],
        "penalty_seconds": season.wrong_attempt_penalty_seconds,
        "rows": rows,
        "me": me,
        "generated_at": now,
    }


# ---------------------------------------------------------------------------
# Finalisation and rewards
# ---------------------------------------------------------------------------
def _streaks(season: CtfSeason, user_ids: list[int]) -> dict[int, int]:
    """Consecutive months solved, ending with ``season`` (which counts as solved)."""
    if not user_ids:
        return {}
    this_month = month_start(season.month)
    earliest = add_months(this_month, -STREAK_LOOKBACK_MONTHS)
    solved = defaultdict(set)
    rows = CtfSeasonEntry.objects.filter(
        user_id__in=user_ids,
        solved_at__isnull=False,
        disqualified=False,
        season__month__gte=earliest,
        season__month__lt=this_month,
    ).values_list("user_id", "season__month")
    for user_id, month in rows:
        solved[user_id].add(month_start(month))
    streaks = {}
    for user_id in user_ids:
        count = 1
        cursor = add_months(this_month, -1)
        while cursor in solved[user_id]:
            count += 1
            cursor = add_months(cursor, -1)
        streaks[user_id] = count
    return streaks


def planned_rewards(season: CtfSeason, *, now: datetime | None = None) -> list[CtfSeasonReward]:
    """The rewards finalising now would grant (unsaved). Used by preview and finalise."""
    now = now or timezone.now()
    label = month_label(month_start(season.month))
    standings = list(standings_queryset(season).select_related("user"))
    if not standings:
        return []
    window_start, window_end = season.cosmetic_window(now)
    first_blood = min(standings, key=lambda entry: (entry.solved_at, entry.id))
    streaks = _streaks(season, [entry.user_id for entry in standings])
    rewards = []

    def add(entry, kind, title, *, rank=None, tier="", cosmetic=False, points=0, metadata=None, verify=False):
        rewards.append(
            CtfSeasonReward(
                season=season,
                user_id=entry.user_id,
                kind=kind,
                rank=rank,
                tier=tier,
                title=title[:160],
                starts_at=window_start if cosmetic else now,
                ends_at=window_end if cosmetic else None,
                points=points,
                metadata=metadata or {},
                verify_slug=new_verify_slug() if verify else None,
                created_at=now,
            )
        )

    for index, entry in enumerate(standings):
        rank = index + 1
        if rank == 1:
            add(entry, CtfSeasonReward.KIND_GOLDEN_AURA, f"Golden Aura · {label}", rank=1, cosmetic=True)
            add(entry, CtfSeasonReward.KIND_CHAMPION, f"Season Champion · {label}", rank=1, tier=CtfSeasonReward.TIER_GOLD)
        if rank <= TOP_PODIUM:
            tier = TIERS[rank]
            add(entry, CtfSeasonReward.KIND_PODIUM_FRAME, f"Podium frame · {label}", rank=rank, tier=tier, cosmetic=True)
            add(entry, CtfSeasonReward.KIND_PODIUM_TROPHY, f"{TIER_LABELS[tier]} trophy · {label}", rank=rank, tier=tier)
        if rank <= TOP_FINALISTS:
            add(entry, CtfSeasonReward.KIND_FINALIST, f"Finalist · {label}", rank=rank)
            add(entry, CtfSeasonReward.KIND_HALL_OF_FAME, f"Hall of Fame · {label}", rank=rank)
            add(entry, CtfSeasonReward.KIND_CERTIFICATE, f"Finalist certificate · {label}", rank=rank, verify=True)
        streak = streaks.get(entry.user_id, 1)
        add(
            entry,
            CtfSeasonReward.KIND_OPERATIVE,
            f"Monthly Operative · {label}",
            rank=rank,
            metadata={"streak": streak},
        )
        if season.solve_xp:
            add(entry, CtfSeasonReward.KIND_XP, f"{season.solve_xp} XP · {label}", rank=rank, points=season.solve_xp)
        if entry.id == first_blood.id:
            add(entry, CtfSeasonReward.KIND_FIRST_BLOOD, f"First Blood · {label}", rank=rank, cosmetic=True)
    return rewards


def finalise(season: CtfSeason, *, actor=None, now: datetime | None = None, automatic: bool = False) -> dict:
    """Rank the season and grant every reward. Idempotent: a second call grants nothing new."""
    now = now or timezone.now()
    with transaction.atomic():
        season = CtfSeason.objects.select_for_update().get(pk=season.pk)
        if season.status == CtfSeason.STATUS_FINALISED:
            return {"finalised": False, "already": True, "granted": 0, "ranked": standings_queryset(season).count()}
        if season.status == CtfSeason.STATUS_OPEN and season.closes_at <= now:
            season.status = CtfSeason.STATUS_CLOSED
            season.closed_at = now
            season.save(update_fields=["status", "closed_at", "updated_at"])
            audit(season, None, "close")
        if season.status != CtfSeason.STATUS_CLOSED:
            raise Conflict("Results can be finalised only after the season closes.", code="season_not_closed")
        standings = list(standings_queryset(season))
        for index, entry in enumerate(standings):
            entry.final_rank = index + 1
        CtfSeasonEntry.objects.filter(season=season).exclude(pk__in=[entry.pk for entry in standings]).update(final_rank=None)
        if standings:
            CtfSeasonEntry.objects.bulk_update(standings, ["final_rank"], batch_size=500)
        planned = planned_rewards(season, now=now)
        existing = set(CtfSeasonReward.objects.filter(season=season).values_list("user_id", "kind"))
        fresh = [reward for reward in planned if (reward.user_id, reward.kind) not in existing]
        CtfSeasonReward.objects.bulk_create(fresh, batch_size=500, ignore_conflicts=True)
        season.status = CtfSeason.STATUS_FINALISED
        season.finalised_at = now
        season.finalised_by = actor if actor is not None and getattr(actor, "is_authenticated", False) else None
        season.save(update_fields=["status", "finalised_at", "finalised_by", "updated_at"])
        audit(
            season,
            actor,
            "finalise",
            automatic=automatic,
            ranked=len(standings),
            rewards=len(fresh),
            champion_entry=standings[0].pk if standings else None,
        )
        if any(reward.kind == CtfSeasonReward.KIND_XP for reward in fresh):
            publish(EVENT_DELIVER_XP, {"season_id": season.pk}, dedupe_key=f"ctf-season-xp:{season.pk}")
        transaction.on_commit(bump_cosmetics_generation)
        transaction.on_commit(lambda: _bump_leaderboard(season.pk))
    return {"finalised": True, "already": False, "granted": len(fresh), "ranked": len(standings)}


def finalise_due(now: datetime | None = None) -> int:
    now = now or timezone.now()
    done = 0
    for season in CtfSeason.objects.filter(status=CtfSeason.STATUS_CLOSED, auto_finalise=True, finalised_at__isnull=True):
        try:
            if finalise(season, now=now, automatic=True)["finalised"]:
                done += 1
        except Conflict:
            continue
    return done


def _engagement_award(user_id: int, reward: CtfSeasonReward) -> bool | None:
    """True = recorded, False = engagement switched off (retry later), None = unavailable."""
    try:
        from apps.engagement import rules as engagement_rules
        from apps.engagement import services as engagement_services
        from apps.engagement.badges import AwardedItem
    except Exception:  # noqa: BLE001 - the engagement app is optional
        return None
    item = AwardedItem(
        kind=getattr(engagement_rules, "KIND_MONTHLY_CTF", "monthly_ctf"),
        points=int(reward.points),
        key=f"ctf-season:{reward.season_id}:{user_id}",
        source_type="ctf_season",
        source_id=str(reward.season_id),
        occurred_at=reward.starts_at,
    )
    result = engagement_services.award(user_id, item)
    return not result.skipped


def xp_pending_exists() -> bool:
    return CtfSeasonReward.objects.filter(
        kind=CtfSeasonReward.KIND_XP, delivered_at__isnull=True, revoked_at__isnull=True
    ).exists()


def deliver_xp(season_id: int | None = None, *, now: datetime | None = None, limit: int = 500) -> int:
    """Hand pending solve XP to the engagement ledger (idempotent keys)."""
    now = now or timezone.now()
    queryset = CtfSeasonReward.objects.filter(
        kind=CtfSeasonReward.KIND_XP, delivered_at__isnull=True, revoked_at__isnull=True
    ).order_by("id")
    if season_id is not None:
        queryset = queryset.filter(season_id=season_id)
    delivered = 0
    for reward in queryset[:limit]:
        try:
            outcome = _engagement_award(reward.user_id, reward)
        except Exception:  # noqa: BLE001 - one failure must not block the rest
            logger.warning("ctf.season.xp_failed reward=%s", reward.pk, exc_info=True)
            continue
        if outcome is None or outcome is False:
            # Engagement missing or switched off: keep the reward pending.
            break
        CtfSeasonReward.objects.filter(pk=reward.pk, delivered_at__isnull=True).update(delivered_at=now)
        delivered += 1
    return delivered


# ---------------------------------------------------------------------------
# Moderation
# ---------------------------------------------------------------------------
def disqualify(entry: CtfSeasonEntry, *, actor, reason: str) -> CtfSeasonEntry:
    reason = str(reason or "").strip()[:300]
    if not reason:
        raise ValidationFailed("Give a reason.", details={"reason": ["Required."]})
    with transaction.atomic():
        entry = CtfSeasonEntry.objects.select_for_update().select_related("season").get(pk=entry.pk)
        if entry.season.status == CtfSeason.STATUS_FINALISED:
            raise Conflict("Results are final; revoke the rewards instead.", code="season_finalised")
        entry.disqualified = True
        entry.disqualified_reason = reason
        entry.save(update_fields=["disqualified", "disqualified_reason", "updated_at"])
        audit(entry.season, actor, "disqualify", entry=entry.pk, user=entry.user_id, reason=reason)
        transaction.on_commit(lambda: _bump_leaderboard(entry.season_id))
    return entry


def reinstate(entry: CtfSeasonEntry, *, actor) -> CtfSeasonEntry:
    with transaction.atomic():
        entry = CtfSeasonEntry.objects.select_for_update().select_related("season").get(pk=entry.pk)
        if entry.season.status == CtfSeason.STATUS_FINALISED:
            raise Conflict("Results are final.", code="season_finalised")
        entry.disqualified = False
        entry.disqualified_reason = ""
        entry.save(update_fields=["disqualified", "disqualified_reason", "updated_at"])
        audit(entry.season, actor, "reinstate", entry=entry.pk, user=entry.user_id)
        transaction.on_commit(lambda: _bump_leaderboard(entry.season_id))
    return entry


def revoke_reward(reward: CtfSeasonReward, *, actor, reason: str, now: datetime | None = None) -> CtfSeasonReward:
    reason = str(reason or "").strip()[:300]
    if not reason:
        raise ValidationFailed("Give a reason.", details={"reason": ["Required."]})
    now = now or timezone.now()
    with transaction.atomic():
        changed = CtfSeasonReward.objects.filter(pk=reward.pk, revoked_at__isnull=True).update(
            revoked_at=now, revoked_reason=reason
        )
        if changed:
            audit(reward.season, actor, "revoke", reward=reward.pk, kind=reward.kind, user=reward.user_id, reason=reason)
            transaction.on_commit(bump_cosmetics_generation)
    reward.refresh_from_db()
    return reward


# ---------------------------------------------------------------------------
# Cosmetics and rewards read model
# ---------------------------------------------------------------------------
EMPTY_COSMETICS = {"aura": False, "frame": False, "frame_tier": "", "title": "", "until": None}
COSMETICS_GENERATION_KEY = "ctf:season:cosmetics:gen"


def _cosmetics_generation() -> int:
    try:
        return int(cache.get(COSMETICS_GENERATION_KEY) or 0)
    except Exception:  # noqa: BLE001
        return 0


def bump_cosmetics_generation() -> None:
    try:
        if not cache.add(COSMETICS_GENERATION_KEY, 1, timeout=None):
            cache.incr(COSMETICS_GENERATION_KEY)
    except Exception:  # noqa: BLE001
        logger.warning("ctf.season.cosmetics_cache_unavailable")


def _compute_cosmetics(user_ids: list[int], now: datetime) -> dict[int, dict]:
    result = {user_id: dict(EMPTY_COSMETICS) for user_id in user_ids}
    rows = CtfSeasonReward.objects.filter(
        user_id__in=user_ids,
        kind__in=CtfSeasonReward.COSMETIC_KINDS,
        revoked_at__isnull=True,
        starts_at__lte=now,
        ends_at__gt=now,
    ).values_list("user_id", "kind", "tier", "title", "ends_at", "starts_at")
    newest_title = {}
    for user_id, kind, tier, title, ends_at, starts_at in rows:
        state = result[user_id]
        if kind == CtfSeasonReward.KIND_GOLDEN_AURA:
            state["aura"] = True
        elif kind == CtfSeasonReward.KIND_PODIUM_FRAME:
            state["frame"] = True
            if not state["frame_tier"] or tier == CtfSeasonReward.TIER_GOLD:
                state["frame_tier"] = tier
        elif kind == CtfSeasonReward.KIND_FIRST_BLOOD:
            if user_id not in newest_title or starts_at > newest_title[user_id]:
                newest_title[user_id] = starts_at
                state["title"] = title.split(" · ")[0]
        if ends_at and (state["until"] is None or ends_at > state["until"]):
            state["until"] = ends_at
    return result


def active_cosmetics(user_ids, *, now: datetime | None = None) -> dict[int, dict]:
    """``{user_id: {aura, frame, frame_tier, title, until}}`` (empty when the switch is off)."""
    ids = sorted({int(user_id) for user_id in user_ids or [] if user_id})
    if not ids:
        return {}
    if not is_enabled():
        return {user_id: dict(EMPTY_COSMETICS) for user_id in ids}
    now = now or timezone.now()
    generation = _cosmetics_generation()
    keys = {user_id: f"ctf:season:cos:{generation}:{user_id}" for user_id in ids}
    try:
        cached = cache.get_many(list(keys.values()))
    except Exception:  # noqa: BLE001
        cached = {}
    result = {}
    missing = []
    for user_id, key in keys.items():
        value = cached.get(key)
        until = value.get("until") if isinstance(value, dict) else None
        if isinstance(value, dict) and (until is None or until > now):
            result[user_id] = value
        else:
            missing.append(user_id)
    if missing:
        computed = _compute_cosmetics(missing, now)
        result.update(computed)
        try:
            cache.set_many({keys[user_id]: computed[user_id] for user_id in missing}, timeout=COSMETICS_CACHE_SECONDS)
        except Exception:  # noqa: BLE001
            pass
    return result


def cosmetics_for_user(user) -> dict:
    if not user or not getattr(user, "is_authenticated", False):
        return dict(EMPTY_COSMETICS)
    return active_cosmetics([user.pk]).get(user.pk, dict(EMPTY_COSMETICS))


def reward_payload(reward: CtfSeasonReward, now: datetime) -> dict:
    return {
        "kind": reward.kind,
        "title": reward.title,
        "season": reward.season.slug,
        "month": reward.season.month_label,
        "rank": reward.rank,
        "tier": reward.tier,
        "points": reward.points,
        "starts_at": reward.starts_at,
        "ends_at": reward.ends_at,
        "active": reward.is_active(now),
        "permanent": reward.ends_at is None,
        "streak": int((reward.metadata or {}).get("streak") or 0) or None,
        "certificate_slug": reward.verify_slug if reward.kind == CtfSeasonReward.KIND_CERTIFICATE else None,
    }


def my_summary(user, *, now: datetime | None = None) -> dict:
    now = now or timezone.now()
    rewards = list(
        CtfSeasonReward.objects.filter(user=user, revoked_at__isnull=True)
        .exclude(kind=CtfSeasonReward.KIND_XP)
        .select_related("season")
        .order_by("-season__month", "kind")[:200]
    )
    xp_total = sum(
        CtfSeasonReward.objects.filter(user=user, revoked_at__isnull=True, kind=CtfSeasonReward.KIND_XP).values_list(
            "points", flat=True
        )
    )
    solved_months = list(
        CtfSeasonEntry.objects.filter(user=user, solved_at__isnull=False, disqualified=False)
        .order_by("-season__month")
        .values_list("season__month", flat=True)[:STREAK_LOOKBACK_MONTHS]
    )
    current = month_start(now.astimezone(IST).date())
    streak = 0
    cursor = month_start(solved_months[0]) if solved_months else None
    solved_set = {month_start(month) for month in solved_months}
    # A streak is alive when the latest solve is this month or last month.
    if cursor is not None and cursor >= add_months(current, -1):
        while cursor in solved_set:
            streak += 1
            cursor = add_months(cursor, -1)
    handle = public_name(user)
    return {
        "handle": handle,
        "display_name": handle,  # handle only (owner privacy rule)
        "cosmetics": cosmetics_for_user(user),
        "streak_months": streak,
        "seasons_solved": len(solved_set),
        "xp_earned": int(xp_total or 0),
        "trophies": [
            reward_payload(reward, now)
            for reward in rewards
            if reward.kind in (CtfSeasonReward.KIND_CHAMPION, CtfSeasonReward.KIND_PODIUM_TROPHY)
        ],
        "badges": [
            reward_payload(reward, now)
            for reward in rewards
            if reward.kind
            in (
                CtfSeasonReward.KIND_FINALIST,
                CtfSeasonReward.KIND_OPERATIVE,
                CtfSeasonReward.KIND_HALL_OF_FAME,
            )
        ],
        "cosmetic_rewards": [reward_payload(reward, now) for reward in rewards if reward.kind in CtfSeasonReward.COSMETIC_KINDS],
        "certificates": [
            reward_payload(reward, now) for reward in rewards if reward.kind == CtfSeasonReward.KIND_CERTIFICATE
        ],
    }


def _may_see_certificate(reward, viewer) -> bool:
    if viewer is None or not getattr(viewer, "is_authenticated", False):
        return False
    return bool(getattr(viewer, "is_staff", False) or getattr(viewer, "is_superuser", False) or viewer.pk == reward.user_id)


def certificate(slug: str, viewer=None) -> dict:
    """Verification facts for a Finalist certificate. The holder's real name is
    returned only to the holder and to staff (certificates are private)."""
    reward = (
        CtfSeasonReward.objects.select_related("season", "user")
        .filter(kind=CtfSeasonReward.KIND_CERTIFICATE, verify_slug=str(slug or "")[:32])
        .first()
    )
    if reward is None:
        raise NotFound("Certificate not found.", code="season_certificate_not_found")
    return {
        "valid": reward.revoked_at is None,
        # A certificate is the one place a real name is printed (owner rule), and
        # only its holder (and staff) may see it.
        "name": certificate_name(reward.user) if _may_see_certificate(reward, viewer) else "",
        "season": reward.season.slug,
        "season_title": reward.season.title,
        "month": reward.season.month_label,
        "rank": reward.rank,
        "issued_at": reward.starts_at,
        "slug": reward.verify_slug,
    }


def hall_of_fame(*, limit_seasons: int = 24) -> list[dict]:
    """Finalised seasons, newest first, each with its top 10 (handles only)."""
    seasons = list(
        CtfSeason.objects.filter(status=CtfSeason.STATUS_FINALISED).order_by("-month")[: max(1, int(limit_seasons))]
    )
    if not seasons:
        return []
    real_names = real_names_enabled()
    entries = (
        CtfSeasonEntry.objects.filter(
            season__in=seasons, final_rank__isnull=False, final_rank__lte=TOP_FINALISTS, disqualified=False
        )
        .select_related("user", "user__student_profile")
        .order_by("season_id", "final_rank")
    )
    revoked = set(
        CtfSeasonReward.objects.filter(
            season__in=seasons, kind=CtfSeasonReward.KIND_HALL_OF_FAME, revoked_at__isnull=False
        ).values_list("season_id", "user_id")
    )
    solvers = defaultdict(int)
    for season_id in CtfSeasonEntry.objects.filter(
        season__in=seasons, solved_at__isnull=False, disqualified=False
    ).values_list("season_id", flat=True):
        solvers[season_id] += 1
    by_season = defaultdict(list)
    entries = list(entries)
    attach_handles([entry.user for entry in entries])
    for entry in entries:
        if (entry.season_id, entry.user_id) in revoked:
            continue
        by_season[entry.season_id].append(
            {
                "rank": entry.final_rank,
                "name": public_name(entry.user, real_names=real_names),
                "solve_seconds": entry.solve_seconds,
                "wrong_attempts": entry.wrong_attempts,
                "score_seconds": entry.score_seconds,
                "tier": TIERS.get(entry.final_rank, ""),
            }
        )
    return [
        {
            "slug": season.slug,
            "title": season.title,
            "month": season.month_label,
            "solvers": solvers.get(season.pk, 0),
            "finalised_at": season.finalised_at,
            "finalists": by_season.get(season.pk, []),
        }
        for season in seasons
    ]

