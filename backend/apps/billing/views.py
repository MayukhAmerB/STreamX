"""REST API under /api/billing/ (thin wrappers around ``services``)."""

from __future__ import annotations

from config.audit import log_security_event
from config.response import api_response
from rest_framework import permissions, serializers
from rest_framework.views import APIView

from apps.core.idempotency import IdempotencyMixin
from apps.payments.throttles import (
    BillingCheckoutThrottle,
    BillingVerifyThrottle,
    PaymentIpCeilingThrottle,
)

from . import services
from .registry import describe


def plan_payload(plan) -> dict:
    price = plan.price
    days = price.period_days()
    return {
        "id": plan.pk,
        "key": plan.key,
        "name": plan.name,
        "description": plan.description,
        "badge": plan.badge,
        "is_highlighted": plan.is_highlighted,
        "sort_order": plan.sort_order,
        "product": {"key": plan.product.key, "name": plan.product.name},
        "price": {
            "id": price.pk,
            "amount": format(price.amount, ".2f"),
            "amount_paise": price.amount_paise,
            "currency": price.currency,
            "billing_type": price.billing_type,
            "interval": price.interval,
            "interval_count": price.interval_count,
            "access_days": days,
            "lifetime": days is None,
            "period_label": price.describe_period(),
        },
        "features": [
            {"text": feature.text, "is_highlighted": feature.is_highlighted} for feature in plan.features.all()
        ],
        "entitlements": [{"key": key, "label": describe(key)} for key in plan.entitlement_keys()],
    }


def _error(exc: services.BillingError):
    response = api_response(
        success=False,
        message=exc.message,
        errors={"detail": exc.message, "code": exc.code},
        status_code=exc.status,
    )
    if exc.status == 503:
        response["Retry-After"] = "30"
    return response


class _PlanInput(serializers.Serializer):
    plan_id = serializers.CharField(max_length=100)


class _VerifyInput(serializers.Serializer):
    order_id = serializers.CharField(max_length=255)
    payment_id = serializers.CharField(max_length=255)
    signature = serializers.CharField(max_length=255)


def _no_store(response):
    response["Cache-Control"] = "no-store"
    return response


class PlanListView(APIView):
    """``GET /api/billing/plans/?product=<key>&course=<id>&entitlement=<key>&billing_type=...``"""

    permission_classes = [permissions.AllowAny]

    def get(self, request):
        params = request.query_params
        context = {}
        course = str(params.get("course") or "").strip()
        if course:
            if not course.isdigit():
                return api_response(success=False, message="Invalid course.", errors={"course": "Must be a number."},
                                    status_code=400)
            context["course_id"] = int(course)
        for name in ("entitlement", "billing_type"):
            if params.get(name):
                context[name] = str(params.get(name))[:160]
        plans = services.list_plans(product_key=(params.get("product") or None), context=context)
        return _no_store(api_response(success=True, message="Plans.", data={"plans": [plan_payload(p) for p in plans]}))


class QuoteView(APIView):
    """``POST /api/billing/quote/ {plan_id}``: the server-side amount."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        data = _PlanInput(data=request.data)
        data.is_valid(raise_exception=True)
        try:
            quote = services.quote(data.validated_data["plan_id"], request.user)
        except services.BillingError as exc:
            return _error(exc)
        return _no_store(api_response(success=True, message="Quote.", data=quote.as_dict()))


class CheckoutView(IdempotencyMixin, APIView):
    """``POST /api/billing/checkout/ {plan_id}``: a Razorpay order for the plan's current price.

    An optional ``Idempotency-Key`` replays the first answer (double submit).
    """

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [BillingCheckoutThrottle, PaymentIpCeilingThrottle]

    def post(self, request):
        data = _PlanInput(data=request.data)
        data.is_valid(raise_exception=True)
        try:
            payload = services.start_checkout(request.user, data.validated_data["plan_id"])
        except services.BillingError as exc:
            return _error(exc)
        log_security_event("billing.checkout_created", request=request, purchase_id=payload["purchase_id"])
        return _no_store(api_response(success=True, message="Checkout created.", data=payload, status_code=201))


class CheckoutVerifyView(APIView):
    """``POST /api/billing/checkout/verify/ {order_id, payment_id, signature}`` (idempotent by design)."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [BillingVerifyThrottle, PaymentIpCeilingThrottle]

    def post(self, request):
        data = _VerifyInput(data=request.data)
        data.is_valid(raise_exception=True)
        try:
            purchase = services.verify_checkout(request.user, **data.validated_data)
        except services.BillingError as exc:
            log_security_event("billing.verify_failed", request=request, code=exc.code)
            return _error(exc)
        log_security_event("billing.verified", request=request, purchase_id=purchase.pk)
        return _no_store(
            api_response(
                success=True,
                message="Payment verified.",
                data={
                    "purchase_id": purchase.pk,
                    "status": purchase.status,
                    "entitlements": services.entitlements_for(request.user),
                },
            )
        )


class MyEntitlementsView(APIView):
    """``GET /api/billing/entitlements/``: what the signed-in user can use now."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        return _no_store(
            api_response(success=True, message="Entitlements.",
                         data={"entitlements": services.entitlements_for(request.user)})
        )
