"""Server-owned live-class lifecycle (Phase 2).

One place for the state the live reconciler, the host heartbeat and every
End path share:

* ``reconciler_mode()``      LIVE_RECONCILER_MODE = off | shadow | enforce.
* host heartbeat             a Redis key with a short TTL written by the Host
                             Studio heartbeat; the reconciler reads it.
* feed bookkeeping           when the reconciler last saw the feed (Owncast
                             online, egress running, meeting participants).
* ``end_session()``          the single idempotent End: CAS to ENDED, stop
                             the stream, finalize the recording, and a
                             ``live.ended`` outbox event whose handler stops
                             the LiveKit egress and deletes the room.
* async Go Live              ``request_go_live()`` (202) and the
                             ``realtime.go_live`` outbox handler.
* egress restart budget      shared by the heartbeat and the reconciler,
                             with exponential backoff.

Everything here is safe to call repeatedly: transitions are compare-and-set
UPDATEs, outbox events carry dedupe keys, and LiveKit cleanup treats
"already gone" as success.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.core.outbox import outbox_handler, publish

logger = logging.getLogger("apps.realtime.lifecycle")
ops_logger = logging.getLogger("ops.realtime")

MODE_OFF = "off"
MODE_SHADOW = "shadow"
MODE_ENFORCE = "enforce"
MODES = (MODE_OFF, MODE_SHADOW, MODE_ENFORCE)

HOST_PUBLISHING = "publishing"
HOST_RECONNECTING = "reconnecting"
HOST_CONNECTED = "connected"
HOST_STATES = (HOST_PUBLISHING, HOST_RECONNECTING, HOST_CONNECTED)

END_REASON_HOST = "host"
END_REASON_ADMIN = "admin"
END_REASON_ABANDONED = "abandoned"
END_REASON_NEVER_STARTED = "never_started"

KIND_OBS = "obs"
KIND_STUDIO = "studio"
KIND_MEETING = "meeting"

EVENT_LIVE_ENDED = "live.ended"
EVENT_GO_LIVE = "realtime.go_live"

EGRESS_RESTART_WINDOW_SECONDS = 600
EGRESS_RESTART_BACKOFF_CAP_SECONDS = 60
LAST_LIVE_ACTIVITY_KEY = "realtime:live:last-activity"


# --- configuration ------------------------------------------------------------


def reconciler_mode() -> str:
    mode = str(getattr(settings, "LIVE_RECONCILER_MODE", MODE_SHADOW) or "").strip().lower()
    return mode if mode in MODES else MODE_SHADOW


def enforcing() -> bool:
    return reconciler_mode() == MODE_ENFORCE


def _setting_int(name: str, default: int, *, minimum: int = 0) -> int:
    try:
        value = int(getattr(settings, name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


def host_heartbeat_ttl_seconds() -> int:
    return _setting_int("REALTIME_HOST_HEARTBEAT_TTL_SECONDS", 30, minimum=10)


def host_grace_seconds() -> int:
    return _setting_int("REALTIME_HOST_GRACE_SECONDS", 60, minimum=10)


def obs_offline_grace_seconds() -> int:
    return _setting_int("REALTIME_OWNCAST_OFFLINE_GRACE_SECONDS", 45, minimum=0)


def abandoned_end_seconds() -> int:
    return _setting_int("REALTIME_ABANDONED_END_MINUTES", 20, minimum=1) * 60


def never_live_end_seconds() -> int:
    from .schedule import attendee_join_max_live_hours

    hours = attendee_join_max_live_hours() or 6.0
    return int(hours * 3600)


def starting_timeout_seconds() -> int:
    return _setting_int("REALTIME_STREAM_STARTING_TIMEOUT_SECONDS", 180, minimum=30)


def max_auto_restarts() -> int:
    return _setting_int("REALTIME_HOST_EGRESS_MAX_AUTO_RESTARTS", 5, minimum=0)


def session_kind(session) -> str:
    if session.session_type == session.TYPE_MEETING:
        return KIND_MEETING
    if session.stream_service == session.STREAM_SERVICE_OBS:
        return KIND_OBS
    return KIND_STUDIO


def _now_ts(now=None) -> float:
    return (now or timezone.now()).timestamp()


# --- host heartbeat (Redis) ---------------------------------------------------


def _heartbeat_key(session_id) -> str:
    return f"realtime:host-heartbeat:{session_id}"


def _host_last_seen_key(session_id) -> str:
    return f"realtime:host-last-seen:{session_id}"


def _reconnecting_since_key(session_id) -> str:
    return f"realtime:host-reconnecting-since:{session_id}"


def normalize_host_state(state, *, publishing: bool) -> str:
    value = str(state or "").strip().lower()
    if value in HOST_STATES:
        return value
    return HOST_PUBLISHING if publishing else HOST_CONNECTED


def record_host_heartbeat(session_id, *, state: str, user_id=None, now=None) -> dict:
    """Store the host's latest heartbeat. Never raises (Redis trouble is logged)."""
    at = _now_ts(now)
    payload = {"state": state, "at": at, "user_id": user_id}
    try:
        cache.set(_heartbeat_key(session_id), payload, timeout=host_heartbeat_ttl_seconds())
        cache.set(_host_last_seen_key(session_id), at, timeout=24 * 3600)
        if state == HOST_RECONNECTING:
            cache.add(_reconnecting_since_key(session_id), at, timeout=6 * 3600)
        else:
            cache.delete(_reconnecting_since_key(session_id))
    except Exception:  # noqa: BLE001
        logger.warning("host heartbeat for session %s could not be stored", session_id, exc_info=True)
    return payload


def read_host_heartbeat(session_id) -> dict | None:
    """The fresh heartbeat (within the TTL), else None."""
    try:
        value = cache.get(_heartbeat_key(session_id))
    except Exception:  # noqa: BLE001
        return None
    return value if isinstance(value, dict) else None


def host_last_seen_age(session_id, now=None) -> float | None:
    try:
        value = cache.get(_host_last_seen_key(session_id))
    except Exception:  # noqa: BLE001
        return None
    if value is None:
        return None
    return max(0.0, _now_ts(now) - float(value))


def host_reconnecting_for(session_id, now=None) -> float | None:
    try:
        value = cache.get(_reconnecting_since_key(session_id))
    except Exception:  # noqa: BLE001
        return None
    if value is None:
        return None
    return max(0.0, _now_ts(now) - float(value))


# --- feed bookkeeping ---------------------------------------------------------


def _feed_seen_key(session_id) -> str:
    return f"realtime:feed-last-seen:{session_id}"


def record_feed_seen(session_id, now=None) -> None:
    try:
        cache.set(_feed_seen_key(session_id), _now_ts(now), timeout=24 * 3600)
        cache.set(LAST_LIVE_ACTIVITY_KEY, _now_ts(now), timeout=24 * 3600)
    except Exception:  # noqa: BLE001
        logger.debug("feed bookkeeping failed for session %s", session_id)


def feed_lost_age(session_id, now=None) -> float | None:
    """Seconds since the feed was last seen; None when it was never seen."""
    try:
        value = cache.get(_feed_seen_key(session_id))
    except Exception:  # noqa: BLE001
        return None
    if value is None:
        return None
    return max(0.0, _now_ts(now) - float(value))


def mark_live_activity(now=None) -> None:
    try:
        cache.set(LAST_LIVE_ACTIVITY_KEY, _now_ts(now), timeout=24 * 3600)
    except Exception:  # noqa: BLE001
        pass


def seconds_since_live_activity(now=None) -> float | None:
    try:
        value = cache.get(LAST_LIVE_ACTIVITY_KEY)
    except Exception:  # noqa: BLE001
        return None
    if value is None:
        return None
    return max(0.0, _now_ts(now) - float(value))


# --- egress restart budget ----------------------------------------------------


def restart_count_key(session_id) -> str:
    # Shared with the heartbeat view's automatic restart budget.
    return f"realtime:host-egress:{session_id}:auto-restarts"


def _restart_not_before_key(session_id) -> str:
    return f"realtime:host-egress:{session_id}:next-restart-at"


def restart_budget(session_id, now=None) -> tuple[bool, bool]:
    """``(allowed_now, exhausted)`` for an automatic egress restart."""
    try:
        count = int(cache.get(restart_count_key(session_id)) or 0)
        not_before = cache.get(_restart_not_before_key(session_id))
    except Exception:  # noqa: BLE001
        return False, False
    if count >= max_auto_restarts():
        return False, True
    if not_before is not None and _now_ts(now) < float(not_before):
        return False, False
    return True, False


def consume_restart_budget(session_id, now=None) -> int:
    """Count one automatic restart and push the next one out (exponential backoff)."""
    key = restart_count_key(session_id)
    try:
        cache.add(key, 0, timeout=EGRESS_RESTART_WINDOW_SECONDS)
        try:
            count = int(cache.incr(key))
        except ValueError:
            count = 1
            cache.set(key, count, timeout=EGRESS_RESTART_WINDOW_SECONDS)
        base = _setting_int("REALTIME_EGRESS_RESTART_BACKOFF_SECONDS", 5, minimum=1)
        delay = min(EGRESS_RESTART_BACKOFF_CAP_SECONDS, base * (2 ** max(0, count - 1)))
        cache.set(_restart_not_before_key(session_id), _now_ts(now) + delay, timeout=EGRESS_RESTART_WINDOW_SECONDS)
        return count
    except Exception:  # noqa: BLE001
        return 0


def reset_restart_budget(session_id) -> None:
    try:
        cache.delete_many([restart_count_key(session_id), _restart_not_before_key(session_id)])
    except Exception:  # noqa: BLE001
        pass


# --- transition events --------------------------------------------------------

try:  # pragma: no cover - prometheus_client is a hard dependency in production
    from prometheus_client import Counter

    LIVE_TRANSITIONS_TOTAL = Counter(
        "streamx_live_transitions_total",
        "Live-class state transitions decided by the reconciler or an End path.",
        labelnames=("kind", "to_status", "reason", "mode"),
    )
    LIVE_EGRESS_RESTARTS_TOTAL = Counter(
        "streamx_live_egress_restarts_total",
        "Automatic Host Studio egress restarts by outcome.",
        labelnames=("source", "outcome"),
    )
except Exception:  # noqa: BLE001
    LIVE_TRANSITIONS_TOTAL = None
    LIVE_EGRESS_RESTARTS_TOTAL = None


def _metrics_on() -> bool:
    return bool(getattr(settings, "METRICS_ENABLED", True))


def emit_transition(*, session_id, kind, from_status, to_status, reason, mode, applied) -> None:
    """Structured event for every (intended or applied) lifecycle transition."""
    ops_logger.info(
        "live.transition session_id=%s kind=%s from=%s to=%s reason=%s mode=%s applied=%s",
        session_id,
        kind,
        from_status,
        to_status,
        reason,
        mode,
        applied,
    )
    if LIVE_TRANSITIONS_TOTAL is not None and _metrics_on():
        try:
            LIVE_TRANSITIONS_TOTAL.labels(
                kind=str(kind)[:20], to_status=str(to_status)[:20], reason=str(reason)[:40], mode=str(mode)[:10]
            ).inc()
        except Exception:  # noqa: BLE001
            pass


def record_egress_restart(*, source: str, outcome: str) -> None:
    if LIVE_EGRESS_RESTARTS_TOTAL is not None and _metrics_on():
        try:
            LIVE_EGRESS_RESTARTS_TOTAL.labels(source=str(source)[:20], outcome=str(outcome)[:20]).inc()
        except Exception:  # noqa: BLE001
            pass


# --- reconciler egress restart (outbox job) -------------------------------------

EVENT_RESTART_EGRESS = "live.restart_egress"


def queue_egress_restart(session, *, expected_stream_status: str, reason: str, publisher_user_id=None, now=None):
    """Spend one unit of the restart budget and queue the restart as an outbox job.

    The reconciler tick only decides; StartEgress (a Twirp call that can take
    a minute) runs in the outbox handler, outside the reconciler lock, so a
    slow LiveKit cannot stall the tick or outlive its lock. A second start is
    prevented by the handler itself (per-session egress lock and a
    compare-and-set on the stream status), not by the dedupe key.

    The dedupe key names this budget unit *and* when it was spent: the count
    restarts at 1 when the budget window expires, and a key of the count alone
    would collide with the delivered job of an earlier window and silently
    drop the restart. Returns None (nothing queued) when the budget could not
    be counted, so restarts never run unbounded while Redis misbehaves.
    """
    count = consume_restart_budget(session.pk, now)
    if count <= 0:
        logger.warning("egress restart for session %s not queued: the restart budget could not be counted", session.pk)
        return None
    return publish(
        EVENT_RESTART_EGRESS,
        {
            "session_id": session.pk,
            "expected_stream_status": expected_stream_status,
            "publisher_user_id": publisher_user_id,
            "reason": reason,
        },
        dedupe_key=f"egress-restart:{session.pk}:{count}:{int(_now_ts(now))}",
        max_attempts=1,
    )


@outbox_handler(EVENT_RESTART_EGRESS, max_attempts=1)
def handle_restart_egress(event):
    """Restart a Host Studio broadcast egress the reconciler asked for.

    Re-checks the row first: an End, Stop or Go Live since the decision wins
    (the restart itself is also compare-and-set on the stream status).
    """
    from . import views as realtime_views
    from .models import RealtimeSession

    payload = event.payload or {}
    session = RealtimeSession.objects.filter(pk=payload.get("session_id")).first()
    expected = str(payload.get("expected_stream_status") or "")
    if session is None or session.status != RealtimeSession.STATUS_LIVE or session.stream_status != expected:
        return {"outcome": "superseded"}
    rtmp_target_url = session.resolve_stream_target_url()
    if not rtmp_target_url:
        return {"outcome": "no_target"}
    heartbeat = read_host_heartbeat(session.pk) or {}
    outcome, _error = realtime_views._restart_host_broadcast_egress(
        session=session,
        request=None,
        publisher_user_id=payload.get("publisher_user_id") or heartbeat.get("user_id") or session.host_id,
        rtmp_target_url=rtmp_target_url,
        expected_stream_status=expected,
    )
    record_egress_restart(source="reconciler", outcome=outcome)
    if outcome == realtime_views.EGRESS_RESTART_STARTED:
        emit_transition(
            session_id=session.pk,
            kind=session_kind(session),
            from_status=expected,
            to_status=session.STREAM_LIVE,
            reason=str(payload.get("reason") or "restart_egress"),
            mode=reconciler_mode(),
            applied=True,
        )
    return {"outcome": outcome}


# --- compare-and-set stream transitions ---------------------------------------


def cas_stream_status(session_id, *, expected: str, target: str, now=None, **extra) -> bool:
    """``UPDATE ... WHERE stream_status = expected AND status = 'live'``.

    Leaving "live" records ``stream_interrupted_at`` (first time only);
    entering "live" clears it.
    """
    from .models import RealtimeSession
    from .policies.transitions import ensure_stream_transition

    ensure_stream_transition(expected, target)
    now = now or timezone.now()
    values = {"stream_status": target, "updated_at": now, **extra}
    if target == RealtimeSession.STREAM_LIVE:
        values.setdefault("stream_interrupted_at", None)
    elif target == RealtimeSession.STREAM_INTERRUPTED:
        values.setdefault("stream_interrupted_at", now)
    updated = RealtimeSession.objects.filter(
        pk=session_id,
        status=RealtimeSession.STATUS_LIVE,
        stream_status=expected,
    ).update(**values)
    return updated == 1


# --- end_session --------------------------------------------------------------


@dataclass(frozen=True)
class EndResult:
    session: object
    transitioned: bool
    stopped_egress_id: str
    event_id: int | None


def _is_gone_error(exc) -> bool:
    text = str(exc or "").lower()
    return any(
        marker in text
        for marker in (
            "http 404",
            "http 412",
            "not found",
            "not_found",
            "does not exist",
            "egress_complete",
            "egress_failed",
            "egress_aborted",
            "cannot be stopped",
            "failed_precondition",
            "already",
        )
    )


def end_session(
    session_or_id,
    *,
    reason: str,
    actor=None,
    request=None,
    expected_stream_status: str | None = None,
    expected_updated_at=None,
) -> EndResult:
    """End a live (or scheduled) session. Idempotent: every End path calls this.

    ``expected_stream_status`` / ``expected_updated_at`` (the reconciler's
    auto-end): under the row lock, skip the End when the row changed since it
    was observed (the host pressed Go Live or resumed in between). Host and
    admin Ends pass neither and always win.

    1. Under a row lock: CAS the session to ENDED (first caller wins and sets
       ``end_reason``), stop the stream (CAS to "stopped", egress id cleared)
       and publish ``live.ended`` with the egress id and room name.
    2. After commit: request the recording finalize and re-sync the fixed OBS
       key (both already idempotent), clear the live caches.

    LiveKit work (StopEgress, DeleteRoom) runs in the ``live.ended`` handler
    in the worker, with retries, so an End request never waits on LiveKit.
    """
    from .models import RealtimeSession

    session_id = getattr(session_or_id, "pk", session_or_id)
    now = timezone.now()
    with transaction.atomic():
        row = RealtimeSession.objects.select_for_update().get(pk=session_id)
        if row.status != RealtimeSession.STATUS_ENDED and (
            (expected_stream_status is not None and row.stream_status != expected_stream_status)
            or (expected_updated_at is not None and row.updated_at != expected_updated_at)
        ):
            logger.info(
                "end_session(%s) skipped for session %s: the row changed since it was observed (stream %s)",
                reason,
                row.pk,
                row.stream_status,
            )
            return EndResult(session=row, transitioned=False, stopped_egress_id="", event_id=None)
        transitioned = row.status != RealtimeSession.STATUS_ENDED
        stream_was = row.stream_status
        egress_id = str(row.livekit_egress_id or "").strip()
        update_fields = []
        if transitioned:
            row.status = RealtimeSession.STATUS_ENDED
            row.ended_at = now
            row.end_reason = str(reason or "")[:40]
            update_fields += ["status", "ended_at", "end_reason"]
        if row.stream_status not in {RealtimeSession.STREAM_STOPPED, RealtimeSession.STREAM_IDLE} or egress_id:
            if row.stream_status not in {RealtimeSession.STREAM_STOPPED, RealtimeSession.STREAM_IDLE}:
                row.stream_status = RealtimeSession.STREAM_STOPPED
                update_fields.append("stream_status")
            if egress_id:
                row.livekit_egress_id = ""
                update_fields.append("livekit_egress_id")
        if update_fields:
            row.save(update_fields=[*update_fields, "updated_at"])
        kind = session_kind(row)
        event = None
        if transitioned or egress_id:
            event = publish(
                EVENT_LIVE_ENDED,
                {
                    "session_id": row.pk,
                    "kind": kind,
                    "egress_id": egress_id,
                    "room_name": row.livekit_room_name or row.room_name,
                    "reason": str(reason or ""),
                },
                dedupe_key=f"live-ended:{row.pk}:{egress_id or 'none'}",
            )
    if transitioned:
        emit_transition(
            session_id=row.pk,
            kind=kind,
            from_status=stream_was,
            to_status="ended",
            reason=reason,
            mode=reconciler_mode(),
            applied=True,
        )
        mark_live_activity(now)
    _after_end(row, request=request, stream_was=stream_was, transitioned=transitioned)
    clear_live_keys(row.pk)
    return EndResult(session=row, transitioned=transitioned, stopped_egress_id=egress_id, event_id=getattr(event, "pk", None))


def _after_end(session, *, request, stream_was, transitioned) -> None:
    from .recording import services as class_recording_services

    try:
        class_recording_services.request_finalize(session, reason="session_ended", request=request)
    except Exception:  # noqa: BLE001 - recording must never block End
        ops_logger.exception("Class recording finalize request failed. session_id=%s", session.pk)
    if (
        transitioned
        and session_kind(session) == KIND_OBS
        and stream_was != session.STREAM_STOPPED
    ):
        from . import views as realtime_views

        try:
            rotation = realtime_views._rotate_obs_stream_key_if_enabled(session=session)
        except Exception as exc:  # noqa: BLE001
            rotation = {"error": str(exc)}
        if rotation.get("error"):
            session.livekit_egress_error = str(rotation["error"])[:1000]
            session.save(update_fields=["livekit_egress_error", "updated_at"])


def clear_live_keys(session_id) -> None:
    try:
        cache.delete_many(
            [
                _heartbeat_key(session_id),
                _reconnecting_since_key(session_id),
                go_live_state_key(session_id),
                f"realtime:host-egress:{session_id}:last-check",
                restart_count_key(session_id),
                _restart_not_before_key(session_id),
            ]
        )
    except Exception:  # noqa: BLE001
        pass


@outbox_handler(EVENT_LIVE_ENDED, max_attempts=6)
def handle_live_ended(event):
    """Stop the broadcast egress and delete the LiveKit room. Idempotent."""
    from . import services

    payload = event.payload or {}
    session_id = payload.get("session_id")
    egress_id = str(payload.get("egress_id") or "").strip()
    room_name = str(payload.get("room_name") or "").strip()
    kind = str(payload.get("kind") or "")
    errors = []
    if egress_id:
        try:
            services.stop_room_broadcast_egress(egress_id=egress_id)
        except services.LiveKitConfigError:
            pass
        except services.LiveKitEgressError as exc:
            if not _is_gone_error(exc):
                errors.append(f"StopEgress: {exc}")
    if kind in {KIND_STUDIO, KIND_MEETING} and room_name and services.is_livekit_configured():
        try:
            services.delete_livekit_room(room_name)
        except services.LiveKitConfigError:
            pass
        except services.LiveKitRoomServiceError as exc:
            if not _is_gone_error(exc):
                errors.append(f"DeleteRoom: {exc}")
    clear_live_keys(session_id)
    if errors:
        raise RuntimeError("; ".join(errors)[:500])
    ops_logger.info("live.ended cleanup done session_id=%s egress_id=%s room=%s", session_id, egress_id or "-", room_name)
    return {"session_id": session_id, "egress_id": egress_id, "room_name": room_name}


# --- async Go Live ------------------------------------------------------------


def go_live_state_key(session_id) -> str:
    return f"realtime:go-live:{session_id}"


def read_go_live_state(session_id) -> dict:
    try:
        value = cache.get(go_live_state_key(session_id))
    except Exception:  # noqa: BLE001
        value = None
    return value if isinstance(value, dict) else {}


def _store_go_live_state(session_id, **values) -> dict:
    # The same clock ``go_live_job_is_stale`` reads (timezone.now), so the
    # staleness and timeout checks stay consistent under a test clock.
    state = {**read_go_live_state(session_id), **values, "updated_at": _now_ts()}
    try:
        cache.set(go_live_state_key(session_id), state, timeout=3600)
    except Exception:  # noqa: BLE001
        pass
    return state


# A queued Go Live job the worker has not picked up after this long is stale
# (worker down or backlogged, event lost): the next Go Live re-publishes it
# instead of answering "already starting" for the hour the state lives.
GO_LIVE_QUEUED_STALE_SECONDS = 30
# A job the worker took but never finished (worker killed mid-StartEgress).
# Longer than the egress lock, so a slow but healthy start is not doubled.
GO_LIVE_STARTING_STALE_SECONDS = 150


def go_live_job_is_stale(state: dict, now=None) -> bool:
    phase = state.get("state")
    limit = {"queued": GO_LIVE_QUEUED_STALE_SECONDS, "starting": GO_LIVE_STARTING_STALE_SECONDS}.get(phase)
    if limit is None:
        return True
    try:
        age = _now_ts(now) - float(state.get("updated_at") or 0)
    except (TypeError, ValueError):
        return True
    return age >= limit


def open_session_for_start(session, now=None) -> bool:
    """scheduled -> live (CAS) when the host starts the stream.

    Pressing Start Live / Go Live opens the class: students can join and wait
    on the player for the feed, and the reconciler (which only watches live
    sessions) takes over. A concurrent End always wins. Returns True when this
    call opened it; ``session`` is updated in memory either way.
    """
    from django.db.models import F
    from django.db.models.functions import Coalesce

    from .models import RealtimeSession

    moment = now or timezone.now()
    opened = (
        RealtimeSession.objects.filter(pk=session.pk, status=RealtimeSession.STATUS_SCHEDULED).update(
            status=RealtimeSession.STATUS_LIVE,
            started_at=Coalesce(F("started_at"), moment),
            ended_at=None,
            updated_at=moment,
        )
        == 1
    )
    if opened:
        session.refresh_from_db(fields=["status", "started_at", "ended_at", "updated_at"])
        mark_live_activity()
    return opened


def request_go_live(session, *, user) -> dict:
    """Move the stream to "starting" (CAS) and queue the egress start.

    Returns ``{"queued": bool, "reason": str}``. Raises
    ``InvalidRealtimeTransition`` when the state changed underneath.
    """
    from . import views as realtime_views
    from .models import RealtimeSession
    from .policies.transitions import InvalidRealtimeTransition, ensure_stream_transition

    if session.stream_status == RealtimeSession.STREAM_STARTING:
        state = read_go_live_state(session.pk)
        if state.get("state") in {"queued", "starting"} and not go_live_job_is_stale(state):
            return {"queued": False, "reason": "already_starting"}
        if state.get("state") in {"queued", "starting"}:
            logger.warning(
                "Go Live job stale; re-publishing. session_id=%s state=%s", session.pk, state.get("state")
            )
    ensure_stream_transition(session.stream_status, RealtimeSession.STREAM_STARTING)
    if not realtime_views._host_egress_compare_and_set(
        session.pk,
        expected_stream_status=session.stream_status,
        expected_egress_id=session.livekit_egress_id or "",
        exclude_ended=True,
        stream_status=RealtimeSession.STREAM_STARTING,
        livekit_egress_error="",
    ):
        raise InvalidRealtimeTransition({"stream_status": "The stream state changed while starting."})
    open_session_for_start(session)
    token = uuid.uuid4().hex
    _store_go_live_state(session.pk, state="queued", token=token, user_id=getattr(user, "pk", None), error="")
    reset_restart_budget(session.pk)
    mark_live_activity()
    publish(
        EVENT_GO_LIVE,
        {"session_id": session.pk, "user_id": getattr(user, "pk", None), "token": token},
        dedupe_key=f"go-live:{session.pk}:{token}",
    )
    return {"queued": True, "reason": "queued"}


@outbox_handler(EVENT_GO_LIVE, max_attempts=4)
def handle_go_live(event):
    """Start the Host Studio broadcast egress for a queued Go Live."""
    from . import views as realtime_views
    from .models import RealtimeSession

    payload = event.payload or {}
    session_id = payload.get("session_id")
    token = payload.get("token")
    session = RealtimeSession.objects.filter(pk=session_id).first()
    if session is None:
        return None
    state = read_go_live_state(session_id)
    if state.get("token") and token and state.get("token") != token:
        return {"outcome": "superseded"}
    if session.status == RealtimeSession.STATUS_ENDED or session.stream_status != RealtimeSession.STREAM_STARTING:
        _store_go_live_state(session_id, state=session.stream_status or "idle")
        return {"outcome": "superseded"}
    _store_go_live_state(session_id, state="starting")
    rtmp_target_url = session.resolve_stream_target_url()
    if not rtmp_target_url:
        cas_stream_status_any(
            session_id,
            expected=RealtimeSession.STREAM_STARTING,
            target=RealtimeSession.STREAM_FAILED,
            livekit_egress_error="Streaming target unavailable. Set OWNCAST_RTMP_TARGET.",
        )
        _store_go_live_state(session_id, state="failed", error="Streaming target unavailable.")
        return {"outcome": "failed"}
    outcome, error = realtime_views._restart_host_broadcast_egress(
        session=session,
        request=None,
        publisher_user_id=payload.get("user_id"),
        rtmp_target_url=rtmp_target_url,
        expected_stream_status=RealtimeSession.STREAM_STARTING,
    )
    if outcome == realtime_views.EGRESS_RESTART_BUSY:
        # Another start holds the egress lock; retry this event shortly.
        raise RuntimeError("Go Live: another egress start is in progress.")
    if outcome == realtime_views.EGRESS_RESTART_STARTED:
        reset_restart_budget(session_id)
        record_feed_seen(session_id)
        realtime_views._sync_owncast_chat_settings_non_blocking(session=session)
        _store_go_live_state(session_id, state="live", error="")
        # Record this class explicitly (as OBS prepare does) rather than
        # leaving the recorder to guess which live broadcast Owncast carries.
        try:
            from .recording import services as recording_services

            session.refresh_from_db()
            recording_services.ensure_server_recording(session)
        except Exception:  # noqa: BLE001 - recording must never fail Go Live
            ops_logger.exception("Class recording start after Go Live failed. session_id=%s", session_id)
        try:
            from .resource_profile import nudge_resource_profile

            nudge_resource_profile()
        except Exception:  # noqa: BLE001
            logger.debug("resource profile nudge failed", exc_info=True)
    elif outcome == realtime_views.EGRESS_RESTART_FAILED:
        _store_go_live_state(session_id, state="failed", error=str(error or "")[:500])
    else:
        _store_go_live_state(session_id, state="superseded")
    return {"outcome": outcome}


def cas_stream_status_any(session_id, *, expected: str, target: str, **extra) -> bool:
    """Like ``cas_stream_status`` but for any non-ended session (scheduled or live)."""
    from .models import RealtimeSession

    updated = (
        RealtimeSession.objects.filter(pk=session_id, stream_status=expected)
        .exclude(status=RealtimeSession.STATUS_ENDED)
        .update(stream_status=target, updated_at=timezone.now(), **extra)
    )
    return updated == 1


GO_LIVE_TIMEOUT_MESSAGE = "Going live took too long. Press Go Live again."


def expire_stuck_go_live(session, now=None) -> bool:
    """Fail a start that has been "starting" for longer than the start timeout.

    The reconciler applies the same rule, but only in enforce mode; this bound
    holds in every mode, so a lost or never-finished Go Live job cannot keep
    the host on "starting". Called from the Go Live poll. The age is measured
    from the job's last progress (or, with no job state, from the row's last
    change). Compare-and-set: a start that lands first wins. ``session`` is
    refreshed when this call failed it.
    """
    from .models import RealtimeSession

    if session.status == RealtimeSession.STATUS_ENDED or session.stream_status != RealtimeSession.STREAM_STARTING:
        return False
    state = read_go_live_state(session.pk)
    if state.get("state") in {"queued", "starting"}:
        since = state.get("updated_at")
    else:
        since = session.updated_at.timestamp() if session.updated_at else None
    try:
        age = _now_ts(now) - float(since)
    except (TypeError, ValueError):
        return False
    if age < starting_timeout_seconds():
        return False
    if not cas_stream_status_any(
        session.pk,
        expected=RealtimeSession.STREAM_STARTING,
        target=RealtimeSession.STREAM_FAILED,
        livekit_egress_error=GO_LIVE_TIMEOUT_MESSAGE,
    ):
        return False
    _store_go_live_state(session.pk, state="failed", error=GO_LIVE_TIMEOUT_MESSAGE)
    emit_transition(
        session_id=session.pk,
        kind=session_kind(session),
        from_status=RealtimeSession.STREAM_STARTING,
        to_status=RealtimeSession.STREAM_FAILED,
        reason="start_timeout",
        mode=reconciler_mode(),
        applied=True,
    )
    session.refresh_from_db(fields=["stream_status", "livekit_egress_error", "updated_at"])
    return True


def go_live_status_payload(session) -> dict:
    """What the Host Studio polls after a 202 Go Live.

    ``stalled`` is true while the queued job has waited longer than
    ``GO_LIVE_QUEUED_STALE_SECONDS`` without a worker picking it up: the
    studio then starts the egress on the request path (stream/start/).
    """
    state = read_go_live_state(session.pk)
    stream_status = session.stream_status
    if session.status == session.STATUS_ENDED:
        phase = "ended"
    elif stream_status == session.STREAM_LIVE:
        phase = "live"
    elif stream_status == session.STREAM_STARTING:
        phase = "starting"
    elif stream_status == session.STREAM_FAILED:
        phase = "failed"
    else:
        phase = stream_status or "idle"
    return {
        "state": phase,
        "stream_status": stream_status,
        "error": session.livekit_egress_error if phase == "failed" else "",
        "stalled": phase == "starting" and state.get("state") == "queued" and go_live_job_is_stale(state),
        "job": {key: state.get(key) for key in ("state", "error", "updated_at") if key in state},
    }


# --- viewer-facing state ------------------------------------------------------


def live_state_for(session) -> str:
    """One word for students: ended | waiting | live | reconnecting | paused."""
    if session.status == session.STATUS_ENDED:
        return "ended"
    if session.status == session.STATUS_SCHEDULED:
        return "waiting"
    if session.session_type == session.TYPE_MEETING:
        return "live"
    stream = session.stream_status
    if stream == session.STREAM_LIVE:
        return "live"
    if stream == session.STREAM_INTERRUPTED:
        return "reconnecting"
    if stream in {session.STREAM_STOPPED, session.STREAM_FAILED}:
        return "paused"
    return "waiting"
