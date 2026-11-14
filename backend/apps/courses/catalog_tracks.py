"""Server-owned track (category) availability for the public catalog.

The landing page and the course list must never infer whether a track is
open from counts or titles (plan §7.2 rule 1). This module answers it once:

* ``course_count``: published courses of the track in the current catalog
  (coming soon, or live with registration open), the number the track tile
  shows;
* ``open_course_count``: of those, the courses a visitor can actually buy now
  (published, live, registration open, at least one payment plan switched on
  with a price);
* ``state``: ``"open"`` when ``open_course_count > 0``, else ``"coming_soon"``.
  Pentesting is always ``"coming_soon"`` (and has no open courses) while the
  ``pentesting`` feature switch is off (``apps.courses.features``).

The global ``DIRECT_COURSE_PAYMENTS_ENABLED`` switch is deliberately ignored:
it is an operational kill switch for checkout, not a catalog state, and
turning it off must not relabel every track "Coming soon".

One query (only the fields the rules need), cached per course-list cache
version, so it is shared by every visitor and invalidated by the same course
saves that invalidate the list.
"""

from django.conf import settings
from django.core.cache import cache

from apps.payments.plans import CATALOG as PLAN_CATALOG
from apps.payments.plans import enabled_plan_ids

from .cache_utils import get_course_list_cache_version
from .models import Course

TRACK_STATE_OPEN = "open"
TRACK_STATE_COMING_SOON = "coming_soon"

# Public order and titles (match the landing track tiles).
TRACKS = (
    (Course.CATEGORY_OSINT, "Open Source Intelligence"),
    (Course.CATEGORY_WEB_PENTESTING, "Pentesting"),
)

_PLAN_FIELDS = tuple(sorted({field for spec in PLAN_CATALOG for field in (spec.enabled_field, spec.price_field)}))
_FIELDS = ("id", "category", "launch_status", "registration_closed", "is_published", *_PLAN_FIELDS)


def _in_current_catalog(course):
    if course.launch_status == Course.STATUS_COMING_SOON:
        return True
    return course.launch_status == Course.STATUS_LIVE and not course.registration_closed


def _is_purchasable(course):
    return (
        course.is_published
        and course.launch_status == Course.STATUS_LIVE
        and not course.registration_closed
        and bool(enabled_plan_ids(course))
    )


def compute_catalog_tracks():
    """The ``tracks`` block, computed from the database (one query)."""
    from .features import course_acquisition_blocked

    counts = {key: {"course_count": 0, "open_course_count": 0} for key, _title in TRACKS}
    for course in Course.objects.filter(is_published=True).only(*_FIELDS).iterator():
        bucket = counts.get(course.category)
        if bucket is None or not _in_current_catalog(course):
            continue
        bucket["course_count"] += 1
        if _is_purchasable(course) and not course_acquisition_blocked(course):
            bucket["open_course_count"] += 1
    return [
        {
            "key": key,
            "title": title,
            "state": TRACK_STATE_OPEN if counts[key]["open_course_count"] > 0 else TRACK_STATE_COMING_SOON,
            "course_count": counts[key]["course_count"],
            "open_course_count": counts[key]["open_course_count"],
        }
        for key, title in TRACKS
    ]


def get_catalog_tracks():
    """Cached ``tracks`` block; shared by all users (it holds no user data)."""
    from apps.core import features

    cache_key = f"course-tracks:v={get_course_list_cache_version()}:f={features.fingerprint()}"
    tracks = cache.get(cache_key)
    if tracks is None:
        tracks = compute_catalog_tracks()
        cache.set(cache_key, tracks, timeout=getattr(settings, "COURSE_LIST_CACHE_TTL_SECONDS", 60))
    return tracks
