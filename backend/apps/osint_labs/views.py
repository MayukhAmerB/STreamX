"""Free OSINT directory and labs access endpoints (contract §3, §4).

Mounted at ``/api/labs/`` (LMS frontend) and ``/api/ctf/labs/`` (the labs
origin may only call ``/api/ctf/*`` cross-origin; ``config/labs_origin.py``).
"""

from __future__ import annotations

from config.audit import log_security_event
from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle
from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import ensure_csrf_cookie
from django.utils.decorators import method_decorator
from rest_framework import permissions, status
from rest_framework.views import APIView

from .access import STARTER_DIFFICULTIES, LabsPassNotConfigured, issue_pass, labs_entitlements, membership_required
from .models import OsintChallenge, OsintChallengeProgress, OsintPath, flag_hash


def directory_items(*, tier=OsintChallenge.TIER_FREE):
    rows = (
        OsintChallenge.objects.filter(is_published=True, access_tier=tier)
        .select_related("path")
        .order_by("path__order", "path_order", "title")
    )
    return [serialize_challenge(row) for row in rows]


def serialize_challenge(row: OsintChallenge) -> dict:
    return {
        "id": row.pk,
        "slug": row.slug,
        "title": row.title,
        "summary": row.summary,
        "platform": row.platform,
        "url": row.url,
        "difficulty": row.difficulty,
        "skills": list(row.skills or []),
        "estimated_minutes": int(row.estimated_minutes),
        "source_is_free": bool(row.source_is_free),
        "hosting": row.hosting,
        "hosted": row.hosting == OsintChallenge.HOSTING_HOSTED,
        "licence": row.licence,
        "licence_url": row.licence_url,
        "attribution": row.attribution,
        "xp": int(row.xp),
        "path": row.path.key if row.path_id else "",
        "path_order": int(row.path_order),
        "cta_label": row.cta_label,
        "has_flag": bool(row.flag_sha256),
    }


def directory_paths(items):
    by_path: dict[str, list[int]] = {}
    for item in items:
        if item["path"]:
            by_path.setdefault(item["path"], []).append(item["id"])
    return [
        {"key": path.key, "title": path.title, "summary": path.summary, "item_ids": by_path.get(path.key, [])}
        for path in OsintPath.objects.filter(is_published=True).order_by("order", "id")
    ]


def progress_for(user) -> dict | None:
    if not user or not user.is_authenticated:
        return None
    rows = OsintChallengeProgress.objects.filter(user=user, challenge__is_published=True)
    done = sorted(rows.values_list("challenge_id", flat=True))
    xp = rows.aggregate(total=Sum("challenge__xp"))["total"] or 0
    return {"done": done, "xp": int(xp)}


class LabsReadThrottle(ClientIpScopedRateThrottle):
    scope = "catalog_read"


class DirectoryView(APIView):
    """``GET /api/labs/directory/``: the free challenge directory (public)."""

    permission_classes = [permissions.AllowAny]
    throttle_classes = [LabsReadThrottle]

    def get(self, request):
        items = directory_items()
        response = api_response(
            success=True,
            message="Free OSINT challenges.",
            data={"items": items, "paths": directory_paths(items), "me": progress_for(request.user)},
        )
        response["Cache-Control"] = "private, no-cache" if request.user.is_authenticated else "public, max-age=60"
        return response


class DirectoryProgressView(APIView):
    """``POST /api/labs/directory/<slug>/progress/`` ``{done, flag?}``: self-reported progress (+ flag for hosted)."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpScopedRateThrottle]
    throttle_scope = "directory_write"

    def post(self, request, slug):
        challenge = get_object_or_404(OsintChallenge, slug=slug, is_published=True, access_tier=OsintChallenge.TIER_FREE)
        done = request.data.get("done", True)
        if isinstance(done, str):
            done = done.strip().lower() in {"1", "true", "yes"}
        if not done:
            OsintChallengeProgress.objects.filter(user=request.user, challenge=challenge).delete()
            return api_response(success=True, message="Marked as not done.", data={"done": False, **(progress_for(request.user) or {})})
        method = OsintChallengeProgress.METHOD_SELF
        if challenge.flag_sha256:
            flag = str(request.data.get("flag") or "")
            if len(flag) > 300 or flag_hash(flag) != challenge.flag_sha256:
                log_security_event("osint_directory.flag_incorrect", request=request, challenge=challenge.pk)
                return api_response(
                    success=False,
                    message="That flag is not correct.",
                    errors={"detail": "That flag is not correct.", "code": "flag_incorrect"},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            method = OsintChallengeProgress.METHOD_FLAG
        try:
            with transaction.atomic():
                OsintChallengeProgress.objects.get_or_create(
                    user=request.user, challenge=challenge, defaults={"method": method}
                )
        except IntegrityError:
            pass
        return api_response(success=True, message="Marked as done.", data={"done": True, **(progress_for(request.user) or {})})


class LabsPolicyView(APIView):
    """``GET /api/labs/policy/``: whether the labs are members-only (public, cached 30 s)."""

    permission_classes = [permissions.AllowAny]
    throttle_classes = [LabsReadThrottle]

    def get(self, request):
        frontend = str(getattr(settings, "FRONTEND_BASE_URL", "") or getattr(settings, "FRONTEND_URL", "") or "").rstrip("/")
        labs = str(getattr(settings, "LABS_PUBLIC_URL", "") or "").rstrip("/")
        response = api_response(
            success=True,
            message="Labs access policy.",
            data={
                "membership_required": membership_required(),
                "starter_difficulties": list(STARTER_DIFFICULTIES),
                "sign_in_url": f"{frontend}/login?next={labs}/" if frontend else "/login",
                "pricing_url": f"{frontend}/pricing" if frontend else "/pricing",
            },
        )
        response["Cache-Control"] = "public, max-age=30"
        return response


class LabsEntitlementView(APIView):
    """``GET /api/labs/entitlement/``: the signed-in viewer's labs access."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        response = api_response(success=True, message="Labs entitlement.", data=labs_entitlements(request.user))
        response["Cache-Control"] = "no-store"
        return response


@method_decorator(ensure_csrf_cookie, name="dispatch")
class LabsPassView(APIView):
    """``POST /api/labs/pass/``: a short-lived signed pass the labs server verifies locally."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpScopedRateThrottle]
    throttle_scope = "labs_pass"

    def post(self, request):
        try:
            data = issue_pass(request.user)
        except LabsPassNotConfigured:
            return api_response(
                success=False,
                message="Labs access is not configured.",
                errors={"detail": "Labs access is not configured.", "code": "labs_pass_unavailable"},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        log_security_event(
            "labs.pass_issued", request=request, difficulties=",".join(data["allowed_difficulties"]) or "none"
        )
        response = api_response(success=True, message="Labs pass issued.", data=data)
        response["Cache-Control"] = "no-store"
        return response
