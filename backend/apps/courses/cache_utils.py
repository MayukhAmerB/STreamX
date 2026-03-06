from django.core.cache import cache


COURSE_LIST_CACHE_VERSION_KEY = "course-list-cache-version"
LIVE_CLASS_LIST_CACHE_VERSION_KEY = "live-class-list-cache-version"


def _get_cache_version(cache_key: str) -> int:
    value = cache.get(cache_key)
    if isinstance(value, int) and value > 0:
        return value
    cache.set(cache_key, 1, timeout=None)
    return 1


def _bump_cache_version(cache_key: str) -> int:
    try:
        return int(cache.incr(cache_key))
    except ValueError:
        # Key missing or non-integer in backend cache.
        cache.set(cache_key, 2, timeout=None)
        return 2


def get_course_list_cache_version() -> int:
    return _get_cache_version(COURSE_LIST_CACHE_VERSION_KEY)


def bump_course_list_cache_version() -> int:
    return _bump_cache_version(COURSE_LIST_CACHE_VERSION_KEY)


def get_live_class_list_cache_version() -> int:
    return _get_cache_version(LIVE_CLASS_LIST_CACHE_VERSION_KEY)


def bump_live_class_list_cache_version() -> int:
    return _bump_cache_version(LIVE_CLASS_LIST_CACHE_VERSION_KEY)
