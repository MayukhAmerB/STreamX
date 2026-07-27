from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from apps.courses.models import Enrollment
from apps.realtime.domain import invalidate_course_join_access_cache

from .models import Payment, StudentAccountSequence


def _allocate_student_login():
    sequence, _ = StudentAccountSequence.objects.select_for_update().get_or_create(
        pk=1, defaults={"next_number": 1}
    )
    User = get_user_model()
    while True:
        number = sequence.next_number
        sequence.next_number += 1
        email = f"adl-{number:04d}@adlfront.com"
        if not User.objects.filter(email__iexact=email).exists():
            sequence.save(update_fields=["next_number", "updated_at"])
            return email


def _resolve_or_create_user(payment):
    if payment.user_id:
        return payment.user

    User = get_user_model()
    buyer_email = User.objects.normalize_auth_email(payment.buyer_email)
    prior_paid_purchase = (
        Payment.objects.filter(
            buyer_email__iexact=buyer_email,
            course=payment.course,
            status=Payment.STATUS_PAID,
            user__isnull=False,
        )
        .exclude(pk=payment.pk)
        .select_related("user")
        .order_by("-paid_at", "-created_at")
        .first()
        if buyer_email
        else None
    )
    if prior_paid_purchase is not None:
        payment.user = prior_paid_purchase.user
        return prior_paid_purchase.user

    generated_email = _allocate_student_login()
    user = User(
        email=generated_email,
        full_name=payment.buyer_name,
        phone_number=payment.whatsapp_number,
        role=User.ROLE_STUDENT,
        is_active=True,
    )
    user.set_unusable_password()
    user.save()
    payment.user = user
    return user


@transaction.atomic
def provision_paid_payment(payment):
    payment = (
        Payment.objects.select_for_update()
        .select_related("course", "user")
        .get(pk=payment.pk)
    )
    if payment.status != Payment.STATUS_PAID or not payment.course_id:
        return None

    user = _resolve_or_create_user(payment)
    course = payment.course
    enrollment, _ = Enrollment.objects.select_for_update().get_or_create(
        user=user,
        course=course,
        defaults={"payment_status": Enrollment.STATUS_PAID},
    )
    enrollment.payment_status = Enrollment.STATUS_PAID

    if payment.plan == Payment.PLAN_MONTHLY:
        paid_installments = (
            Payment.objects.filter(
                user=user,
                course=course,
                plan=Payment.PLAN_MONTHLY,
                status=Payment.STATUS_PAID,
            )
            .exclude(pk=payment.pk)
            .exclude(razorpay_payment_id="")
            .values("razorpay_payment_id")
            .distinct()
            .count()
        ) + 1
        payment.installment_number = max(paid_installments, 1)
        enrollment.installments_paid = max(enrollment.installments_paid, paid_installments)
        if paid_installments >= max(course.installments_required, 1):
            enrollment.access_type = Enrollment.ACCESS_LIFETIME
            enrollment.access_expires_at = None
            payment.access_expires_at = None
        else:
            now = payment.paid_at or timezone.now()
            base = (
                enrollment.access_expires_at
                if enrollment.access_expires_at and enrollment.access_expires_at > now
                else now
            )
            expires_at = base + timedelta(days=max(course.installment_access_days, 1))
            enrollment.access_type = Enrollment.ACCESS_INSTALLMENT
            enrollment.access_expires_at = expires_at
            payment.access_expires_at = expires_at
    else:
        enrollment.access_type = Enrollment.ACCESS_LIFETIME
        enrollment.access_expires_at = None
        payment.access_expires_at = None

    enrollment.save(
        update_fields=[
            "payment_status",
            "access_type",
            "access_expires_at",
            "installments_paid",
        ]
    )
    if not payment.invoice_number:
        paid_at = payment.paid_at or timezone.now()
        payment.invoice_number = f"ADL-{paid_at:%Y%m}-{payment.internal_reference.hex[:10].upper()}"
    payment.user = user
    payment.user_email_snapshot = user.email
    payment.provisioning_status = (
        Payment.PROVISION_AWAITING_ADMIN
        if not user.has_usable_password()
        else Payment.PROVISION_CREDENTIALS_ISSUED
    )
    payment.save(
        update_fields=[
            "user",
            "user_email_snapshot",
            "installment_number",
            "access_expires_at",
            "invoice_number",
            "provisioning_status",
            "updated_at",
        ]
    )
    invalidate_course_join_access_cache(user_id=user.id, course_id=course.id)
    return enrollment
