"""``live.reconcile``: the server-side authority for live-class state (Phase 2).

Every ``LIVE_RECONCILER_INTERVAL_SECONDS`` (5 s) one worker, under a
DistributedLock, observes each live session:

* OBS broadcast   Owncast ``/api/status`` (cached, single-flight)
* Host Studio     LiveKit ``ListEgress`` for the session's egress + the host
                  heartbeat in Redis (written by the studio every 10 s)
* Meeting         LiveKit ``ListParticipants`` for the room

``decide()`` turns one observation into at most one action. It is a pure
function so the whole table is unit-tested. ``reconcile_live_sessions()``
applies actions with compare-and-set UPDATEs (a concurrent Stop/End/Go Live
always wins) and emits a ``live.transition`` event for each.

Modes (``LIVE_RECONCILER_MODE``):
  off      nothing runs.
  shadow   observe and log what *would* change; write nothing (production
           default for the first weekends).
  enforce  apply the transitions, restart egress, auto-end abandoned classes.

State machine (stream_status while session.status == live)::

  starting --feed--> live --feed lost--> interrupted --feed--> live
                                          |  host publishing: restart egress
                                          |  budget exhausted: failed
                                          `- grace over, host gone: stopped
  failed + host publishing + budget  -> restart egress
  any non-live, feed gone >= N min and host silent -> END (abandoned)
  never live, started >= 6 h and host silent        -> END (never_started)
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from django.core.cache import cache
from django.utils import timezone

from apps.core.concurrency import DistributedLock

from . import lifecycle

logger = logging.getLogger("apps.realtime.reconciler")

ACTION_NOOP = "noop"
ACTION_MARK_LIVE = "mark_live"
ACTION_MARK_INTERRUPTED = "mark_interrupted"
ACTION_MARK_STOPPED = "mark_stopped"
ACTION_MARK_FAILED = "mark_failed"
ACTION_RESTART_EGRESS = "restart_egress"
ACTION_END_SESSION = "end_session"

LIVE = "live"
STARTING = "starting"
INTERRUPTED = "interrupted"
STOPPED = "stopped"
FAILED = "failed"
IDLE = "idle"

MAX_SESSIONS_PER_TICK = 50


@dataclass(frozen=True)
class Policy:
    host_grace_seconds: int = 60
    obs_grace_seconds: int = 45
    abandoned_after_seconds: int = 1200
    never_live_after_seconds: int = 6 * 3600
    starting_timeout_seconds: int = 180

    @classmethod
    def from_settings(cls) -> Policy:
        return cls(
            host_grace_seconds=lifecycle.host_grace_seconds(),
            obs_grace_seconds=lifecycle.obs_offline_grace_seconds(),
            abandoned_after_seconds=lifecycle.abandoned_end_seconds(),
            never_live_after_seconds=lifecycle.never_live_end_seconds(),
            starting_timeout_seconds=lifecycle.starting_timeout_seconds(),
        )


@dataclass(frozen=True)
class Observation:
    session_id: int
    kind: str  # lifecycle.KIND_OBS | KIND_STUDIO | KIND_MEETING
    stream_status: str
    # OBS: Owncast online. Studio: egress running. Meeting: participants > 0.
    # None when the upstream could not be asked: never act on an unknown.
    feed_online: bool | None
    # Studio only: publishing | reconnecting | connected, None = no fresh heartbeat.
    host_state: str | None = None
    host_seen_age: float | None = None  # seconds since any heartbeat; None = never
    feed_lost_age: float | None = None  # seconds since the feed was last seen; None = never seen
    session_age: float = 0.0  # seconds since started_at
    stream_age: float = 0.0  # seconds since the row last changed
    restart_allowed: bool = False
    restart_exhausted: bool = False
    # The row's updated_at when observed: an auto-end only applies to an unchanged row.
    observed_updated_at: object = None


@dataclass(frozen=True)
class Decision:
    action: str
    target: str = ""
    reason: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def is_noop(self) -> bool:
        return self.action == ACTION_NOOP


NOOP = Decision(ACTION_NOOP)


def _host_silent(obs: Observation, seconds: float) -> bool:
    return obs.host_state is None and (obs.host_seen_age is None or obs.host_seen_age >= seconds)


def _abandoned(obs: Observation, policy: Policy) -> Decision | None:
    """End rules for a live session whose stream is not live."""
    if obs.feed_online:
        return None
    if obs.feed_lost_age is not None:
        if obs.feed_lost_age >= policy.abandoned_after_seconds and _host_silent(obs, policy.abandoned_after_seconds):
            return Decision(ACTION_END_SESSION, target="ended", reason=lifecycle.END_REASON_ABANDONED)
        return None
    if obs.session_age >= policy.never_live_after_seconds and _host_silent(obs, policy.abandoned_after_seconds):
        return Decision(ACTION_END_SESSION, target="ended", reason=lifecycle.END_REASON_NEVER_STARTED)
    return None


def decide(obs: Observation, policy: Policy | None = None) -> Decision:
    """The reconciler's transition table for one live session."""
    policy = policy or Policy()
    status = obs.stream_status or IDLE

    if obs.kind == lifecycle.KIND_MEETING:
        if obs.feed_online is None:
            return NOOP
        return _abandoned(obs, policy) or NOOP

    if obs.kind == lifecycle.KIND_OBS:
        if obs.feed_online is None:
            return NOOP
        if obs.feed_online:
            if status != LIVE:
                return Decision(ACTION_MARK_LIVE, target=LIVE, reason="feed_online")
            return NOOP
        if status == LIVE:
            return Decision(ACTION_MARK_INTERRUPTED, target=INTERRUPTED, reason="feed_lost")
        if status == INTERRUPTED:
            if obs.feed_lost_age is None or obs.feed_lost_age >= policy.obs_grace_seconds:
                return Decision(ACTION_MARK_STOPPED, target=STOPPED, reason="grace_expired")
            return NOOP
        return _abandoned(obs, policy) or NOOP

    # Host Studio (LiveKit participant egress -> RTMP -> Owncast).
    publishing = obs.host_state == lifecycle.HOST_PUBLISHING
    if status == LIVE:
        if obs.feed_online is False:
            return Decision(ACTION_MARK_INTERRUPTED, target=INTERRUPTED, reason="egress_lost")
        return NOOP
    if status == INTERRUPTED:
        if obs.feed_online is True:
            return Decision(ACTION_MARK_LIVE, target=LIVE, reason="egress_running")
        if publishing:
            if obs.restart_exhausted:
                return Decision(ACTION_MARK_FAILED, target=FAILED, reason="restart_budget_exhausted")
            if obs.restart_allowed:
                return Decision(ACTION_RESTART_EGRESS, target=LIVE, reason="host_publishing")
            return NOOP  # backoff
        lost_for = obs.feed_lost_age if obs.feed_lost_age is not None else policy.host_grace_seconds
        if obs.host_state == lifecycle.HOST_RECONNECTING and (obs.host_seen_age or 0) < policy.host_grace_seconds:
            # The tab is alive and rejoining: keep viewers on "Host reconnecting".
            if lost_for < policy.host_grace_seconds * 3:
                return NOOP
        if lost_for >= policy.host_grace_seconds:
            return Decision(ACTION_MARK_STOPPED, target=STOPPED, reason="host_grace_expired")
        return NOOP
    if status == FAILED:
        if publishing and obs.restart_allowed:
            return Decision(ACTION_RESTART_EGRESS, target=LIVE, reason="failed_while_publishing")
        return _abandoned(obs, policy) or NOOP
    if status == STARTING:
        if obs.feed_online is True:
            return NOOP  # the Go Live job records live itself
        if obs.stream_age >= policy.starting_timeout_seconds:
            return Decision(ACTION_MARK_FAILED, target=FAILED, reason="start_timeout")
        return NOOP
    return _abandoned(obs, policy) or NOOP


# --- observation ---------------------------------------------------------------


def _owncast_online() -> bool | None:
    from .services import get_owncast_public_status

    try:
        payload = get_owncast_public_status()
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(payload, dict) or "online" not in payload:
        return None
    return bool(payload.get("online"))


LIVEKIT_DOWN_CACHE_KEY = "realtime:reconcile:livekit-unreachable"
LIVEKIT_DOWN_SECONDS = 15
SHADOW_LOG_EVERY_SECONDS = 300


def _livekit_down() -> bool:
    try:
        return bool(cache.get(LIVEKIT_DOWN_CACHE_KEY))
    except Exception:  # noqa: BLE001
        return False


def _mark_livekit_down() -> None:
    # One unreachable LiveKit must not cost a timeout per session per tick
    # (the worker also delivers outbox events): skip LiveKit for a while.
    try:
        cache.set(LIVEKIT_DOWN_CACHE_KEY, True, timeout=LIVEKIT_DOWN_SECONDS)
    except Exception:  # noqa: BLE001
        pass


_UNREACHABLE_MARKERS = (
    "network error",
    "unknown error",
    "timed out",
    "timeout",
    "connection",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
)
_NOT_FOUND_MARKERS = ("not_found", "does not exist", "room not found")


def _livekit_unreachable(exc) -> bool:
    """A connection problem with LiveKit itself (worth the global back-off),
    as opposed to an application error about one room or egress."""
    text = str(exc or "").lower()
    return not text or any(marker in text for marker in _UNREACHABLE_MARKERS)


def _egress_running(session) -> bool | None:
    from . import services

    egress_id = str(session.livekit_egress_id or "").strip()
    if not egress_id:
        return False
    if not services.is_livekit_configured() or _livekit_down():
        return None
    try:
        result = services.get_broadcast_egress_status(egress_id=egress_id)
    except services.LiveKitConfigError:
        return None
    except services.LiveKitEgressError as exc:
        if _livekit_unreachable(exc):
            _mark_livekit_down()
        return None
    return result.get("running")


def _meeting_has_participants(session) -> bool | None:
    """True/False, or None when LiveKit could not be asked.

    A room LiveKit does not know (nobody joined yet, or it closed after its
    empty timeout) has no participants: that is an answer about this meeting,
    not an outage, so it must not blind the reconciler for every session.
    """
    from . import services

    if not services.is_livekit_configured() or _livekit_down():
        return None
    try:
        return services.list_room_participant_count(session.livekit_room_name or session.room_name) > 0
    except services.LiveKitConfigError:
        return None
    except Exception as exc:  # noqa: BLE001
        text = str(exc or "").lower()
        if any(marker in text for marker in _NOT_FOUND_MARKERS):
            return False
        if _livekit_unreachable(exc):
            _mark_livekit_down()
        return None


def _heartbeat_fresh(heartbeat, now) -> bool:
    """A heartbeat counts only within its TTL of the *observation* time.

    The cache TTL usually removes a stale heartbeat first, but every other age
    here (feed lost, host last seen, session age) is measured against ``now``;
    judging presence by the same clock keeps one observation consistent (a
    cache clock that lags, or the E2E test clock, cannot show a host as
    present 30 s after its last heartbeat).
    """
    if not isinstance(heartbeat, dict):
        return False
    try:
        at = float(heartbeat.get("at"))
    except (TypeError, ValueError):
        return True  # no timestamp: trust the cache TTL
    return now.timestamp() - at <= lifecycle.host_heartbeat_ttl_seconds()


def observe(session, *, now=None, owncast_online=None) -> Observation:
    now = now or timezone.now()
    kind = lifecycle.session_kind(session)
    if kind == lifecycle.KIND_OBS:
        feed = owncast_online
    elif kind == lifecycle.KIND_MEETING:
        feed = _meeting_has_participants(session)
    else:
        # Only ask LiveKit when the answer can change something.
        feed = _egress_running(session) if session.stream_status in {LIVE, INTERRUPTED, STARTING} else False
    if feed:
        lifecycle.record_feed_seen(session.pk, now)
    # OBS hosts keep the Host Studio page open (it heartbeats "connected"), so
    # an attended class paused for a break is not auto-ended as abandoned.
    heartbeat = (
        lifecycle.read_host_heartbeat(session.pk) if kind in {lifecycle.KIND_STUDIO, lifecycle.KIND_OBS} else None
    )
    if not _heartbeat_fresh(heartbeat, now):
        heartbeat = None
    allowed, exhausted = lifecycle.restart_budget(session.pk, now) if kind == lifecycle.KIND_STUDIO else (False, False)
    started_at = session.started_at or session.created_at or now
    lost_age = lifecycle.feed_lost_age(session.pk, now)
    if lost_age is None and getattr(session, "stream_interrupted_at", None):
        # Redis lost the bookkeeping: the row still knows when the feed dropped.
        lost_age = max(0.0, (now - session.stream_interrupted_at).total_seconds())
    return Observation(
        session_id=session.pk,
        kind=kind,
        stream_status=session.stream_status,
        feed_online=feed,
        host_state=(heartbeat or {}).get("state"),
        host_seen_age=lifecycle.host_last_seen_age(session.pk, now),
        feed_lost_age=lost_age,
        session_age=max(0.0, (now - started_at).total_seconds()),
        stream_age=max(0.0, (now - (session.updated_at or now)).total_seconds()),
        restart_allowed=allowed,
        restart_exhausted=exhausted,
        observed_updated_at=session.updated_at,
    )


# --- apply -----------------------------------------------------------------------


def apply_decision(session, obs: Observation, decision: Decision, *, now=None) -> bool:
    """Apply one decision with compare-and-set. Returns True when state changed
    (for a restart: when the restart job was queued)."""
    now = now or timezone.now()
    if decision.action == ACTION_END_SESSION:
        # Only the row that was observed: a Go Live or resume in between wins.
        result = lifecycle.end_session(
            session.pk,
            reason=decision.reason,
            expected_stream_status=obs.stream_status,
            expected_updated_at=obs.observed_updated_at,
        )
        return result.transitioned
    if decision.action in {ACTION_MARK_LIVE, ACTION_MARK_INTERRUPTED, ACTION_MARK_STOPPED}:
        extra = {}
        if decision.action == ACTION_MARK_LIVE:
            extra["livekit_egress_error"] = ""
        return lifecycle.cas_stream_status(
            session.pk, expected=obs.stream_status, target=decision.target, now=now, **extra
        )
    if decision.action == ACTION_MARK_FAILED:
        message = {
            "restart_budget_exhausted": (
                "Live delivery stopped repeatedly and automatic restarts are paused. "
                "Check the host connection, then press Resume broadcast."
            ),
            "start_timeout": "Going live took too long. Press Go Live again.",
        }.get(decision.reason, "Live delivery stopped.")
        changed = lifecycle.cas_stream_status(
            session.pk, expected=obs.stream_status, target=FAILED, now=now, livekit_egress_error=message
        )
        if changed and decision.reason == "restart_budget_exhausted":
            # Pages ops through the error log and the restarts metric.
            logger.error("live: egress restart budget exhausted session_id=%s", session.pk)
        return changed
    if decision.action == ACTION_RESTART_EGRESS:
        # Queued, not run here: StartEgress can block for a minute
        # (lifecycle.handle_restart_egress runs it in the outbox).
        heartbeat = lifecycle.read_host_heartbeat(session.pk) or {}
        if not session.resolve_stream_target_url():
            return False
        queued = lifecycle.queue_egress_restart(
            session,
            expected_stream_status=obs.stream_status,
            reason=decision.reason,
            publisher_user_id=heartbeat.get("user_id") or session.host_id,
            now=now,
        )
        return queued is not None
    return False


@dataclass
class TickResult:
    mode: str
    observed: int = 0
    intended: list = field(default_factory=list)
    applied: list = field(default_factory=list)
    skipped_lock: bool = False
    lost_lock: bool = False
    deferred: int = 0


def _live_sessions():
    from .models import RealtimeSession

    return list(
        RealtimeSession.objects.filter(status=RealtimeSession.STATUS_LIVE)
        .order_by("-updated_at")[:MAX_SESSIONS_PER_TICK]
    )


def _first_shadow_report(entry) -> bool:
    """Shadow mode logs each intended transition once per 5 minutes, not every tick."""
    session_id, from_status, action, target, _reason = entry
    try:
        return bool(
            cache.add(
                f"realtime:reconcile:shadow:{session_id}:{from_status}:{action}:{target}",
                1,
                timeout=SHADOW_LOG_EVERY_SECONDS,
            )
        )
    except Exception:  # noqa: BLE001
        return True


# Above the worst case of one session's observation (a LiveKit status call
# times out after LIVEKIT_EGRESS_STATUS_TIMEOUT_SECONDS per base URL); the lock
# is also extended after every session.
LOCK_TTL_SECONDS = 120


def _still_holds(lock) -> bool:
    """Extend the tick lock; False when it is no longer ours."""
    try:
        return bool(lock.extend())
    except Exception:  # noqa: BLE001 - an unknown lock state is not ownership
        return False


def tick_budget_seconds() -> float:
    """Stop observing after this long; the rest wait for the next tick (5 s later)."""
    from django.conf import settings

    try:
        return max(1.0, float(getattr(settings, "LIVE_RECONCILER_TICK_BUDGET_SECONDS", 10) or 10))
    except (TypeError, ValueError):
        return 10.0


def reconcile_live_sessions(*, now=None, mode=None) -> TickResult:
    """One reconciler tick (the ``live.reconcile`` periodic hook)."""
    mode = mode or lifecycle.reconciler_mode()
    result = TickResult(mode=mode)
    if mode == lifecycle.MODE_OFF:
        return result
    lock = DistributedLock("live.reconcile", ttl=LOCK_TTL_SECONDS)
    try:
        acquired = lock.acquire(blocking=False)
    except Exception:  # noqa: BLE001
        acquired = False
    if not acquired:
        result.skipped_lock = True
        return result
    try:
        return _reconcile_locked(result, now=now, lock=lock)
    finally:
        lock.release()


def _reconcile_locked(result: TickResult, *, now=None, lock=None) -> TickResult:
    from .models import RealtimeSession

    policy = Policy.from_settings()
    sessions = _live_sessions()
    owncast_online = None
    if any(lifecycle.session_kind(row) == lifecycle.KIND_OBS for row in sessions):
        owncast_online = _owncast_online()
    started = time.monotonic()
    budget = tick_budget_seconds()
    for index, session in enumerate(sessions):
        if index:
            if time.monotonic() - started >= budget:
                result.deferred = len(sessions) - index
                logger.warning(
                    "live.reconcile: tick budget (%ss) used; %s session(s) wait for the next tick",
                    budget,
                    result.deferred,
                )
                break
            if lock is not None and not _still_holds(lock):
                # The TTL ran out (or Redis lost the key) and another worker
                # may already run its own tick: stop, so two ticks never
                # apply decisions side by side. The next tick re-observes.
                result.lost_lock = True
                result.deferred = len(sessions) - index
                logger.warning(
                    "live.reconcile: lost the tick lock; %s session(s) wait for the next tick", result.deferred
                )
                break
        tick_now = now or timezone.now()
        try:
            obs = observe(session, now=tick_now, owncast_online=owncast_online)
            decision = decide(obs, policy)
        except Exception:  # noqa: BLE001 - one session must not stop the others
            logger.exception("live.reconcile: observing session %s failed", session.pk)
            continue
        result.observed += 1
        if decision.is_noop:
            continue
        entry = (session.pk, obs.stream_status, decision.action, decision.target, decision.reason)
        result.intended.append(entry)
        if result.mode != lifecycle.MODE_ENFORCE:
            if not _first_shadow_report(entry):
                continue
            lifecycle.emit_transition(
                session_id=session.pk,
                kind=obs.kind,
                from_status=obs.stream_status,
                to_status=decision.target or decision.action,
                reason=decision.reason,
                mode=result.mode,
                applied=False,
            )
            continue
        try:
            changed = apply_decision(session, obs, decision, now=tick_now)
        except Exception:  # noqa: BLE001
            logger.exception("live.reconcile: applying %s to session %s failed", decision.action, session.pk)
            continue
        if changed:
            result.applied.append(entry)
            # end_session emits its own event; a queued restart emits when it starts.
            if decision.action not in {ACTION_END_SESSION, ACTION_RESTART_EGRESS}:
                lifecycle.emit_transition(
                    session_id=session.pk,
                    kind=obs.kind,
                    from_status=obs.stream_status,
                    to_status=decision.target,
                    reason=decision.reason,
                    mode=result.mode,
                    applied=True,
                )
        elif decision.action != ACTION_RESTART_EGRESS:
            # Lost the CAS race: a host action moved the row first. Next tick re-reads.
            logger.info(
                "live.reconcile: %s for session %s superseded (stream was %s)",
                decision.action,
                session.pk,
                RealtimeSession.objects.filter(pk=session.pk).values_list("stream_status", flat=True).first(),
            )
    return result
