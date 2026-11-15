"""Write-behind counters for high-frequency signals (watch time, live presence).

Production (Django ``RedisCache``): one ``HINCRBY`` per lecture progress
update or presence ping, nothing written to the database. The worker flushes
every ``FLUSH_INTERVAL_SECONDS``: ``RENAME`` the pending hash to a
per-batch processing key (atomic hand-over: new increments go to a fresh
hash), ``HGETALL``, apply to the database together with a ``FlushLog`` row,
then ``DEL``. A crash between the DB commit and the ``DEL`` is detected by the
``FlushLog`` token on the next run, so a batch is applied exactly once.

Without Redis (development, tests) an in-process buffer with the same
interface is used; it is flushed by whichever process holds it.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from collections import defaultdict

from django.core.cache import cache

logger = logging.getLogger("apps.engagement.buffer")

PREFIX = "eng:buf"
PROCESSING_SET = f"{PREFIX}:processing"
LAST_SEEN_TTL_SECONDS = 6 * 3600

# Tests inject a fake redis client here.
_client_override = None


def redis_client():
    """The raw redis-py client behind Django's cache, or None (locmem etc.)."""
    if _client_override is not None:
        return _client_override
    try:
        from django.core.cache.backends.redis import RedisCache
    except ImportError:  # pragma: no cover
        return None
    # Check the real backend: ``django.core.cache.cache`` is a ConnectionProxy
    # and is never an instance of RedisCache, which silently kept every
    # production process on its own in-memory buffer (XP was never flushed).
    from django.core.cache import caches

    try:
        backend = caches["default"]
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(backend, RedisCache):
        return None
    try:
        return backend._cache.get_client(PREFIX, write=True)  # noqa: SLF001 - documented Django internals
    except Exception:  # noqa: BLE001
        logger.error("engagement.buffer.redis_client_unavailable", exc_info=True)
        return None


class _LocalBuffer:
    def __init__(self):
        self.lock = threading.Lock()
        self.hashes: dict[str, dict[str, int]] = defaultdict(dict)
        self.values: dict[str, tuple[str, float]] = {}

    def reset(self):
        with self.lock:
            self.hashes.clear()
            self.values.clear()


_local = _LocalBuffer()


def reset_local_for_tests():
    _local.reset()


def _pending_key(kind: str) -> str:
    return f"{PREFIX}:{kind}:pending"


def incr(kind: str, field: str, amount: int) -> None:
    """Add ``amount`` to ``field`` of the pending ``kind`` hash (never raises)."""
    amount = int(amount)
    if amount <= 0:
        return
    client = redis_client()
    if client is None:
        with _local.lock:
            bucket = _local.hashes[_pending_key(kind)]
            bucket[field] = bucket.get(field, 0) + amount
        return
    try:
        client.hincrby(_pending_key(kind), field, amount)
    except Exception:  # noqa: BLE001 - engagement must never break the request
        logger.warning("engagement.buffer.incr_failed kind=%s", kind, exc_info=True)


def swap_last_seen(key: str, value: str) -> str | None:
    """Store ``value`` under ``key`` and return the previous value (one round trip)."""
    full_key = f"{PREFIX}:last:{key}"
    client = redis_client()
    if client is None:
        with _local.lock:
            previous = _local.values.get(full_key)
            _local.values[full_key] = (value, time.time() + LAST_SEEN_TTL_SECONDS)
        if previous and previous[1] > time.time():
            return previous[0]
        return None
    try:
        previous = client.set(full_key, value, ex=LAST_SEEN_TTL_SECONDS, get=True)
    except Exception:  # noqa: BLE001
        logger.warning("engagement.buffer.last_seen_failed", exc_info=True)
        return None
    if isinstance(previous, bytes):
        previous = previous.decode("utf-8", "replace")
    return previous


def _decode_hash(raw) -> dict[str, int]:
    data = {}
    for field, value in (raw or {}).items():
        if isinstance(field, bytes):
            field = field.decode("utf-8", "replace")
        try:
            data[str(field)] = int(value)
        except (TypeError, ValueError):
            continue
    return data


def take_batches(kind: str) -> list[tuple[str, dict[str, int]]]:
    """Hand over the pending hash (and any batch a crashed flush left behind).

    Returns ``[(token, {field: amount})]``; call :func:`ack` once a batch is
    applied (or was already applied).
    """
    client = redis_client()
    if client is None:
        with _local.lock:
            data = _local.hashes.pop(_pending_key(kind), {})
        return [(f"local:{kind}:{secrets.token_hex(8)}", dict(data))] if data else []
    batches = []
    try:
        leftovers = [
            member.decode() if isinstance(member, bytes) else str(member)
            for member in (client.smembers(PROCESSING_SET) or [])
        ]
    except Exception:  # noqa: BLE001
        leftovers = []
    for processing_key in leftovers:
        if not processing_key.startswith(f"{PREFIX}:{kind}:processing:"):
            continue
        batches.append((processing_key.rsplit(":", 1)[-1], _decode_hash(client.hgetall(processing_key))))
    token = secrets.token_hex(12)
    processing_key = f"{PREFIX}:{kind}:processing:{token}"
    try:
        client.sadd(PROCESSING_SET, processing_key)
        client.rename(_pending_key(kind), processing_key)
    except Exception as exc:  # noqa: BLE001 - "no such key": nothing pending
        client.srem(PROCESSING_SET, processing_key)
        if "no such key" not in str(exc).lower():
            logger.warning("engagement.buffer.rename_failed kind=%s", kind, exc_info=True)
        return batches
    batches.append((token, _decode_hash(client.hgetall(processing_key))))
    return batches


def ack(kind: str, token: str) -> None:
    client = redis_client()
    if client is None or token.startswith("local:"):
        return
    processing_key = f"{PREFIX}:{kind}:processing:{token}"
    try:
        client.delete(processing_key)
        client.srem(PROCESSING_SET, processing_key)
    except Exception:  # noqa: BLE001
        logger.warning("engagement.buffer.ack_failed kind=%s", kind, exc_info=True)


def pending_snapshot(kind: str) -> dict[str, int]:
    """Read-only view of what is waiting (tests and diagnostics)."""
    client = redis_client()
    if client is None:
        with _local.lock:
            return dict(_local.hashes.get(_pending_key(kind), {}))
    return _decode_hash(client.hgetall(_pending_key(kind)))
