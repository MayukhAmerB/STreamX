"""Recordings-only access from OSINT memberships.

* Starter plan (``ctf_starter``): the published recordings of the one batch
  (course) linked to the plan.
* CTF Labs membership (``ctf_labs``): this IST month's published membership
  bundle plus every course marked "always included".

This never creates Enrollments: members get lecture playback only (no live
classes, reports, exams or certificates). ``apps.courses.access.lecture_access_context``
consults it only for signed-in viewers who are not enrolled, so enrolled
students pay nothing extra.
"""

from __future__ import annotations

from django.db.models import Q
from django.utils import timezone

from .models import PlatformGrant, PlatformPlan, PlatformSubscription


def _active_osint_plans(user_id, at):
    subscription_rows = PlatformSubscription.objects.filter(
        user_id=user_id, access_until__gt=at, plan__product__in=PlatformPlan.OSINT_PRODUCTS
    ).values_list("plan__product", "plan__starter_course_id")
    grant_rows = (
        PlatformGrant.objects.filter(user_id=user_id, is_active=True, plan__product__in=PlatformPlan.OSINT_PRODUCTS)
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=at))
        .values_list("plan__product", "plan__starter_course_id")
    )
    return list(subscription_rows) + list(grant_rows)


def recording_course_ids(user, at=None) -> set[int]:
    if not user or not getattr(user, "is_authenticated", False):
        return set()
    at = at or timezone.now()
    rows = _active_osint_plans(user.pk, at)
    ids: set[int] = set()
    has_labs = False
    for product, starter_course_id in rows:
        if product == PlatformPlan.PRODUCT_CTF_STARTER and starter_course_id:
            ids.add(int(starter_course_id))
        elif product == PlatformPlan.PRODUCT_CTF_LABS:
            has_labs = True
    if has_labs:
        from .platform_plans import bundle_course_ids

        ids.update(bundle_course_ids(at))
    return ids


def user_has_recording_access(user, course_id, at=None) -> bool:
    if not course_id:
        return False
    return int(course_id) in recording_course_ids(user, at=at)


def recording_access_source(user, course_id, at=None) -> str | None:
    """"starter" / "membership_bundle" / None, for the course page and the player."""
    if not user or not getattr(user, "is_authenticated", False) or not course_id:
        return None
    at = at or timezone.now()
    rows = _active_osint_plans(user.pk, at)
    if any(p == PlatformPlan.PRODUCT_CTF_STARTER and int(c or 0) == int(course_id) for p, c in rows):
        return "starter"
    if any(p == PlatformPlan.PRODUCT_CTF_LABS for p, _c in rows):
        from .platform_plans import bundle_course_ids

        if int(course_id) in bundle_course_ids(at):
            return "membership_bundle"
    return None
