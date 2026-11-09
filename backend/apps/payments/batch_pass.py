"""All-future-batches pass: grant included courses to pass holders.

Access is materialized as lifetime Enrollments, so course pages, live classes
and stream authorization keep using their existing enrollment checks.
"""

from django.db import transaction

from apps.courses.models import Course, Enrollment
from apps.realtime.domain import invalidate_course_join_access_cache

from .models import BatchPass


def _grant_lifetime_enrollment(user_id, course_id):
    enrollment, created = Enrollment.objects.select_for_update().get_or_create(
        user_id=user_id,
        course_id=course_id,
        defaults={
            "payment_status": Enrollment.STATUS_PAID,
            "access_type": Enrollment.ACCESS_LIFETIME,
        },
    )
    if not created and not (
        enrollment.payment_status == Enrollment.STATUS_PAID
        and enrollment.access_type in (Enrollment.ACCESS_LIFETIME, Enrollment.ACCESS_LEGACY)
    ):
        enrollment.payment_status = Enrollment.STATUS_PAID
        enrollment.access_type = Enrollment.ACCESS_LIFETIME
        enrollment.access_expires_at = None
        enrollment.save(update_fields=["payment_status", "access_type", "access_expires_at"])
    elif not created:
        return False
    invalidate_course_join_access_cache(user_id=user_id, course_id=course_id)
    return True


def included_courses():
    return Course.objects.filter(included_in_batch_pass=True, is_published=True)


@transaction.atomic
def activate_batch_pass(payment):
    """Record the pass for a provisioned payment and grant every included course."""
    batch_pass, _ = BatchPass.objects.get_or_create(
        payment=payment,
        defaults={"user": payment.user, "source_course": payment.course},
    )
    if batch_pass.is_active:
        for course_id in included_courses().values_list("id", flat=True):
            _grant_lifetime_enrollment(batch_pass.user_id, course_id)
    return batch_pass


@transaction.atomic
def grant_course_to_pass_holders(course):
    """Unlock a newly included or newly published course for every active holder."""
    if not (course.included_in_batch_pass and course.is_published):
        return 0
    holder_ids = BatchPass.objects.filter(is_active=True).values_list("user_id", flat=True).distinct()
    return sum(_grant_lifetime_enrollment(user_id, course.id) for user_id in holder_ids)


def user_has_active_batch_pass(user):
    return bool(
        user
        and getattr(user, "is_authenticated", False)
        and BatchPass.objects.filter(user=user, is_active=True).exists()
    )
