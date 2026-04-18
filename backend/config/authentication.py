from rest_framework import exceptions
from rest_framework.authentication import CSRFCheck
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken

from apps.users.session_policy import token_matches_active_session
from apps.users.terms import TERMS_VERSION
from config.cookies import ACCESS_COOKIE


TERMS_ACCEPTANCE_EXEMPT_PATHS = {
    "/api/auth/config/",
    "/api/auth/csrf/",
    "/api/auth/google/",
    "/api/auth/login/",
    "/api/auth/logout/",
    "/api/auth/password-reset/",
    "/api/auth/password-reset-confirm/",
    "/api/auth/refresh/",
    "/api/auth/register/",
    "/api/auth/terms/",
    "/api/auth/terms/accept/",
    "/api/auth/user/",
}


class CookieJWTAuthentication(JWTAuthentication):
    def enforce_csrf(self, request):
        check = CSRFCheck(lambda req: None)
        check.process_request(request)
        reason = check.process_view(request, None, (), {})
        if reason:
            raise exceptions.PermissionDenied(f"CSRF Failed: {reason}")

    def authenticate(self, request):
        header = self.get_header(request)
        using_header = header is not None
        if header is not None:
            raw_token = self.get_raw_token(header)
        else:
            raw_token = request.COOKIES.get(ACCESS_COOKIE)
        if raw_token is None:
            return None
        try:
            validated_token = self.get_validated_token(raw_token)
        except InvalidToken:
            return None
        try:
            user = self.get_user(validated_token)
        except InvalidToken:
            return None
        if not token_matches_active_session(validated_token, user):
            return None
        if not using_header:
            self.enforce_csrf(request)
        self.enforce_terms_acceptance(request, user)
        return user, validated_token

    def enforce_terms_acceptance(self, request, user):
        if not user or not getattr(user, "is_authenticated", False):
            return
        if request.method == "OPTIONS":
            return
        path = str(getattr(request, "path", "") or "")
        if path in TERMS_ACCEPTANCE_EXEMPT_PATHS:
            return
        if str(getattr(user, "terms_accepted_version", "") or "") == TERMS_VERSION:
            return
        raise exceptions.PermissionDenied(
            {
                "detail": "You must accept the current Terms and Conditions before continuing.",
                "code": "terms_acceptance_required",
                "terms_version": TERMS_VERSION,
            }
        )
