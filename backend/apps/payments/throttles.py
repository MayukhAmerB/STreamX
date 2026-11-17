"""Throttles for payment and billing endpoints.

Two layers on every checkout/verify endpoint:

* the endpoint's own scope, per account when signed in and per client IP for
  guests (``ClientIpScopedRateThrottle`` semantics), and
* ``PaymentIpCeilingThrottle``: a generous per-IP ceiling across every
  account behind one address (``payment_ip``), so many throwaway accounts
  cannot hammer order creation from one machine.

The Razorpay webhook gets its own per-IP scope (``payment_webhook``) instead of
the global anonymous budget (50/minute), which a burst of real Razorpay events
could exhaust.

All of them FAIL OPEN when the cache (Redis) is unreachable: a Redis outage
must never turn into "nobody can pay" or "Razorpay webhooks get 500s". The
failure is logged; the payment flows themselves keep their database-backed
idempotency and row locks.
"""

from __future__ import annotations

import logging

from config.throttling import ClientIpIdentMixin, ClientIpScopedRateThrottle
from django.conf import settings
from rest_framework.throttling import SimpleRateThrottle

logger = logging.getLogger("apps.payments.throttles")

# Used when a scope is missing from REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],
# so a partial settings override can never raise ImproperlyConfigured on a
# payment path.
DEFAULT_RATES = {
    "payment_create": "120/minute",
    "payment_verify": "240/minute",
    "payment_ip": "300/minute",
    "payment_webhook": "1200/minute",
    "plan_checkout": "20/hour",
    "plan_verify": "120/hour",
    "billing_checkout": "30/hour",
    "billing_verify": "120/hour",
}


class FailOpenThrottleMixin:
    def get_rate(self):
        rates = getattr(settings, "REST_FRAMEWORK", {}).get("DEFAULT_THROTTLE_RATES", {}) or {}
        scope = getattr(self, "scope", None)
        if scope in rates:
            return rates[scope]
        return DEFAULT_RATES.get(scope) or super().get_rate()

    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except Exception:  # noqa: BLE001 - cache outage: fail open
            logger.warning("payments.throttle_cache_unavailable scope=%s", getattr(self, "scope", ""), exc_info=True)
            return True


class PaymentScopedRateThrottle(FailOpenThrottleMixin, ClientIpScopedRateThrottle):
    """``throttle_scope`` of the view; per account when signed in, else per IP."""


class PaymentIpCeilingThrottle(FailOpenThrottleMixin, ClientIpIdentMixin, SimpleRateThrottle):
    scope = "payment_ip"

    def get_cache_key(self, request, view):
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class PaymentWebhookThrottle(FailOpenThrottleMixin, ClientIpIdentMixin, SimpleRateThrottle):
    scope = "payment_webhook"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class _UserOrIpThrottle(FailOpenThrottleMixin, ClientIpIdentMixin, SimpleRateThrottle):
    def get_cache_key(self, request, view):
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        user = getattr(request, "user", None)
        if user is not None and getattr(user, "is_authenticated", False):
            ident = f"user:{user.pk}"
        else:
            ident = f"ip:{self.get_ident(request)}"
        return self.cache_format % {"scope": self.scope, "ident": ident}


class PlanCheckoutThrottle(_UserOrIpThrottle):
    scope = "plan_checkout"


class PlanVerifyThrottle(_UserOrIpThrottle):
    scope = "plan_verify"


class BillingCheckoutThrottle(_UserOrIpThrottle):
    scope = "billing_checkout"


class BillingVerifyThrottle(_UserOrIpThrottle):
    scope = "billing_verify"


CHECKOUT_THROTTLES = [PaymentScopedRateThrottle, PaymentIpCeilingThrottle]
