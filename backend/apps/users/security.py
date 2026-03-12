from django.conf import settings
from django.core.cache import cache

from config.client_ip import resolve_client_ip


def _normalize_email(email):
    return str(email or "").strip().lower()


def _normalize_client_ip(request):
    if not request:
        return "unknown"
    return str(resolve_client_ip(request) or "unknown").strip() or "unknown"


def _key_email(email, request):
    # Scope lockout by email + client identity so one attacker cannot globally
    # lock the same account for every network/device.
    return (
        f"auth:login:fail:email:{_normalize_email(email) or 'unknown'}:"
        f"ip:{_normalize_client_ip(request)}"
    )


def get_lockout_state(email, request):
    max_failures = int(getattr(settings, "AUTH_LOGIN_MAX_FAILURES", 10))
    email_count = int(cache.get(_key_email(email, request), 0) or 0)
    attempts = email_count
    return attempts >= max_failures, attempts, max_failures


def register_failed_login(email, request):
    ttl_seconds = int(getattr(settings, "AUTH_LOGIN_LOCKOUT_SECONDS", 3600))
    email_key = _key_email(email, request)
    email_count = int(cache.get(email_key, 0) or 0) + 1
    cache.set(email_key, email_count, timeout=ttl_seconds)
    return email_count


def clear_failed_login(email, request):
    cache.delete(_key_email(email, request))
