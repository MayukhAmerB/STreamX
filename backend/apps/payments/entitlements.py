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
from apps.payments.access_cache import invalidate_course_join_access_cache

from .models import BatchPass, Payment
from .plans import INSTALLMENT_PLANS, PERMANENT_PLANS, get_plan_terms

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


def _platform_entitlement(user_id, course):
    """Access from platform plans: active grants (Bootcamp/Lifetime) and Pentesting memberships."""
    from .models import PlatformGrant, PlatformPlan, PlatformSubscription
    from .platform_plans import plan_covers_course

    now = timezone.now()
    best = None
    grants = PlatformGrant.objects.filter(
        user_id=user_id, is_active=True, plan__product__in=PlatformPlan.PENTESTING_PRODUCTS
    ).select_related("plan")
    for grant in grants:
        if grant.expires_at is not None and grant.expires_at <= now:
            continue
        if not plan_covers_course(grant.plan, course):
            continue
        if grant.expires_at is None:
            return LIFETIME
        if best is None or grant.expires_at > best.access_expires_at:
            best = Entitlement(Enrollment.ACCESS_INSTALLMENT, access_expires_at=grant.expires_at)
    subscriptions = PlatformSubscription.objects.filter(
        user_id=user_id, access_until__gt=now, plan__product=PlatformPlan.PRODUCT_PT_MEMBERSHIP
    ).select_related("plan")
    for subscription in subscriptions:
        if not plan_covers_course(subscription.plan, course):
            continue
        if best is None or subscription.access_until > best.access_expires_at:
            best = Entitlement(Enrollment.ACCESS_INSTALLMENT, access_expires_at=subscription.access_until)
    return best


def _strongest(*entitlements):
    candidates = [item for item in entitlements if item is not None]
    if not candidates:
        return None
    for item in candidates:
        if item.access_type != Enrollment.ACCESS_INSTALLMENT:
            return item
    return max(candidates, key=lambda item: item.access_expires_at)


def derive_entitlement(user_id, course):
    """Return the strongest access still backed by a payment, pass or platform plan, or None.

    Strength: lifetime (payment, pass, one-time platform plan) > the latest
    time-limited access (installments, Pentesting membership, dated grants).
    """
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
    platform = _platform_entitlement(user_id, course)
    if platform is LIFETIME:
        return LIFETIME
    external = [provider(user_id, course) for provider in _EXTERNAL_PROVIDERS]
    if any(item is not None and item.access_type != Enrollment.ACCESS_INSTALLMENT for item in external):
        return LIFETIME
    return _strongest(platform, _installment_entitlement(payments, course), *external)


# Other modules (apps.billing via apps.courses.billing_hooks) that also back course
# access register ``provider(user_id, course) -> Entitlement | None`` here, so a
# refund elsewhere never revokes access they still justify.
_EXTERNAL_PROVIDERS = []


def register_entitlement_provider(provider):
    if provider not in _EXTERNAL_PROVIDERS:
        _EXTERNAL_PROVIDERS.append(provider)


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
