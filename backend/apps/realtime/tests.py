from datetime import datetime
from types import SimpleNamespace

from django.test import SimpleTestCase

from .schedule import LIVE_CLASS_TIMEZONE, attendee_can_join_live_session, get_live_class_schedule_snapshot


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
        )

        self.assertTrue(attendee_can_join_live_session(session, now=monday_evening))

    def test_live_meeting_still_respects_weekly_window(self):
        monday_evening = datetime(2026, 7, 13, 19, 30, tzinfo=LIVE_CLASS_TIMEZONE)
        session = SimpleNamespace(
            status="live",
            STATUS_LIVE="live",
            session_type="meeting",
            TYPE_BROADCASTING="broadcasting",
        )

        self.assertFalse(attendee_can_join_live_session(session, now=monday_evening))
