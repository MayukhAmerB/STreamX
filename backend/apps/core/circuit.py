"""Circuit breaker whose state lives in the Django cache.

State is shared by every gunicorn worker/thread and every backend replica
that points at the same Redis, so one replica discovering that Owncast is down
protects all of them.

States::

    CLOSED     calls flow; consecutive failures are counted.
    OPEN       ``failure_threshold`` consecutive failures happened; calls are
               rejected with CircuitOpenError for ``open_seconds``.
    HALF_OPEN  the open window elapsed; exactly ONE caller (single-flight via
               ``cache.add``) is allowed through as a probe. Success closes
               the circuit, failure re-opens it for another window.

Cache keys (``core:cb:<name>:*``)::

    failures   int counter (cache.incr) of consecutive failures, TTL = failure_window
    opened_at  float epoch seconds when the circuit opened, TTL = state_ttl
    probe      owner token of the in-flight half-open probe, TTL = probe_timeout

The breaker fails OPEN on cache errors (i.e. allows calls): Redis trouble must
never turn into an outage of every upstream.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace

from config.metrics import record_circuit_breaker_transition
from django.conf import settings
from django.core.cache import caches

from .errors import UpstreamUnavailable

logger = logging.getLogger("apps.core.circuit")

STATE_CLOSED = "closed"
STATE_OPEN = "open"
STATE_HALF_OPEN = "half_open"


class CircuitOpenError(UpstreamUnavailable):
    code = "circuit_open"
    default_message = "A required service is temporarily unavailable. Please try again shortly."


@dataclass(frozen=True)
class BreakerConfig:
    failure_threshold: int = 5
    failure_window_seconds: int = 60
    open_seconds: float = 30.0
    probe_timeout_seconds: float = 15.0
    cache_alias: str = "default"

    @property
    def state_ttl_seconds(self) -> int:
        # Long enough to survive several open windows; an idle breaker that
        # nobody calls for this long simply resets to closed.
        return int(max(self.open_seconds * 10, 600))


def _config_for(name: str) -> BreakerConfig:
    defaults = dict(getattr(settings, "CIRCUIT_BREAKER_DEFAULTS", {}) or {})
    overrides = dict((getattr(settings, "CIRCUIT_BREAKERS", {}) or {}).get(name, {}) or {})
    merged = {**defaults, **overrides}
    known = {key: merged[key] for key in BreakerConfig.__dataclass_fields__ if key in merged}
    return BreakerConfig(**known)


@dataclass
class Permit:
    """Returned by ``CircuitBreaker.allow``; hand it back to record_*()."""

    breaker: CircuitBreaker
    probe_token: str | None = None
    _done: bool = field(default=False, repr=False)

    @property
    def is_probe(self) -> bool:
        return self.probe_token is not None

    def success(self) -> None:
        if not self._done:
            self._done = True
            self.breaker.record_success(self)

    def failure(self) -> None:
        if not self._done:
            self._done = True
            self.breaker.record_failure(self)

    def release(self) -> None:
        """Neither success nor failure (e.g. a 4xx caused by the caller)."""
        if not self._done:
            self._done = True
            self.breaker.release(self)


class CircuitBreaker:
    def __init__(self, name: str, config: BreakerConfig | None = None, *, clock: Callable[[], float] = time.time):
        if not name or not str(name).strip():
            raise ValueError("Circuit breaker name is required.")
        self.name = str(name).strip()
        self.config = config or _config_for(self.name)
        self._clock = clock
        prefix = f"core:cb:{self.name}"
        self._failures_key = f"{prefix}:failures"
        self._opened_key = f"{prefix}:opened_at"
        self._probe_key = f"{prefix}:probe"

    @property
    def cache(self):
        return caches[self.config.cache_alias]

    # -- inspection --------------------------------------------------------

    def state(self) -> str:
        try:
            opened_at = self.cache.get(self._opened_key)
        except Exception:  # noqa: BLE001
            return STATE_CLOSED
        if opened_at is None:
            return STATE_CLOSED
        if self._clock() - float(opened_at) < self.config.open_seconds:
            return STATE_OPEN
        return STATE_HALF_OPEN

    def snapshot(self) -> dict:
        try:
            failures = int(self.cache.get(self._failures_key) or 0)
        except Exception:  # noqa: BLE001
            failures = 0
        return {"state": self.state(), "consecutive_failures": failures}

    # -- protocol ----------------------------------------------------------

    def allow(self) -> Permit:
        """Return a Permit or raise CircuitOpenError."""
        try:
            opened_at = self.cache.get(self._opened_key)
        except Exception:  # noqa: BLE001
            logger.warning("circuit %s: cache unavailable, failing open", self.name)
            return Permit(self)
        if opened_at is None:
            return Permit(self)
        elapsed = self._clock() - float(opened_at)
        remaining = self.config.open_seconds - elapsed
        if remaining > 0:
            raise CircuitOpenError(upstream=self.name, retry_after=remaining)
        token = uuid.uuid4().hex
        try:
            acquired = self.cache.add(self._probe_key, token, timeout=self.config.probe_timeout_seconds)
        except Exception:  # noqa: BLE001
            return Permit(self)
        if acquired:
            logger.info("circuit %s: half-open probe started", self.name)
            record_circuit_breaker_transition(upstream=self.name, from_state=STATE_OPEN, to_state=STATE_HALF_OPEN)
            return Permit(self, probe_token=token)
        raise CircuitOpenError(upstream=self.name, retry_after=max(1.0, self.config.probe_timeout_seconds / 2))

    def record_success(self, permit: Permit | None = None) -> None:
        try:
            if permit is not None and permit.is_probe:
                self.cache.delete_many([self._opened_key, self._probe_key, self._failures_key])
                logger.warning("circuit %s: closed after successful probe", self.name)
                record_circuit_breaker_transition(upstream=self.name, from_state=STATE_HALF_OPEN, to_state=STATE_CLOSED)
                return
            # Consecutive-failure semantics: one success resets the streak.
            # The read keeps the common all-healthy path to a single GET.
            if self.cache.get(self._failures_key):
                self.cache.delete(self._failures_key)
        except Exception:  # noqa: BLE001
            logger.debug("circuit %s: cache unavailable recording success", self.name)

    def record_failure(self, permit: Permit | None = None) -> None:
        try:
            if permit is not None and permit.is_probe:
                self.cache.set(self._opened_key, self._clock(), timeout=self.config.state_ttl_seconds)
                self.cache.delete(self._probe_key)
                logger.warning("circuit %s: probe failed, re-opened for %ss", self.name, self.config.open_seconds)
                record_circuit_breaker_transition(upstream=self.name, from_state=STATE_HALF_OPEN, to_state=STATE_OPEN)
                return
            self.cache.add(self._failures_key, 0, timeout=self.config.failure_window_seconds)
            try:
                failures = self.cache.incr(self._failures_key)
            except ValueError:
                # Expired between add and incr.
                self.cache.set(self._failures_key, 1, timeout=self.config.failure_window_seconds)
                failures = 1
            if failures >= self.config.failure_threshold:
                if self.cache.add(self._opened_key, self._clock(), timeout=self.config.state_ttl_seconds):
                    self.cache.delete(self._failures_key)
                    logger.warning(
                        "circuit %s: opened after %s consecutive failures (for %ss)",
                        self.name,
                        failures,
                        self.config.open_seconds,
                    )
                    record_circuit_breaker_transition(upstream=self.name, from_state=STATE_CLOSED, to_state=STATE_OPEN)
        except Exception:  # noqa: BLE001
            logger.debug("circuit %s: cache unavailable recording failure", self.name)

    def release(self, permit: Permit | None = None) -> None:
        """Give back a probe slot without changing the state."""
        if permit is None or not permit.is_probe:
            return
        try:
            if self.cache.get(self._probe_key) == permit.probe_token:
                self.cache.delete(self._probe_key)
        except Exception:  # noqa: BLE001
            pass

    def reset(self) -> None:
        self.cache.delete_many([self._opened_key, self._probe_key, self._failures_key])

    def call(self, fn: Callable, *args, is_failure: Callable[[BaseException], bool] | None = None, **kwargs):
        """Run ``fn`` under the breaker. Exceptions count as failures unless
        ``is_failure(exc)`` returns False."""
        permit = self.allow()
        try:
            result = fn(*args, **kwargs)
        except BaseException as exc:
            if is_failure is None or is_failure(exc):
                permit.failure()
            else:
                permit.release()
            raise
        permit.success()
        return result


_registry: dict[str, CircuitBreaker] = {}
_registry_lock = threading.Lock()


def get_breaker(name: str, **config_overrides) -> CircuitBreaker:
    """Process-wide breaker instance for ``name`` (state itself is in the cache)."""
    key = str(name).strip()
    with _registry_lock:
        breaker = _registry.get(key)
        if breaker is None or config_overrides:
            config = _config_for(key)
            if config_overrides:
                config = replace(config, **config_overrides)
            breaker = CircuitBreaker(key, config)
            if not config_overrides:
                _registry[key] = breaker
        return breaker


def known_breakers() -> list[str]:
    configured = set((getattr(settings, "CIRCUIT_BREAKERS", {}) or {}).keys())
    with _registry_lock:
        return sorted(configured | set(_registry.keys()))


def breaker_states() -> dict[str, dict]:
    """Cheap (cache reads only) view of every known breaker, for /health/ready."""
    return {name: get_breaker(name).snapshot() for name in known_breakers()}
