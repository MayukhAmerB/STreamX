from django.conf import settings


SESSION_VERSION_CLAIM = "session_version"


def _normalized_email(value):
    return str(value or "").strip().lower()


def allows_concurrent_sessions(user):
    if not user:
        return False
    if getattr(user, "is_superuser", False) or getattr(user, "is_staff", False):
        return True

    allowed_emails = {
        _normalized_email(email)
        for email in getattr(settings, "AUTH_CONCURRENT_SESSION_EMAILS", [])
    }
    return bool(_normalized_email(getattr(user, "email", "")) in allowed_emails)


def should_enforce_single_session(user):
    return bool(user and not allows_concurrent_sessions(user))


def get_active_session_version(user):
    try:
        return max(0, int(getattr(user, "active_session_version", 0) or 0))
    except (TypeError, ValueError):
        return 0


def token_matches_active_session(token, user):
    if not user:
        return False
    if not should_enforce_single_session(user):
        return True

    active_version = get_active_session_version(user)
    try:
        token_version = token.get(SESSION_VERSION_CLAIM)
    except AttributeError:
        token_version = None

    if active_version <= 0:
        if token_version in (None, "", 0, "0"):
            return True
        try:
            return int(token_version) == 0
        except (TypeError, ValueError):
            return False

    try:
        return int(token_version) == active_version
    except (TypeError, ValueError):
        return False
