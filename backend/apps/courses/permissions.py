from rest_framework.permissions import SAFE_METHODS, BasePermission

from .access import user_has_course_access


class IsInstructor(BasePermission):
    message = "Instructor role required."

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.role == "instructor")


class PublicReadInstructorWrite(BasePermission):
    """Allow catalog reads publicly while protecting every mutation."""

    message = "Instructor role required."

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.role == "instructor"
        )


class IsCourseInstructor(BasePermission):
    message = "You can only manage your own course."

    def has_object_permission(self, request, view, obj):
        course = getattr(obj, "course", None)
        if course is not None:
            return course.instructor_id == request.user.id
        return obj.instructor_id == request.user.id


class IsEnrolledInCourse(BasePermission):
    message = "Enrollment required to access this lecture."

    def has_object_permission(self, request, view, obj):
        if not request.user or not request.user.is_authenticated:
            return False
        course = obj.section.course
        if obj.is_preview:
            return True
        return user_has_course_access(request.user, course.id)
