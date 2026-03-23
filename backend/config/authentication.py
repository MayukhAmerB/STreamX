from rest_framework import exceptions
from rest_framework.authentication import CSRFCheck
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken

from apps.users.session_policy import token_matches_active_session
from config.cookies import ACCESS_COOKIE


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
        return user, validated_token
