"""Cache invalidation for course access that never fails a payment.

``apps.realtime.domain.invalidate_course_join_access_cache`` deletes keys in
Redis. Payment provisioning, refunds and grants call it inside the database
transaction that records the money; if Redis is down the ``delete_many`` raised
and rolled back the whole capture (verify answered 500, the webhook was queued
for retry), so a Redis outage blocked enrollment after a successful payment.

This wrapper keeps the call and its timing but logs instead of raising; the
cached access answers expire on their own TTL.
"""

from __future__ import annotations

import logging

from django.db import transaction

from apps.realtime.domain import invalidate_course_join_access_cache as _invalidate

logger = logging.getLogger("apps.payments.access_cache")


def invalidate_course_join_access_cache(*, user_id, course_id):
    try:
        # Savepoint: a failure here never poisons the caller's transaction.
        with transaction.atomic():
            _invalidate(user_id=user_id, course_id=course_id)
    except Exception:  # noqa: BLE001 - Redis outage must not undo a payment
        logger.warning(
            "payments.access_cache_invalidation_failed user_id=%s course_id=%s", user_id, course_id, exc_info=True
        )
