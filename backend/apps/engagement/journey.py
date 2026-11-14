""""Your journey so far": the one-time welcome for students who studied here
before release day (``LegacyGrant`` rows written by ``engagement_legacy_rewards``).

    GET  /api/engagement/journey/          {show, journey|null}
    POST /api/engagement/journey/dismiss/  {show: false}

``show`` is true once per legacy student: until they dismiss it. Everyone else
(and every student once dismissed) gets ``{"show": false, "journey": null}``
from one primary-key read. The payload is the student's own data only.
Also exposes ``founding_glow(user_ids)`` for profile frames.
"""

from __future__ import annotations

import logging

from config.response import api_response
from config.throttling import ClientIpUserRateThrottle
from django.utils import timezone
from rest_framework import permissions
from rest_framework.views import APIView

from . import badges as badge_catalogue
from . import leaderboard, rules, services
from .models import BadgeAward, Certificate, EngagementSummary, LegacyGrant
from .throttles import EngagementReadThrottle, EngagementWriteThrottle

logger = logging.getLogger("apps.engagement.journey")


def founding_glow(user_ids, *, at=None) -> dict[int, str]:
    """``{user_id: glow_ends_at ISO}`` for students whose Founding Glow frame is on now (one query)."""
    ids = [int(pk) for pk in user_ids or [] if pk]
    if not ids:
        return {}
    at = at or timezone.now()
    try:
        rows = LegacyGrant.objects.filter(
            user_id__in=ids, glow_starts_at__lte=at, glow_ends_at__gt=at
        ).values_list("user_id", "glow_ends_at")
        return {user_id: ends.isoformat() for user_id, ends in rows}
    except Exception:  # noqa: BLE001 - a cosmetic must never break a page
        logger.warning("engagement.founding_glow_failed", exc_info=True)
        return {}


def _position(user_id: int, summary) -> dict | None:
    try:
        batch_ids = leaderboard.member_batch_ids(user_id)
        if not batch_ids or summary is None:
            return None
        hidden = leaderboard.EngagementSettings.objects.filter(
            user_id=user_id, leaderboard_display=leaderboard.EngagementSettings.DISPLAY_HIDDEN
        ).exists()
        rank = leaderboard.rank_of(batch_ids[0], leaderboard.PERIOD_ALL, user_id, summary, visible=not hidden)
        return {"batch_id": batch_ids[0], "all_time_rank": rank} if rank else None
    except Exception:  # noqa: BLE001 - informative only
        logger.warning("engagement.journey_position_failed user=%s", user_id, exc_info=True)
        return None


def journey_payload(user, grant: LegacyGrant) -> dict:
    from .certificates import public_url

    summary = EngagementSummary.objects.filter(user_id=user.pk).first()
    xp = int(summary.total_xp or 0) if summary else 0
    level = rules.level_for(xp)
    earned = list(
        BadgeAward.objects.filter(user_id=user.pk, revoked_at__isnull=True).order_by("-awarded_at", "-id").values_list("badge_key", flat=True)
    )
    badges = []
    for key in earned:
        badge = badge_catalogue.get(key)
        if badge:
            badges.append({**badge.as_dict(), "legacy": badge_catalogue.is_legacy(key)})
    badges.sort(key=lambda item: (not item["legacy"], badge_catalogue.TIERS.index(item["tier"]) * -1))
    certs = [
        {"reference": cert.reference, "title": cert.title, "heading": cert.heading, "issued_at": cert.issued_at.isoformat(),
         "url": public_url(cert.reference)}
        for cert in Certificate.objects.filter(user_id=user.pk, revoked_at__isnull=True, reference__isnull=False).order_by("-issued_at", "-id")[:20]
        if cert.is_valid
    ]
    handle = ""
    try:
        from apps.profiles.handles import public_handle

        handle = public_handle(user) or ""
    except Exception:  # noqa: BLE001
        handle = ""
    now = timezone.now()
    return {
        "cohort": grant.cohort,
        "active": grant.cohort == LegacyGrant.COHORT_ACTIVE,
        "graduate": bool(grant.graduate),
        "batches": list(grant.batches or []),
        "first_enrolled_at": grant.first_enrolled_at.isoformat() if grant.first_enrolled_at else None,
        "xp": xp,
        "level": rules.level_dict(level),
        "next_level": rules.level_dict(rules.next_level(xp)),
        "best_streak": int(summary.best_streak or 0) if summary else 0,
        "position": _position(user.pk, summary),
        "badges": badges,
        "certificates": certs,
        "founding_glow": {
            "active": grant.glow_active(now),
            "ends_at": grant.glow_ends_at.isoformat() if grant.glow_ends_at else None,
        },
        "share": {
            "handle": handle,
            "profile_path": f"/u/{handle}" if handle else None,
            "certificate_url": certs[0]["url"] if certs else None,
        },
    }


class JourneyView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, EngagementReadThrottle]

    def get(self, request):
        services.require_enabled()
        grant = LegacyGrant.objects.filter(user_id=request.user.pk).first()
        if grant is None or grant.welcome_seen_at is not None:
            return api_response(message="Journey.", data={"show": False, "journey": None})
        return api_response(message="Journey.", data={"show": True, "journey": journey_payload(request.user, grant)})


class JourneyDismissView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, EngagementWriteThrottle]

    def post(self, request):
        services.require_enabled()
        LegacyGrant.objects.filter(user_id=request.user.pk, welcome_seen_at__isnull=True).update(welcome_seen_at=timezone.now())
        return api_response(message="Journey dismissed.", data={"show": False, "journey": None})
