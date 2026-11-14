"""Phase 2: server-owned live-class lifecycle.

* ``decide()``: the reconciler's transition table (table-driven).
* Compare-and-set races: a host Stop/End/Go Live always beats the reconciler.
* ``end_session()`` idempotency and the ``live.ended`` LiveKit cleanup.
* Host grace: "reconnecting" heartbeats, interrupted -> live/stopped/failed,
  server-side egress restart with a budget and backoff.
* Abandoned classes auto-end; shadow/off modes write nothing.
* Async Go Live (202 + polling), stable meeting identity, calendar-aware
  resource profile, pre-class probe, deploy guard, worker heartbeat.
"""

from __future__ import annotations

import io
import os
import tempfile
import time
from datetime import datetime, timedelta
from unittest.mock import patch

from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.core.worker import _periodic_hooks
from apps.realtime import lifecycle, preflight, reconciler, resource_profile, worker_heartbeat
from apps.realtime.models import RealtimeSession, ServerResourceProfile
from apps.realtime.policies.transitions import InvalidRealtimeTransition, ensure_stream_transition
from apps.realtime.reconciler import Decision, Observation, Policy, decide
from apps.realtime.schedule import LIVE_CLASS_TIMEZONE
from apps.realtime.services import LiveKitEgressError, LiveKitRoomServiceError
from apps.realtime.views import build_stable_meeting_identity
from django.core.cache import cache
from django.core.management import call_command
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from .test_phase1_reliability import RealtimeFixtureMixin

LIVEKIT_SETTINGS = {
    "OWNCAST_RTMP_TARGET": "rtmp://owncast:1935/live/stream-key",
    "LIVEKIT_URL": "ws://livekit.test",
    "LIVEKIT_SERVER_URL": "",
    "LIVEKIT_API_KEY": "devkey",
    "LIVEKIT_API_SECRET": "secret",
}
ENFORCE = {"LIVE_RECONCILER_MODE": "enforce", **LIVEKIT_SETTINGS}

STUDIO = lifecycle.KIND_STUDIO
OBS = lifecycle.KIND_OBS
MEETING = lifecycle.KIND_MEETING
P = Policy(
    host_grace_seconds=60,
    obs_grace_seconds=45,
    abandoned_after_seconds=1200,
    never_live_after_seconds=6 * 3600,
    starting_timeout_seconds=180,
)


def obs(kind=STUDIO, stream="live", feed=True, **kwargs):
    return Observation(session_id=1, kind=kind, stream_status=stream, feed_online=feed, **kwargs)


# --- 1. the decision table -----------------------------------------------------

DECISION_TABLE = [
    # (name, observation, expected action, expected target or reason)
    # OBS (Owncast is the feed)
    ("obs live+online stays", obs(OBS, "live", True), "noop", ""),
    ("obs unknown upstream never acts", obs(OBS, "live", None), "noop", ""),
    ("obs starting goes live", obs(OBS, "starting", True), "mark_live", "live"),
    ("obs stopped comes back", obs(OBS, "stopped", True), "mark_live", "live"),
    ("obs idle goes live", obs(OBS, "idle", True), "mark_live", "live"),
    ("obs interrupted recovers", obs(OBS, "interrupted", True), "mark_live", "live"),
    ("obs live loses feed", obs(OBS, "live", False), "mark_interrupted", "interrupted"),
    ("obs interrupted inside grace", obs(OBS, "interrupted", False, feed_lost_age=20), "noop", ""),
    ("obs interrupted grace over", obs(OBS, "interrupted", False, feed_lost_age=46), "mark_stopped", "stopped"),
    ("obs stopped not yet abandoned", obs(OBS, "stopped", False, feed_lost_age=600), "noop", ""),
    ("obs stopped abandoned", obs(OBS, "stopped", False, feed_lost_age=1300), "end_session", "abandoned"),
    ("obs starting never live, young", obs(OBS, "starting", False, session_age=3600), "noop", ""),
    ("obs never live, 7h old", obs(OBS, "idle", False, session_age=7 * 3600), "end_session", "never_started"),
    # Host Studio (egress is the feed, the heartbeat is the host)
    ("studio live+egress", obs(STUDIO, "live", True, host_state="publishing"), "noop", ""),
    ("studio live unknown egress", obs(STUDIO, "live", None), "noop", ""),
    ("studio live egress lost", obs(STUDIO, "live", False, host_state="publishing"), "mark_interrupted", "interrupted"),
    ("studio interrupted egress back", obs(STUDIO, "interrupted", True), "mark_live", "live"),
    (
        "studio interrupted host publishing -> restart",
        obs(STUDIO, "interrupted", False, host_state="publishing", restart_allowed=True),
        "restart_egress",
        "host_publishing",
    ),
    (
        "studio interrupted in backoff waits",
        obs(STUDIO, "interrupted", False, host_state="publishing", restart_allowed=False),
        "noop",
        "",
    ),
    (
        "studio interrupted budget exhausted -> failed",
        obs(STUDIO, "interrupted", False, host_state="publishing", restart_exhausted=True),
        "mark_failed",
        "restart_budget_exhausted",
    ),
    (
        "studio host reconnecting holds the class",
        obs(STUDIO, "interrupted", False, host_state="reconnecting", host_seen_age=5, feed_lost_age=90),
        "noop",
        "",
    ),
    (
        "studio reconnecting too long -> stopped",
        obs(STUDIO, "interrupted", False, host_state="reconnecting", host_seen_age=5, feed_lost_age=200),
        "mark_stopped",
        "stopped",
    ),
    (
        "studio host gone inside grace",
        obs(STUDIO, "interrupted", False, host_state=None, host_seen_age=40, feed_lost_age=30),
        "noop",
        "",
    ),
    (
        "studio host gone grace over",
        obs(STUDIO, "interrupted", False, host_state=None, host_seen_age=70, feed_lost_age=65),
        "mark_stopped",
        "stopped",
    ),
    (
        "studio camera off grace over",
        obs(STUDIO, "interrupted", False, host_state="connected", host_seen_age=5, feed_lost_age=65),
        "mark_stopped",
        "stopped",
    ),
    (
        "studio failed while publishing -> restart",
        obs(STUDIO, "failed", False, host_state="publishing", restart_allowed=True),
        "restart_egress",
        "failed_while_publishing",
    ),
    ("studio failed, host away, young", obs(STUDIO, "failed", False, feed_lost_age=100), "noop", ""),
    ("studio starting in progress", obs(STUDIO, "starting", False, stream_age=20), "noop", ""),
    ("studio starting stuck -> failed", obs(STUDIO, "starting", False, stream_age=200), "mark_failed", "start_timeout"),
    ("studio stopped by host stays", obs(STUDIO, "stopped", False, host_state="connected", feed_lost_age=60), "noop", ""),
    (
        "studio abandoned but host studio open",
        obs(STUDIO, "stopped", False, host_state="connected", host_seen_age=5, feed_lost_age=5000),
        "noop",
        "",
    ),
    (
        "studio abandoned, host silent",
        obs(STUDIO, "stopped", False, host_state=None, host_seen_age=1500, feed_lost_age=1500),
        "end_session",
        "abandoned",
    ),
    (
        "studio host seen recently blocks auto-end",
        obs(STUDIO, "stopped", False, host_state=None, host_seen_age=300, feed_lost_age=1500),
        "noop",
        "",
    ),
    # Meetings (participants are the feed)
    ("meeting busy", obs(MEETING, "idle", True), "noop", ""),
    ("meeting unknown", obs(MEETING, "idle", None), "noop", ""),
    ("meeting empty briefly", obs(MEETING, "idle", False, feed_lost_age=300), "noop", ""),
    ("meeting empty 25 min", obs(MEETING, "idle", False, feed_lost_age=1500), "end_session", "abandoned"),
    ("meeting never joined, 7h", obs(MEETING, "idle", False, session_age=7 * 3600), "end_session", "never_started"),
]


class DecisionTableTests(SimpleTestCase):
    def test_transition_table(self):
        for name, observation, action, detail in DECISION_TABLE:
            with self.subTest(name):
                decision = decide(observation, P)
                self.assertEqual(decision.action, action, decision)
                if detail:
                    self.assertIn(detail, (decision.target, decision.reason))

    def test_every_non_noop_target_is_a_legal_stream_transition(self):
        for name, observation, _action, _detail in DECISION_TABLE:
            decision = decide(observation, P)
            if decision.action in {"mark_live", "mark_interrupted", "mark_stopped", "mark_failed"}:
                with self.subTest(name):
                    ensure_stream_transition(observation.stream_status, decision.target)

    def test_interrupted_transitions(self):
        for current, target in [
            ("live", "interrupted"),
            ("interrupted", "live"),
            ("interrupted", "stopped"),
            ("interrupted", "failed"),
            ("interrupted", "starting"),
        ]:
            ensure_stream_transition(current, target)
        for current, target in [("idle", "interrupted"), ("stopped", "interrupted"), ("starting", "interrupted")]:
            with self.assertRaises(InvalidRealtimeTransition):
                ensure_stream_transition(current, target)

    def test_noop_decision(self):
        self.assertTrue(Decision("noop").is_noop)


# --- shared fixture ---------------------------------------------------------------


class LifecycleFixture(RealtimeFixtureMixin):
    def setUp(self):
        self.make_fixture()
        self.addCleanup(cache.clear)

    def studio(self, **overrides):
        fields = {"stream_status": RealtimeSession.STREAM_LIVE, "livekit_egress_id": "EG_1"}
        fields.update(overrides)
        return self.make_session(**fields)

    def feed_lost(self, session, seconds_ago):
        cache.set(f"realtime:feed-last-seen:{session.pk}", time.time() - seconds_ago, timeout=3600)

    def host_seen(self, session, seconds_ago):
        cache.set(f"realtime:host-last-seen:{session.pk}", time.time() - seconds_ago, timeout=3600)

    def heartbeat_state(self, session, state):
        lifecycle.record_host_heartbeat(session.pk, state=state, user_id=self.instructor.pk)

    def tick(self, mode=None):
        return reconciler.reconcile_live_sessions(mode=mode)

    def tick_and_run_jobs(self, mode=None):
        """One worker loop: the reconciler tick, then the jobs it queued
        (an egress restart runs in the outbox, not inside the tick)."""
        result = self.tick(mode=mode)
        drain_outbox(batch_size=20)
        return result


# --- 2. compare-and-set races ------------------------------------------------------


@override_settings(**ENFORCE)
class CompareAndSetRaceTests(LifecycleFixture, TestCase):
    def test_cas_loses_to_a_concurrent_host_stop(self):
        session = self.studio()
        # The reconciler judged "live"; the host pressed Stop before it applied.
        RealtimeSession.objects.filter(pk=session.pk).update(stream_status=RealtimeSession.STREAM_STOPPED)
        changed = lifecycle.cas_stream_status(session.pk, expected="live", target="interrupted")
        self.assertFalse(changed)
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_STOPPED)

    def test_cas_never_touches_an_ended_session(self):
        session = self.studio(status=RealtimeSession.STATUS_ENDED)
        self.assertFalse(lifecycle.cas_stream_status(session.pk, expected="live", target="interrupted"))

    def test_cas_records_and_clears_the_interruption_time(self):
        session = self.studio()
        self.assertTrue(lifecycle.cas_stream_status(session.pk, expected="live", target="interrupted"))
        session.refresh_from_db()
        self.assertIsNotNone(session.stream_interrupted_at)
        self.assertTrue(lifecycle.cas_stream_status(session.pk, expected="interrupted", target="live"))
        session.refresh_from_db()
        self.assertIsNone(session.stream_interrupted_at)

    def test_stale_observation_is_not_applied(self):
        session = self.studio()
        stale = Observation(session_id=session.pk, kind=STUDIO, stream_status="live", feed_online=False)
        RealtimeSession.objects.filter(pk=session.pk).update(stream_status=RealtimeSession.STREAM_FAILED)
        changed = reconciler.apply_decision(session, stale, decide(stale, P))
        self.assertFalse(changed)
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_FAILED)

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_end_during_a_reconciler_restart_stops_the_new_egress(self, mock_start, mock_stop):
        session = self.studio(stream_status=RealtimeSession.STREAM_INTERRUPTED, livekit_egress_id="EG_dead")
        self.heartbeat_state(session, lifecycle.HOST_PUBLISHING)

        def end_while_starting(**_kwargs):
            lifecycle.end_session(session.pk, reason="host")
            return "EG_orphan"

        mock_start.side_effect = end_while_starting
        self.tick_and_run_jobs()
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_ENDED)
        self.assertEqual(session.livekit_egress_id, "")
        stopped = [call.kwargs["egress_id"] for call in mock_stop.call_args_list]
        self.assertIn("EG_orphan", stopped)

    def test_the_reconciler_skips_a_tick_while_another_holds_the_lock(self):
        from apps.core.concurrency import DistributedLock

        self.studio()
        lock = DistributedLock("live.reconcile", ttl=30)
        self.assertTrue(lock.acquire(blocking=False))
        try:
            result = self.tick()
        finally:
            lock.release()
        self.assertTrue(result.skipped_lock)
        self.assertEqual(result.observed, 0)


# --- 3. end_session ----------------------------------------------------------------


@override_settings(**ENFORCE)
class EndSessionTests(LifecycleFixture, APITestCase):
    def test_end_session_is_idempotent(self):
        session = self.studio(livekit_egress_id="EG_live")
        first = lifecycle.end_session(session.pk, reason="host")
        ended_at = RealtimeSession.objects.get(pk=session.pk).ended_at
        second = lifecycle.end_session(session.pk, reason="abandoned")

        self.assertTrue(first.transitioned)
        self.assertFalse(second.transitioned)
        self.assertEqual(first.stopped_egress_id, "EG_live")
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_ENDED)
        self.assertEqual(session.end_reason, "host")  # the first End wins
        self.assertEqual(session.ended_at, ended_at)
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_STOPPED)
        self.assertEqual(session.livekit_egress_id, "")
        events = OutboxEvent.objects.filter(event_type=lifecycle.EVENT_LIVE_ENDED)
        self.assertEqual(events.count(), 1)
        self.assertEqual(events.get().payload["egress_id"], "EG_live")

    def test_end_view_twice_answers_200_both_times(self):
        session = self.studio()
        self.login(self.instructor)
        url = reverse("realtime-session-end", kwargs={"pk": session.pk})
        first = self.client.post(url, {}, format="json")
        second = self.client.post(url, {}, format="json")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(first.data["data"]["status"], "ended")
        self.assertEqual(first.data["data"]["live_state"], "ended")
        self.assertEqual(first.data["data"]["end_reason"], "host")
        self.assertEqual(OutboxEvent.objects.filter(event_type=lifecycle.EVENT_LIVE_ENDED).count(), 1)

    def test_admin_end_records_the_admin_reason(self):
        session = self.studio()
        self.login(self.admin)
        response = self.client.post(reverse("realtime-session-end", kwargs={"pk": session.pk}), {}, format="json")
        self.assertEqual(response.status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.end_reason, "admin")

    def test_students_cannot_end(self):
        session = self.studio()
        self.login(self.student)
        response = self.client.post(reverse("realtime-session-end", kwargs={"pk": session.pk}), {}, format="json")
        self.assertEqual(response.status_code, 403)
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_LIVE)

    @patch("apps.realtime.services.delete_livekit_room")
    @patch("apps.realtime.services.stop_room_broadcast_egress")
    def test_live_ended_handler_stops_egress_and_deletes_room(self, mock_stop, mock_delete):
        session = self.studio(livekit_egress_id="EG_live")
        lifecycle.end_session(session.pk, reason="host")
        stats = drain_outbox(batch_size=10)
        self.assertEqual(stats["delivered"], 1)
        mock_stop.assert_called_once_with(egress_id="EG_live")
        mock_delete.assert_called_once_with(session.livekit_room_name or session.room_name)

    @patch("apps.realtime.services.delete_livekit_room")
    @patch("apps.realtime.services.stop_room_broadcast_egress")
    def test_already_gone_egress_and_room_count_as_done(self, mock_stop, mock_delete):
        mock_stop.side_effect = LiveKitEgressError("Egress HTTP 412: egress EG_live is EGRESS_COMPLETE")
        mock_delete.side_effect = LiveKitRoomServiceError("RoomService DeleteRoom HTTP 404: room not found")
        session = self.studio(livekit_egress_id="EG_live")
        lifecycle.end_session(session.pk, reason="host")
        self.assertEqual(drain_outbox(batch_size=10)["delivered"], 1)

    @patch("apps.realtime.services.delete_livekit_room")
    @patch("apps.realtime.services.stop_room_broadcast_egress")
    def test_livekit_outage_retries_the_cleanup(self, mock_stop, _mock_delete):
        mock_stop.side_effect = LiveKitEgressError("Egress network error: connection refused")
        session = self.studio(livekit_egress_id="EG_live")
        lifecycle.end_session(session.pk, reason="host")
        self.assertEqual(drain_outbox(batch_size=10)["retried"], 1)

    @patch("apps.realtime.services.delete_livekit_room")
    def test_obs_end_does_not_touch_livekit_rooms(self, mock_delete):
        session = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS, stream_status=RealtimeSession.STREAM_STOPPED
        )
        lifecycle.end_session(session.pk, reason="host")
        drain_outbox(batch_size=10)
        mock_delete.assert_not_called()

    @patch("apps.realtime.views.sync_owncast_stream_key")
    def test_obs_end_resyncs_the_fixed_key_while_streaming(self, mock_sync):
        with self.settings(OWNCAST_STREAM_KEY="fixed-key-123"):
            session = self.make_session(
                stream_service=RealtimeSession.STREAM_SERVICE_OBS, stream_status=RealtimeSession.STREAM_LIVE
            )
            lifecycle.end_session(session.pk, reason="host")
        mock_sync.assert_called_once_with("fixed-key-123")

    def test_end_clears_the_live_caches(self):
        session = self.studio()
        self.heartbeat_state(session, lifecycle.HOST_PUBLISHING)
        lifecycle.end_session(session.pk, reason="host")
        self.assertIsNone(lifecycle.read_host_heartbeat(session.pk))


# --- 4. host grace -----------------------------------------------------------------


class HostGraceHeartbeatTests(LifecycleFixture, APITestCase):
    def setUp(self):
        super().setUp()
        self.session = self.studio(livekit_egress_id="EG_dead")
        self.login(self.instructor)

    def heartbeat(self, **payload):
        return self.client.post(
            reverse("realtime-session-stream-heartbeat", kwargs={"pk": self.session.pk}), payload, format="json"
        )

    @override_settings(**ENFORCE)
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_reconnecting_host_keeps_the_class_live(self, mock_status):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}
        response = self.heartbeat(publishing=False, state="reconnecting")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["data"]["grace"])
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertEqual(lifecycle.read_host_heartbeat(self.session.pk)["state"], "reconnecting")

    @override_settings(LIVE_RECONCILER_MODE="shadow", **LIVEKIT_SETTINGS)
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_shadow_mode_grace_expires_into_the_legacy_failure(self, mock_status):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}
        self.assertTrue(self.heartbeat(publishing=False, state="reconnecting").data["data"]["grace"])
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)

        cache.set(f"realtime:host-reconnecting-since:{self.session.pk}", time.time() - 120, timeout=600)
        cache.delete(f"realtime:host-egress:{self.session.pk}:last-check")
        response = self.heartbeat(publishing=False, state="reconnecting")
        self.assertFalse(response.data["data"]["grace"])
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_FAILED)

    @override_settings(**ENFORCE)
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_legacy_not_publishing_heartbeat_still_fails_the_stream(self, mock_status):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}
        self.heartbeat(publishing=False)
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_FAILED)

    @override_settings(**ENFORCE)
    def test_heartbeat_for_a_stopped_stream_still_records_the_host(self):
        RealtimeSession.objects.filter(pk=self.session.pk).update(stream_status=RealtimeSession.STREAM_STOPPED)
        self.heartbeat(publishing=True)
        self.assertEqual(lifecycle.read_host_heartbeat(self.session.pk)["state"], "publishing")
        self.assertLess(lifecycle.host_last_seen_age(self.session.pk), 5)


@override_settings(REALTIME_HOST_EGRESS_MAX_AUTO_RESTARTS=2, REALTIME_EGRESS_RESTART_BACKOFF_SECONDS=5, **ENFORCE)
class HostGraceReconcilerTests(LifecycleFixture, TestCase):
    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_lost_egress_shows_host_reconnecting_to_viewers(self, mock_status):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}
        session = self.studio()
        self.feed_lost(session, 3)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_INTERRUPTED)
        from apps.realtime.serializers import RealtimeSessionListSerializer

        data = RealtimeSessionListSerializer(session, context={}).data
        self.assertTrue(data["host_reconnecting"])
        self.assertEqual(data["live_state"], "reconnecting")

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress", return_value="EG_new")
    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_host_back_triggers_a_server_side_restart(self, mock_status, mock_start, mock_stop):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}
        session = self.studio(stream_status=RealtimeSession.STREAM_INTERRUPTED, livekit_egress_id="EG_dead")
        RealtimeSession.objects.filter(pk=session.pk).update(stream_interrupted_at=timezone.now())
        self.heartbeat_state(session, lifecycle.HOST_PUBLISHING)

        result = self.tick_and_run_jobs()

        self.assertEqual([row[2] for row in result.applied], ["restart_egress"])
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertEqual(session.livekit_egress_id, "EG_new")
        self.assertIsNone(session.stream_interrupted_at)
        mock_stop.assert_called_once_with(egress_id="EG_dead")
        self.assertEqual(
            mock_start.call_args.kwargs["participant_identity"], f"host-{self.instructor.pk}-session-{session.pk}"
        )

    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_restarts_back_off_and_then_fail_for_the_resume_banner(self, mock_status, mock_start):
        from apps.realtime.services import LiveKitEgressError as EgressError

        mock_status.return_value = {"running": False, "status": "EGRESS_FAILED", "error": ""}
        mock_start.side_effect = EgressError("no available egress workers")
        session = self.studio(stream_status=RealtimeSession.STREAM_INTERRUPTED, livekit_egress_id="EG_dead")
        self.heartbeat_state(session, lifecycle.HOST_PUBLISHING)

        self.tick_and_run_jobs()  # restart 1 fails -> failed
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_FAILED)
        self.tick_and_run_jobs()  # inside the backoff: no second attempt yet
        self.assertEqual(mock_start.call_count, 1)

        cache.delete(f"realtime:host-egress:{session.pk}:next-restart-at")
        self.tick_and_run_jobs()  # restart 2 (failed while publishing)
        self.assertEqual(mock_start.call_count, 2)
        cache.delete(f"realtime:host-egress:{session.pk}:next-restart-at")
        self.tick_and_run_jobs()  # budget (2) used up: no third attempt
        self.assertEqual(mock_start.call_count, 2)
        allowed, exhausted = lifecycle.restart_budget(session.pk)
        self.assertFalse(allowed)
        self.assertTrue(exhausted)

    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_budget_exhausted_while_interrupted_marks_failed(self, mock_status):
        mock_status.return_value = {"running": False, "status": "EGRESS_FAILED", "error": ""}
        session = self.studio(stream_status=RealtimeSession.STREAM_INTERRUPTED, livekit_egress_id="EG_dead")
        self.heartbeat_state(session, lifecycle.HOST_PUBLISHING)
        cache.set(lifecycle.restart_count_key(session.pk), 2, timeout=600)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_FAILED)
        self.assertIn("Resume broadcast", session.livekit_egress_error)

    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_host_gone_past_the_grace_period_stops_the_stream(self, mock_status):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}
        session = self.studio(stream_status=RealtimeSession.STREAM_INTERRUPTED, livekit_egress_id="EG_dead")
        self.feed_lost(session, 30)
        self.host_seen(session, 45)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_INTERRUPTED)

        self.feed_lost(session, 61)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_STOPPED)
        self.assertEqual(session.status, RealtimeSession.STATUS_LIVE)

    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_reconnecting_host_gets_extra_time(self, mock_status):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}
        session = self.studio(stream_status=RealtimeSession.STREAM_INTERRUPTED, livekit_egress_id="EG_dead")
        self.heartbeat_state(session, lifecycle.HOST_RECONNECTING)
        self.feed_lost(session, 90)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_INTERRUPTED)

    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_unknown_livekit_state_changes_nothing(self, mock_status):
        mock_status.side_effect = LiveKitEgressError("Egress network error")
        session = self.studio()
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_LIVE)

    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_unreachable_livekit_is_asked_once_per_tick_not_per_session(self, mock_status):
        mock_status.side_effect = LiveKitEgressError("Egress network error: timed out")
        self.studio(title="A", livekit_egress_id="EG_a")
        self.studio(title="B", livekit_egress_id="EG_b")
        self.tick()
        self.tick()
        self.assertEqual(mock_status.call_count, 1)


# --- 5. abandoned classes and modes -------------------------------------------------


@override_settings(**ENFORCE)
class AbandonedClassTests(LifecycleFixture, TestCase):
    def test_abandoned_studio_class_auto_ends(self):
        session = self.studio(stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id="")
        self.feed_lost(session, 25 * 60)
        self.host_seen(session, 25 * 60)
        result = self.tick()
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_ENDED)
        self.assertEqual(session.end_reason, "abandoned")
        self.assertEqual([row[2] for row in result.applied], ["end_session"])
        self.assertTrue(OutboxEvent.objects.filter(event_type=lifecycle.EVENT_LIVE_ENDED).exists())

    def test_open_host_studio_keeps_a_paused_class(self):
        session = self.studio(stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id="")
        self.feed_lost(session, 25 * 60)
        self.heartbeat_state(session, lifecycle.HOST_CONNECTED)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_LIVE)

    def test_never_started_class_ends_after_the_attendee_bound(self):
        old = self.studio(stream_status=RealtimeSession.STREAM_IDLE, livekit_egress_id="")
        young = self.studio(stream_status=RealtimeSession.STREAM_IDLE, livekit_egress_id="", title="Young")
        RealtimeSession.objects.filter(pk=old.pk).update(started_at=timezone.now() - timedelta(hours=7))
        self.tick()
        old.refresh_from_db()
        young.refresh_from_db()
        self.assertEqual(old.status, RealtimeSession.STATUS_ENDED)
        self.assertEqual(old.end_reason, "never_started")
        self.assertEqual(young.status, RealtimeSession.STATUS_LIVE)

    @patch("apps.realtime.services.get_owncast_public_status", return_value={"online": False})
    def test_obs_feed_loss_interrupts_then_stops_then_ends(self, _status):
        session = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS, stream_status=RealtimeSession.STREAM_LIVE
        )
        self.feed_lost(session, 2)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_INTERRUPTED)
        self.feed_lost(session, 50)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_STOPPED)
        self.feed_lost(session, 25 * 60)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_ENDED)

    @patch("apps.realtime.services.get_owncast_public_status", return_value={"online": True})
    def test_obs_feed_back_goes_live_and_is_remembered(self, _status):
        session = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS, stream_status=RealtimeSession.STREAM_STOPPED
        )
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertLess(lifecycle.feed_lost_age(session.pk), 5)

    @patch("apps.realtime.services.list_room_participant_count", return_value=0)
    def test_empty_meeting_auto_ends(self, _count):
        session = self.make_session(session_type=RealtimeSession.TYPE_MEETING)
        self.feed_lost(session, 25 * 60)
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_ENDED)

    @patch("apps.realtime.services.list_room_participant_count", return_value=3)
    def test_busy_meeting_stays(self, _count):
        session = self.make_session(session_type=RealtimeSession.TYPE_MEETING)
        RealtimeSession.objects.filter(pk=session.pk).update(started_at=timezone.now() - timedelta(hours=7))
        self.tick()
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_LIVE)


class ReconcilerModeTests(LifecycleFixture, TestCase):
    @override_settings(LIVE_RECONCILER_MODE="shadow", **LIVEKIT_SETTINGS)
    @patch("apps.realtime.services.get_broadcast_egress_status")
    def test_shadow_mode_logs_but_writes_nothing(self, mock_status):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}
        session = self.studio()
        abandoned = self.studio(stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id="", title="Gone")
        self.feed_lost(abandoned, 25 * 60)
        with self.assertLogs("ops.realtime", level="INFO") as logs:
            result = self.tick()
        self.assertEqual(result.mode, "shadow")
        self.assertEqual(len(result.intended), 2)
        self.assertEqual(result.applied, [])
        session.refresh_from_db()
        abandoned.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertEqual(abandoned.status, RealtimeSession.STATUS_LIVE)
        self.assertFalse(OutboxEvent.objects.filter(event_type=lifecycle.EVENT_LIVE_ENDED).exists())
        self.assertTrue(any("applied=False" in line and "mode=shadow" in line for line in logs.output))

    @override_settings(LIVE_RECONCILER_MODE="shadow", **LIVEKIT_SETTINGS)
    def test_shadow_mode_reports_each_intended_transition_once_per_window(self):
        abandoned = self.studio(stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id="", title="Gone")
        self.feed_lost(abandoned, 25 * 60)
        with self.assertLogs("ops.realtime", level="INFO") as logs:
            self.tick()
            self.tick()
            self.tick()
        self.assertEqual(sum("applied=False" in line for line in logs.output), 1)

    @override_settings(LIVE_RECONCILER_MODE="off")
    def test_off_mode_does_nothing(self):
        self.studio()
        result = self.tick()
        self.assertEqual(result.observed, 0)

    @override_settings(LIVE_RECONCILER_MODE="bogus")
    def test_unknown_mode_falls_back_to_shadow(self):
        self.assertEqual(lifecycle.reconciler_mode(), "shadow")

    @override_settings(LIVE_RECONCILER_MODE="enforce")
    def test_legacy_obs_writer_stands_down_in_enforce_mode(self):
        from apps.realtime.periodic import persist_obs_stream_health

        self.make_session(stream_service=RealtimeSession.STREAM_SERVICE_OBS, stream_status=RealtimeSession.STREAM_STARTING)
        with patch("apps.realtime.services.get_owncast_public_status", return_value={"online": True}) as status:
            self.assertEqual(persist_obs_stream_health(), 0)
        status.assert_not_called()

    def test_hooks_are_registered(self):
        for name in ("live.reconcile", "realtime.resource_profile", "realtime.preclass_probe", worker_heartbeat.hook_name()):
            self.assertIn(name, _periodic_hooks)


# --- 6. async Go Live ---------------------------------------------------------------


@override_settings(**ENFORCE)
class GoLiveTests(LifecycleFixture, APITestCase):
    def setUp(self):
        super().setUp()
        self.session = self.studio(stream_status=RealtimeSession.STREAM_IDLE, livekit_egress_id="")
        self.url = reverse("realtime-session-go-live", kwargs={"pk": self.session.pk})
        self.login(self.instructor)

    @patch("apps.realtime.views.start_room_broadcast_egress", return_value="EG_go")
    def test_go_live_returns_202_then_the_worker_starts_the_egress(self, mock_start):
        response = self.client.post(self.url, {}, format="json")
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(response.data["data"]["state"], "starting")
        mock_start.assert_not_called()  # nothing blocks the request thread

        drain_outbox(batch_size=10)

        mock_start.assert_called_once()
        status_response = self.client.get(self.url)
        self.assertEqual(status_response.status_code, 200)
        self.assertEqual(status_response.data["data"]["state"], "live")
        self.session.refresh_from_db()
        self.assertEqual(self.session.livekit_egress_id, "EG_go")

    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_a_double_click_queues_one_start(self, mock_start):
        mock_start.return_value = "EG_go"
        self.client.post(self.url, {}, format="json")
        second = self.client.post(self.url, {}, format="json")
        self.assertIn(second.status_code, (200, 202, 409))
        self.assertEqual(OutboxEvent.objects.filter(event_type=lifecycle.EVENT_GO_LIVE).count(), 1)

    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_failed_start_is_reported_to_the_poll(self, mock_start):
        mock_start.side_effect = LiveKitEgressError("participant not found")
        self.client.post(self.url, {}, format="json")
        drain_outbox(batch_size=10)
        data = self.client.get(self.url).data["data"]
        self.assertEqual(data["state"], "failed")
        self.assertIn("participant not found", data["error"])

    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_end_before_the_worker_runs_supersedes_the_start(self, mock_start):
        self.client.post(self.url, {}, format="json")
        lifecycle.end_session(self.session.pk, reason="host")
        drain_outbox(batch_size=10)
        mock_start.assert_not_called()

    @override_settings(REALTIME_ASYNC_GO_LIVE=False)
    def test_kill_switch_sends_the_studio_back_to_stream_start(self):
        response = self.client.post(self.url, {}, format="json")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["errors"]["code"], "go_live_async_disabled")
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_IDLE)

    def test_ended_obs_and_student_requests_are_refused(self):
        obs_session = self.make_session(stream_service=RealtimeSession.STREAM_SERVICE_OBS)
        self.assertEqual(
            self.client.post(reverse("realtime-session-go-live", kwargs={"pk": obs_session.pk}), {}).status_code, 400
        )
        lifecycle.end_session(self.session.pk, reason="host")
        self.assertEqual(self.client.post(self.url, {}).status_code, 409)
        self.login(self.student)
        self.assertEqual(self.client.get(self.url).status_code, 403)

    # Recovery when the queued job is delayed or lost (host lock-out).

    def age_go_live_job(self, seconds):
        key = lifecycle.go_live_state_key(self.session.pk)
        state = cache.get(key)
        state["updated_at"] -= seconds
        cache.set(key, state, timeout=3600)

    def go_live_events(self):
        return OutboxEvent.objects.filter(event_type=lifecycle.EVENT_GO_LIVE).count()

    @patch("apps.realtime.views.start_room_broadcast_egress", return_value="EG_go")
    def test_go_live_again_re_publishes_a_job_no_worker_picked_up(self, mock_start):
        self.assertEqual(self.client.post(self.url, {}, format="json").status_code, 202)
        self.age_go_live_job(lifecycle.GO_LIVE_QUEUED_STALE_SECONDS + 1)

        retry = self.client.post(self.url, {}, format="json")

        self.assertEqual(retry.status_code, 202, retry.content)
        self.assertEqual(self.go_live_events(), 2)
        drain_outbox(batch_size=10)
        mock_start.assert_called_once()  # the superseded first job starts nothing
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)

    @patch("apps.realtime.views.start_room_broadcast_egress", return_value="EG_go")
    def test_go_live_again_re_publishes_a_job_whose_worker_died_mid_start(self, mock_start):
        self.client.post(self.url, {}, format="json")
        lifecycle._store_go_live_state(self.session.pk, state="starting")
        self.age_go_live_job(lifecycle.GO_LIVE_STARTING_STALE_SECONDS - 10)
        self.client.post(self.url, {}, format="json")
        self.assertEqual(self.go_live_events(), 1)  # a slow but healthy start is not doubled
        self.age_go_live_job(11)
        self.assertEqual(self.client.post(self.url, {}, format="json").status_code, 202)
        self.assertEqual(self.go_live_events(), 2)

    @patch("apps.realtime.views.start_room_broadcast_egress", return_value="EG_sync")
    def test_poll_flags_a_stalled_job_and_the_synchronous_start_recovers(self, mock_start):
        self.client.post(self.url, {}, format="json")
        self.assertFalse(self.client.get(self.url).data["data"]["stalled"])
        self.age_go_live_job(lifecycle.GO_LIVE_QUEUED_STALE_SECONDS + 1)
        self.assertTrue(self.client.get(self.url).data["data"]["stalled"])

        start = self.client.post(
            reverse("realtime-session-stream-start", kwargs={"pk": self.session.pk}), {}, format="json"
        )

        self.assertEqual(start.status_code, 200, start.content)
        data = self.client.get(self.url).data["data"]
        self.assertEqual(data["state"], "live")
        self.assertFalse(data["stalled"])
        drain_outbox(batch_size=10)  # the late job finds the stream live and starts nothing
        mock_start.assert_called_once()
        self.session.refresh_from_db()
        self.assertEqual(self.session.livekit_egress_id, "EG_sync")
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)

    @override_settings(LIVE_RECONCILER_MODE="shadow")
    @patch("apps.realtime.views.start_room_broadcast_egress", return_value="EG_go")
    def test_a_start_stuck_past_the_timeout_fails_on_the_poll_in_shadow_mode(self, mock_start):
        self.client.post(self.url, {}, format="json")
        self.age_go_live_job(lifecycle.starting_timeout_seconds() - 5)
        self.assertEqual(self.client.get(self.url).data["data"]["state"], "starting")
        self.age_go_live_job(10)

        data = self.client.get(self.url).data["data"]

        self.assertEqual(data["state"], "failed")
        self.assertEqual(data["error"], lifecycle.GO_LIVE_TIMEOUT_MESSAGE)
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_FAILED)
        # The host presses Go Live again: a fresh job runs and the class goes live.
        self.assertEqual(self.client.post(self.url, {}, format="json").status_code, 202)
        drain_outbox(batch_size=10)
        self.assertEqual(self.client.get(self.url).data["data"]["state"], "live")
        mock_start.assert_called_once()

    @override_settings(LIVE_RECONCILER_MODE="shadow")
    def test_a_start_with_no_job_state_times_out_from_the_row_age(self):
        # A synchronous start whose request died (or a flushed cache): no job state.
        RealtimeSession.objects.filter(pk=self.session.pk).update(
            stream_status=RealtimeSession.STREAM_STARTING,
            updated_at=timezone.now() - timedelta(seconds=lifecycle.starting_timeout_seconds() + 1),
        )
        self.assertEqual(self.client.get(self.url).data["data"]["state"], "failed")

    def test_a_fresh_start_is_not_timed_out(self):
        self.client.post(self.url, {}, format="json")
        self.session.refresh_from_db()
        self.assertFalse(lifecycle.expire_stuck_go_live(self.session))
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_STARTING)

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_cancel_while_starting_stops_the_queued_start(self, mock_start, _mock_stop):
        self.client.post(self.url, {}, format="json")

        stop = self.client.post(
            reverse("realtime-session-stream-stop", kwargs={"pk": self.session.pk}), {}, format="json"
        )

        self.assertEqual(stop.status_code, 200, stop.content)
        drain_outbox(batch_size=10)
        mock_start.assert_not_called()
        self.assertEqual(self.client.get(self.url).data["data"]["state"], "stopped")

    @patch("apps.realtime.views.start_room_broadcast_egress", return_value="EG_go")
    def test_go_live_opens_a_scheduled_class(self, _mock_start):
        RealtimeSession.objects.filter(pk=self.session.pk).update(
            status=RealtimeSession.STATUS_SCHEDULED, started_at=None
        )
        self.assertEqual(self.client.post(self.url, {}, format="json").status_code, 202)
        self.session.refresh_from_db()
        self.assertEqual(self.session.status, RealtimeSession.STATUS_LIVE)
        self.assertIsNotNone(self.session.started_at)


@override_settings(**ENFORCE)
class ObsStartLiveOpensTheClassTests(LifecycleFixture, APITestCase):
    """OBS Start Live moves a scheduled class to live: no extra Join Broadcast."""

    def setUp(self):
        super().setUp()
        self.session = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            status=RealtimeSession.STATUS_SCHEDULED,
            stream_status=RealtimeSession.STREAM_IDLE,
        )
        self.login(self.instructor)

    def start(self):
        return self.client.post(
            reverse("realtime-session-stream-start", kwargs={"pk": self.session.pk}), {}, format="json"
        )

    @patch("apps.realtime.views._start_class_recording_non_blocking")
    @patch("apps.realtime.views._sync_owncast_chat_settings_non_blocking")
    @patch("apps.realtime.views.sync_owncast_stream_key", return_value={"success": True})
    def test_start_live_opens_the_class_and_the_feed_marks_the_stream_live(self, _key, _chat, _rec):
        with patch("apps.realtime.services.get_owncast_public_status", return_value={"online": False}):
            response = self.start()
        self.assertEqual(response.status_code, 200, response.content)
        self.session.refresh_from_db()
        self.assertEqual(self.session.status, RealtimeSession.STATUS_LIVE)
        self.assertIsNotNone(self.session.started_at)
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_STARTING)
        self.assertEqual(lifecycle.live_state_for(self.session), "waiting")

        # OBS starts publishing: the reconciler (live sessions only) sees the feed.
        with patch("apps.realtime.services.get_owncast_public_status", return_value={"online": True}):
            self.tick()
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)

    @patch("apps.realtime.views.sync_owncast_stream_key")
    def test_a_failed_prepare_leaves_the_class_scheduled(self, mock_key):
        from apps.realtime.services import OwncastAdminError

        mock_key.side_effect = OwncastAdminError("owncast down")
        self.assertEqual(self.start().status_code, 400)
        self.session.refresh_from_db()
        self.assertEqual(self.session.status, RealtimeSession.STATUS_SCHEDULED)


# --- 7. stable meeting identity -------------------------------------------------------


class StableIdentityTests(LifecycleFixture, APITestCase):
    def test_identity_is_stable_per_device_and_parseable(self):
        from apps.realtime.services import _parse_user_id_from_participant_identity

        a = build_stable_meeting_identity(user_id=7, slot_id="slot-a")
        self.assertEqual(a, build_stable_meeting_identity(user_id=7, slot_id="slot-a"))
        self.assertNotEqual(a, build_stable_meeting_identity(user_id=7, slot_id="slot-b"))
        self.assertEqual(
            build_stable_meeting_identity(user_id=7, device_id="device-1234"),
            build_stable_meeting_identity(user_id=7, device_id="device-1234"),
        )
        self.assertEqual(_parse_user_id_from_participant_identity(a), 7)
        self.assertRegex(build_stable_meeting_identity(user_id=7), r"^user-7-\d+$")

    @override_settings(**LIVEKIT_SETTINGS)
    @patch("apps.realtime.views.build_meet_embed_url", return_value="https://meet.test/x")
    @patch("apps.realtime.views.get_room_participant_count", return_value=1)
    @patch("apps.realtime.views.build_participant_token", return_value="token")
    def test_rejoins_use_the_same_identity(self, _token, _count, _embed):
        session = self.make_session(session_type=RealtimeSession.TYPE_MEETING)
        self.login(self.student)
        url = reverse("realtime-session-join", kwargs={"pk": session.pk})
        first = self.client.post(url, {"device_id": "browser-abcdef12"}, format="json")
        second = self.client.post(url, {"device_id": "browser-abcdef12"}, format="json")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(
            first.data["data"]["meeting"]["participant_identity"],
            second.data["data"]["meeting"]["participant_identity"],
        )

    def test_bad_device_ids_are_rejected(self):
        session = self.make_session(session_type=RealtimeSession.TYPE_MEETING)
        self.login(self.student)
        response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.pk}), {"device_id": "<script>"}, format="json"
        )
        self.assertEqual(response.status_code, 400)


# --- 8. resource profile, preflight, deploy guard, worker heartbeat -------------------------


def ist(year, month, day, hour, minute):
    return datetime(year, month, day, hour, minute, tzinfo=LIVE_CLASS_TIMEZONE)


FRIDAY_CLASS = ist(2026, 11, 13, 19, 10)
FRIDAY_EARLY = ist(2026, 11, 13, 18, 50)
MONDAY_NOON = ist(2026, 11, 16, 12, 0)


@override_settings(REALTIME_AUTO_RESOURCE_PROFILE=True)
class ResourceProfileTests(LifecycleFixture, TestCase):
    def test_disabled_by_default(self):
        with self.settings(REALTIME_AUTO_RESOURCE_PROFILE=False):
            self.assertIsNone(resource_profile.apply_auto_resource_profile(MONDAY_NOON))

    def test_live_broadcast_wants_the_broadcast_profile(self):
        self.studio()
        self.assertEqual(resource_profile.apply_auto_resource_profile(MONDAY_NOON), "broadcast")
        self.assertEqual(ServerResourceProfile.get_solo().profile, "broadcast")

    def test_class_window_and_lead_time(self):
        self.assertTrue(resource_profile.in_class_window(FRIDAY_CLASS))
        self.assertTrue(resource_profile.in_class_window(FRIDAY_EARLY))
        self.assertFalse(resource_profile.in_class_window(ist(2026, 11, 13, 18, 40)))
        self.assertFalse(resource_profile.in_class_window(MONDAY_NOON))
        self.assertEqual(resource_profile.desired_profile(FRIDAY_EARLY), "broadcast")

    def test_meeting_profile_and_revert_after_ten_minutes(self):
        meeting = self.make_session(session_type=RealtimeSession.TYPE_MEETING)
        self.assertEqual(resource_profile.desired_profile(MONDAY_NOON), "meeting")
        lifecycle.end_session(meeting.pk, reason="host")
        self.assertIsNone(resource_profile.desired_profile(timezone.now()))  # hold right after End
        cache.set(lifecycle.LAST_LIVE_ACTIVITY_KEY, time.time() - 700, timeout=3600)
        self.assertEqual(resource_profile.desired_profile(MONDAY_NOON), "content")

    def test_a_manual_choice_is_kept_until_the_decision_changes(self):
        self.studio()
        resource_profile.apply_auto_resource_profile(MONDAY_NOON)
        profile = ServerResourceProfile.get_solo()
        profile.profile = "content"  # admin override mid-class
        profile.save()
        self.assertIsNone(resource_profile.apply_auto_resource_profile(MONDAY_NOON))
        self.assertEqual(ServerResourceProfile.get_solo().profile, "content")


@override_settings(REALTIME_PRECLASS_PROBE_ENABLED=True)
class PreflightTests(LifecycleFixture, APITestCase):
    def test_probe_window_is_ten_minutes_before_class(self):
        self.assertEqual(preflight.preclass_probe_due(ist(2026, 11, 13, 18, 52)), "2026-11-13")
        self.assertIsNone(preflight.preclass_probe_due(ist(2026, 11, 13, 18, 49)))
        self.assertIsNone(preflight.preclass_probe_due(ist(2026, 11, 13, 19, 0)))
        self.assertIsNone(preflight.preclass_probe_due(ist(2026, 11, 16, 18, 55)))

    def test_probe_runs_once_per_class_and_reports_red_checks(self):
        ok = lambda: {"name": "owncast", "ok": True, "detail": "HTTP 200"}  # noqa: E731
        bad = lambda: {"name": "egress", "ok": False, "detail": "refused"}  # noqa: E731
        with patch.object(preflight, "CHECKS", (ok, bad)):
            with self.assertLogs("ops.realtime", level="ERROR"):
                first = preflight.schedule_preclass_probe(ist(2026, 11, 13, 18, 52))
            second = preflight.schedule_preclass_probe(ist(2026, 11, 13, 18, 55))
        self.assertFalse(first["ok"])
        self.assertEqual(first["failed"], ["egress"])
        self.assertIsNone(second)
        self.assertEqual(preflight.latest_preflight()["failed"], ["egress"])

    def test_a_crashing_check_is_reported_not_raised(self):
        def boom():
            raise RuntimeError("kaboom")

        with self.assertLogs("ops.realtime", level="ERROR"):
            result = preflight.run_preflight(checks=(boom,))
        self.assertFalse(result["ok"])

    def test_endpoint_is_for_managers(self):
        url = reverse("realtime-preflight")
        self.login(self.student)
        self.assertEqual(self.client.get(url).status_code, 403)
        self.login(self.instructor)
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn("preflight", response.data["data"])


class DeployGuardCommandTests(LifecycleFixture, TestCase):
    def run_guard(self, *args, now=MONDAY_NOON):
        out = io.StringIO()
        with patch("apps.realtime.management.commands.live_deploy_guard.timezone.now", return_value=now):
            try:
                call_command("live_deploy_guard", *args, stdout=out, stderr=io.StringIO())
            except SystemExit as exc:
                return exc.code, out.getvalue()
        return 0, out.getvalue()

    def test_safe_when_nothing_is_live(self):
        self.studio(stream_status=RealtimeSession.STREAM_IDLE, livekit_egress_id="")  # created, never streamed
        self.assertEqual(self.run_guard()[0], 0)

    def test_refuses_while_a_class_streams(self):
        self.studio()
        self.assertEqual(self.run_guard()[0], 3)
        self.assertEqual(self.run_guard("--force")[0], 0)

    def test_refuses_inside_the_class_window(self):
        self.assertEqual(self.run_guard(now=FRIDAY_CLASS)[0], 4)
        self.assertEqual(self.run_guard("--skip-window", now=FRIDAY_CLASS)[0], 0)

    def test_json_output(self):
        self.studio()
        code, out = self.run_guard("--json")
        self.assertEqual(code, 3)
        self.assertIn('"safe": false', out)


class WorkerHeartbeatTests(SimpleTestCase):
    def test_touch_writes_the_liveness_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "hb", "worker-heartbeat")
            with self.settings(WORKER_HEARTBEAT_FILE=path):
                self.assertEqual(worker_heartbeat.touch_heartbeat(), path)
            self.assertTrue(os.path.exists(path))
            self.assertLess(time.time() - os.path.getmtime(path), 5)

    def test_disabled_without_a_path(self):
        with self.settings(WORKER_HEARTBEAT_FILE=""):
            self.assertIsNone(worker_heartbeat.touch_heartbeat())

    def test_hook_name_is_per_process(self):
        self.assertIn(str(os.getpid()), worker_heartbeat.hook_name())
