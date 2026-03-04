from rest_framework.throttling import SimpleRateThrottle


def _client_ip(request):
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "") or "unknown"


class LoginRateThrottle(SimpleRateThrottle):
    scope = "login_burst"

    def get_cache_key(self, request, view):
        if request.method != "POST":
            return None
        email = str(request.data.get("email", "")).strip().lower()
        ident = _client_ip(request)
        if not email:
            email = "no-email"
        return self.cache_format % {"scope": self.scope, "ident": f"{ident}:{email}"}
