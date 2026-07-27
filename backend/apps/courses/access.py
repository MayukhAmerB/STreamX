from django.db.models import Q
from django.utils import timezone

from .models import Enrollment, LiveClass, LiveClassEnrollment


def _authenticated_user_id(user):
    if not user or not getattr(user, "is_authenticated", False):
        return None
    return getattr(user, "id", None)


def active_enrollment_q(prefix="", at=None):
    at = at or timezone.now()
    field = lambda name: f"{prefix}{name}"
    return Q(**{field("payment_status"): Enrollment.STATUS_PAID}) & (
        Q(**{field("access_type__in"): [Enrollment.ACCESS_LEGACY, Enrollment.ACCESS_LIFETIME]})
        | Q(
            **{
                field("access_type"): Enrollment.ACCESS_INSTALLMENT,
                field("access_expires_at__gt"): at,
            }
        )
    )


def enrollment_has_active_access(enrollment, at=None):
    return bool(enrollment and enrollment.has_active_access(at=at))


def accessible_course_ids_for_user(user):
    user_id = _authenticated_user_id(user)
    if not user_id:
        return Enrollment.objects.none().values_list("course_id", flat=True)
    return Enrollment.objects.filter(user_id=user_id).filter(active_enrollment_q()).values_list(
        "course_id", flat=True
    )


def accessible_live_class_ids_for_user(user):
    user_id = _authenticated_user_id(user)
    if not user_id:
        return LiveClass.objects.none().values_list("id", flat=True)
    return (
        LiveClass.objects.filter(is_active=True)
        .filter(
            (
                Q(
                    linked_course__enrollments__user_id=user_id,
                )
                & active_enrollment_q("linked_course__enrollments__")
            )
            | Q(
                enrollments__user_id=user_id,
                enrollments__status=LiveClassEnrollment.STATUS_APPROVED,
            )
        )
        .values_list("id", flat=True)
        .distinct()
    )


def user_has_course_access(user, course_id):
    user_id = _authenticated_user_id(user)
    if not user_id or not course_id:
        return False
    return Enrollment.objects.filter(user_id=user_id, course_id=course_id).filter(
        active_enrollment_q()
    ).exists()


def user_has_live_class_access(user, *, live_class_id, linked_course_id=None):
    user_id = _authenticated_user_id(user)
    if not user_id or not live_class_id:
        return False
    if linked_course_id and Enrollment.objects.filter(
        user_id=user_id, course_id=linked_course_id
    ).filter(active_enrollment_q()).exists():
        return True
    return LiveClassEnrollment.objects.filter(
        user_id=user_id,
        live_class_id=live_class_id,
        status=LiveClassEnrollment.STATUS_APPROVED,
        live_class__is_active=True,
    ).exists()


def build_live_class_access_maps(*, live_classes, user):
    rows = list(live_classes)
    user_id = _authenticated_user_id(user)
    if not user_id or not rows:
        return {}, {}

    live_class_ids = [item.id for item in rows]
    linked_course_ids = {
        item.linked_course_id for item in rows if getattr(item, "linked_course_id", None)
    }
    paid_course_ids = set(
        Enrollment.objects.filter(user_id=user_id, course_id__in=linked_course_ids)
        .filter(active_enrollment_q())
        .values_list("course_id", flat=True)
    )
    legacy_statuses = dict(
        LiveClassEnrollment.objects.filter(
            user_id=user_id,
            live_class_id__in=live_class_ids,
        ).values_list("live_class_id", "status")
    )

    statuses = {}
    sources = {}
    for item in rows:
        if item.linked_course_id in paid_course_ids:
            statuses[item.id] = LiveClassEnrollment.STATUS_APPROVED
            sources[item.id] = "course"
            continue
        legacy_status = legacy_statuses.get(item.id)
        if legacy_status:
            statuses[item.id] = legacy_status
            sources[item.id] = "legacy_live_class"
    return statuses, sources
