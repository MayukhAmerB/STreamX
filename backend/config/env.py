import os


def env(key, default=None):
    return os.getenv(key, default)


def env_bool(key, default=False):
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_list(key, default=None):
    raw = os.getenv(key)
    if raw is None:
        return default or []
    return [item.strip() for item in raw.split(",") if item.strip()]


def env_int(key, default=0):
    raw = os.getenv(key)
    if raw is None:
        return int(default)
    try:
        return int(raw.strip())
    except (TypeError, ValueError):
        return int(default)
