from urllib.parse import urlparse

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa

DEBUG = False
APP_ENV = "production"

SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", True)
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
JWT_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = max(SECURE_HSTS_SECONDS, env_int("SECURE_HSTS_SECONDS_FLOOR", 31536000))
SECURE_HSTS_INCLUDE_SUBDOMAINS = env_bool("SECURE_HSTS_INCLUDE_SUBDOMAINS", True)
SECURE_HSTS_PRELOAD = env_bool("SECURE_HSTS_PRELOAD", True)
USE_X_FORWARDED_HOST = env_bool("USE_X_FORWARDED_HOST", True)
USE_X_FORWARDED_PORT = env_bool("USE_X_FORWARDED_PORT", True)
TRUST_X_FORWARDED_FOR = env_bool("TRUST_X_FORWARDED_FOR", True)

ENFORCE_PRODUCTION_REQUIREMENTS = env_bool("ENFORCE_PRODUCTION_REQUIREMENTS", True)
ALLOW_SQLITE_IN_PRODUCTION = env_bool("ALLOW_SQLITE_IN_PRODUCTION", False)
ALLOW_INSECURE_HTTP_ORIGINS = env_bool("ALLOW_INSECURE_HTTP_ORIGINS", False)


def _is_placeholder_secret(value):
    return str(value or "").strip() in {"", "change-me", "dev-only-secret-key"}


def _is_secure_origin(value):
    parsed = urlparse(str(value or "").strip())
    return parsed.scheme == "https"


if ENFORCE_PRODUCTION_REQUIREMENTS:
    errors = []

    if _is_placeholder_secret(SECRET_KEY):
        errors.append("DJANGO_SECRET_KEY must be set to a strong, non-placeholder value.")
    if not ALLOWED_HOSTS:
        errors.append("ALLOWED_HOSTS must include your production hostnames.")
    if not CORS_ALLOWED_ORIGINS:
        errors.append("CORS_ALLOWED_ORIGINS must include your frontend origin(s).")
    if not CSRF_TRUSTED_ORIGINS:
        errors.append("CSRF_TRUSTED_ORIGINS must include your frontend origin(s).")

    is_sqlite_database = DATABASE_URL.startswith("sqlite:///")
    if is_sqlite_database and not ALLOW_SQLITE_IN_PRODUCTION:
        errors.append("Production should use PostgreSQL. Set DATABASE_URL to postgres://... .")

    insecure_http_origins = [
        origin
        for origin in [*CORS_ALLOWED_ORIGINS, *CSRF_TRUSTED_ORIGINS]
        if not _is_secure_origin(origin)
    ]
    if insecure_http_origins and not ALLOW_INSECURE_HTTP_ORIGINS:
        errors.append(
            "All CORS/CSRF origins must use HTTPS in production. "
            f"Found insecure origins: {', '.join(sorted(set(insecure_http_origins)))}"
        )

    if FRONTEND_PUBLIC_ORIGIN and not _is_secure_origin(FRONTEND_PUBLIC_ORIGIN) and not ALLOW_INSECURE_HTTP_ORIGINS:
        errors.append("FRONTEND_PUBLIC_ORIGIN must use HTTPS in production.")

    if LIVEKIT_PUBLIC_URL and LIVEKIT_PUBLIC_URL.startswith("ws://"):
        errors.append("LIVEKIT_PUBLIC_URL should use WSS in production.")

    if not SECURE_SSL_REDIRECT:
        errors.append("SECURE_SSL_REDIRECT must be enabled in production.")
    if not SESSION_COOKIE_SECURE or not CSRF_COOKIE_SECURE or not JWT_COOKIE_SECURE:
        errors.append("All auth/session cookies must be marked secure in production.")
    if SECURE_HSTS_SECONDS < 31536000:
        errors.append("SECURE_HSTS_SECONDS must be at least 31536000 in production.")

    if errors:
        raise ImproperlyConfigured("Production configuration is not secure:\n- " + "\n- ".join(errors))
