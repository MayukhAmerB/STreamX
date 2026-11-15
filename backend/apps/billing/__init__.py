"""Billing: a generic, reusable catalogue + checkout + entitlements module.

Use the service API (see README.md)::

    from apps import billing
    billing.has_entitlement(user, "all_labs")

Attributes resolve lazily from ``apps.billing.services`` so importing this
package never touches models before the app registry is ready.
"""

_API = {
    "BillingError",
    "CapturedPayment",
    "Quote",
    "entitlement_keys",
    "entitlement_window",
    "entitlements_for",
    "get_plan",
    "grant_manually",
    "has_entitlement",
    "list_plans",
    "on_payment_captured",
    "on_payment_failed",
    "on_payment_refunded",
    "quote",
    "revoke_grant",
    "start_checkout",
    "verify_checkout",
}


def __getattr__(name):
    if name in _API:
        from . import services

        return getattr(services, name)
    raise AttributeError(name)


def __dir__():
    return sorted(_API)
