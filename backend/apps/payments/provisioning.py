from datetime import date, datetime, time, timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.courses.models import Enrollment
from apps.realtime.domain import invalidate_course_join_access_cache
from config.audit import log_security_event

from .batch_pass import activate_batch_pass
from .entitlements import is_duplicate_guest_purchase
from .models import Payment, StudentAccountSequence
from .pricing import get_plan_terms
from .refunds import apply_pending_refund


def _allocate_student_login():
    sequence, _ = StudentAccountSequence.objects.select_for_update().get_or_create(
        pk=1, defaults={"next_number": 1}
    )
    User = get_user_model()
    while True:
        number = sequence.next_number
        sequence.next_number += 1
        email = f"ADL{number:04d}@adlfront.com"
        legacy_email = f"adl-{number:04d}@adlfront.com"
        if not User.objects.filter(
            Q(email__iexact=email) | Q(email__iexact=legacy_email)
        ).exists():
            sequence.save(update_fields=["next_number", "updated_at"])
            return email


def _resolve_or_create_user(payment):
    if payment.user_id:
        return payment.user

    User = get_user_model()
    buyer_email = User.objects.normalize_auth_email(payment.buyer_email)
    # Refunded purchases still identify the buyer's account, so a repurchase
    # after a refund reuses it instead of minting a second login.
    prior_paid_purchase = (
        Payment.objects.filter(
            buyer_email__iexact=buyer_email,
            course=payment.course,
            status__in=(Payment.STATUS_PAID, Payment.STATUS_REFUNDED),
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
    payment = Payment.objects.select_for_update().get(pk=payment.pk)
    if payment.status != Payment.STATUS_PAID or not payment.course_id:
        return None
    if payment.provisioning_status == Payment.PROVISION_DUPLICATE:
        return None
    pending_refund = apply_pending_refund(payment)
    if pending_refund is not None:
        # The refund webhook for this very payment was handled before its
        # capture: a full refund ends here, refunded, with no access granted.
        payment = pending_refund.payment
        if payment.status != Payment.STATUS_PAID:
            log_security_event(
                "payment.refund_before_capture_applied",
                payment_id=payment.pk,
                course_id=payment.course_id,
                amount_refunded=str(payment.amount_refunded),
            )
            return None
    if is_duplicate_guest_purchase(payment):
        # Never grant (or mint a second login for) what this email already
        # owns; the admin refunds the payment.
        payment.provisioning_status = Payment.PROVISION_DUPLICATE
        payment.save(update_fields=["provisioning_status", "updated_at"])
        log_security_event(
            "payment.duplicate_guest_purchase_refund_due",
            payment_id=payment.pk,
            course_id=payment.course_id,
            plan=payment.plan,
        )
        return None

    user = _resolve_or_create_user(payment)
    course = payment.course
    if payment.application_id:
        application = payment.application
        application.student = user
        application.status = "enrolled"
        application.save(update_fields=["student", "status", "updated_at"])
    enrollment, created = Enrollment.objects.select_for_update().get_or_create(
        user=user,
        course=course,
        defaults={"payment_status": Enrollment.STATUS_PAID},
    )
    # Provider retries must not extend access or downgrade previously granted lifetime access.
    if payment.invoice_number and payment.provisioning_status in (Payment.PROVISION_AWAITING_ADMIN, Payment.PROVISION_CREDENTIALS_ISSUED):
        if payment.plan == Payment.PLAN_BATCH_PASS:
            activate_batch_pass(payment)
        return enrollment
    had_permanent_access = enrollment.payment_status == Enrollment.STATUS_PAID and enrollment.access_type in (Enrollment.ACCESS_LEGACY, Enrollment.ACCESS_LIFETIME) and not created
    enrollment.payment_status = Enrollment.STATUS_PAID
    terms = payment.terms_snapshot or get_plan_terms(course, payment.plan)

    if payment.plan in (Payment.PLAN_MONTHLY, Payment.PLAN_BUNDLE):
        paid_installments = (
            Payment.objects.filter(
                user=user,
                course=course,
                plan=payment.plan,
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
        if had_permanent_access or paid_installments >= max(int(terms["installments"]), 1):
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
            if terms.get("start_date"):
                starts_at = timezone.make_aware(datetime.combine(date.fromisoformat(terms["start_date"]), time.min))
                base = max(base, starts_at)
            expires_at = base + timedelta(days=max(int(terms["access_days"]), 1))
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
    if payment.plan == Payment.PLAN_BATCH_PASS:
        activate_batch_pass(payment)
    return enrollment
