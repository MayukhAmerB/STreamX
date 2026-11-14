from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.users import teaching

from .access import user_has_course_access


def _instructor_or_feature_disabled(user):
    """Instructor role required; while Teaching is off a non-staff instructor
    gets 403 ``feature_disabled`` with the calm reason (plan §5.3)."""
    if not teaching.has_instructor_role(user):
        return False
    teaching.require_teaching(user)
    return True


class IsInstructor(BasePermission):
    message = "Instructor role required."

    def has_permission(self, request, view):
        return _instructor_or_feature_disabled(request.user)


class PublicReadInstructorWrite(BasePermission):
    """Allow catalog reads publicly while protecting every mutation."""

    message = "Instructor role required."

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        return _instructor_or_feature_disabled(request.user)


class IsCourseInstructor(BasePermission):
    message = "You can only manage your own course."

    def has_object_permission(self, request, view, obj):
        course = getattr(obj, "course", None)
        return teaching.owns_course(request.user, course if course is not None else obj)


class IsEnrolledInCourse(BasePermission):
    message = "Enrollment required to access this lecture."

    def has_object_permission(self, request, view, obj):
        if not request.user or not request.user.is_authenticated:
            return False
        course = obj.section.course
        if obj.is_preview:
            return True
        return user_has_course_access(request.user, course.id)
