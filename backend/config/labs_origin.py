"""Scope what the labs site (labs.alsyedinitiative.com) may do on this API.

The labs page calls the LMS API from the browser with the student's own
cookies (same site, so the host-only Lax cookies are sent). It is trusted for
CSRF and allowed by CORS, but ONLY on the CTF exam endpoints plus the CSRF
bootstrap and the token refresh it needs to keep a session alive:

* ``apps.ctf.signals`` enables CORS for a labs origin on these paths only;
* ``LabsOriginScopeMiddleware`` refuses every other unsafe request that
  carries a labs ``Origin``, so a script injected into the labs site could
  not drive any other write on the LMS (payments, profile, enrolments...).

This module stays app-free (settings only) like the rest of ``config``.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from django.conf import settings
from django.http import JsonResponse

from config.audit import log_security_event

LABS_ALLOWED_PATH = re.compile(r"^/api/(?:ctf/|auth/(?:csrf|refresh)/$)")
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _normalise_origin(value) -> str:
    text = str(value or "").strip().rstrip("/").lower()
    if not text:
        return ""
    try:
        parts = urlsplit(text)
    except ValueError:
        return ""
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return ""
    return f"{parts.scheme}://{parts.netloc}"


def labs_origins() -> frozenset:
    return frozenset(
        origin for origin in (_normalise_origin(item) for item in getattr(settings, "CTF_LABS_ORIGINS", [])) if origin
    )


def is_labs_origin(origin) -> bool:
    normalised = _normalise_origin(origin)
    return bool(normalised) and normalised in labs_origins()


def labs_path_allowed(path) -> bool:
    return bool(LABS_ALLOWED_PATH.match(str(path or "")))


class LabsOriginScopeMiddleware:
    """Place right after ``corsheaders.middleware.CorsMiddleware``."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.method not in SAFE_METHODS:
            origin = request.headers.get("Origin")
            if origin and is_labs_origin(origin) and not labs_path_allowed(request.path_info):
                log_security_event("security.labs_origin_forbidden", request=request, origin=origin)
                return JsonResponse(
                    {
                        "success": False,
                        "message": "This action is not available from the labs site.",
                        "data": None,
                        "errors": {
                            "detail": "This action is not available from the labs site.",
                            "code": "labs_origin_forbidden",
                        },
                        "code": "labs_origin_forbidden",
                    },
                    status=403,
                )
        return self.get_response(request)
