"""``GET /api/catalog/``: the public catalogue for the marketing pages (contract §1).

Tracks, Pentesting tiers with course cards, the OSINT courses, the feature
gates (``pentesting``, ``memberships``, ``labs_membership_required``), the
public plan cards (prices only once the owner confirmed them), the free OSINT
directory and the labs tabs. Holds no user data: one cached payload (60 s, and
keyed by every input's version, so a switch flip or a plan edit shows within
the feature memo window) shared by every visitor, with an ETag.
"""

from __future__ import annotations

import hashlib
import json

from django.conf import settings
from django.core.cache import cache
from django.db.models import Q
from django.http import HttpResponseNotModified
from rest_framework import permissions
from rest_framework.views import APIView

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle

from .cache_utils import get_course_list_cache_version
from .catalog_tracks import TRACKS, get_catalog_tracks
from .features import purchase_gate
from .models import Course
from .pentesting_catalog import TIER_ORDER, TIER_SUMMARIES

CATALOG_VERSION_KEY = "catalog-api-version"
CACHE_SECONDS = 60
GATE_KEYS = ("pentesting", "memberships", "labs_membership_required")

LABS_TABS = (
    ("hub", "01", "CTF hub", "mixed"),
    ("realworld", "02", "Real-World OSINT lab", "mixed"),
    ("blackmeridian", "03", "Black Meridian", "expert"),
    ("certification", "04", "Certification CTF", "professional"),
    ("exam", "05", "OSINT Examination", "professional"),
)


def get_catalog_version() -> int:
    value = cache.get(CATALOG_VERSION_KEY)
    if isinstance(value, int) and value > 0:
        return value
    cache.set(CATALOG_VERSION_KEY, 1, timeout=None)
    return 1


def bump_catalog_version(**_kwargs) -> None:
    """Signal receiver: platform plans, bundles or the free directory changed."""
    try:
        cache.incr(CATALOG_VERSION_KEY)
    except ValueError:
        cache.set(CATALOG_VERSION_KEY, 2, timeout=None)


def _hours_label(course) -> str:
    return course.total_hours_label or ""


def course_card(course) -> dict:
    curriculum = course.public_curriculum if isinstance(course.public_curriculum, list) else []
    return {
        "id": course.pk,
        "slug": course.slug,
        "title": course.title,
        "card_title": course.card_title,
        "card_subtitle": course.card_subtitle,
        "summary": course.card_summary or course.description[:240],
        "track": course.category,
        "tier": course.tier,
        "tier_label": course.get_tier_display() if course.tier else "",
        "tier_order": int(course.tier_order or 0),
        "level": course.level,
        "level_label": course.get_level_display(),
        "format": "self_paced" if (course.duration or "").lower().startswith("self") else "live_cohort",
        "total_hours_label": _hours_label(course),
        "module_count": len(curriculum),
        "launch_status": course.launch_status,
        "purchase": purchase_gate(course),
        "url": f"/courses/{course.pk}",
    }


def _gates() -> dict:
    from apps.core import features

    gates = {}
    for key in GATE_KEYS:
        enabled = features.is_enabled(key)
        reason = "" if enabled else features.reason_for(key)
        if key == "labs_membership_required":
            # "enabled" here means "the labs are members-only"; off = open labs.
            reason = "" if not enabled else "The labs are open to members."
        gates[key] = {"enabled": enabled, "reason": reason}
    return gates


def _labs_block(membership_required: bool) -> dict:
    base = str(getattr(settings, "LABS_PUBLIC_URL", "") or "https://labs.alsyedinitiative.com").rstrip("/")
    return {
        "url": base,
        "membership_required": membership_required,
        "tabs": [
            {"key": key, "number": number, "title": title, "difficulty": difficulty, "href": f"{base}/#{key}"}
            for key, number, title, difficulty in LABS_TABS
        ],
    }


def build_catalog() -> dict:
    from apps.osint_labs.views import directory_items
    from apps.payments.platform_plans import public_plans

    courses = list(
        Course.objects.filter(is_published=True)
        .filter(Q(launch_status=Course.STATUS_COMING_SOON) | Q(launch_status=Course.STATUS_LIVE, registration_closed=False))
        .order_by("tier_order", "-created_at")
    )
    osint = [course_card(c) for c in sorted(
        (c for c in courses if c.category == Course.CATEGORY_OSINT), key=lambda c: c.created_at, reverse=True
    )]
    pentesting = [c for c in courses if c.category == Course.CATEGORY_WEB_PENTESTING]
    tiers = []
    for order, key in enumerate(TIER_ORDER, start=1):
        rows = sorted((c for c in pentesting if c.tier == key), key=lambda c: (c.tier_order, c.pk))
        cards = [course_card(c) for c in rows]
        tiers.append(
            {
                "key": key,
                "title": dict(Course.TIER_CHOICES)[key],
                "label": dict(Course.TIER_CHOICES)[key],
                "summary": TIER_SUMMARIES[key],
                "track": Course.CATEGORY_WEB_PENTESTING,
                "order": order,
                "course_count": len(cards),
                "module_count": sum(card["module_count"] for card in cards),
                "courses": cards,
            }
        )
    untiered = [course_card(c) for c in pentesting if not c.tier]
    free_challenges = directory_items()
    plans = public_plans(directory_count=len(free_challenges))
    for plan in plans:  # aliases the marketing client reads (requests/catalog.md)
        plan["family"] = plan["group"]
        plan["price_inr"] = plan["price"]
    gates = _gates()
    tracks = []
    tier_heads = [{"key": t["key"], "label": t["title"], "summary": t["summary"], "order": t["order"]} for t in tiers]
    for track in get_catalog_tracks():
        item = dict(track)
        item["tiers"] = tier_heads if track["key"] == Course.CATEGORY_WEB_PENTESTING else []
        tracks.append(item)
    all_cards = osint + [card for tier in tiers for card in tier["courses"]] + untiered
    return {
        "gates": gates,
        "tracks": tracks,
        "osint": {"courses": osint},
        "tiers": tiers,
        "untiered_pentesting": untiered,
        "stats": {
            "course_count": len(all_cards),
            "module_count": sum(card["module_count"] for card in all_cards),
            "free_challenge_count": len(free_challenges),
            "live_cohort_count": sum(1 for card in osint if card["format"] == "live_cohort"),
        },
        "plans": plans,
        "free_challenges": free_challenges,
        "labs": _labs_block(gates["labs_membership_required"]["enabled"]),
    }


def _cache_key() -> str:
    from apps.core import features

    return (
        f"catalog-api:c={get_course_list_cache_version()}:p={get_catalog_version()}:"
        f"f={features.fingerprint()}:pay={int(bool(getattr(settings, 'DIRECT_COURSE_PAYMENTS_ENABLED', False)))}"
    )


def get_catalog() -> dict:
    key = _cache_key()
    payload = cache.get(key)
    if payload is None:
        payload = build_catalog()
        body = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
        payload["version"] = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
        cache.set(key, payload, timeout=CACHE_SECONDS)
    return payload


class CatalogThrottle(ClientIpScopedRateThrottle):
    scope = "catalog_read"


class CatalogView(APIView):
    """Public catalogue (no auth, no user data)."""

    permission_classes = [permissions.AllowAny]
    authentication_classes: list = []
    throttle_classes = [CatalogThrottle]

    def get(self, request):
        payload = get_catalog()
        etag = f'"catalog-{payload["version"]}"'
        if request.headers.get("If-None-Match") == etag:
            response = HttpResponseNotModified()
            response["ETag"] = etag
            return response
        response = api_response(success=True, message="Catalogue.", data=payload)
        response["ETag"] = etag
        response["Cache-Control"] = f"public, max-age={CACHE_SECONDS}"
        return response


__all__ = ["CatalogView", "TRACKS", "bump_catalog_version", "build_catalog", "course_card", "get_catalog"]
