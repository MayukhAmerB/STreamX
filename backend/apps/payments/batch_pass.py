"""All-future-batches pass: grant included courses to pass holders.

Access is materialized as lifetime Enrollments, so course pages, live classes
and stream authorization keep using their existing enrollment checks. Taking a
course out of the pass, or ending a pass, re-derives each affected enrollment
through apps.payments.entitlements so access the student paid for separately
is kept.
"""

from django.db import transaction
from django.db.models import Q

from apps.courses.models import Course, Enrollment
from apps.realtime.domain import invalidate_course_join_access_cache

from .entitlements import resync_enrollment_access, tally
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
    holder_ids = active_pass_holder_ids()
    return sum(_grant_lifetime_enrollment(user_id, course.id) for user_id in holder_ids)


def active_pass_holder_ids():
    return BatchPass.objects.filter(is_active=True).values_list("user_id", flat=True).distinct()


def active_pass_holder_count():
    return active_pass_holder_ids().count()


@transaction.atomic
def revoke_course_from_pass_holders(course):
    """Re-derive holders' access after the course left the pass.

    Every pass holder (active or ended) is checked, so enrollments that exist
    only because of the pass are revoked while payment-backed ones stay.
    """
    course = Course.objects.select_for_update().get(pk=course.pk)
    if course.included_in_batch_pass:
        return tally([])
    holder_ids = BatchPass.objects.values_list("user_id", flat=True).distinct()
    return tally([resync_enrollment_access(user_id, course) for user_id in holder_ids])


def _pass_scoped_courses(batch_pass):
    return Course.objects.filter(
        Q(included_in_batch_pass=True) | Q(pk=batch_pass.source_course_id),
        enrollments__user_id=batch_pass.user_id,
    ).distinct()


@transaction.atomic
def deactivate_batch_pass(batch_pass):
    """End a pass and revoke the courses that only it was unlocking."""
    batch_pass = BatchPass.objects.select_for_update().get(pk=batch_pass.pk)
    if batch_pass.is_active:
        batch_pass.is_active = False
        batch_pass.save(update_fields=["is_active"])
    return tally(
        [resync_enrollment_access(batch_pass.user_id, course) for course in _pass_scoped_courses(batch_pass)]
    )

