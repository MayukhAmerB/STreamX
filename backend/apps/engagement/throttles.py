"""Engagement throttles. Rates live here (overridable by settings) so the app
needs no entry in ``REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]``."""

from django.conf import settings
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle

from config.throttling import ClientIpIdentMixin


def _rate(name: str, default: str) -> str:
    return str(getattr(settings, name, "") or default)


class EngagementReadThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "engagement_read"
    rate = _rate("ENGAGEMENT_READ_RATE", "240/minute")


class EngagementWriteThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "engagement_write"
    rate = _rate("ENGAGEMENT_WRITE_RATE", "30/minute")


class EngagementPresenceThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "engagement_presence"
    rate = _rate("ENGAGEMENT_PRESENCE_RATE", "12/minute")


class EngagementPublicThrottle(ClientIpIdentMixin, AnonRateThrottle):
    """Public verification pages and images, per client IP (signed-in or not)."""

    scope = "engagement_public"
    rate = _rate("ENGAGEMENT_PUBLIC_RATE", "60/minute")

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class EngagementStaffThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "engagement_staff"
    rate = _rate("ENGAGEMENT_STAFF_RATE", "600/hour")


class CertificateLookupThrottle(ClientIpIdentMixin, AnonRateThrottle):
    """Public certificate lookups by reference number, per client IP (signed-in or not).

    References are sequential, so this is the brake on enumeration; the files
    (PDF, image, preview card) use ``EngagementPublicThrottle``.
    """

    scope = "engagement_certificate_lookup"
    rate = _rate("ENGAGEMENT_CERTIFICATE_LOOKUP_RATE", "30/minute")

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
