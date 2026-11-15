from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

from django.core.cache import cache
from django.test import override_settings
from django.test import SimpleTestCase

from .schedule import LIVE_CLASS_TIMEZONE, attendee_can_join_live_session, get_live_class_schedule_snapshot
from .services import refresh_obs_session_stream_health


class LiveClassScheduleTests(SimpleTestCase):
    def test_weekend_evening_window_is_open(self):
        friday_evening = datetime(2026, 7, 17, 19, 30, tzinfo=LIVE_CLASS_TIMEZONE)

        snapshot = get_live_class_schedule_snapshot(now=friday_evening)

        self.assertTrue(snapshot["is_open"])
        self.assertEqual(snapshot["timezone_label"], "IST")

    def test_weekday_and_late_weekend_are_closed(self):
        monday_evening = datetime(2026, 7, 13, 19, 30, tzinfo=LIVE_CLASS_TIMEZONE)
        sunday_late = datetime(2026, 7, 19, 20, 0, tzinfo=LIVE_CLASS_TIMEZONE)

        self.assertFalse(get_live_class_schedule_snapshot(now=monday_evening)["is_open"])
        self.assertFalse(get_live_class_schedule_snapshot(now=sunday_late)["is_open"])

    def test_next_window_points_to_next_weekend_class(self):
        monday_evening = datetime(2026, 7, 13, 19, 30, tzinfo=LIVE_CLASS_TIMEZONE)

        snapshot = get_live_class_schedule_snapshot(now=monday_evening)

        self.assertEqual(snapshot["next_start"], "2026-07-17T19:00:00+05:30")
        self.assertEqual(snapshot["next_end"], "2026-07-17T20:00:00+05:30")

    def test_live_broadcast_is_joinable_outside_weekly_window(self):
        monday_evening = datetime(2026, 7, 13, 19, 30, tzinfo=LIVE_CLASS_TIMEZONE)
        session = SimpleNamespace(
            status="live",
            STATUS_LIVE="live",
            session_type="broadcasting",
            TYPE_BROADCASTING="broadcasting",
            stream_status="live",
            STREAM_LIVE="live",
        )

        self.assertTrue(attendee_can_join_live_session(session, now=monday_evening))

    def test_stopped_broadcast_is_not_joinable(self):
        session = SimpleNamespace(
            status="live",
            STATUS_LIVE="live",
            session_type="broadcasting",
            TYPE_BROADCASTING="broadcasting",
            stream_status="stopped",
            STREAM_LIVE="live",
        )

        self.assertFalse(attendee_can_join_live_session(session))

    def test_live_meeting_still_respects_weekly_window(self):
        monday_evening = datetime(2026, 7, 13, 19, 30, tzinfo=LIVE_CLASS_TIMEZONE)
        session = SimpleNamespace(
            status="live",
            STATUS_LIVE="live",
            session_type="meeting",
            TYPE_BROADCASTING="broadcasting",
        )

        self.assertFalse(attendee_can_join_live_session(session, now=monday_evening))


class OwncastStreamHealthTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.session = SimpleNamespace(
            pk=71,
            session_type="broadcasting",
            TYPE_BROADCASTING="broadcasting",
            stream_service="obs",
            STREAM_SERVICE_OBS="obs",
            status="live",
            STATUS_ENDED="ended",
            stream_status="live",
            STREAM_IDLE="idle",
            STREAM_STARTING="starting",
            STREAM_LIVE="live",
            STREAM_STOPPED="stopped",
            STREAM_FAILED="failed",
        )

    @override_settings(REALTIME_OWNCAST_OFFLINE_GRACE_SECONDS=45)
    @patch("apps.realtime.services.get_owncast_public_status")
    def test_transient_offline_status_does_not_stop_live_stream(self, mock_status):
        mock_status.side_effect = [{"online": True}, {"online": False}]

        refresh_obs_session_stream_health(self.session, persist=False)
        result = refresh_obs_session_stream_health(self.session, force_refresh=True, persist=False)

        self.assertEqual(result["stream_status"], "live")
        self.assertTrue(result["grace_active"])

    @override_settings(REALTIME_OWNCAST_OFFLINE_GRACE_SECONDS=45)
    @patch("apps.realtime.services.get_owncast_public_status", return_value={"online": False})
    def test_sustained_offline_status_stops_stream_after_grace(self, _mock_status):
        cache.delete("realtime:owncast:last-online:71")

        result = refresh_obs_session_stream_health(self.session, force_refresh=True, persist=False)

        self.assertEqual(result["stream_status"], "stopped")
        self.assertFalse(result["grace_active"])
