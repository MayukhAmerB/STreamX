"""Write-behind presence buffer: Redis per ping, Postgres per batch.

A presence ping or a join/leave event costs one Redis round trip and **no
database write**:

* ``att:last:<session>:<user>``  last ping (``SET ... GET EX``): the wall-clock
  credit for the next ping is measured from it;
* ``att:buf:pending``            one hash for every session, fields
  ``<s>:<u>:sec`` (HINCRBY credited seconds), ``<s>:<u>:first`` (HSETNX first
  seen, epoch) and ``<s>:<u>:last`` (HSET last seen, epoch).

The flush (``flush.py``, a periodic outbox event) hands the hash over with an
atomic ``RENAME`` to ``att:buf:processing:<token>``, applies it with one
``AttendanceFlushLog`` row in one transaction (exactly once), then deletes it.
A batch left behind by a crashed worker is picked up on the next run.

Without Redis (development, tests) an in-process buffer with the same
interface is used. Every function here swallows Redis errors: presence must
never break the live page.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from collections import defaultdict

from django.core.cache import cache

logger = logging.getLogger("apps.attendance.buffer")

PREFIX = "att:buf"
PENDING_KEY = f"{PREFIX}:pending"
PROCESSING_SET = f"{PREFIX}:processing"
LAST_PREFIX = "att:last"
LAST_SEEN_TTL_SECONDS = 8 * 3600

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
    if not isinstance(cache, RedisCache):
        return None
    try:
        return cache._cache.get_client(PREFIX, write=True)  # noqa: SLF001 - documented Django internals
    except Exception:  # noqa: BLE001
        return None


class _LocalBuffer:
    def __init__(self):
        self.lock = threading.Lock()
        self.pending: dict[str, int | float] = {}
        self.last: dict[str, tuple[float, float]] = {}

    def reset(self):
        with self.lock:
            self.pending.clear()
            self.last.clear()


_local = _LocalBuffer()


def reset_local_for_tests():
    _local.reset()


def _last_key(session_id: int, user_id: int) -> str:
    return f"{LAST_PREFIX}:{int(session_id)}:{int(user_id)}"


def swap_last_seen(session_id: int, user_id: int, ts: float) -> float | None:
    """Store ``ts`` as the pair's last ping and return the previous one."""
    key = _last_key(session_id, user_id)
    client = redis_client()
    if client is None:
        with _local.lock:
            previous = _local.last.get(key)
            _local.last[key] = (ts, time.time() + LAST_SEEN_TTL_SECONDS)
        if previous and previous[1] > time.time():
            return previous[0]
        return None
    try:
        previous = client.set(key, f"{ts:.3f}", ex=LAST_SEEN_TTL_SECONDS, get=True)
    except Exception:  # noqa: BLE001
        logger.warning("attendance.buffer.last_seen_failed", exc_info=True)
        return None
    if isinstance(previous, bytes):
        previous = previous.decode("utf-8", "replace")
    try:
        return float(previous) if previous is not None else None
    except (TypeError, ValueError):
        return None


def clear_last_seen(session_id: int, user_id: int) -> None:
    key = _last_key(session_id, user_id)
    client = redis_client()
    if client is None:
        with _local.lock:
            _local.last.pop(key, None)
        return
    try:
        client.delete(key)
    except Exception:  # noqa: BLE001
        logger.warning("attendance.buffer.clear_last_failed", exc_info=True)


def last_seen_many(session_id: int, user_ids) -> dict[int, float]:
    """``{user_id: last ping epoch}`` for the users with a live last-seen key."""
    user_ids = [int(user_id) for user_id in user_ids]
    if not user_ids:
        return {}
    keys = [_last_key(session_id, user_id) for user_id in user_ids]
    client = redis_client()
    result: dict[int, float] = {}
    if client is None:
        now = time.time()
        with _local.lock:
            for user_id, key in zip(user_ids, keys):
                value = _local.last.get(key)
                if value and value[1] > now:
                    result[user_id] = value[0]
        return result
    try:
        values = client.mget(keys)
    except Exception:  # noqa: BLE001
        logger.warning("attendance.buffer.mget_failed", exc_info=True)
        return {}
    for user_id, value in zip(user_ids, values or []):
        if value is None:
            continue
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        try:
            result[user_id] = float(value)
        except (TypeError, ValueError):
            continue
    return result


def record(session_id: int, user_id: int, *, seconds: int, ts: float) -> None:
    """Add ``seconds`` for the pair and stamp first/last seen (one pipeline)."""
    base = f"{int(session_id)}:{int(user_id)}"
    seconds = max(0, int(seconds))
    client = redis_client()
    if client is None:
        with _local.lock:
            pending = _local.pending
            if seconds:
                pending[f"{base}:sec"] = int(pending.get(f"{base}:sec", 0)) + seconds
            pending.setdefault(f"{base}:first", float(ts))
            pending[f"{base}:last"] = float(ts)
        return
    try:
        pipe = client.pipeline(transaction=False)
        if seconds:
            pipe.hincrby(PENDING_KEY, f"{base}:sec", seconds)
        pipe.hsetnx(PENDING_KEY, f"{base}:first", f"{ts:.3f}")
        pipe.hset(PENDING_KEY, f"{base}:last", f"{ts:.3f}")
        pipe.execute()
    except Exception:  # noqa: BLE001 - presence must never break the request
        logger.warning("attendance.buffer.record_failed", exc_info=True)


def _decode_hash(raw) -> dict[str, float]:
    data: dict[str, float] = {}
    for field, value in (raw or {}).items():
        if isinstance(field, bytes):
            field = field.decode("utf-8", "replace")
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        try:
            data[str(field)] = float(value)
        except (TypeError, ValueError):
            continue
    return data


def parse_batch(data: dict[str, float]) -> dict[tuple[int, int], dict[str, float]]:
    """``{(session, user): {"sec": n, "first": epoch, "last": epoch}}``."""
    pairs: dict[tuple[int, int], dict[str, float]] = defaultdict(dict)
    for field, value in data.items():
        parts = str(field).split(":")
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        if parts[2] not in ("sec", "first", "last"):
            continue
        pairs[(int(parts[0]), int(parts[1]))][parts[2]] = value
    return dict(pairs)


def take_batches() -> list[tuple[str, dict[str, float]]]:
    """Hand over the pending hash (and any batch a crashed flush left behind)."""
    client = redis_client()
    if client is None:
        with _local.lock:
            data = dict(_local.pending)
            _local.pending.clear()
        return [(f"local:{secrets.token_hex(8)}", {key: float(value) for key, value in data.items()})] if data else []
    batches = []
    try:
        leftovers = [
            member.decode() if isinstance(member, bytes) else str(member)
            for member in (client.smembers(PROCESSING_SET) or [])
        ]
    except Exception:  # noqa: BLE001
        leftovers = []
    for processing_key in leftovers:
        if not processing_key.startswith(f"{PREFIX}:processing:"):
            continue
        try:
            batches.append((processing_key.rsplit(":", 1)[-1], _decode_hash(client.hgetall(processing_key))))
        except Exception:  # noqa: BLE001
            logger.warning("attendance.buffer.leftover_read_failed", exc_info=True)
    token = secrets.token_hex(12)
    processing_key = f"{PREFIX}:processing:{token}"
    try:
        client.sadd(PROCESSING_SET, processing_key)
        client.rename(PENDING_KEY, processing_key)
    except Exception as exc:  # noqa: BLE001 - "no such key": nothing pending
        try:
            client.srem(PROCESSING_SET, processing_key)
        except Exception:  # noqa: BLE001
            pass
        if "no such key" not in str(exc).lower():
            logger.warning("attendance.buffer.rename_failed", exc_info=True)
        return batches
    batches.append((token, _decode_hash(client.hgetall(processing_key))))
    return batches


def ack(token: str) -> None:
    client = redis_client()
    if client is None or token.startswith("local:"):
        return
    processing_key = f"{PREFIX}:processing:{token}"
    try:
        client.delete(processing_key)
        client.srem(PROCESSING_SET, processing_key)
    except Exception:  # noqa: BLE001
        logger.warning("attendance.buffer.ack_failed", exc_info=True)


def pending_snapshot() -> dict[tuple[int, int], dict[str, float]]:
    """Read-only view of what is waiting (live roster, tests, diagnostics)."""
    client = redis_client()
    if client is None:
        with _local.lock:
            data = {key: float(value) for key, value in _local.pending.items()}
        return parse_batch(data)
    try:
        return parse_batch(_decode_hash(client.hgetall(PENDING_KEY)))
    except Exception:  # noqa: BLE001
        return {}
