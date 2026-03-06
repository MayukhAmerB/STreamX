from django.conf import settings
from django.http import JsonResponse

from config.audit import log_security_event
from config.request_security import (
    contains_suspicious_sqli,
    contains_suspicious_xss,
    iter_request_strings,
)


class APISecurityHeadersMiddleware:
    """
    Adds strict security headers primarily for API responses without breaking Django admin pages.
    """

    API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    API_CACHE_CONTROL = "no-store"
    PERMISSIONS_POLICY = (
        "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), "
        "clipboard-write=(), geolocation=(), gyroscope=(), magnetometer=(), "
        "microphone=(), payment=(), usb=()"
    )

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)

        permissions_policy = getattr(settings, "SECURE_PERMISSIONS_POLICY", self.PERMISSIONS_POLICY)
        cross_origin_resource_policy = getattr(settings, "SECURE_CROSS_ORIGIN_RESOURCE_POLICY", "same-origin")
        cross_origin_opener_policy = getattr(settings, "SECURE_CROSS_ORIGIN_OPENER_POLICY", "same-origin")
        response.setdefault("Permissions-Policy", permissions_policy)
        response.setdefault("Cross-Origin-Resource-Policy", cross_origin_resource_policy)
        response.setdefault("Cross-Origin-Opener-Policy", cross_origin_opener_policy)
        response.setdefault("X-Permitted-Cross-Domain-Policies", "none")

        path = request.path or ""
        content_type = response.get("Content-Type", "")
        is_api = path.startswith("/api/")
        is_json = "application/json" in content_type

        if is_api or is_json:
            response.setdefault("Content-Security-Policy", getattr(settings, "API_SECURITY_CSP", self.API_CSP))
            response.setdefault("Cache-Control", self.API_CACHE_CONTROL)

        if not settings.DEBUG:
            response.setdefault("Cross-Origin-Embedder-Policy", "require-corp")

        return response


class SuspiciousInputFirewallMiddleware:
    """
    Lightweight request inspection for obvious SQLi/XSS payload signatures on API endpoints.
    This is a supplemental guard, not a substitute for ORM/escaping/CSRF protections.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    @staticmethod
    def _blocked_response():
        return JsonResponse(
            {
                "success": False,
                "message": "Request blocked by security policy.",
                "errors": {"detail": "Suspicious input detected."},
            },
            status=400,
        )

    def __call__(self, request):
        if getattr(settings, "SECURITY_BLOCK_SUSPICIOUS_INPUT", True) and request.path.startswith("/api/"):
            max_body_bytes = getattr(settings, "SECURITY_MAX_INSPECTION_BODY_BYTES", 16384)
            for source, value in iter_request_strings(request, max_body_bytes=max_body_bytes):
                if contains_suspicious_xss(value):
                    log_security_event(
                        "security.firewall_blocked",
                        request=request,
                        threat_type="xss",
                        source=source,
                    )
                    return self._blocked_response()
                if contains_suspicious_sqli(value):
                    log_security_event(
                        "security.firewall_blocked",
                        request=request,
                        threat_type="sqli",
                        source=source,
                    )
                    return self._blocked_response()
        return self.get_response(request)
