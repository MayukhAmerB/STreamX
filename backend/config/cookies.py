from django.conf import settings


ACCESS_COOKIE = "access_token"
REFRESH_COOKIE = "refresh_token"


def set_auth_cookies(response, access_token, refresh_token):
    cookie_params = {
        "httponly": True,
        "secure": settings.JWT_COOKIE_SECURE,
        "samesite": settings.JWT_COOKIE_SAMESITE,
        "path": "/",
    }
    response.set_cookie(ACCESS_COOKIE, access_token, max_age=settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"].total_seconds(), **cookie_params)
    response.set_cookie(REFRESH_COOKIE, refresh_token, max_age=settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds(), **cookie_params)


def clear_auth_cookies(response):
    response.delete_cookie(ACCESS_COOKIE, path="/")
    response.delete_cookie(REFRESH_COOKIE, path="/")
