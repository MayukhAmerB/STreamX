"""Courses side of billing: ``course_access:<id>`` grants become Enrollments.

Billing never imports courses; this module listens to its signals:

* granted -> create or extend the Enrollment (lifetime, or time-limited to the end
  of the billing coverage, following back-to-back monthly renewals);
* revoked -> re-derive the Enrollment from every source that still backs it
  (``apps.payments.entitlements.resync_enrollment_access``), so access paid for
  some other way is kept.

It also registers billing as a source in ``derive_entitlement`` so a refund in
the course flow never removes access a billing grant still justifies.
"""

from __future__ import annotations

from django.db import transaction
from django.dispatch import receiver

from apps.billing import signals as billing_signals

PREFIX = "course_access:"


def _course_id(key: str) -> int | None:
    if not str(key or "").startswith(PREFIX):
        return None
    value = key[len(PREFIX):]
    return int(value) if value.isdigit() else None


def billing_course_entitlement(user_id, course):
    """``derive_entitlement`` provider: what billing grants say about this course."""
    from django.contrib.auth import get_user_model

    from apps.billing.services import entitlement_window
    from apps.payments.entitlements import LIFETIME, Entitlement

    from .models import Enrollment

    user = get_user_model().objects.filter(pk=user_id).first()
    if user is None:
        return None
    window = entitlement_window(user, f"{PREFIX}{course.pk}")
    if not window["active"]:
        return None
    if window["lifetime"]:
        return LIFETIME
    return Entitlement(Enrollment.ACCESS_INSTALLMENT, access_expires_at=window["ends_at"])


def apply_course_grant(user, course_id: int) -> None:
    from apps.billing.services import entitlement_window
    from apps.realtime.domain import invalidate_course_join_access_cache

    from .models import Course, Enrollment

    if not Course.objects.filter(pk=course_id).exists():
        return
    window = entitlement_window(user, f"{PREFIX}{course_id}")
    if not window["active"]:
        return  # a grant that starts later is applied by the renewal-aware window when it starts
    with transaction.atomic():
        enrollment, created = Enrollment.objects.select_for_update().get_or_create(
            user=user,
            course_id=course_id,
            defaults={
                "payment_status": Enrollment.STATUS_PAID,
                "access_type": Enrollment.ACCESS_LIFETIME if window["lifetime"] else Enrollment.ACCESS_INSTALLMENT,
                "access_expires_at": None if window["lifetime"] else window["ends_at"],
            },
        )
        if not created:
            permanent = enrollment.access_type in (Enrollment.ACCESS_LIFETIME, Enrollment.ACCESS_LEGACY)
            if enrollment.payment_status == Enrollment.STATUS_PAID and permanent:
                pass  # already permanent: never downgrade
            elif window["lifetime"]:
                enrollment.payment_status = Enrollment.STATUS_PAID
                enrollment.access_type = Enrollment.ACCESS_LIFETIME
                enrollment.access_expires_at = None
                enrollment.save(update_fields=["payment_status", "access_type", "access_expires_at"])
            else:
                current = enrollment.access_expires_at if enrollment.has_active_access() else None
                enrollment.payment_status = Enrollment.STATUS_PAID
                enrollment.access_type = Enrollment.ACCESS_INSTALLMENT
                enrollment.access_expires_at = max(filter(None, [current, window["ends_at"]]))
                enrollment.save(update_fields=["payment_status", "access_type", "access_expires_at"])
    invalidate_course_join_access_cache(user_id=user.pk, course_id=course_id)


@receiver(billing_signals.entitlement_granted, dispatch_uid="courses.billing_course_access_granted")
def on_entitlement_granted(sender, grant=None, user=None, key="", **kwargs):
    course_id = _course_id(key)
    if course_id is not None and user is not None:
        apply_course_grant(user, course_id)


@receiver(billing_signals.entitlement_revoked, dispatch_uid="courses.billing_course_access_revoked")
def on_entitlement_revoked(sender, grant=None, user=None, key="", **kwargs):
    course_id = _course_id(key)
    if course_id is None or user is None:
        return
    from apps.payments.entitlements import resync_enrollment_access

    from .models import Course

    course = Course.objects.filter(pk=course_id).first()
    if course is None:
        return
    with transaction.atomic():
        resync_enrollment_access(user.pk, course)


def register():
    from apps.payments.entitlements import register_entitlement_provider

    register_entitlement_provider(billing_course_entitlement)


register()
