"""Engagement API (``/api/engagement/``). Views map HTTP onto services only.

Every endpoint answers 403 ``feature_disabled`` while the ``engagement``
switch is off. Reads carry an ``ETag`` (If-None-Match -> 304) and a short
private ``Cache-Control``.
"""

from __future__ import annotations

import hashlib
import json

from django.core.cache import cache
from django.core.serializers.json import DjangoJSONEncoder
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.errors import NotFound, PermissionDenied, ValidationFailed
from config.response import api_response
from config.throttling import ClientIpAnonRateThrottle, ClientIpUserRateThrottle

from . import badges as badge_catalogue
from . import buffer, certificate_render, certificates, leaderboard, progress, rules, services
from .models import Achievement, BadgeAward, EngagementSettings, EngagementSummary
from .throttles import (
    EngagementPresenceThrottle,
    EngagementPublicThrottle,
    EngagementReadThrottle,
    EngagementStaffThrottle,
    EngagementWriteThrottle,
)

READ_THROTTLES = [ClientIpUserRateThrottle, EngagementReadThrottle]


# --- helpers ---------------------------------------------------------------------------
def conditional_response(request, data, *, message: str, max_age: int):
    body = json.dumps(data, sort_keys=True, cls=DjangoJSONEncoder, separators=(",", ":"))
    etag = '"' + hashlib.sha256(body.encode("utf-8")).hexdigest()[:32] + '"'
    presented = [value.strip().removeprefix("W/") for value in request.headers.get("If-None-Match", "").split(",")]
    if etag in presented or "*" in presented:
        response = Response(status=304)
    else:
        response = api_response(success=True, message=message, data=data)
    response["ETag"] = etag
    response["Cache-Control"] = f"private, max-age={int(max_age)}"
    response["Vary"] = "Cookie, Authorization"
    return response


def is_staff(user) -> bool:
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def initials(full_name: str, email: str = "") -> str:
    parts = [part for part in str(full_name or "").replace(".", " ").split() if part[:1].isalnum()]
    if not parts:
        local = str(email or "").split("@", 1)[0]
        return (local[:1].upper() + ".") if local else "?"
    letters = [parts[0][0]] + ([parts[-1][0]] if len(parts) > 1 else [])
    return "".join(f"{letter.upper()}." for letter in letters)


def display_name(user, mode: str = "") -> str:
    """How a student appears on a leaderboard: the profile handle, always
    (owner privacy rule; ``mode`` is kept for callers, "hidden" rows are
    dropped before this is called)."""
    from apps.profiles.handles import public_handle

    return public_handle(user)


def normalize_display(mode) -> str:
    """Stored/sent mode -> "handle" | "hidden" (retired initials/name map to handle)."""
    return EngagementSettings.DISPLAY_HIDDEN if mode == EngagementSettings.DISPLAY_HIDDEN else EngagementSettings.DISPLAY_HANDLE


def _int_param(request, name, default=None, *, minimum=None, maximum=None):
    raw = request.query_params.get(name)
    if raw in (None, ""):
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValidationFailed(details={name: ["Must be a whole number."]}) from None
    if minimum is not None and value < minimum:
        raise ValidationFailed(details={name: [f"Must be at least {minimum}."]})
    if maximum is not None:
        value = min(value, maximum)
    return value


def _period(request) -> str:
    period = str(request.query_params.get("period") or leaderboard.PERIOD_WEEK).strip().lower()
    if period not in leaderboard.PERIODS:
        raise ValidationFailed(details={"period": ["Use week or all."]})
    scope = str(request.query_params.get("scope") or "batch").strip().lower()
    if scope != "batch":
        raise ValidationFailed(details={"scope": ["Only scope=batch is supported."]})
    return period


def _batch_dicts(batch_ids):
    from apps.courses.models import Course

    rows = Course.objects.filter(pk__in=list(batch_ids)).order_by("title", "id").values("id", "title", "batch")
    return [{"id": row["id"], "title": row["title"], "batch": row["batch"] or ""} for row in rows]


def _both_totals(values, period: str, week) -> dict:
    """``xp_with_purchases`` / ``xp_without_purchases`` for the board's period."""
    if not values:
        return {"xp_with_purchases": 0, "xp_without_purchases": 0}
    total, purchase, week_start, weekly, weekly_purchase = values
    if period == leaderboard.PERIOD_ALL:
        return {"xp_with_purchases": int(total or 0), "xp_without_purchases": int(total or 0) - int(purchase or 0)}
    if week_start != week:
        return {"xp_with_purchases": 0, "xp_without_purchases": 0}
    return {
        "xp_with_purchases": int(weekly or 0),
        "xp_without_purchases": int(weekly or 0) - int(weekly_purchase or 0),
    }


def _my_ranked_xp(snapshot: dict, period: str) -> int:
    if period == leaderboard.PERIOD_WEEK:
        return snapshot["weekly_xp"] if rules.leaderboard_counts_purchase_xp() else snapshot["weekly_xp_without_purchases"]
    return snapshot["xp"] if rules.leaderboard_counts_purchase_xp() else snapshot["xp_without_purchases"]


def build_board(batch_id: int, period: str, limit: int, week) -> dict:
    """The viewer-independent part of a board (cached 60 s by ``leaderboard.cached_board``)."""
    from apps.profiles.handles import public_handles

    rows, participants, source = leaderboard.top(batch_id, period, limit, week)
    user_ids = [user_id for user_id, _xp in rows]
    # Handles only (owner privacy rule): one query, existing accounts only.
    handles = public_handles(user_ids)
    modes = dict(EngagementSettings.objects.filter(user_id__in=user_ids).values_list("user_id", "leaderboard_display"))
    # Both totals per row (owner rules A): one query, same as before.
    sums = {
        row[0]: row[1:]
        for row in EngagementSummary.objects.filter(user_id__in=user_ids).values_list(
            "user_id", "total_xp", "purchase_xp", "week_start", "weekly_xp", "weekly_purchase_xp"
        )
    }
    totals = {user_id: values[0] for user_id, values in sums.items()}
    entries = []
    for position, (user_id, xp) in enumerate(rows, 1):
        handle = handles.get(user_id)
        mode = normalize_display(modes.get(user_id))
        if handle is None or mode == EngagementSettings.DISPLAY_HIDDEN:
            continue
        entries.append(
            {
                "rank": position,
                "user_id": user_id,
                "display_name": handle,
                "handle": handle,
                "xp": int(xp),
                **_both_totals(sums.get(user_id), period, week),
                "level": rules.level_dict(rules.level_for(totals.get(user_id, xp))),
            }
        )
    return {
        "counts_purchase_xp": rules.leaderboard_counts_purchase_xp(),
        "week_start": week.isoformat(),
        "participants": int(participants),
        "entries": entries,
        "source": source,
        "generated_at": timezone.now().isoformat(),
    }


# --- student API ---------------------------------------------------------------------------
class MeView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = READ_THROTTLES

    def get(self, request):
        services.require_enabled()
        return conditional_response(
            request, progress.me_payload(request.user), message="Engagement summary.", max_age=rules.ME_MAX_AGE_SECONDS
        )


class LeaderboardView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = READ_THROTTLES

    def get(self, request):
        services.require_enabled()
        period = _period(request)
        limit = _int_param(request, "limit", rules.LEADERBOARD_DEFAULT_LIMIT, minimum=1, maximum=rules.LEADERBOARD_MAX_LIMIT)
        batch_ids = leaderboard.member_batch_ids(request.user.pk)
        requested = _int_param(request, "batch", None, minimum=1)
        week = rules.current_week_start()
        if requested is not None and requested not in batch_ids:
            raise NotFound("You are not in this batch.", code="engagement_batch_not_found")
        if not batch_ids:
            data = {
                "scope": "batch", "period": period, "batch": None, "batches": [], "week_start": week.isoformat(),
                "participants": 0, "entries": [], "me": None,
            }
            return conditional_response(request, data, message="Leaderboard.", max_age=rules.LEADERBOARD_MAX_AGE_SECONDS)
        batch_id = requested or batch_ids[0]
        board = leaderboard.cached_board(batch_id, period, limit, build_board)
        summary = EngagementSummary.objects.filter(user_id=request.user.pk).first()
        mode = normalize_display(
            EngagementSettings.objects.filter(user_id=request.user.pk).values_list("leaderboard_display", flat=True).first()
        )
        visible = mode != EngagementSettings.DISPLAY_HIDDEN
        my_rank = leaderboard.rank_of(batch_id, period, request.user.pk, summary, visible=visible, week=week)
        snapshot = services.summary_snapshot(summary)
        batches = _batch_dicts(batch_ids)
        from apps.profiles.handles import cached_handle

        my_handle = next(
            (entry["handle"] for entry in board["entries"] if entry["user_id"] == request.user.pk and entry.get("handle")),
            None,
        ) or cached_handle(request.user)
        data = {
            "scope": "batch",
            "period": period,
            "batch": next((item for item in batches if item["id"] == batch_id), None),
            "batches": batches,
            "week_start": board["week_start"],
            "participants": board["participants"],
            "entries": [
                {key: value for key, value in entry.items() if key != "user_id"} | {"is_me": entry["user_id"] == request.user.pk}
                for entry in board["entries"]
            ],
            "me": {
                "rank": my_rank,
                "xp": _my_ranked_xp(snapshot, period),
                "xp_with_purchases": snapshot["weekly_xp"] if period == leaderboard.PERIOD_WEEK else snapshot["xp"],
                "xp_without_purchases": (
                    snapshot["weekly_xp_without_purchases"]
                    if period == leaderboard.PERIOD_WEEK
                    else snapshot["xp_without_purchases"]
                ),
                "visible": visible,
                "display_name": my_handle if visible else None,
                "handle": my_handle,
                "leaderboard_display": mode,
            },
            "counts_purchase_xp": rules.leaderboard_counts_purchase_xp(),
            "generated_at": board["generated_at"],
        }
        return conditional_response(request, data, message="Leaderboard.", max_age=rules.LEADERBOARD_MAX_AGE_SECONDS)


# --- level chart and the level-up moment (owner rules B) --------------------------------------------
LEVEL_CHART_CURVE_NOTE = (
    "A regular week (three live classes, a few lectures and recordings, the weekly report) earns about "
    "800 XP, so a steady student moves up a rank every two to four weeks."
)


def level_chart(summary) -> dict:
    snapshot = services.summary_snapshot(summary)
    total = snapshot["xp"]
    current = rules.level_for(total)
    levels = []
    for index, level in enumerate(rules.LEVELS):
        following = rules.LEVELS[index + 1] if index + 1 < len(rules.LEVELS) else None
        levels.append(
            {
                **rules.level_dict(level),
                "next_min_xp": following.min_xp if following else None,
                "xp_span": (following.min_xp - level.min_xp) if following else None,
                "unlocks": list(rules.LEVEL_UNLOCKS.get(level.key, ())),
                "reached": total >= level.min_xp,
                "current": level.number == current.number,
            }
        )
    return {
        "levels": levels,
        "earn": rules.earn_table(),
        "curve": {"weekly_xp_estimate": 800, "note": LEVEL_CHART_CURVE_NOTE},
        "me": {
            "xp": total,
            "level": snapshot["level"],
            "next_level": snapshot["next_level"],
            "xp_to_next_level": snapshot["xp_to_next_level"],
            "level_progress": snapshot["level_progress"],
            "level_up": snapshot["level_up"],
        },
    }


class LevelChartView(APIView):
    """Every rank, its threshold and what it unlocks, how to earn XP, and where the caller stands."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = READ_THROTTLES

    def get(self, request):
        services.require_enabled()
        summary = EngagementSummary.objects.filter(user_id=request.user.pk).first()
        return conditional_response(request, level_chart(summary), message="Level chart.", max_age=rules.ME_MAX_AGE_SECONDS)


class LevelSeenView(APIView):
    """The UI showed the level-up moment: acknowledge it (it is shown once)."""

    permission_classes = [permissions.IsAuthenticated]

    def get_throttles(self):
        return [ClientIpUserRateThrottle(), EngagementWriteThrottle()]

    def post(self, request):
        services.require_enabled()
        services.acknowledge_level(request.user.pk)
        summary = EngagementSummary.objects.filter(user_id=request.user.pk).first()
        snapshot = services.summary_snapshot(summary)
        return api_response(
            success=True,
            message="Level-up acknowledged.",
            data={"level": snapshot["level"], "level_up": snapshot["level_up"]},
        )


class PromotionSeenView(LevelSeenView):
    """The level-up celebration was shown: acknowledge the promotion (idempotent; it is shown once per rank)."""


class SettingsSerializer(serializers.Serializer):
    # "handle" | "hidden"; the retired "initials" / "name" are accepted and mean "handle".
    leaderboard_display = serializers.ChoiceField(
        choices=[*EngagementSettings.DISPLAY_CHOICES, *((value, value) for value in EngagementSettings.RETIRED_DISPLAYS)],
        required=False,
    )
    show_on_leaderboards = serializers.BooleanField(required=False)


def _settings_dict(row: EngagementSettings) -> dict:
    mode = normalize_display(row.leaderboard_display)
    return {
        "leaderboard_display": mode,
        "show_on_leaderboards": mode != EngagementSettings.DISPLAY_HIDDEN,
        "choices": [value for value, _label in EngagementSettings.DISPLAY_CHOICES],
    }


class SettingsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_throttles(self):
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [throttle() for throttle in READ_THROTTLES]
        return [ClientIpUserRateThrottle(), EngagementWriteThrottle()]

    def get(self, request):
        services.require_enabled()
        return api_response(success=True, message="Engagement settings.", data=_settings_dict(services.get_settings(request.user)))

    def patch(self, request):
        services.require_enabled()
        serializer = SettingsSerializer(data=request.data)
        if not serializer.is_valid():
            raise ValidationFailed(details=serializer.errors)
        values = serializer.validated_data
        services.get_settings(request.user)
        mode = values.get("leaderboard_display")
        if mode is not None:
            mode = normalize_display(mode)
        if mode is None and "show_on_leaderboards" in values:
            mode = EngagementSettings.DISPLAY_HANDLE if values["show_on_leaderboards"] else EngagementSettings.DISPLAY_HIDDEN
        if mode is None:
            raise ValidationFailed(details={"leaderboard_display": ["Send leaderboard_display or show_on_leaderboards."]})
        row = services.update_settings(request.user, leaderboard_display=mode)
        return api_response(success=True, message="Engagement settings saved.", data=_settings_dict(row))


class BadgeCatalogueView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = READ_THROTTLES

    def get(self, request):
        services.require_enabled()
        earned = dict(
            BadgeAward.objects.filter(user_id=request.user.pk, revoked_at__isnull=True).values_list("badge_key", "awarded_at")
        )
        data = [
            {
                **badge.as_dict(),
                "earned": badge.key in earned,
                "earned_at": earned[badge.key].isoformat() if badge.key in earned else None,
            }
            for badge in badge_catalogue.CATALOGUE
        ]
        return conditional_response(request, {"badges": data}, message="Badges.", max_age=rules.ME_MAX_AGE_SECONDS)


class MyAchievementsView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = READ_THROTTLES

    def get(self, request):
        services.require_enabled()
        rows = list(
            Achievement.objects.filter(user_id=request.user.pk).select_related("certificate").order_by("-earned_at", "-id")[:200]
        )
        for row in rows:
            if progress._certificate_of(row) is None:  # issued before certificates existed
                row._state.fields_cache["certificate"] = certificates.ensure_for_achievement(row, user=request.user)
        data = {"achievements": [progress.achievement_dict(row, request=request) for row in rows]}
        return conditional_response(request, data, message="Achievements.", max_age=rules.ME_MAX_AGE_SECONDS)


# --- public verification ----------------------------------------------------------------------
def _achievement_or_404(slug: str) -> Achievement:
    achievement = Achievement.objects.filter(slug=str(slug or "")[:32]).first()
    if achievement is None:
        raise NotFound("Achievement not found.", code="achievement_not_found")
    return achievement


# Verification keeps working while the ``engagement`` switch is off: an issued
# certificate must stay verifiable (owner decision). The card and the PDF are
# the certificate's own renderings (certificate_render), so there is one design.
def _with_certificate(achievement: Achievement) -> Achievement:
    achievement._state.fields_cache["certificate"] = certificates.ensure_for_achievement(achievement)
    return achievement


class AchievementVerifyView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ClientIpAnonRateThrottle, EngagementPublicThrottle]

    def get(self, request, slug):
        achievement = _with_certificate(_achievement_or_404(slug))
        data = progress.achievement_dict(achievement, request=request)
        data.pop("verify_api_url", None)
        # Owner privacy rule: the achievement page shows the holder's handle; the
        # real name is printed only on the certificate it links to.
        from apps.profiles.handles import public_handle

        data["recipient_name"] = public_handle(achievement.user_id)
        data["recipient_handle"] = data["recipient_name"]
        # Certificates are private to their holder: only the holder and staff get the file links.
        from .certificate_views import viewer

        user = viewer(request)
        if not (user is not None and (is_staff(user) or user.pk == achievement.user_id)):
            data["share_card_url"] = None
            data["certificate_url"] = None
        response = api_response(
            success=True,
            message="Valid achievement." if achievement.revoked_at is None else "This achievement was revoked.",
            data=data,
        )
        response["Cache-Control"] = "private, no-store"
        response["X-Robots-Tag"] = "noindex"
        return response


def require_full_access(request, certificate):
    from .certificate_views import require_full_access as _require

    _require(request, certificate)


class AchievementCardView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ClientIpAnonRateThrottle, EngagementPublicThrottle]

    def get(self, request, slug):
        certificate = certificates.ensure_for_achievement(_achievement_or_404(slug))
        require_full_access(request, certificate)
        response = HttpResponse(certificate_render.og_png(certificate), content_type="image/png")
        response["Cache-Control"] = "private, no-store"
        response["Content-Disposition"] = f'inline; filename="{certificate.reference}-preview.png"'
        response["X-Robots-Tag"] = "noindex"
        return response


class AchievementCertificateView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ClientIpAnonRateThrottle, EngagementPublicThrottle]

    def get(self, request, slug):
        certificate = certificates.ensure_for_achievement(_achievement_or_404(slug))
        require_full_access(request, certificate)
        response = HttpResponse(certificate_render.certificate_pdf(certificate), content_type="application/pdf")
        response["Cache-Control"] = "private, no-store"
        response["Content-Disposition"] = f'attachment; filename="{certificate.reference}.pdf"'
        response["X-Robots-Tag"] = "noindex"
        return response


# --- live presence ---------------------------------------------------------------------------------
class LivePresenceView(APIView):
    """``POST`` once a minute while a live class is open and visible."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, EngagementPresenceThrottle]

    def post(self, request, session_id):
        services.require_enabled()
        status_key = f"eng:live:st:{int(session_id)}"
        status = cache.get(status_key)
        if status is None:
            from apps.realtime.models import RealtimeSession

            status = RealtimeSession.objects.filter(pk=session_id).values_list("status", flat=True).first() or "missing"
            cache.set(status_key, status, timeout=30)
        if status == "missing":
            raise NotFound("Live class not found.", code="live_session_not_found")
        if status != "live":
            return api_response(success=True, message="The class is not live.", data={"counted": False, "credited_seconds": 0})
        access_key = f"eng:live:acc:{int(session_id)}:{request.user.pk}"
        if not cache.get(access_key):
            from apps.realtime.domain import get_access_decision
            from apps.realtime.models import RealtimeSession

            session = RealtimeSession.objects.with_related().filter(pk=session_id).first()
            if session is None:
                raise NotFound("Live class not found.", code="live_session_not_found")
            if not get_access_decision(session, request.user).allowed:
                raise PermissionDenied("You do not have access to this class.", code="live_session_forbidden")
            cache.set(access_key, 1, timeout=300)
        now = timezone.now()
        previous = buffer.swap_last_seen(f"live:{int(session_id)}:{request.user.pk}", f"{now.timestamp():.3f}")
        if previous is None:
            credit = rules.LIVE_PRESENCE_FIRST_CREDIT_SECONDS
        else:
            try:
                credit = int(min(rules.LIVE_PRESENCE_MAX_CREDIT_SECONDS, max(0.0, now.timestamp() - float(previous))))
            except ValueError:
                credit = 0
        buffer.incr("live", f"{int(session_id)}:{request.user.pk}:{rules.ist_day(now).isoformat()}", credit)
        # Thin alias: the same ping also feeds attendance (the source of truth for
        # live presence; XP reads its results). Fail-safe, Redis only.
        from apps.attendance.hooks import on_engagement_presence

        on_engagement_presence(session_id, request.user)
        return api_response(success=True, message="Presence recorded.", data={"counted": True, "credited_seconds": credit})


# --- staff ------------------------------------------------------------------------------------------
def _require_board_reader(user, batch_id: int) -> bool:
    """Staff read any batch; instructors their own batches (through the Teachers switch)."""
    if is_staff(user):
        return True
    from apps.users import teaching

    if batch_id in set(teaching.taught_course_ids(user)):
        return False
    teaching.require_teaching(user)
    raise PermissionDenied("Only staff can open this leaderboard.", code="engagement_staff_only")


def _require_staff(user):
    if not is_staff(user):
        raise PermissionDenied("Only staff can do this.", code="engagement_staff_only")


class StaffLeaderboardView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, EngagementStaffThrottle]

    def get(self, request):
        services.require_enabled()
        period = _period(request)
        batch_id = _int_param(request, "batch", None, minimum=1)
        if batch_id is None:
            raise ValidationFailed(details={"batch": ["Choose a batch."]})
        full = _require_board_reader(request.user, batch_id)
        limit = _int_param(request, "limit", 50, minimum=1, maximum=500)
        week = rules.current_week_start()
        rows = list(leaderboard.db_queryset(batch_id, period, week, include_hidden=True).select_related("user")[:limit])
        from apps.profiles.handles import public_handles

        handles = public_handles([row.user_id for row in rows])
        modes = dict(
            EngagementSettings.objects.filter(user_id__in=[row.user_id for row in rows]).values_list(
                "user_id", "leaderboard_display"
            )
        )
        entries = []
        for position, row in enumerate(rows, 1):
            mode = normalize_display(modes.get(row.user_id))
            handle = handles.get(row.user_id) or display_name(row.user)
            entries.append(
                {
                    "rank": position,
                    "user_id": row.user_id,
                    # Staff see the identity pattern; instructors of the batch see handles.
                    "full_name": row.user.full_name if full else handle,
                    "handle": handle,
                    "email": row.user.email if full else None,
                    "xp": int(row.ranked_xp),
                    "total_xp": row.total_xp,
                    "purchase_xp": row.purchase_xp,
                    "total_xp_without_purchases": row.total_xp - row.purchase_xp,
                    "level": rules.level_dict(rules.level_for(row.total_xp)),
                    "current_streak": row.current_streak,
                    "hidden": mode == EngagementSettings.DISPLAY_HIDDEN,
                }
            )
        if not full:
            entries = [entry for entry in entries if not entry["hidden"]]
        batches = _batch_dicts([batch_id])
        data = {
            "scope": "batch",
            "period": period,
            "batch": batches[0] if batches else None,
            "week_start": week.isoformat(),
            "entries": entries,
        }
        return conditional_response(request, data, message="Leaderboard.", max_age=rules.LEADERBOARD_MAX_AGE_SECONDS)


class StaffAwardSerializer(serializers.Serializer):
    user_id = serializers.IntegerField(min_value=1)
    points = serializers.IntegerField()
    reason = serializers.CharField(max_length=300)


class StaffRevokeSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=300)


class StaffBadgeSerializer(serializers.Serializer):
    user_id = serializers.IntegerField(min_value=1)
    badge_key = serializers.CharField(max_length=40)
    action = serializers.ChoiceField(choices=["award", "revoke"])
    reason = serializers.CharField(max_length=300)


def _validated(serializer_class, data):
    serializer = serializer_class(data=data)
    if not serializer.is_valid():
        raise ValidationFailed(details=serializer.errors)
    return serializer.validated_data


def _event_dict(event) -> dict:
    return {
        "id": event.pk,
        "user_id": event.user_id,
        "kind": event.kind,
        "points": event.points,
        "source_type": event.source_type,
        "source_id": event.source_id,
        "occurred_at": event.occurred_at.isoformat(),
        "created_at": event.created_at.isoformat(),
    }


class StaffXpAwardView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, EngagementStaffThrottle]

    def post(self, request):
        _require_staff(request.user)
        values = _validated(StaffAwardSerializer, request.data)
        event = services.staff_award_xp(
            actor=request.user, user_id=values["user_id"], points=values["points"], reason=values["reason"], request=request
        )
        return api_response(success=True, message="XP awarded.", data=_event_dict(event), status_code=201)


class StaffXpRevokeView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, EngagementStaffThrottle]

    def post(self, request, event_id):
        _require_staff(request.user)
        values = _validated(StaffRevokeSerializer, request.data)
        event = services.staff_revoke_xp(actor=request.user, event_id=event_id, reason=values["reason"], request=request)
        return api_response(success=True, message="XP revoked.", data=_event_dict(event))


class StaffBadgeView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, EngagementStaffThrottle]

    def post(self, request):
        _require_staff(request.user)
        values = _validated(StaffBadgeSerializer, request.data)
        row = services.staff_set_badge(
            actor=request.user,
            user_id=values["user_id"],
            badge_key=values["badge_key"],
            award_it=values["action"] == "award",
            reason=values["reason"],
            request=request,
        )
        return api_response(
            success=True,
            message="Badge awarded." if values["action"] == "award" else "Badge revoked.",
            data={
                "user_id": row.user_id,
                "badge_key": row.badge_key,
                "awarded_at": row.awarded_at.isoformat(),
                "revoked_at": row.revoked_at.isoformat() if row.revoked_at else None,
            },
        )


# --- reward history and highlights (profile tabs) --------------------------------------
class RewardHistoryView(APIView):
    """``GET /api/engagement/me/history/``: the caller's XP ledger (paginated), badges,
    batches and own certificates, each with its ``highlighted`` flag. Works whatever
    the ``engagement`` switch says (it is the student's own record)."""

    permission_classes = [permissions.IsAuthenticated]

    def get_throttles(self):
        return [ClientIpUserRateThrottle(), EngagementReadThrottle()]

    def get(self, request):
        from . import history

        def _int(name, default):
            try:
                return int(request.query_params.get(name) or default)
            except (TypeError, ValueError):
                raise ValidationFailed(details={name: ["Send a whole number."]}) from None

        data = history.history_payload(
            request.user, page=_int("page", 1), page_size=_int("page_size", history.DEFAULT_PAGE_SIZE)
        )
        response = api_response(success=True, message="Reward history.", data=data)
        response["Cache-Control"] = "private, no-store"
        response["Vary"] = "Cookie, Authorization"
        return response


class RewardHighlightsView(APIView):
    """``PATCH /api/engagement/me/highlights/`` (POST accepted): choose up to 3 badges or
    certificates to feature on the public profile. ``GET`` returns the current choice."""

    permission_classes = [permissions.IsAuthenticated]

    def get_throttles(self):
        if self.request.method == "GET":
            return [ClientIpUserRateThrottle(), EngagementReadThrottle()]
        return [ClientIpUserRateThrottle(), EngagementWriteThrottle()]

    def get(self, request):
        from . import history

        response = api_response(success=True, message="Highlights.", data=history.highlights_dict(request.user.pk))
        response["Cache-Control"] = "private, no-store"
        return response

    def patch(self, request):
        from . import history

        data = history.set_highlights(request.user, request.data)
        return api_response(success=True, message="Highlights saved.", data=data)

    def post(self, request):
        return self.patch(request)
