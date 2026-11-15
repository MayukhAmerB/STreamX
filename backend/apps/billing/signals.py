"""Billing hooks other apps listen to (billing never imports them).

All signals are sent inside the transaction that changed the grant, with
``send_robust``: a failing receiver is logged and never loses a payment. The
grant stays the source of truth; Billing > Entitlement grants > "Re-send hooks"
replays them.

* ``entitlement_granted(sender, grant, user, key)``
* ``entitlement_revoked(sender, grant, user, key)``
* ``purchase_paid(sender, purchase)``
* ``purchase_refunded(sender, purchase)``
"""

import logging

from django.dispatch import Signal

logger = logging.getLogger(__name__)

entitlement_granted = Signal()
entitlement_revoked = Signal()
purchase_paid = Signal()
purchase_refunded = Signal()


SENDER = "billing"


def send(signal, **kwargs):
    """Call every receiver in its own savepoint; a failure is logged and rolled back alone."""
    from django.db import transaction

    try:
        receivers = signal._live_receivers(SENDER)
        if isinstance(receivers, tuple):  # Django >= 5.0: (sync, async)
            receivers = receivers[0]
    except Exception:  # noqa: BLE001 - private API changed: fall back to the public one
        for receiver, result in signal.send_robust(sender=SENDER, **kwargs):
            if isinstance(result, Exception):
                logger.error("billing hook %r failed: %s", receiver, result, exc_info=result)
        return
    for receiver in receivers:
        try:
            with transaction.atomic():
                receiver(signal=signal, sender=SENDER, **kwargs)
        except Exception as exc:  # noqa: BLE001
            logger.error("billing hook %r failed: %s", receiver, exc, exc_info=exc)
