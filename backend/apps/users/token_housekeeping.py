"""Daily removal of expired JWT refresh-token records.

``BLACKLIST_AFTER_ROTATION`` writes an OutstandingToken (and, on rotation, a
BlacklistedToken) for every refresh, forever. This is simplejwt's
``flushexpiredtokens``, run by the async worker: a periodic hook publishes one
deduplicated outbox event per day; its handler deletes expired rows in small
primary-key batches, so no single statement comes near the database role's
statement timeout. An expired token is rejected on its expiry alone, so its
records are no longer needed.
"""

from __future__ import annotations

import logging

from django.utils import timezone

from apps.core.outbox import outbox_handler, publish

logger = logging.getLogger("apps.users.token_housekeeping")

EVENT_FLUSH_EXPIRED_TOKENS = "users.flush_expired_tokens"
FLUSH_INTERVAL_SECONDS = 24 * 3600
FLUSH_BATCH_SIZE = 2000
FLUSH_MAX_BATCHES = 200


def schedule_flush_expired_tokens(now=None):
    now = now or timezone.now()
    bucket = int(now.timestamp()) // FLUSH_INTERVAL_SECONDS
    return publish(
        EVENT_FLUSH_EXPIRED_TOKENS,
        {"bucket": bucket},
        dedupe_key=f"users-flush-expired-tokens:{bucket}",
    )


def flush_expired_tokens(*, now=None, batch_size=FLUSH_BATCH_SIZE, max_batches=FLUSH_MAX_BATCHES):
    """Delete expired outstanding tokens (their blacklist rows cascade).

    Returns the number of outstanding tokens deleted. Stops after
    ``max_batches``; the next day's run continues.
    """
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

    now = now or timezone.now()
    deleted = 0
    for _ in range(max(1, int(max_batches))):
        ids = list(
            OutstandingToken.objects.filter(expires_at__lte=now).order_by("pk").values_list("pk", flat=True)[
                : max(1, int(batch_size))
            ]
        )
        if not ids:
            break
        OutstandingToken.objects.filter(pk__in=ids).delete()
        deleted += len(ids)
    return deleted


@outbox_handler(EVENT_FLUSH_EXPIRED_TOKENS, max_attempts=3)
def handle_flush_expired_tokens(event):
    deleted = flush_expired_tokens()
    logger.info("users: flushed %s expired refresh tokens", deleted)
    return deleted
