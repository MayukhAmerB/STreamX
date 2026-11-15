import re
from dataclasses import dataclass

from django.conf import settings
from django.http import JsonResponse
from django.urls import Resolver404, resolve

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


@dataclass(frozen=True)
class FirewallExemption:
    """Free-text fields where SQL- or HTML-looking text is legitimate content.

    A value skips the SQLi/XSS pattern block only when ALL of these match: the
    resolved URL name, the exact path shape, the HTTP method, the field's
    source (``json:<field>`` / ``form:<field>`` as produced by
    ``iter_request_strings``) and the value is within ``max_length``. These
    fields are stored as plain data (ORM parameters) and rendered as text:
    report briefs/criteria/feedback/notes through the safe Markdown renderer
    (features/reports/markdown.jsx, no HTML injection) and lecture comments as
    plain text after server-side tag stripping (engagement/text.py).
    """

    url_name: str
    path: re.Pattern
    methods: frozenset
    fields: tuple  # (compiled source pattern, max_length)

    def allows(self, url_name, path, method, source, value):
        if url_name != self.url_name or method not in self.methods or not self.path.fullmatch(path):
            return False
        return any(pattern.fullmatch(source) and len(value) <= limit for pattern, limit in self.fields)


def _fields(*items):
    return tuple((re.compile(rf"(?:json|form):{pattern}"), limit) for pattern, limit in items)


REPORT_TASK_TEXT_FIELDS = _fields(
    ("title", 200),
    ("brief", 20000),
    (r"criteria\[\d{1,2}\]:name", 120),
    (r"criteria\[\d{1,2}\]:description", 2000),
)

# The ONLY places where the input firewall lets SQL/XSS-looking text through.
FIREWALL_EXEMPTIONS = (
    # Weekly report task: create (POST) and edit (PATCH) -- title, brief, rubric text.
    FirewallExemption(
        "reports-manage-tasks", re.compile(r"/api/reports/manage/tasks/"), frozenset({"POST"}), REPORT_TASK_TEXT_FIELDS
    ),
    FirewallExemption(
        "reports-manage-task-detail",
        re.compile(r"/api/reports/manage/tasks/\d+/"),
        frozenset({"PATCH"}),
        REPORT_TASK_TEXT_FIELDS,
    ),
    # Grading: feedback (stored as feedback, or revision_feedback on "return").
    FirewallExemption(
        "reports-manage-submission-grade",
        re.compile(r"/api/reports/manage/submissions/\d+/grade/"),
        frozenset({"POST"}),
        _fields(("feedback", 10000)),
    ),
    # Student submission note.
    FirewallExemption(
        "reports-task-submit",
        re.compile(r"/api/reports/tasks/\d+/submit/"),
        frozenset({"POST"}),
        _fields(("note", 2000)),
    ),
    # Lecture comments: create and edit.
    FirewallExemption(
        "lecture-comments", re.compile(r"/api/lectures/\d+/comments/"), frozenset({"POST"}), _fields(("body", 2000))
    ),
    FirewallExemption(
        "lecture-comment-detail",
        re.compile(r"/api/lecture-comments/\d+/"),
        frozenset({"PATCH"}),
        _fields(("body", 2000)),
    ),
    # OSINT CTF exam answers: URLs, handles, dork strings and SQL-looking text
    # are legitimate answers and every attempt must be recorded. Stored through
    # the ORM, compared as an HMAC, shown in the admin as escaped text.
    FirewallExemption(
        "ctf-question-attempts",
        re.compile(r"/api/ctf/exams/[-\w]+/questions/[-\w]+/attempts/"),
        frozenset({"POST"}),
        _fields(("answer", 512)),
    ),
)


class SuspiciousInputFirewallMiddleware:
    """
    Lightweight request inspection for obvious SQLi/XSS payload signatures on API endpoints.
    This is a supplemental guard, not a substitute for ORM/escaping/CSRF protections.
    Only the fields listed in ``FIREWALL_EXEMPTIONS`` may carry such text.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    @staticmethod
    def _url_name(request):
        try:
            return resolve(request.path_info).url_name or ""
        except Resolver404:
            return ""

    @classmethod
    def _is_exempt(cls, request, source, value, cache):
        if "url_name" not in cache:
            cache["url_name"] = cls._url_name(request)
        url_name = cache["url_name"]
        if not url_name:
            return False
        return any(
            exemption.allows(url_name, request.path, request.method, source, value)
            for exemption in FIREWALL_EXEMPTIONS
        )

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
            route_cache = {}
            for source, value in iter_request_strings(request, max_body_bytes=max_body_bytes):
                suspicious = contains_suspicious_xss(value) or contains_suspicious_sqli(value)
                if suspicious and self._is_exempt(request, source, value, route_cache):
                    continue
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
