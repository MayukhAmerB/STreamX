from django.conf import settings
from django.core.cache import cache

from config.client_ip import resolve_client_ip


def _normalize_email(email):
    return str(email or "").strip().lower()


def _key_email(email):
    return f"auth:login:fail:email:{_normalize_email(email) or 'unknown'}"


def _key_ip(ip):
    return f"auth:login:fail:ip:{ip or 'unknown'}"


def get_lockout_state(email, request):
    max_failures = int(getattr(settings, "AUTH_LOGIN_MAX_FAILURES", 3))
    email_count = int(cache.get(_key_email(email), 0) or 0)
    ip_count = int(cache.get(_key_ip(resolve_client_ip(request)), 0) or 0)
    attempts = max(email_count, ip_count)
    return attempts >= max_failures, attempts, max_failures


def register_failed_login(email, request):
    ttl_seconds = int(getattr(settings, "AUTH_LOGIN_LOCKOUT_SECONDS", 3600))
    email_key = _key_email(email)
    ip_key = _key_ip(resolve_client_ip(request))
    email_count = int(cache.get(email_key, 0) or 0) + 1
    ip_count = int(cache.get(ip_key, 0) or 0) + 1
    cache.set(email_key, email_count, timeout=ttl_seconds)
    cache.set(ip_key, ip_count, timeout=ttl_seconds)
    return max(email_count, ip_count)


def clear_failed_login(email, request):
    cache.delete_many([_key_email(email), _key_ip(resolve_client_ip(request))])
