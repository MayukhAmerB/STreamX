"""Permission classes shared by the Console API views (frozen after WS-0)."""

from rest_framework import permissions


def is_staff_user(user) -> bool:
    """Staff (the Console "Admin" workspace): ``is_staff`` or superuser."""
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


class IsStaffMember(permissions.BasePermission):
    message = "Only admins can open this page."

    def has_permission(self, request, view):
        return is_staff_user(request.user)


def can_change_features(user) -> bool:
    """Superuser or the ``core.change_featureflag`` permission (plan §5.5)."""
    return bool(user and user.is_authenticated and (user.is_superuser or user.has_perm("core.change_featureflag")))
