SESSION_VERSION_CLAIM = "session_version"


def allows_concurrent_sessions(user):
    return bool(user and (getattr(user, "is_staff", False) or getattr(user, "is_superuser", False)))


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
