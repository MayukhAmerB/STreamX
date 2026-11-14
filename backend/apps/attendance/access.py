"""Who may see what.

* students see only their own attendance and the classes of the batches
  (courses / live classes) they can access;
* instructors see the batches they teach (``apps.users.teaching``, so the
  Teachers section switch covers them);
* staff (``is_staff`` / superuser) see everything.
"""

from __future__ import annotations

from apps.core import features
from apps.core.errors import PermissionDenied
from apps.users import teaching

from .conf import FEATURE_KEY

ALL = None  # scope value: every course


def require_enabled() -> None:
    features.require(FEATURE_KEY)


def enabled() -> bool:
    try:
        return features.is_enabled(FEATURE_KEY)
    except Exception:  # noqa: BLE001
        return False


def is_staff(user) -> bool:
    return teaching.is_staff(user)


def staff_scope(user):
    """``ALL`` for staff, the taught course ids for instructors, else 403."""
    if is_staff(user):
        return ALL
    teaching.require_teaching(user)  # 403 feature_disabled while Teaching is off
    if teaching.teaching_allowed(user):
        return set(teaching.taught_course_ids(user))
    raise PermissionDenied("Only staff and instructors can open this.", code="attendance_staff_only")


def in_scope(scope, course_id) -> bool:
    return scope is ALL or (course_id is not None and int(course_id) in scope)


def require_course_in_scope(scope, course_id) -> None:
    if not in_scope(scope, course_id):
        raise PermissionDenied("You do not teach this batch.", code="attendance_out_of_scope")


def student_course_ids(user) -> set[int]:
    from apps.courses.access import accessible_course_ids_for_user

    return {int(pk) for pk in accessible_course_ids_for_user(user)}


def student_live_class_ids(user) -> set[int]:
    from apps.courses.access import accessible_live_class_ids_for_user

    return {int(pk) for pk in accessible_live_class_ids_for_user(user)}


def roster_user_ids(*, course_id=None, live_class_id=None, enrolled_before=None, exclude_ids=()) -> list[int]:
    """Students expected at a class of this batch: active course enrolments plus
    approved live-class enrolments, active non-staff accounts only."""
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment, LiveClassEnrollment

    user_ids: set[int] = set()
    if course_id:
        enrolments = Enrollment.objects.filter(
            course_id=course_id, user__is_active=True, user__is_staff=False, user__is_superuser=False
        ).filter(active_enrollment_q())
        if enrolled_before is not None:
            enrolments = enrolments.filter(enrolled_at__lte=enrolled_before)
        user_ids.update(enrolments.values_list("user_id", flat=True))
    if live_class_id:
        approved = LiveClassEnrollment.objects.filter(
            live_class_id=live_class_id,
            status=LiveClassEnrollment.STATUS_APPROVED,
            user__is_active=True,
            user__is_staff=False,
            user__is_superuser=False,
        )
        if enrolled_before is not None:
            approved = approved.filter(created_at__lte=enrolled_before)
        user_ids.update(approved.values_list("user_id", flat=True))
    excluded = {int(pk) for pk in exclude_ids if pk}
    return sorted(pk for pk in user_ids if pk not in excluded)


def session_course_id(session):
    if session.linked_course_id:
        return session.linked_course_id
    live_class = session._state.fields_cache.get("linked_live_class") if session.linked_live_class_id else None
    if live_class is not None:
        return live_class.linked_course_id
    if session.linked_live_class_id:
        from apps.courses.models import LiveClass

        return LiveClass.objects.filter(pk=session.linked_live_class_id).values_list("linked_course_id", flat=True).first()
    return None


def session_managers(session, course=None) -> set[int]:
    """Host and the course instructor: never on the student roster."""
    ids = {session.host_id}
    instructor_id = getattr(course, "instructor_id", None) if course is not None else None
    if instructor_id:
        ids.add(instructor_id)
    return {pk for pk in ids if pk}
