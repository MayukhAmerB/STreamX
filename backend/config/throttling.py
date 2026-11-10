import hashlib

from rest_framework.throttling import (
    AnonRateThrottle,
    ScopedRateThrottle,
    SimpleRateThrottle,
    UserRateThrottle,
)

from config.client_ip import resolve_client_ip
from config.cookies import REFRESH_COOKIE


class ClientIpIdentMixin:
    """Identify anonymous clients by the proxy-verified address.

    DRF's default get_ident() returns the raw X-Forwarded-For string when
    NUM_PROXIES is unset, so a client could rotate that header to get a fresh
    bucket on every request. Every throttle in this project must use this
    mixin (or one of the classes below) so throttling follows
    resolve_client_ip(), which only trusts entries our own proxies appended.
    """

    def get_ident(self, request):
        return resolve_client_ip(request)


class ClientIpAnonRateThrottle(ClientIpIdentMixin, AnonRateThrottle):
    pass


class ClientIpUserRateThrottle(ClientIpIdentMixin, UserRateThrottle):
    pass


class ClientIpScopedRateThrottle(ClientIpIdentMixin, ScopedRateThrottle):
    pass


class LoginRateThrottle(ClientIpIdentMixin, SimpleRateThrottle):
    scope = "login_burst"

    def get_cache_key(self, request, view):
        if request.method != "POST":
            return None
        email = str(request.data.get("email", "")).strip().lower()
        ident = self.get_ident(request)
        if not email:
            email = "no-email"
        return self.cache_format % {"scope": self.scope, "ident": f"{ident}:{email}"}


def _presented_refresh_token(request):
    raw_token = request.COOKIES.get(REFRESH_COOKIE)
    if not raw_token:
        data = request.data if hasattr(request.data, "get") else {}
        raw_token = data.get("refresh")
    return str(raw_token or "").strip()


class RefreshTokenRateThrottle(ClientIpIdentMixin, SimpleRateThrottle):
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


class RefreshIpCeilingThrottle(ClientIpIdentMixin, SimpleRateThrottle):
    """Generous per-IP ceiling so forged tokens cannot mint unbounded buckets."""

    scope = "refresh_ip"

    def get_cache_key(self, request, view):
        if request.method != "POST" or not _presented_refresh_token(request):
            return None
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
