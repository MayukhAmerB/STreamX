from rest_framework.throttling import SimpleRateThrottle

from config.client_ip import resolve_client_ip


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
