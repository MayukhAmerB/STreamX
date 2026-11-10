"""Derive a student's course access from what still backs it.

Refunds and batch pass changes must remove exactly the access that depended on
them and nothing more. Instead of undoing individual grants, an enrollment is
re-derived from the sources that still exist:

* the student's own paid, non-refunded payments for that course (one-time and
  pass payments give lifetime access; EMI installments give lifetime access once
  every installment is paid, otherwise time-limited access), and
* an active all-future-batches pass while the course is included in the pass.

Re-deriving only ever reduces access. Legacy enrollments are admin-managed
approvals that no payment created, so they are never touched here. A revoked
enrollment keeps its row with payment_status "failed", which every access check
(apps.courses.access) already treats as no access.
"""

from dataclasses import dataclass
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone

from apps.courses.access import active_enrollment_q
from apps.courses.models import Enrollment
from apps.realtime.domain import invalidate_course_join_access_cache

from .models import BatchPass, Payment
from .pricing import get_plan_terms

PERMANENT_PLANS = (Payment.PLAN_FULL, Payment.PLAN_BATCH_PASS)
INSTALLMENT_PLANS = (Payment.PLAN_MONTHLY, Payment.PLAN_BUNDLE)

RESULT_UNCHANGED = "unchanged"
RESULT_REVOKED = "revoked"
RESULT_REDUCED = "reduced"


@dataclass(frozen=True)
class Entitlement:
    access_type: str
    access_expires_at: object = None
    installments_paid: int = 0


LIFETIME = Entitlement(Enrollment.ACCESS_LIFETIME)


def user_has_covering_batch_pass(user_id, course):
    if not course.included_in_batch_pass:
        return False
    return BatchPass.objects.filter(
        user_id=user_id,
        is_active=True,
        payment__status=Payment.STATUS_PAID,
    ).exists()


def _installment_expiry(payment, terms):
    if payment.access_expires_at:
        return payment.access_expires_at
    paid_at = payment.paid_at or payment.created_at
    return paid_at + timedelta(days=max(int(terms["access_days"]), 1))


def _installment_entitlement(payments, course):
    best = None
    for plan in INSTALLMENT_PLANS:
        rows = [payment for payment in payments if payment.plan == plan]
        if not rows:
            continue
        terms = rows[-1].terms_snapshot or get_plan_terms(course, plan)
        paid_count = len({payment.razorpay_payment_id or f"pk-{payment.pk}" for payment in rows})
        if paid_count >= max(int(terms["installments"]), 1):
            return LIFETIME
        candidate = Entitlement(
            Enrollment.ACCESS_INSTALLMENT,
            access_expires_at=max(_installment_expiry(payment, terms) for payment in rows),
            installments_paid=paid_count,
        )
        if best is None or candidate.access_expires_at > best.access_expires_at:
            best = candidate
    return best


def derive_entitlement(user_id, course):
    """Return the strongest access still backed by a payment or pass, or None."""
    if user_has_covering_batch_pass(user_id, course):
        return LIFETIME
    payments = list(
        Payment.objects.filter(
            user_id=user_id,
            course_id=course.id,
            status=Payment.STATUS_PAID,
        ).order_by("paid_at", "created_at", "pk")
    )
    if any(payment.plan in PERMANENT_PLANS for payment in payments):
        return LIFETIME
    return _installment_entitlement(payments, course)


def _reduced_fields(enrollment, entitlement):
    """Fields to change so the enrollment never exceeds its entitlement."""
    if entitlement.access_type != Enrollment.ACCESS_INSTALLMENT:
        return {}
    expires_at = entitlement.access_expires_at
    if enrollment.access_type == Enrollment.ACCESS_INSTALLMENT and enrollment.access_expires_at:
        expires_at = min(expires_at, enrollment.access_expires_at)
    changes = {
        "access_type": Enrollment.ACCESS_INSTALLMENT,
        "access_expires_at": expires_at,
        "installments_paid": min(enrollment.installments_paid, entitlement.installments_paid),
    }
    return {
        field: value for field, value in changes.items() if getattr(enrollment, field) != value
    }


def resync_enrollment_access(user_id, course):
    """Reduce or revoke one enrollment to what its remaining sources justify.

    Must run inside a transaction; the enrollment row is locked.
    """
    enrollment = (
        Enrollment.objects.select_for_update()
        .filter(user_id=user_id, course_id=course.id)
        .first()
    )
    if (
        enrollment is None
        or enrollment.payment_status != Enrollment.STATUS_PAID
        or enrollment.access_type == Enrollment.ACCESS_LEGACY
    ):
        return RESULT_UNCHANGED

    entitlement = derive_entitlement(user_id, course)
    if entitlement is None:
        enrollment.payment_status = Enrollment.STATUS_FAILED
        enrollment.save(update_fields=["payment_status"])
        invalidate_course_join_access_cache(user_id=user_id, course_id=course.id)
        return RESULT_REVOKED

    changes = _reduced_fields(enrollment, entitlement)
    if not changes:
        return RESULT_UNCHANGED
    for field, value in changes.items():
        setattr(enrollment, field, value)
    enrollment.save(update_fields=list(changes))
    invalidate_course_join_access_cache(user_id=user_id, course_id=course.id)
    return RESULT_REDUCED


def tally(results):
    return {
        "revoked": sum(result == RESULT_REVOKED for result in results),
        "reduced": sum(result == RESULT_REDUCED for result in results),
        "kept": sum(result == RESULT_UNCHANGED for result in results),
    }


# ---------------------------------------------------------------------------
# Guest checkout: one-time entitlements already owned by a buyer email.
# ---------------------------------------------------------------------------


def _normalized_email(email):
    return get_user_model().objects.normalize_auth_email(email)


def _paid_by_email_q(email):
    return Q(buyer_email__iexact=email) | Q(user__email__iexact=email)


def _buyer_user_ids(email):
    """Accounts reachable from a buyer email: its own login or its paid purchases."""
    return get_user_model().objects.filter(
        Q(email__iexact=email)
        | Q(payments__buyer_email__iexact=email, payments__status=Payment.STATUS_PAID)
    ).values("id")


def buyer_email_has_batch_pass(email, *, exclude_payment_id=None):
    email = _normalized_email(email)
    if not email:
        return False
    return (
        BatchPass.objects.filter(is_active=True, user_id__in=_buyer_user_ids(email)).exists()
        or Payment.objects.filter(
            _paid_by_email_q(email),
            plan=Payment.PLAN_BATCH_PASS,
            status=Payment.STATUS_PAID,
        )
        .exclude(pk=exclude_payment_id)
        .exists()
    )


def buyer_email_has_course_access(email, course, *, exclude_payment_id=None):
    """Mirror the logged-in "full" check for a guest identified only by email."""
    email = _normalized_email(email)
    if not email:
        return False
    if course.included_in_batch_pass and buyer_email_has_batch_pass(email, exclude_payment_id=exclude_payment_id):
        return True
    return (
        Payment.objects.filter(
            _paid_by_email_q(email),
            course=course,
            plan__in=PERMANENT_PLANS,
            status=Payment.STATUS_PAID,
        )
        .exclude(pk=exclude_payment_id)
        .exists()
        or Enrollment.objects.filter(course=course, user_id__in=_buyer_user_ids(email))
        .filter(active_enrollment_q(at=timezone.now()))
        .exists()
    )


def is_duplicate_guest_purchase(payment):
    """A captured guest one-time purchase of something the buyer email already owns.

    Guests are identified only by the email they type, so this is checked after
    capture (never before, which would disclose purchases to anyone who types
    an email). Only the first provisioning of a guest checkout is judged: the
    payment has no account yet, so it cannot match itself.
    """
    if payment.user_id or not payment.course_id:
        return False
    if payment.plan == Payment.PLAN_BATCH_PASS:
        return buyer_email_has_batch_pass(payment.buyer_email, exclude_payment_id=payment.pk)
    if payment.plan == Payment.PLAN_FULL:
        return buyer_email_has_course_access(payment.buyer_email, payment.course, exclude_payment_id=payment.pk)
    return False
