"""Profile throttles. Rates live here (overridable by settings) so the app
needs no entry in ``REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]``."""

from django.conf import settings
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle

from config.throttling import ClientIpIdentMixin


def _rate(name: str, default: str) -> str:
    return str(getattr(settings, name, "") or default)


class ProfileReadThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "profiles_read"
    rate = _rate("PROFILES_READ_RATE", "240/minute")


class ProfileWriteThrottle(ClientIpIdentMixin, UserRateThrottle):
    """Draft saves, settings and handle changes."""

    scope = "profiles_write"
    rate = _rate("PROFILES_WRITE_RATE", "60/minute")


class ProfilePublishThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "profiles_publish"
    rate = _rate("PROFILES_PUBLISH_RATE", "30/hour")


class ProfileUploadThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "profiles_upload"
    rate = _rate("PROFILES_UPLOAD_RATE", "40/hour")


class ProfileReportThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "profiles_report"
    rate = _rate("PROFILES_REPORT_RATE", "10/hour")


class ProfilePublicThrottle(ClientIpIdentMixin, AnonRateThrottle):
    """Public profile pages and images, per client IP (signed-in or not)."""

    scope = "profiles_public"
    rate = _rate("PROFILES_PUBLIC_RATE", "120/minute")

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class ProfileStaffThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "profiles_staff"
    rate = _rate("PROFILES_STAFF_RATE", "600/hour")
