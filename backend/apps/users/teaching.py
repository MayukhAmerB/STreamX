"""The one place that decides whether an account may teach (UI overhaul plan §5.3).

The ``teaching`` feature switch ("Teachers section", ``apps.core.features``)
covers **non-staff instructor accounts** (owner decision D1). Every grant of
instructor rights goes through these predicates so the switch is enforced by
the server, not only hidden in the UI (``tests/test_architecture.py`` fails on
a new ``role == "instructor"`` / ``instructor_id=user`` grant elsewhere):

* ``has_instructor_role(user)``  the account's role is instructor (no switch);
* ``acts_as_instructor(user)``   a non-staff instructor account (what the switch covers);
* ``teaching_allowed(user)``     may use instructor-role tools now (staff bypass the switch);
* ``teaching_blocked(user)``     a signed-in non-staff account while the switch is off: grants
                                 based on *owning* a course (``course.instructor_id == user.id``)
                                 must not apply;
* ``require_teaching(user)``     raises ``FeatureDisabled`` (403 ``feature_disabled``) for a
                                 non-staff instructor while the switch is off.

Staff (``is_staff`` or superuser) are never affected. Students are unaffected
because they hold no instructor grant to begin with. A class already on air
is never cut off: ``RealtimeSession`` keeps its instructor-owner controls while
``status == live`` (see ``apps/realtime/models.py``).
"""

from __future__ import annotations

from apps.core import features

FEATURE_KEY = "teaching"
ROLE = "instructor"


def _authenticated(user) -> bool:
    return bool(user is not None and getattr(user, "is_authenticated", False))


def is_staff(user) -> bool:
    return _authenticated(user) and bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def has_instructor_role(user) -> bool:
    return _authenticated(user) and str(getattr(user, "role", "") or "").strip().lower() == ROLE


def acts_as_instructor(user) -> bool:
    """A non-staff instructor account: the accounts the switch covers."""
    return has_instructor_role(user) and not is_staff(user)


def teaching_enabled() -> bool:
    return features.is_enabled(FEATURE_KEY)


def teaching_blocked(user) -> bool:
    """True for a signed-in non-staff account while Teaching is off."""
    return _authenticated(user) and not is_staff(user) and not teaching_enabled()


def teaching_allowed(user) -> bool:
    """An instructor account that may use its teaching tools right now."""
    return has_instructor_role(user) and (is_staff(user) or teaching_enabled())


def owns_course(user, course_or_instructor_id) -> bool:
    """``user`` is the course's instructor and teaching is not switched off for them.

    Accepts a course (anything with ``instructor_id``) or the instructor id itself.
    """
    if not _authenticated(user):
        return False
    instructor_id = getattr(course_or_instructor_id, "instructor_id", course_or_instructor_id)
    if not instructor_id or instructor_id != getattr(user, "id", None):
        return False
    return not teaching_blocked(user)


def _course_model():
    from django.apps import apps as django_apps

    return django_apps.get_model("courses", "Course")


def taught_courses(user):
    """``Course`` queryset ``user`` teaches; empty while Teaching is off for them."""
    course_model = _course_model()
    if not _authenticated(user) or teaching_blocked(user):
        return course_model.objects.none()
    return course_model.objects.filter(instructor_id=user.pk)


def taught_course_ids(user) -> list[int]:
    return list(taught_courses(user).values_list("pk", flat=True))


def disabled_error():
    """The 403 ``feature_disabled`` error with the current user-facing reason."""
    return features.disabled_error(FEATURE_KEY)


def require_teaching(user) -> None:
    """Raise ``FeatureDisabled`` when a non-staff instructor tries to teach while off."""
    if acts_as_instructor(user) and not teaching_enabled():
        raise disabled_error()


def reason() -> str:
    return features.reason_for(FEATURE_KEY)
