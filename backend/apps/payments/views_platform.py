"""Platform plan endpoints: one-time orders (Bootcamp, Lifetime) and memberships (contract §5).

Every acquisition is gated server-side (``pentesting`` for plans that include
Pentesting courses, ``memberships`` for subscriptions, then the plan's own
confirmed price and ``is_enabled``) and refused with 403 ``feature_disabled``
or ``plan_unavailable``. Verification and webhooks are never gated (money may
already have been captured).
"""

from __future__ import annotations

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle
from rest_framework import permissions, status
from rest_framework.views import APIView

from apps.core.idempotency import IdempotencyMixin

from . import platform_orders, subscriptions
from .models import PlatformSubscription
from .subscriptions import SubscriptionError


def error_response(exc: SubscriptionError):
    errors = {"detail": exc.message, "code": exc.code}
    if exc.feature:
        errors.update({"feature": exc.feature, "reason": exc.message})
    response = api_response(success=False, message=exc.message, errors=errors, status_code=exc.status)
    if hasattr(response, "data") and isinstance(response.data, dict):
        response.data["code"] = exc.code
        response.data["detail"] = exc.message
    return response


class PlanCheckoutThrottle(ClientIpScopedRateThrottle):
    scope = "plan_checkout"


def _prefill(user) -> dict:
    return {"name": getattr(user, "full_name", "") or "", "email": getattr(user, "email", "") or ""}


class PlatformOrderCreateView(IdempotencyMixin, APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [PlanCheckoutThrottle]

    def post(self, request):
        try:
            payment = platform_orders.create_order(request.user, request.data.get("plan_key"), request=request)
        except SubscriptionError as exc:
            return error_response(exc)
        data = platform_orders.checkout_payload(payment)
        data["prefill"] = _prefill(request.user)
        return api_response(success=True, message="Order created.", data=data)


class PlatformOrderVerifyView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        try:
            payment = platform_orders.verify_order(
                request.user,
                order_id=request.data.get("razorpay_order_id"),
                payment_id=request.data.get("razorpay_payment_id"),
                signature=request.data.get("razorpay_signature"),
                request=request,
            )
        except SubscriptionError as exc:
            return error_response(exc)
        return api_response(
            success=True, message="Payment verified.", data={"plan_key": payment.platform_plan.key, "granted": True}
        )


class SubscriptionCreateView(IdempotencyMixin, APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [PlanCheckoutThrottle]

    def post(self, request):
        try:
            sub = subscriptions.create_subscription(request.user, request.data.get("plan_key"), request=request)
        except SubscriptionError as exc:
            return error_response(exc)
        from django.conf import settings

        return api_response(
            success=True,
            message="Subscription created.",
            data={
                "subscription_id": sub.razorpay_subscription_id,
                "key_id": getattr(settings, "RAZORPAY_KEY_ID", ""),
                "plan_key": sub.plan.key,
                "status": sub.status,
                "amount": format(sub.amount, ".2f"),
                "currency": "INR",
                "name": "Al Syed Initiative",
                "description": sub.plan.title,
                "prefill": _prefill(request.user),
            },
        )


class SubscriptionVerifyView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        try:
            sub = subscriptions.verify_checkout(
                request.user,
                payment_id=request.data.get("razorpay_payment_id"),
                subscription_id=request.data.get("razorpay_subscription_id"),
                signature=request.data.get("razorpay_signature"),
                request=request,
            )
        except SubscriptionError as exc:
            return error_response(exc)
        return api_response(success=True, message="Subscription verified.", data={"subscription": subscriptions.serialize(sub)})


class SubscriptionCancelView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        at_cycle_end = request.data.get("at_cycle_end", True)
        if isinstance(at_cycle_end, str):
            at_cycle_end = at_cycle_end.strip().lower() not in {"0", "false", "no"}
        # Students cancel at the end of the paid period; immediate cancel is admin-only.
        if not (request.user.is_staff or request.user.is_superuser):
            at_cycle_end = True
        try:
            sub = subscriptions.cancel_subscription(request.user, pk, at_cycle_end=bool(at_cycle_end), request=request)
        except SubscriptionError as exc:
            return error_response(exc)
        return api_response(success=True, message="Cancellation recorded.", data={"subscription": subscriptions.serialize(sub)})


class MySubscriptionsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        rows = PlatformSubscription.objects.filter(user=request.user).select_related("plan").order_by("-created_at")[:20]
        response = api_response(
            success=True,
            message="Your memberships.",
            data={"subscriptions": [subscriptions.serialize(sub) for sub in rows]},
        )
        response["Cache-Control"] = "no-store"
        return response


__all__ = [
    "MySubscriptionsView",
    "PlatformOrderCreateView",
    "PlatformOrderVerifyView",
    "SubscriptionCancelView",
    "SubscriptionCreateView",
    "SubscriptionVerifyView",
    "status",
]
