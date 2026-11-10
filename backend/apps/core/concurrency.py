"""Cross-process concurrency helpers backed by the Django cache.

* ``DistributedLock``   mutual exclusion across gunicorn workers/replicas.
* ``get_or_compute``    single-flight cache fill with stale-while-revalidate.
* ``per_request_memo``  memoise a pure function for the current request only.

Backends: production uses Django's built-in ``RedisCache`` (``django-redis``
is NOT installed). With Redis the lock is redis-py's ``Lock`` -- the same
implementation django-redis exposes -- which acquires with ``SET NX PX`` and
releases/extends with an atomic compare-and-delete script, so a holder whose
TTL expired can never delete a successor's lock. Other backends (LocMem in
dev/tests) fall back to ``cache.add`` + get/compare/delete, which is only
race-free inside one process -- fine for LocMem, which is per-process anyway.

Existing ad-hoc equivalents to migrate later (not touched in Phase 0):
``apps/realtime/services.py`` (Owncast status single-flight) and
``apps/users/refresh_rotation.py`` (refresh rotation lock).
"""

from __future__ import annotations

import contextvars
import functools
import logging
import random
import time
import uuid
from collections.abc import Callable, Hashable
from contextlib import contextmanager

from django.core.cache import caches

logger = logging.getLogger("apps.core.concurrency")



class LockNotAcquired(Exception):
    """Raised by ``DistributedLock`` used as a context manager when it times out."""


def _redis_client(cache, key: str):
    """Return the raw redis-py client for Django's RedisCache, else None."""
    try:
        from django.core.cache.backends.redis import RedisCache
    except ImportError:  # pragma: no cover
        return None
    if not isinstance(cache, RedisCache):
        return None
    return cache._cache.get_client(key, write=True)  # noqa: SLF001 - documented Django internals


class DistributedLock:
    """Owner-token lock with a TTL.

    ::

        with DistributedLock(f"egress:{session.pk}", ttl=30, blocking_timeout=5):
            ...  # raises LockNotAcquired after 5s of waiting

        lock = DistributedLock("recording-sweep", ttl=600)
        if lock.acquire(blocking=False):
            try: ...
            finally: lock.release()

    ``ttl`` bounds how long a crashed holder blocks others; pick it above the
    worst-case critical section and call ``extend()`` for long work.
    """

    def __init__(self, name: str, *, ttl: float = 30.0, blocking_timeout: float | None = 0, cache_alias: str = "default", poll_interval: float = 0.05):
        if not name:
            raise ValueError("Lock name is required.")
        if ttl <= 0:
            raise ValueError("Lock ttl must be positive.")
        self.name = str(name)
        self.ttl = float(ttl)
        self.blocking_timeout = blocking_timeout
        self.poll_interval = max(0.01, float(poll_interval))
        self.cache = caches[cache_alias]
        self.key = f"core:lock:{self.name}"
        self.token: str | None = None
        self._redis_lock = None
        client = _redis_client(self.cache, self.key)
        if client is not None:
            raw_key = self.cache.make_and_validate_key(self.key)
            self._redis_lock = client.lock(raw_key, timeout=self.ttl, sleep=self.poll_interval, thread_local=False)

    @property
    def backend(self) -> str:
        return "redis" if self._redis_lock is not None else "cache"

    def acquire(self, blocking: bool | None = None, timeout: float | None = None) -> bool:
        wait = self.blocking_timeout if timeout is None else timeout
        if blocking is False:
            wait = 0
        wait = max(0.0, float(wait or 0))
        token = uuid.uuid4().hex
        if self._redis_lock is not None:
            acquired = self._redis_lock.acquire(blocking=wait > 0, blocking_timeout=wait or None, token=token)
            self.token = token if acquired else None
            return bool(acquired)
        deadline = time.monotonic() + wait
        while True:
            if self.cache.add(self.key, token, timeout=self.ttl):
                self.token = token
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(min(self.poll_interval, max(0.0, deadline - time.monotonic())))

    def release(self) -> bool:
        """Release only if we still own it. Returns False if the lock expired/was taken."""
        if self.token is None:
            return False
        token, self.token = self.token, None
        if self._redis_lock is not None:
            from redis.exceptions import LockError

            try:
                self._redis_lock.local.token = token.encode() if isinstance(token, str) else token
                self._redis_lock.release()
                return True
            except LockError:
                logger.warning("lock %s expired before release", self.name)
                return False
        if self.cache.get(self.key) == token:
            self.cache.delete(self.key)
            return True
        logger.warning("lock %s expired before release", self.name)
        return False

    def extend(self, additional_ttl: float | None = None) -> bool:
        """Reset the TTL while still owning the lock."""
        if self.token is None:
            return False
        ttl = float(additional_ttl or self.ttl)
        if self._redis_lock is not None:
            from redis.exceptions import LockError

            try:
                self._redis_lock.local.token = self.token.encode()
                return bool(self._redis_lock.extend(ttl, replace_ttl=True))
            except LockError:
                return False
        if self.cache.get(self.key) == self.token:
            return bool(self.cache.touch(self.key, timeout=ttl))
        return False

    def locked(self) -> bool:
        if self._redis_lock is not None:
            return bool(self._redis_lock.locked())
        return self.cache.get(self.key) is not None

    def __enter__(self):
        if not self.acquire():
            raise LockNotAcquired(f"Could not acquire lock {self.name!r}.")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.release()
        return False


# --- single flight -------------------------------------------------------------

_MISSING = object()


def get_or_compute[T](
    key: str,
    ttl: float,
    compute: Callable[[], T],
    *,
    stale_ttl: float = 0,
    lock_ttl: float = 10,
    wait_timeout: float = 2.0,
    cache_alias: str = "default",
    serve_stale_on_error: bool = True,
) -> T:
    """Cache ``compute()`` under ``key`` so only ONE caller recomputes at a time.

    * fresh hit (< ttl)            -> cached value, no lock.
    * stale hit (ttl..ttl+stale)   -> one caller (lock winner) recomputes
                                      synchronously; everyone else gets the
                                      stale value immediately (no stampede).
    * miss                         -> lock winner computes; others poll for up
                                      to ``wait_timeout`` then compute themselves
                                      (bounded latency beats a hung request).
    * compute raises               -> stale value if we have one and
                                      ``serve_stale_on_error``; else re-raise.
    * cache down                   -> compute directly.

    ``compute`` must return something picklable; ``None`` is cached too.
    """
    cache = caches[cache_alias]
    cache_key = f"core:sf:{key}"
    lock_name = f"sf:{key}"
    now = time.time()

    try:
        entry = cache.get(cache_key, _MISSING)
    except Exception:  # noqa: BLE001
        logger.warning("single-flight %s: cache unavailable, computing directly", key)
        return compute()

    def _store(value):
        try:
            cache.set(cache_key, {"v": value, "fresh_until": time.time() + ttl}, timeout=max(1, ttl + max(0, stale_ttl)))
        except Exception:  # noqa: BLE001
            logger.debug("single-flight %s: cache set failed", key)

    def _compute_locked(stale_value=_MISSING):
        try:
            value = compute()
        except Exception:
            if stale_value is not _MISSING and serve_stale_on_error:
                logger.warning("single-flight %s: compute failed, serving stale value", key, exc_info=True)
                return stale_value
            raise
        _store(value)
        return value

    if entry is not _MISSING and isinstance(entry, dict) and "v" in entry:
        if now < float(entry.get("fresh_until", 0)):
            return entry["v"]
        # Stale: one revalidator, everyone else serves stale.
        lock = DistributedLock(lock_name, ttl=lock_ttl, cache_alias=cache_alias)
        try:
            acquired = lock.acquire(blocking=False)
        except Exception:  # noqa: BLE001
            acquired = False
        if not acquired:
            return entry["v"]
        try:
            return _compute_locked(stale_value=entry["v"])
        finally:
            lock.release()

    lock = DistributedLock(lock_name, ttl=lock_ttl, cache_alias=cache_alias)
    try:
        acquired = lock.acquire(blocking=False)
    except Exception:  # noqa: BLE001
        return compute()
    if acquired:
        try:
            return _compute_locked()
        finally:
            lock.release()

    deadline = time.monotonic() + max(0.0, wait_timeout)
    delay = 0.02
    while time.monotonic() < deadline:
        time.sleep(delay + random.uniform(0, delay))
        delay = min(delay * 2, 0.25)
        entry = cache.get(cache_key, _MISSING)
        if entry is not _MISSING and isinstance(entry, dict) and "v" in entry:
            return entry["v"]
    logger.info("single-flight %s: waited %.1fs for the leader, computing locally", key, wait_timeout)
    return _compute_locked()


def invalidate(key: str, *, cache_alias: str = "default") -> None:
    caches[cache_alias].delete(f"core:sf:{key}")


# --- per-request memoisation ---------------------------------------------------

_request_memo: contextvars.ContextVar[dict | None] = contextvars.ContextVar("core_request_memo", default=None)


@contextmanager
def request_scope():
    """Open a memo scope. ``config.observability.RequestContextMiddleware``
    wraps every request in one; management commands/tests may open their own."""
    token = _request_memo.set({})
    try:
        yield
    finally:
        _request_memo.reset(token)


def request_memo() -> dict | None:
    return _request_memo.get()


def memo_get_or_set[T](key: Hashable, compute: Callable[[], T]) -> T:
    """Memoise ``compute()`` for the current request; no-op outside a scope."""
    memo = _request_memo.get()
    if memo is None:
        return compute()
    if key in memo:
        return memo[key]
    value = compute()
    memo[key] = value
    return value


def per_request_memo[T](func: Callable[..., T]) -> Callable[..., T]:
    """Decorator: same args within one request -> computed once.

    Arguments must be hashable (pass ids, not model instances, unless the
    instance's identity is what you mean). Outside a request scope the
    function is simply called, so it is safe in workers and shells.
    """

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        key = (func.__module__, func.__qualname__, args, tuple(sorted(kwargs.items())))
        try:
            hash(key)
        except TypeError:
            return func(*args, **kwargs)
        return memo_get_or_set(key, lambda: func(*args, **kwargs))

    wrapper.uncached = func  # type: ignore[attr-defined]
    return wrapper

