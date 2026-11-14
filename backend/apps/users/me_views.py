"""``/api/me/`` views. OWNER: WS-F (created by WS-0)."""

from __future__ import annotations

from config.response import api_response
from django.http import HttpResponseNotModified
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions
from rest_framework.views import APIView

from .capabilities import build_capabilities, capabilities_etag


def _etag_matches(header: str, etag: str) -> bool:
    candidates = [part.strip() for part in str(header or "").split(",") if part.strip()]
    weak = etag[2:] if etag.startswith("W/") else etag
    return any(candidate == "*" or candidate.removeprefix("W/") == weak for candidate in candidates)


class CapabilitiesView(APIView):
    """``GET /api/me/capabilities/`` (Appendix A.1) with ``ETag`` / ``If-None-Match`` -> 304.

    The same payload is embedded as ``capabilities`` in ``GET /api/auth/user/``
    so the Console needs no extra request at boot; this endpoint is what it
    polls (window focus, every 5 min, and after any ``feature_disabled``).
    """

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "console_read"

    @extend_schema(operation_id="me_capabilities_retrieve", responses={200: OpenApiTypes.OBJECT})
    def get(self, request):
        payload = build_capabilities(request.user)
        etag = capabilities_etag(payload)
        if _etag_matches(request.headers.get("If-None-Match", ""), etag):
            response = HttpResponseNotModified()
        else:
            response = api_response(data=payload)
        response["ETag"] = etag
        response["Cache-Control"] = "private, no-cache"
        response["Vary"] = "Cookie, Authorization"
        return response
