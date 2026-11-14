"""Attendance/calendar throttles. Rates live here (overridable by settings) so
the app needs no entry in ``REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]``."""

from rest_framework.throttling import AnonRateThrottle, UserRateThrottle

from config.throttling import ClientIpIdentMixin

from .conf import rate


class AttendancePresenceThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "attendance_presence"
    rate = rate("ATTENDANCE_PRESENCE_RATE", "12/minute")


class AttendanceReadThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "attendance_read"
    rate = rate("ATTENDANCE_READ_RATE", "240/minute")


class AttendanceStaffThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "attendance_staff"
    rate = rate("ATTENDANCE_STAFF_RATE", "1200/hour")


class AttendanceWriteThrottle(ClientIpIdentMixin, UserRateThrottle):
    scope = "attendance_write"
    rate = rate("ATTENDANCE_WRITE_RATE", "120/hour")


class CalendarFeedThrottle(ClientIpIdentMixin, AnonRateThrottle):
    """The public .ics feed, per client IP (calendar apps poll it)."""

    scope = "calendar_feed"
    rate = rate("CALENDAR_FEED_RATE", "120/hour")

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class CalendarPublicThrottle(ClientIpIdentMixin, AnonRateThrottle):
    scope = "calendar_public"
    rate = rate("CALENDAR_PUBLIC_RATE", "60/minute")

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
