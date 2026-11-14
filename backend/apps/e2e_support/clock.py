"""A controllable server clock for the end-to-end stack.

``install()`` replaces ``django.utils.timezone.now`` (every app calls
``timezone.now()``; ``localtime``/``localdate`` go through it too). The clock
has three modes, switched by the control API:

* real     the wall clock (default)
* frozen   a fixed instant that only moves when ``advance()`` is called
* travel   the wall clock shifted by an offset (time keeps flowing)

Only ``config.settings.e2e`` calls ``install()``. JWT expiry, cache TTLs and
throttles keep using the real clock, so a frozen server never logs anyone out.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone

_lock = threading.Lock()
_state = {"frozen": None, "offset": timedelta(0)}
_real_now = None


def _wall():
    return datetime.now(dt_timezone.utc)


def now():
    with _lock:
        frozen = _state["frozen"]
        offset = _state["offset"]
    if frozen is not None:
        return frozen
    return _wall() + offset if offset else _wall()


def _parse(value) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value or "").strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("The test clock needs an aware ISO instant, e.g. 2026-11-15T23:50:00+05:30.")
    return parsed.astimezone(dt_timezone.utc)


def freeze(value) -> datetime:
    instant = _parse(value)
    with _lock:
        _state["frozen"] = instant
        _state["offset"] = timedelta(0)
    return instant


def travel(value) -> datetime:
    """Jump to ``value`` and keep flowing from there."""
    instant = _parse(value)
    with _lock:
        _state["frozen"] = None
        _state["offset"] = instant - _wall()
    return now()


def advance(seconds: float) -> datetime:
    delta = timedelta(seconds=float(seconds))
    with _lock:
        if _state["frozen"] is not None:
            _state["frozen"] = _state["frozen"] + delta
        else:
            _state["offset"] = _state["offset"] + delta
    return now()


def reset() -> datetime:
    with _lock:
        _state["frozen"] = None
        _state["offset"] = timedelta(0)
    return now()


def describe() -> dict:
    with _lock:
        frozen = _state["frozen"]
        offset = _state["offset"]
    mode = "frozen" if frozen is not None else ("travel" if offset else "real")
    return {"mode": mode, "now": now().isoformat(), "offset_seconds": offset.total_seconds()}


def install(initial: str = "") -> None:
    """Patch ``django.utils.timezone.now`` once (idempotent)."""
    global _real_now
    from django.utils import timezone as dj_timezone

    if _real_now is None:
        _real_now = dj_timezone.now
        dj_timezone.now = now
    if initial:
        freeze(initial)
