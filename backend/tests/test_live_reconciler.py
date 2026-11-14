"""Live reconciler hardening (review findings on apps/realtime/reconciler.py).

Each class is table-driven over the scenarios one finding names:

* An attended OBS class is never auto-ended: the open Host Studio heartbeats
  "connected" for OBS sessions too.
* The tick never blocks the worker on StartEgress (restarts run as outbox
  jobs), stops at its time budget, and stops when it loses its lock (TTL
  expiry): two ticks never apply decisions side by side.
* One meeting LiveKit does not know ("room not found") is an answer about
  that meeting, not an outage: it must not blind the reconciler for every
  other session.
* A reconciler End only applies to the row it observed: a Go Live, resume or
  any other change between observe() and apply wins (compare-and-set races).
"""

from __future__ import annotations

import io
import itertools
import json
import time
from datetime import timedelta
from unittest.mock import patch
from urllib.error import HTTPError

from apps.core.concurrency import DistributedLock
from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.realtime import lifecycle, reconciler
from apps.realtime.models import RealtimeSession
from apps.realtime.reconciler import Decision, Observation, Policy, decide
from apps.realtime.services import LiveKitRoomServiceError
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from .test_phase1_reliability import RealtimeFixtureMixin

ENFORCE = {
    "LIVE_RECONCILER_MODE": "enforce",
    "OWNCAST_RTMP_TARGET": "rtmp://owncast:1935/live/stream-key",
    "LIVEKIT_URL": "ws://livekit.test",
    "LIVEKIT_SERVER_URL": "",
    "LIVEKIT_API_KEY": "devkey",
    "LIVEKIT_API_SECRET": "secret",
}
ABANDONED_AGO = 25 * 60  # past REALTIME_ABANDONED_END_MINUTES (20)
P = Policy()


class ReconcilerFixture(RealtimeFixtureMixin):
    def setUp(self):
        self.make_fixture()
        self.addCleanup(cache.clear)

    def obs_session(self, **overrides):
        fields = {"stream_service": RealtimeSession.STREAM_SERVICE_OBS, "stream_status": RealtimeSession.STREAM_STOPPED}
        fields.update(overrides)
        return self.make_session(**fields)

    def studio(self, **overrides):
        fields = {"stream_status": RealtimeSession.STREAM_LIVE, "livekit_egress_id": "EG_1"}
        fields.update(overrides)
        return self.make_session(**fields)

    def meeting(self, **overrides):
        return self.make_session(session_type=RealtimeSession.TYPE_MEETING, **overrides)

    def feed_lost(self, session, seconds_ago):
        cache.set(f"realtime:feed-last-seen:{session.pk}", time.time() - seconds_ago, timeout=3600)

    def host_seen(self, session, seconds_ago):
        cache.set(f"realtime:host-last-seen:{session.pk}", time.time() - seconds_ago, timeout=3600)

    def abandoned(self, session):
        """Feed gone and host silent for longer than the abandoned threshold."""
        self.feed_lost(session, ABANDONED_AGO)
        self.host_seen(session, ABANDONED_AGO)

    def tick(self, **kwargs):
        return reconciler.reconcile_live_sessions(**kwargs)

    def status_of(self, session):
        session.refresh_from_db()
        return session.status, session.stream_status


# --- 1. "could end a healthy OBS class" ---------------------------------------------


class AttendedObsDecisionTests(SimpleTestCase):
    TABLE = [
        # (name, host_state, host_seen_age, expected action)
        ("studio page open (fresh heartbeat)", lifecycle.HOST_CONNECTED, 5, "noop"),
        ("page closed a minute ago", None, 60, "noop"),
        ("page closed past the abandoned threshold", None, 1300, "end_session"),
        ("host never opened the page", None, None, "end_session"),
    ]

    def test_obs_abandoned_end_respects_host_presence(self):
        for name, host_state, seen_age, expected in self.TABLE:
            with self.subTest(name):
                observation = Observation(
                    session_id=1,
                    kind=lifecycle.KIND_OBS,
                    stream_status="stopped",
                    feed_online=False,
                    feed_lost_age=1300,
                    host_state=host_state,
                    host_seen_age=seen_age,
                )
                self.assertEqual(decide(observation, P).action, expected)


@override_settings(**ENFORCE)
@patch("apps.realtime.services.get_owncast_public_status", return_value={"online": False})
class AttendedObsClassTests(ReconcilerFixture, APITestCase):
    def heartbeat(self, session):
        self.login(self.instructor)
        return self.client.post(
            reverse("realtime-session-stream-heartbeat", kwargs={"pk": session.pk}),
            {"state": "connected", "publishing": False},
            format="json",
        )

    def test_obs_heartbeat_records_the_host_as_present(self, _owncast):
        session = self.obs_session()
        response = self.heartbeat(session)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(lifecycle.read_host_heartbeat(session.pk)["state"], lifecycle.HOST_CONNECTED)
        self.assertLess(lifecycle.host_last_seen_age(session.pk), 5)

    def test_obs_break_with_the_studio_open_is_not_auto_ended(self, _owncast):
        table = [
            # (name, studio page heartbeats, expected session status)
            ("studio open during a 25 min OBS break", True, RealtimeSession.STATUS_LIVE),
            ("nobody there for 25 min", False, RealtimeSession.STATUS_ENDED),
        ]
        for name, page_open, expected in table:
            with self.subTest(name):
                cache.clear()
                session = self.obs_session(title=name)
                self.abandoned(session)
                if page_open:
                    self.heartbeat(session)
                self.tick()
                self.assertEqual(self.status_of(session)[0], expected)
                if expected == RealtimeSession.STATUS_ENDED:
                    self.assertEqual(session.end_reason, lifecycle.END_REASON_ABANDONED)

    def test_presence_is_judged_by_the_observation_clock(self, _owncast):
        """A heartbeat still in the cache but older than its TTL (by the
        server clock the reconciler observes with) is not a present host."""
        ttl = lifecycle.host_heartbeat_ttl_seconds()
        table = [
            # (name, heartbeat age at observation, expected session status)
            ("heartbeat 5 s old", 5, RealtimeSession.STATUS_LIVE),
            ("heartbeat just past its TTL", ttl + 1, RealtimeSession.STATUS_ENDED),
            ("heartbeat 2 min old (studio closed)", 120, RealtimeSession.STATUS_ENDED),
        ]
        for name, age, expected in table:
            with self.subTest(name):
                cache.clear()
                RealtimeSession.objects.all().delete()
                session = self.obs_session(title=name)
                self.abandoned(session)
                lifecycle.record_host_heartbeat(
                    session.pk,
                    state=lifecycle.HOST_CONNECTED,
                    user_id=self.instructor.pk,
                    now=timezone.now() - timedelta(seconds=age),
                )
                self.host_seen(session, ABANDONED_AGO)  # last seen long ago unless the heartbeat is fresh
                self.assertIsNotNone(lifecycle.read_host_heartbeat(session.pk))  # still in the cache
                self.tick()
                self.assertEqual(self.status_of(session)[0], expected)

    def test_ended_obs_session_heartbeat_does_not_resurrect_presence(self, _owncast):
        session = self.obs_session(status=RealtimeSession.STATUS_ENDED)
        self.heartbeat(session)
        self.assertIsNone(lifecycle.read_host_heartbeat(session.pk))


# --- 2. "worker blocking, lock TTL" -------------------------------------------------


@override_settings(REALTIME_HOST_EGRESS_MAX_AUTO_RESTARTS=5, **ENFORCE)
class EgressRestartIsQueuedTests(ReconcilerFixture, TestCase):
    def interrupted_publishing_studio(self):
        session = self.studio(stream_status=RealtimeSession.STREAM_INTERRUPTED, livekit_egress_id="EG_dead")
        lifecycle.record_host_heartbeat(session.pk, state=lifecycle.HOST_PUBLISHING, user_id=self.instructor.pk)
        return session

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress", return_value="EG_new")
    @patch(
        "apps.realtime.services.get_broadcast_egress_status",
        return_value={"running": False, "status": "EGRESS_FAILED", "error": ""},
    )
    def test_the_tick_queues_the_restart_and_never_calls_start_egress_itself(self, _status, mock_start, _stop):
        session = self.interrupted_publishing_studio()
        result = self.tick()
        self.assertEqual([row[2] for row in result.applied], ["restart_egress"])
        mock_start.assert_not_called()  # StartEgress (up to a minute) is not on the tick
        self.assertEqual(
            OutboxEvent.objects.filter(
                event_type=lifecycle.EVENT_RESTART_EGRESS, status=OutboxEvent.STATUS_PENDING
            ).count(),
            1,
        )
        drain_outbox(batch_size=10)
        mock_start.assert_called_once()
        self.assertEqual(self.status_of(session)[1], RealtimeSession.STREAM_LIVE)

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch(
        "apps.realtime.services.get_broadcast_egress_status",
        return_value={"running": False, "status": "EGRESS_FAILED", "error": ""},
    )
    def test_a_restart_after_the_budget_window_expired_is_not_deduplicated_away(self, _status, mock_start, _stop):
        # Regression: the dedupe key was the budget count alone, which restarts
        # at 1 when the 10 min window expires. The second interruption's job
        # collided with the delivered first one and was silently dropped.
        mock_start.side_effect = ["EG_first", "EG_second"]
        session = self.interrupted_publishing_studio()
        self.tick()
        drain_outbox(batch_size=10)
        self.assertEqual(self.status_of(session), (RealtimeSession.STATUS_LIVE, RealtimeSession.STREAM_LIVE))

        # Twelve minutes later the stream drops again; the budget window expired.
        later = timezone.now() + timedelta(minutes=12)
        cache.delete_many(
            [lifecycle.restart_count_key(session.pk), f"realtime:host-egress:{session.pk}:next-restart-at"]
        )
        RealtimeSession.objects.filter(pk=session.pk).update(
            stream_status=RealtimeSession.STREAM_INTERRUPTED, livekit_egress_id="EG_first"
        )
        lifecycle.record_host_heartbeat(
            session.pk, state=lifecycle.HOST_PUBLISHING, user_id=self.instructor.pk, now=later
        )
        result = self.tick(now=later)
        self.assertEqual([row[2] for row in result.applied], ["restart_egress"])
        drain_outbox(batch_size=10)
        self.assertEqual(mock_start.call_count, 2)
        session.refresh_from_db()
        self.assertEqual(session.livekit_egress_id, "EG_second")
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_LIVE)

    @patch("apps.realtime.lifecycle.consume_restart_budget", return_value=0)
    def test_no_restart_is_queued_when_the_budget_cannot_be_counted(self, _consume):
        session = self.interrupted_publishing_studio()
        observation = Observation(
            session_id=session.pk,
            kind=lifecycle.KIND_STUDIO,
            stream_status="interrupted",
            feed_online=False,
            host_state=lifecycle.HOST_PUBLISHING,
            restart_allowed=True,
        )
        decision = decide(observation, P)
        self.assertEqual(decision.action, reconciler.ACTION_RESTART_EGRESS)
        self.assertFalse(reconciler.apply_decision(session, observation, decision))
        self.assertFalse(OutboxEvent.objects.filter(event_type=lifecycle.EVENT_RESTART_EGRESS).exists())

    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_a_queued_restart_loses_to_anything_that_moved_the_row(self, mock_start):
        table = [
            # (name, row change after the decision)
            ("host pressed Stop", {"stream_status": RealtimeSession.STREAM_STOPPED}),
            ("host ended the class", {"status": RealtimeSession.STATUS_ENDED}),
            ("egress came back by itself", {"stream_status": RealtimeSession.STREAM_LIVE}),
        ]
        for name, change in table:
            with self.subTest(name):
                cache.clear()
                session = self.interrupted_publishing_studio()
                lifecycle.queue_egress_restart(
                    session, expected_stream_status="interrupted", reason="host_publishing", now=timezone.now()
                )
                RealtimeSession.objects.filter(pk=session.pk).update(**change)
                drain_outbox(batch_size=10)
                mock_start.assert_not_called()
                event = OutboxEvent.objects.filter(event_type=lifecycle.EVENT_RESTART_EGRESS).latest("id")
                self.assertEqual(event.status, OutboxEvent.STATUS_DELIVERED)


@override_settings(**ENFORCE)
class TickLockAndBudgetTests(ReconcilerFixture, TestCase):
    LOCK_KEY = "core:lock:live.reconcile"

    def abandoned_studios(self, count):
        sessions = []
        for index in range(count):
            session = self.studio(title=f"S{index}", stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id="")
            self.abandoned(session)
            sessions.append(session)
        return sessions

    def test_lock_scenarios(self):
        """(name, another worker's lock state, expect skipped, expect lost)."""
        table = [
            ("free lock: the tick runs", None, False, False),
            ("held by a live worker: skip the tick", "held", True, False),
            ("expired mid-tick and taken over: stop", "expires_mid_tick", False, True),
        ]
        for name, other, expect_skipped, expect_lost in table:
            with self.subTest(name):
                cache.clear()
                RealtimeSession.objects.all().delete()
                sessions = self.abandoned_studios(3)
                competitor = DistributedLock("live.reconcile", ttl=60)
                if other == "held":
                    self.assertTrue(competitor.acquire(blocking=False))
                real_observe = reconciler.observe
                calls = []

                def observe_then_lose_the_lock(
                    session, _calls=calls, _other=other, _competitor=competitor, _observe=real_observe, **kwargs
                ):
                    _calls.append(session.pk)
                    if _other == "expires_mid_tick" and len(_calls) == 1:
                        cache.delete(self.LOCK_KEY)  # our TTL ran out
                        self.assertTrue(_competitor.acquire(blocking=False))  # another worker's tick
                    return _observe(session, **kwargs)

                with patch("apps.realtime.reconciler.observe", side_effect=observe_then_lose_the_lock):
                    result = self.tick()
                ended = RealtimeSession.objects.filter(
                    pk__in=[s.pk for s in sessions], status=RealtimeSession.STATUS_ENDED
                ).count()
                self.assertEqual(result.skipped_lock, expect_skipped)
                self.assertEqual(result.lost_lock, expect_lost)
                if expect_skipped:
                    self.assertEqual((result.observed, ended), (0, 0))
                elif expect_lost:
                    # Only the session observed before the lock was lost.
                    self.assertEqual((result.observed, ended, result.deferred), (1, 1, 2))
                    # Our release must not delete the successor's lock.
                    self.assertTrue(competitor.locked())
                    self.assertEqual(cache.get(self.LOCK_KEY), competitor.token)
                else:
                    self.assertEqual((result.observed, ended), (3, 3))
                    self.assertIsNone(cache.get(self.LOCK_KEY))  # released
                competitor.release()

    def test_the_lock_ttl_is_extended_between_sessions(self):
        self.abandoned_studios(2)
        extended = []
        real_extend = DistributedLock.extend

        def spy(lock, *args, **kwargs):
            extended.append(lock.ttl)
            return real_extend(lock, *args, **kwargs)

        with patch.object(DistributedLock, "extend", spy):
            self.tick()
        self.assertEqual(extended, [reconciler.LOCK_TTL_SECONDS])

    def test_lock_ttl_outlives_the_worst_case_tick(self):
        from django.conf import settings

        status_timeout = int(getattr(settings, "LIVEKIT_EGRESS_STATUS_TIMEOUT_SECONDS", 5) or 5)
        worst_single_observation = 4 * status_timeout  # every configured base URL times out
        self.assertGreater(reconciler.LOCK_TTL_SECONDS, reconciler.tick_budget_seconds() + worst_single_observation)

    @override_settings(LIVE_RECONCILER_TICK_BUDGET_SECONDS=1)
    def test_the_tick_stops_at_its_time_budget(self):
        table = [
            # (name, monotonic clock readings, expected observed, expected deferred)
            ("fast tick observes everyone", [0.0, 0.1, 0.2], 3, 0),
            ("slow LiveKit: the rest wait", [0.0, 0.4, 1.5], 2, 1),
            ("first call eats the budget", [0.0, 2.0], 1, 2),
        ]
        for name, readings, expected_observed, expected_deferred in table:
            with self.subTest(name):
                cache.clear()
                RealtimeSession.objects.all().delete()
                self.abandoned_studios(3)
                clock = itertools.chain(readings, itertools.repeat(readings[-1]))
                # Only the reconciler's clock (the lock and Django keep the real one).
                with patch("apps.realtime.reconciler.time") as fake_time:
                    fake_time.monotonic.side_effect = lambda _clock=clock: next(_clock)
                    result = self.tick()
                self.assertEqual((result.observed, result.deferred), (expected_observed, expected_deferred))


# --- 3. "blinded by one empty meeting" -----------------------------------------------


@override_settings(**ENFORCE)
class MeetingRoomNotFoundTests(ReconcilerFixture, TestCase):
    def test_listparticipants_errors(self):
        table = [
            # (name, error text, meeting feed, LiveKit marked down)
            (
                "room never created (twirp not_found)",
                'RoomService ListParticipants HTTP 404: {"code":"not_found","msg":"requested room does not exist"}',
                False,
                False,
            ),
            (
                "room closed after its empty timeout",
                "RoomService ListParticipants HTTP 404: room not found",
                False,
                False,
            ),
            (
                "connection refused",
                "RoomService ListParticipants network error: <urlopen error [Errno 111] Connection refused>",
                None,
                True,
            ),
            ("timeout", "RoomService ListParticipants unknown error: timed out", None, True),
            ("gateway down", "RoomService ListParticipants HTTP 502: bad gateway", None, True),
            (
                "bad credentials (one-room app error)",
                "RoomService ListParticipants HTTP 401: unauthorized",
                None,
                False,
            ),
        ]
        for name, text, expected_feed, expected_down in table:
            with self.subTest(name):
                cache.clear()
                session = self.meeting(title=name)
                with patch(
                    "apps.realtime.services.list_room_participant_count", side_effect=LiveKitRoomServiceError(text)
                ):
                    self.assertEqual(reconciler._meeting_has_participants(session), expected_feed)
                self.assertEqual(bool(cache.get(reconciler.LIVEKIT_DOWN_CACHE_KEY)), expected_down)

    def test_an_empty_meeting_does_not_blind_the_reconciler_for_other_sessions(self):
        """Real HTTP path: LiveKit answers 404 not_found for the meeting room."""
        meeting = self.meeting(title="Nobody joined")
        studio = self.studio(title="Broadcast", livekit_egress_id="EG_live")
        requests = []

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(request, timeout=None):
            url = request.full_url
            requests.append(url.rsplit("/", 1)[-1])
            if url.endswith("RoomService/ListParticipants"):
                body = json.dumps({"code": "not_found", "msg": "requested room does not exist"}).encode()
                raise HTTPError(url, 404, "Not Found", {}, io.BytesIO(body))
            if url.endswith("Egress/ListEgress"):
                return Response(json.dumps({"items": [{"egress_id": "EG_live", "status": 1}]}).encode())
            raise AssertionError(f"unexpected LiveKit call {url}")

        with patch("apps.realtime.services.urlopen", side_effect=fake_urlopen):
            first = self.tick()
            second = self.tick()

        self.assertFalse(cache.get(reconciler.LIVEKIT_DOWN_CACHE_KEY))
        self.assertEqual((first.observed, second.observed), (2, 2))
        # The studio session was still asked about on both ticks and seen live.
        self.assertEqual(requests.count("ListEgress"), 2)
        self.assertLess(lifecycle.feed_lost_age(studio.pk), 5)
        self.assertEqual(self.status_of(studio), (RealtimeSession.STATUS_LIVE, RealtimeSession.STREAM_LIVE))
        self.assertEqual(self.status_of(meeting)[0], RealtimeSession.STATUS_LIVE)  # young: not abandoned yet

        # An empty meeting (participants once, then nobody for 25 min) still auto-ends.
        self.feed_lost(meeting, ABANDONED_AGO)
        with patch("apps.realtime.services.urlopen", side_effect=fake_urlopen):
            self.tick()
        self.assertEqual(self.status_of(meeting)[0], RealtimeSession.STATUS_ENDED)
        self.assertEqual(meeting.end_reason, lifecycle.END_REASON_ABANDONED)


# --- 4. "end_session from a stale decision" (CAS races) -----------------------------


@override_settings(**ENFORCE)
class StaleEndDecisionTests(ReconcilerFixture, TestCase):
    def test_a_change_between_observe_and_apply_cancels_the_auto_end(self):
        bump = timedelta(seconds=1)
        table = [
            # (name, row change after observe(), expected status, expected stream)
            (
                "nothing changed: abandoned class ends",
                None,
                RealtimeSession.STATUS_ENDED,
                RealtimeSession.STREAM_STOPPED,
            ),
            (
                "host pressed Go Live",
                {"stream_status": RealtimeSession.STREAM_STARTING},
                RealtimeSession.STATUS_LIVE,
                RealtimeSession.STREAM_STARTING,
            ),
            (
                "host resumed: feed back",
                {"stream_status": RealtimeSession.STREAM_LIVE},
                RealtimeSession.STATUS_LIVE,
                RealtimeSession.STREAM_LIVE,
            ),
            (
                "row touched, same stream status",
                {"updated_at": bump},
                RealtimeSession.STATUS_LIVE,
                RealtimeSession.STREAM_STOPPED,
            ),
        ]
        for name, change, expected_status, expected_stream in table:
            with self.subTest(name):
                cache.clear()
                RealtimeSession.objects.all().delete()  # one session per scenario
                session = self.studio(title=name, stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id="")
                self.abandoned(session)
                real_decide = reconciler.decide

                def decide_then_race(observation, policy=None, _change=change, _pk=session.pk, _decide=real_decide):
                    decision = _decide(observation, policy)
                    if _change:
                        values = dict(_change)
                        if "updated_at" in values:
                            values["updated_at"] = observation.observed_updated_at + values["updated_at"]
                        RealtimeSession.objects.filter(pk=_pk).update(**values)
                    return decision

                with patch("apps.realtime.reconciler.decide", side_effect=decide_then_race):
                    result = self.tick()
                self.assertEqual([row[2] for row in result.intended], ["end_session"])
                self.assertEqual(self.status_of(session), (expected_status, expected_stream))
                ended_events = OutboxEvent.objects.filter(
                    event_type=lifecycle.EVENT_LIVE_ENDED, payload__session_id=session.pk
                )
                self.assertEqual(ended_events.exists(), expected_status == RealtimeSession.STATUS_ENDED)
                self.assertEqual(bool(result.applied), expected_status == RealtimeSession.STATUS_ENDED)

    def test_end_session_guards(self):
        table = [
            # (name, kwargs builder, expect transitioned, expected end_reason)
            ("host End passes no expectation and always wins", lambda row: {}, True, "host"),
            (
                "matching expectation ends",
                lambda row: {"expected_stream_status": row.stream_status, "expected_updated_at": row.updated_at},
                True,
                "host",
            ),
            ("stale stream status is skipped", lambda row: {"expected_stream_status": "interrupted"}, False, ""),
            (
                "stale updated_at is skipped",
                lambda row: {"expected_updated_at": row.updated_at - timedelta(seconds=1)},
                False,
                "",
            ),
        ]
        for name, build, expect_transitioned, expected_reason in table:
            with self.subTest(name):
                session = self.studio(title=name, stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id="")
                result = lifecycle.end_session(session.pk, reason="host", **build(session))
                self.assertEqual(result.transitioned, expect_transitioned)
                session.refresh_from_db()
                self.assertEqual(session.end_reason, expected_reason)
                self.assertEqual(
                    session.status,
                    RealtimeSession.STATUS_ENDED if expect_transitioned else RealtimeSession.STATUS_LIVE,
                )

    def test_a_host_end_first_makes_the_auto_end_a_no_op(self):
        session = self.studio(stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id="")
        observed = RealtimeSession.objects.get(pk=session.pk)
        lifecycle.end_session(session.pk, reason="host")
        result = lifecycle.end_session(
            session.pk,
            reason=lifecycle.END_REASON_ABANDONED,
            expected_stream_status=observed.stream_status,
            expected_updated_at=observed.updated_at,
        )
        self.assertFalse(result.transitioned)
        session.refresh_from_db()
        self.assertEqual(session.end_reason, "host")
        self.assertEqual(
            OutboxEvent.objects.filter(event_type=lifecycle.EVENT_LIVE_ENDED, payload__session_id=session.pk).count(), 1
        )

    def test_mark_transitions_lose_to_a_concurrent_change(self):
        table = [
            # (name, observed stream, decision, row stream now, row status now)
            ("interrupt vs host Stop", "live", Decision("mark_interrupted", "interrupted"), "stopped", "live"),
            ("live vs host End", "interrupted", Decision("mark_live", "live"), "interrupted", "ended"),
            (
                "start timeout vs Go Live finished",
                "starting",
                Decision("mark_failed", "failed", "start_timeout"),
                "live",
                "live",
            ),
            ("stop vs egress restart won", "interrupted", Decision("mark_stopped", "stopped"), "live", "live"),
        ]
        for name, observed, decision, row_stream, row_status in table:
            with self.subTest(name):
                session = self.studio(title=name, stream_status=observed)
                observation = Observation(
                    session_id=session.pk, kind=lifecycle.KIND_STUDIO, stream_status=observed, feed_online=False
                )
                RealtimeSession.objects.filter(pk=session.pk).update(stream_status=row_stream, status=row_status)
                self.assertFalse(reconciler.apply_decision(session, observation, decision))
                self.assertEqual(self.status_of(session), (row_status, row_stream))
