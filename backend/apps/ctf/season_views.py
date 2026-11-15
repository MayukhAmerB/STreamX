"""HTTP mapping for the Monthly OSINT CTF (``/api/ctf/seasons/``).

Public (no sign-in): the current season's teaser, leaderboards, the Hall of
Fame and certificate verification. Signed-in students also get the case file
(brief, question) and their own entry, and may submit answers. Boards print a
public handle only (``season_identity``). Every endpoint except certificate
verification answers 403 ``feature_disabled`` while ``monthly_ctf`` is off.
"""

from __future__ import annotations

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from django.core.cache import cache
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.views import APIView

from apps.core.errors import ValidationFailed

from . import season_services as services
from .season_models import CtfSeason, CtfSeasonEntry
from .season_serializers import (
    CertificateSerializer,
    CosmeticsMapSerializer,
    CurrentSeasonSerializer,
    HallOfFameSerializer,
    LeaderboardSerializer,
    MySeasonSummarySerializer,
    SeasonSerializer,
    SubmitRequestSerializer,
    SubmitResponseSerializer,
)

REWARD_RULES = [
    {
        "key": "champion",
        "who": "#1",
        "title": "Golden Aura + Season Champion trophy",
        "detail": "A golden glow around your avatar and handle everywhere your profile appears, and a permanent "
        "'Season Champion' trophy for the month.",
        "lasts": "Aura: the following month · Trophy: permanent",
    },
    {
        "key": "podium",
        "who": "Top 3",
        "title": "Podium frame + gold, silver or bronze trophy",
        "detail": "A golden-white frame around your avatar and a podium trophy for your rank.",
        "lasts": "Frame: the following month · Trophy: permanent",
    },
    {
        "key": "finalist",
        "who": "Top 10",
        "title": "Finalist badge, Hall of Fame and certificate",
        "detail": "Featured in the Monthly CTF Hall of Fame, with a certificate anyone can verify.",
        "lasts": "Permanent",
    },
    {
        "key": "first_blood",
        "who": "First solver",
        "title": "First Blood title",
        "detail": "The earliest correct answer of the month carries the 'First Blood' title next to their handle.",
        "lasts": "The following month",
    },
    {
        "key": "operative",
        "who": "Every solver",
        "title": "XP + Monthly Operative badge",
        "detail": "Solve XP on your profile and the Monthly Operative badge, which counts your streak of months.",
        "lasts": "Permanent",
    },
]
COUNTS_CACHE_SECONDS = 20


def _ok(serializer_class, payload, message="", status_code=200, *, cache_seconds=None):
    response = api_response(message=message, data=serializer_class(payload).data, status_code=status_code)
    if cache_seconds:
        response["Cache-Control"] = f"private, max-age={int(cache_seconds)}"
    return response


class _SeasonView(APIView):
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "ctf_read"
    parser_classes = [JSONParser]
    permission_classes = [AllowAny]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if getattr(self, "feature_gated", True):
            services.require_enabled()


def _counts(season: CtfSeason) -> tuple[int, int]:
    key = f"ctf:season:{season.pk}:counts:{services._leaderboard_generation(season.pk)}"
    try:
        cached = cache.get(key)
    except Exception:  # noqa: BLE001
        cached = None
    if cached is not None:
        return cached
    participants = CtfSeasonEntry.objects.filter(season=season).count()
    solvers = services.standings_queryset(season).count() if participants else 0
    try:
        cache.set(key, (solvers, participants), timeout=COUNTS_CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        pass
    return solvers, participants


def season_payload(season: CtfSeason, user, now) -> dict:
    phase = services.phase_of(season, now)
    signed_in = bool(user and getattr(user, "is_authenticated", False))
    staff = services.is_staff_user(user)
    content_visible = signed_in and (staff or phase != "upcoming")
    entry = None
    if signed_in and not staff:
        entry = CtfSeasonEntry.objects.filter(season=season, user=user).first()
    can_play = phase == "open" and services.is_participant(user)
    if phase == "upcoming":
        reason = "This month's case opens soon."
    elif phase in ("closed", "results"):
        reason = "This season has closed."
    elif not signed_in:
        reason = "Sign in to play. It is free for every registered student."
    elif staff:
        reason = "Staff answers are checked but never ranked."
    elif entry is not None and entry.disqualified:
        reason = "Your entry for this season was withdrawn by an admin."
        can_play = False
    elif entry is not None and entry.solved_at:
        reason = "Solved. Your time is on the board."
        can_play = False
    else:
        reason = ""
    solvers, participants = _counts(season)
    return {
        "slug": season.slug,
        "title": season.title,
        "tagline": season.tagline,
        "month": season.month_label,
        "status": season.status,
        "phase": phase,
        "opens_at": season.opens_at,
        "closes_at": season.closes_at,
        "difficulty": season.difficulty,
        "skills": list(season.skills or []),
        "solvers": solvers,
        "participants": participants,
        "penalty_seconds": season.wrong_attempt_penalty_seconds,
        "max_attempts": season.max_attempts,
        "solve_xp": season.solve_xp,
        "can_play": bool(can_play or (staff and phase == "open")),
        "play_reason": reason,
        "content_visible": content_visible,
        "brief": season.brief if content_visible else None,
        "question": season.question if content_visible else None,
        "flag_format": season.flag_format if content_visible else None,
        "materials_url": season.materials_url if content_visible else None,
        "me": services.entry_payload(season, entry) if entry is not None else None,
    }


class CurrentSeasonView(_SeasonView):
    @extend_schema(operation_id="ctf_seasons_current_retrieve", responses={200: CurrentSeasonSerializer})
    def get(self, request):
        now = timezone.now()
        season = services.current_season(now)
        payload = {
            "season": season_payload(season, request.user, now) if season else None,
            "rewards": REWARD_RULES,
            "server_time": now,
        }
        return _ok(CurrentSeasonSerializer, payload)


class SeasonDetailView(_SeasonView):
    @extend_schema(operation_id="ctf_seasons_retrieve", responses={200: SeasonSerializer})
    def get(self, request, slug):
        now = timezone.now()
        season = services.season_or_404(slug)
        return _ok(SeasonSerializer, season_payload(season, request.user, now))


class SeasonLeaderboardView(_SeasonView):
    @extend_schema(
        operation_id="ctf_seasons_leaderboard_retrieve",
        parameters=[OpenApiParameter("limit", OpenApiTypes.INT, required=False)],
        responses={200: LeaderboardSerializer},
    )
    def get(self, request, slug):
        season = services.season_or_404(slug)
        raw = request.query_params.get("limit")
        try:
            limit = int(raw) if raw not in (None, "") else services.LEADERBOARD_DEFAULT
        except (TypeError, ValueError):
            raise ValidationFailed(details={"limit": ["Must be a whole number."]}) from None
        payload = services.leaderboard(season, request.user, limit=limit)
        return _ok(LeaderboardSerializer, payload, cache_seconds=15)


class SeasonSubmitView(_SeasonView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "ctf_attempt"

    @extend_schema(
        operation_id="ctf_seasons_submit_create",
        request=SubmitRequestSerializer,
        responses={200: SubmitResponseSerializer},
    )
    def post(self, request, slug):
        serializer = SubmitRequestSerializer(data=request.data)
        if not serializer.is_valid():
            raise ValidationFailed(details=serializer.errors)
        season = services.season_or_404(slug)
        result = services.submit_answer(season, request.user, serializer.validated_data.get("answer", ""))
        if result["practice"]:
            message = "Correct (staff preview, not ranked)." if result["correct"] else "Not correct (staff preview)."
        elif result["already_solved"]:
            message = "You already solved this month's case."
        elif result["correct"]:
            message = "Correct. Your time is on the board."
        else:
            message = "Not quite. Each wrong answer adds the time penalty."
        return _ok(SubmitResponseSerializer, result, message=message)


class MySeasonSummaryView(_SeasonView):
    permission_classes = [IsAuthenticated]

    @extend_schema(operation_id="ctf_seasons_me_retrieve", responses={200: MySeasonSummarySerializer})
    def get(self, request):
        return _ok(MySeasonSummarySerializer, services.my_summary(request.user), cache_seconds=30)


class CosmeticsView(_SeasonView):
    """``?user_ids=1,2,3`` (at most 100) -> active Golden Aura / frame / title per user."""

    permission_classes = [IsAuthenticated]
    MAX_IDS = 100

    @extend_schema(
        operation_id="ctf_seasons_cosmetics_retrieve",
        parameters=[OpenApiParameter("user_ids", OpenApiTypes.STR, required=True)],
        responses={200: CosmeticsMapSerializer},
    )
    def get(self, request):
        raw = str(request.query_params.get("user_ids") or "")
        ids = []
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            if not part.isdigit():
                raise ValidationFailed(details={"user_ids": ["Use comma-separated numbers."]})
            ids.append(int(part))
        if len(ids) > self.MAX_IDS:
            raise ValidationFailed(details={"user_ids": [f"At most {self.MAX_IDS} ids."]})
        cosmetics = services.active_cosmetics(ids)
        return _ok(
            CosmeticsMapSerializer,
            {"users": {str(user_id): value for user_id, value in cosmetics.items()}},
            cache_seconds=60,
        )


class HallOfFameView(_SeasonView):
    @extend_schema(operation_id="ctf_seasons_hall_of_fame_retrieve", responses={200: HallOfFameSerializer})
    def get(self, request):
        key = "ctf:season:hof:" + str(services._cosmetics_generation())
        try:
            seasons = cache.get(key)
        except Exception:  # noqa: BLE001
            seasons = None
        if seasons is None:
            seasons = services.hall_of_fame()
            try:
                cache.set(key, seasons, timeout=300)
            except Exception:  # noqa: BLE001
                pass
        return _ok(HallOfFameSerializer, {"seasons": seasons}, cache_seconds=60)


class CertificateView(_SeasonView):
    """Public verification of a Finalist certificate (works even while the switch is off)."""

    feature_gated = False

    @extend_schema(operation_id="ctf_seasons_certificate_retrieve", responses={200: CertificateSerializer})
    def get(self, request, slug):
        response = _ok(CertificateSerializer, services.certificate(slug, viewer=request.user), cache_seconds=300)
        response["Cache-Control"] = "private, no-store"
        return response
