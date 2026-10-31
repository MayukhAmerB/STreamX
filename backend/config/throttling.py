import hashlib

from rest_framework.throttling import SimpleRateThrottle

from config.client_ip import resolve_client_ip
from config.cookies import REFRESH_COOKIE


class LoginRateThrottle(SimpleRateThrottle):
    scope = "login_burst"

    def get_cache_key(self, request, view):
        if request.method != "POST":
            return None
        email = str(request.data.get("email", "")).strip().lower()
        ident = resolve_client_ip(request)
        if not email:
            email = "no-email"
        return self.cache_format % {"scope": self.scope, "ident": f"{ident}:{email}"}


def _presented_refresh_token(request):
    raw_token = request.COOKIES.get(REFRESH_COOKIE)
    if not raw_token:
        data = request.data if hasattr(request.data, "get") else {}
        raw_token = data.get("refresh")
    return str(raw_token or "").strip()


class RefreshTokenRateThrottle(SimpleRateThrottle):
    """Budget refreshes per refresh token, not per IP.

    Classrooms and carrier-grade NAT put many students behind one address, so
    an IP budget turns a synchronized token expiry into mass logouts. The raw
    token is hashed so the throttle cache never holds a usable credential.
    Requests without a token are answered without touching the database and
    come from every anonymous visitor's bootstrap, so they are not throttled.
    """

    scope = "refresh"

    def get_cache_key(self, request, view):
        if request.method != "POST":
            return None
        raw_token = _presented_refresh_token(request)
        if not raw_token:
            return None
        ident = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class RefreshIpCeilingThrottle(SimpleRateThrottle):
    """Generous per-IP ceiling so forged tokens cannot mint unbounded buckets."""

    scope = "refresh_ip"

    def get_cache_key(self, request, view):
        if request.method != "POST" or not _presented_refresh_token(request):
            return None
        return self.cache_format % {"scope": self.scope, "ident": resolve_client_ip(request)}
