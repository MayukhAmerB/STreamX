"""Class calendar (apps.attendance): schedule -> occurrences (weekdays,
exceptions, IST without DST), idempotent materialisation that never
duplicates sessions and respects manual edits, change notifications, the
student/staff/public APIs and the personal iCalendar feed."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance import calendar_queries, ics, scheduling
from apps.attendance.models import CalendarFeedToken, ClassSchedule, ScheduledClass, ScheduleException
from apps.core import features
from apps.realtime.models import RealtimeSession

from . import factories as f
from .test_attendance import reset_attendance_state

IST = ZoneInfo("Asia/Kolkata")
UTC = ZoneInfo("UTC")


def spec(**overrides):
    values = {
        "title_pattern": "{course} · Class {n}",
        "start_date": date(2026, 11, 2),  # a Monday
        "end_date": date(2026, 11, 29),
        "weekdays": [4, 5, 6],  # Fri, Sat, Sun
        "start_time": time(19, 0),
        "duration_minutes": 60,
        "course_title": "OSINT",
        "schedule_id": 9,
    }
    values.update(overrides)
    return scheduling.ScheduleSpec(**values)


class OccurrenceTests(TestCase):
    def test_weekdays_between_the_dates_at_ist_time(self):
        items = scheduling.generate_occurrences(spec(), [])
        self.assertEqual(len(items), 12)  # 4 weeks x Fri/Sat/Sun
        self.assertTrue(all(timezone.localtime(item.starts_at, IST).weekday() in (4, 5, 6) for item in items))
        first = items[0]
        self.assertEqual(first.key, "s9:2026-11-06")
        self.assertEqual(first.starts_at, datetime(2026, 11, 6, 13, 30, tzinfo=UTC))  # 19:00 IST
        self.assertEqual(first.ends_at - first.starts_at, timedelta(minutes=60))
        self.assertEqual([item.title for item in items[:2]], ["OSINT · Class 1", "OSINT · Class 2"])

    def test_ist_has_no_daylight_saving(self):
        items = scheduling.generate_occurrences(
            spec(start_date=date(2026, 1, 1), end_date=date(2026, 12, 31), weekdays=[0]), []
        )
        self.assertEqual({(item.starts_at.hour, item.starts_at.minute) for item in items}, {(13, 30)})
        self.assertEqual(len(items), 52)

    def test_cancelled_rescheduled_and_extra(self):
        moved_to = datetime(2026, 11, 8, 20, 0, tzinfo=IST)
        extra_at = datetime(2026, 11, 11, 18, 0, tzinfo=IST)
        items = scheduling.generate_occurrences(
            spec(),
            [
                scheduling.ExceptionSpec(kind="cancelled", date=date(2026, 11, 6), note="Holiday", id=1),
                scheduling.ExceptionSpec(kind="rescheduled", date=date(2026, 11, 7), new_start=moved_to, id=2),
                scheduling.ExceptionSpec(kind="extra", date=date(2026, 11, 11), new_start=extra_at, duration_minutes=90, title="Doubt clearing", id=3),
            ],
        )
        by_key = {item.key: item for item in items}
        self.assertEqual(by_key["s9:2026-11-06"].status, "cancelled")
        self.assertIsNone(by_key["s9:2026-11-06"].number)
        self.assertEqual(by_key["s9:2026-11-07"].kind, "rescheduled")
        self.assertEqual(by_key["s9:2026-11-07"].starts_at, moved_to.astimezone(UTC))
        extra = by_key["s9:x3"]
        self.assertEqual((extra.kind, extra.title, extra.ends_at - extra.starts_at), ("extra", "Doubt clearing", timedelta(minutes=90)))
        numbered = [item.number for item in items if item.status == "scheduled"]
        self.assertEqual(numbered, list(range(1, len(numbered) + 1)))

    def test_title_placeholders_are_plain_text_only(self):
        items = scheduling.generate_occurrences(spec(title_pattern="{weekday} {date} {batch} {unknown} {course.__class__}", batch="B7"), [])
        self.assertEqual(items[0].title, "Friday 6 Nov B7 {unknown} {course.__class__}")


class CalendarCase(TestCase):
    def setUp(self):
        reset_attendance_state()
        from apps.courses.models import Enrollment, LiveClass

        self.instructor = f.make_instructor(full_name="Imran Syed")
        self.course = f.make_course(instructor=self.instructor, title="OSINT Batch 7", batch="B7")
        self.live_class = LiveClass.objects.create(title="OSINT live", description="Weekly", linked_course=self.course)
        self.student = f.make_user()
        f.make_enrollment(user=self.student, course=self.course)
        Enrollment.objects.filter(course=self.course).update(enrolled_at=timezone.now() - timedelta(days=30))
        self.staff = f.make_admin()
        self.now = timezone.now()

    def tearDown(self):
        reset_attendance_state()

    def as_user(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def make_schedule(self, **overrides):
        today = timezone.localtime(self.now, IST).date()
        values = {
            "course": self.course,
            "live_class": self.live_class,
            "start_date": today,
            "end_date": today + timedelta(days=60),
            "weekdays": list(range(7)),  # daily: easy maths
            "start_time": time(23, 0),
            "duration_minutes": 60,
            "host": self.instructor,
            "title_pattern": "{course} · Class {n}",
        }
        values.update(overrides)
        return ClassSchedule.objects.create(**values)

    def materialize(self, schedule, **kwargs):
        schedule.refresh_from_db()
        return scheduling.materialize_schedule(schedule, now=kwargs.pop("now", self.now), **kwargs)


class MaterializeTests(CalendarCase):
    def test_occurrences_within_the_horizon_and_sessions_within_the_lead(self):
        schedule = self.make_schedule()
        stats = self.materialize(schedule)
        self.assertGreaterEqual(stats["created"], 30)
        self.assertLessEqual(stats["created"], 32)
        # Daily 23:00 IST classes: only those starting within 24 h get a session.
        self.assertIn(stats["sessions_created"], (1, 2))
        session = ScheduledClass.objects.filter(session__isnull=False).first().session
        self.assertEqual(
            (session.status, session.linked_live_class_id, session.linked_course_id, session.host_id),
            ("scheduled", self.live_class.pk, self.course.pk, self.instructor.pk),
        )

    def test_materialisation_is_idempotent(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        counts = (ScheduledClass.objects.count(), RealtimeSession.objects.count())
        again = self.materialize(schedule)
        self.assertEqual((ScheduledClass.objects.count(), RealtimeSession.objects.count()), counts)
        self.assertEqual((again["created"], again["updated"], again["sessions_created"]), (0, 0, 0))

    def test_an_existing_manual_session_is_adopted_not_duplicated(self):
        manual = f.make_realtime_session(
            host=self.instructor, linked_live_class=self.live_class, status=RealtimeSession.STATUS_SCHEDULED,
            title="Made by hand",
        )
        stats = self.materialize(self.make_schedule())
        self.assertEqual((stats["sessions_adopted"], RealtimeSession.objects.count()), (1, 1))
        row = ScheduledClass.objects.get(session=manual)
        self.assertTrue(row.manually_edited)
        manual.refresh_from_db()
        self.assertEqual(manual.title, "Made by hand")

    def test_manual_edits_win(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        row = ScheduledClass.objects.filter(session__isnull=False).order_by("starts_at").first()
        RealtimeSession.objects.filter(pk=row.session_id).update(title="Renamed by the instructor")
        schedule.title_pattern = "New pattern {n}"
        schedule.save()
        self.materialize(schedule)
        row.refresh_from_db()
        self.assertTrue(row.manually_edited)
        self.assertEqual(row.session.title, "Renamed by the instructor")

    def test_a_deleted_session_is_never_recreated(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        row = ScheduledClass.objects.filter(session__isnull=False).first()
        RealtimeSession.objects.filter(pk=row.session_id).delete()
        self.materialize(schedule)
        row.refresh_from_db()
        self.assertIsNone(row.session_id)
        self.assertIsNotNone(row.session_created_at)

    def test_cancelling_a_date_cancels_the_occurrence_and_its_untouched_session(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        row = ScheduledClass.objects.filter(session__isnull=False).order_by("starts_at").first()
        session_id = row.session_id
        ScheduleException.objects.create(schedule=schedule, kind="cancelled", date=row.original_date, note="Holiday")
        stats = self.materialize(schedule)
        row.refresh_from_db()
        self.assertEqual(row.status, "cancelled")
        self.assertFalse(RealtimeSession.objects.filter(pk=session_id).exists())
        self.assertEqual(stats["sessions_deleted"], 1)

    def test_live_or_started_sessions_are_never_touched(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        row = ScheduledClass.objects.filter(session__isnull=False).order_by("starts_at").first()
        RealtimeSession.objects.filter(pk=row.session_id).update(status="live", started_at=self.now)
        ScheduleException.objects.create(schedule=schedule, kind="cancelled", date=row.original_date)
        self.materialize(schedule)
        self.assertTrue(RealtimeSession.objects.filter(pk=row.session_id, status="live").exists())

    def test_past_occurrences_are_history(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        first = ScheduledClass.objects.order_by("starts_at").first()
        later = first.ends_at + timedelta(hours=1)
        schedule.start_time = time(10, 0)
        schedule.save()
        self.materialize(schedule, now=later)
        first.refresh_from_db()
        self.assertEqual(first.status, "scheduled")
        self.assertEqual(timezone.localtime(first.starts_at, IST).hour, 23)

    def test_pausing_cancels_upcoming_classes(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        schedule.is_active = False
        schedule.save()
        self.materialize(schedule)
        self.assertFalse(ScheduledClass.objects.filter(status="scheduled", starts_at__gt=self.now).exists())

    def test_changes_notify_the_batch_once(self):
        from apps.notifications.models import Notification, NotificationRecipient

        schedule = self.make_schedule()
        self.materialize(schedule, notify=True)
        published = Notification.objects.get(event_key__startswith=f"calendar:{schedule.pk}:")
        self.assertEqual(published.title, "Class schedule published")
        self.assertTrue(NotificationRecipient.objects.filter(notification=published, user=self.student).exists())
        target = ScheduledClass.objects.order_by("starts_at")[2]
        ScheduleException.objects.create(schedule=schedule, kind="cancelled", date=target.original_date, note="Holiday")
        schedule.version += 1
        schedule.save()
        self.materialize(schedule, notify=True)
        changed = Notification.objects.filter(event_key__startswith=f"calendar:{schedule.pk}:").exclude(pk=published.pk).get()
        self.assertIn("Cancelled", changed.body)
        self.assertIn("Holiday", changed.body)
        self.assertEqual(changed.action_url, "/calendar")
        self.materialize(schedule, notify=True)  # nothing changed: no new notification
        self.assertEqual(Notification.objects.filter(event_key__startswith=f"calendar:{schedule.pk}:").count(), 2)

    def test_a_broken_notification_never_blocks_materialisation(self):
        schedule = self.make_schedule()
        with patch("apps.notifications.services.create_notification", side_effect=RuntimeError("boom")):
            stats = self.materialize(schedule, notify=True)
        self.assertGreater(stats["created"], 0)

    def test_outbox_handlers(self):
        from apps.attendance.outbox_handlers import handle_materialize, handle_materialize_schedule

        schedule = self.make_schedule()
        result = handle_materialize_schedule(SimpleNamespace(payload={"schedule_id": schedule.pk, "notify": False}))
        self.assertGreater(result["created"], 0)
        totals = handle_materialize(SimpleNamespace(payload={}))
        self.assertEqual((totals["schedules"], totals["created"]), (1, 0))


class StaffScheduleApiTests(CalendarCase):
    def payload(self, **overrides):
        today = timezone.localtime(self.now, IST).date()
        data = {
            "course": self.course.pk,
            "live_class": self.live_class.pk,
            "start_date": (today + timedelta(days=1)).isoformat(),
            "end_date": (today + timedelta(days=28)).isoformat(),
            "weekdays": [4, 5, 6],
            "start_time": "19:00",
            "duration_minutes": 60,
            "title_pattern": "{course} · Class {n}",
            "exceptions": [],
        }
        data.update(overrides)
        return data

    def test_preview_writes_nothing(self):
        response = self.as_user(self.staff).post("/api/calendar/staff/schedules/preview/", self.payload(), format="json")
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertGreaterEqual(data["count"], 10)
        self.assertEqual(data["occurrences"][0]["local_time"], "19:00")
        self.assertFalse(ClassSchedule.objects.exists())
        self.assertFalse(RealtimeSession.objects.exists())

    def test_create_publishes_materialisation_and_validates(self):
        from apps.core.models import OutboxEvent

        response = self.as_user(self.staff).post("/api/calendar/staff/schedules/", self.payload(), format="json")
        self.assertEqual(response.status_code, 201, response.content)
        schedule_id = response.json()["data"]["id"]
        self.assertTrue(OutboxEvent.objects.filter(dedupe_key=f"cal-sched:{schedule_id}:v1").exists())
        self.assertEqual(response.json()["data"]["host"]["id"], self.staff.pk)
        bad = self.as_user(self.staff).post(
            "/api/calendar/staff/schedules/", self.payload(end_date="2020-01-01"), format="json"
        )
        self.assertEqual(bad.status_code, 400)
        script = self.as_user(self.staff).post(
            "/api/calendar/staff/schedules/", self.payload(title_pattern="<script>x</script>"), format="json"
        )
        self.assertEqual(script.status_code, 400)

    def test_exceptions_update_and_pause(self):
        created = self.as_user(self.staff).post("/api/calendar/staff/schedules/", self.payload(), format="json").json()["data"]
        url = f"/api/calendar/staff/schedules/{created['id']}/"
        first_date = created["next_occurrences"][0]["date"]
        exc = self.as_user(self.staff).post(
            url + "exceptions/", {"kind": "cancelled", "date": first_date, "note": "Holiday"}, format="json"
        )
        self.assertEqual(exc.status_code, 201, exc.content)
        self.assertEqual(exc.json()["data"]["next_occurrences"][0]["status"], "cancelled")
        exception_id = exc.json()["data"]["exceptions"][0]["id"]
        patched = self.as_user(self.staff).patch(url, {"start_time": "20:00"}, format="json")
        self.assertEqual(patched.status_code, 200, patched.content)
        self.assertEqual(patched.json()["data"]["start_time"], "20:00")
        self.assertEqual(patched.json()["data"]["version"], 3)
        removed = self.as_user(self.staff).delete(f"/api/calendar/staff/exceptions/{exception_id}/")
        self.assertEqual(removed.status_code, 200)
        paused = self.as_user(self.staff).delete(url)
        self.assertEqual(paused.json()["data"]["is_active"], False)

    def test_permissions(self):
        self.assertEqual(
            self.as_user(self.student).post("/api/calendar/staff/schedules/", self.payload(), format="json").status_code, 403
        )
        own = self.as_user(self.instructor).post("/api/calendar/staff/schedules/", self.payload(), format="json")
        self.assertEqual(own.status_code, 201, own.content)
        other_course = f.make_course()
        from apps.courses.models import LiveClass

        other_live = LiveClass.objects.create(title="Other", description="x", linked_course=other_course)
        denied = self.as_user(self.instructor).post(
            "/api/calendar/staff/schedules/", self.payload(course=other_course.pk, live_class=other_live.pk), format="json"
        )
        self.assertEqual(denied.status_code, 403)
        host_other = self.as_user(self.instructor).post(
            "/api/calendar/staff/schedules/", self.payload(host=self.staff.pk), format="json"
        )
        self.assertEqual(host_other.status_code, 403)
        options = self.as_user(self.instructor).get("/api/calendar/staff/options/").json()["data"]
        self.assertEqual([row["id"] for row in options["courses"]], [self.course.pk])


class StudentCalendarTests(CalendarCase):
    def test_student_sees_own_batches_with_status_and_attendance(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        other = f.make_course()
        from apps.courses.models import LiveClass

        other_live = LiveClass.objects.create(title="Other", description="x", linked_course=other)
        ClassSchedule.objects.create(
            course=other, live_class=other_live, start_date=schedule.start_date, end_date=schedule.end_date,
            weekdays=list(range(7)), start_time=time(9, 0), host=self.instructor,
        )
        response = self.as_user(self.student).get("/api/calendar/me/events/")
        self.assertEqual(response.status_code, 200, response.content)
        events = response.json()["data"]["events"]
        self.assertTrue(events)
        self.assertEqual({event["course"]["id"] for event in events}, {self.course.pk})
        self.assertEqual({event["status"] for event in events}, {"upcoming"})
        self.assertEqual(events[0]["host"], {"name": "Imran Syed"})
        self.assertEqual(events[0]["join_path"], f"/courses/{self.course.pk}/live")
        self.assertEqual(self.as_user(f.make_user()).get("/api/calendar/me/events/").json()["data"]["events"], [])

    def test_live_and_past_classes(self):
        from apps.attendance import services

        session = f.make_realtime_session(
            host=self.instructor, linked_live_class=self.live_class, linked_course=self.course,
            status=RealtimeSession.STATUS_LIVE, started_at=self.now - timedelta(minutes=70),
        )
        events = calendar_queries.student_events(self.student, self.now - timedelta(days=1), self.now + timedelta(days=1))
        self.assertEqual(events[0]["status"], "live")
        self.assertTrue(events[0]["can_join"])
        RealtimeSession.objects.filter(pk=session.pk).update(status="ended", ended_at=self.now - timedelta(minutes=5))
        services.finalize_session(session.pk)
        events = calendar_queries.student_events(self.student, self.now - timedelta(days=1), self.now + timedelta(days=1))
        self.assertEqual((events[0]["status"], events[0]["attendance"]), ("ended", "absent"))

    def test_public_upcoming_needs_no_sign_in(self):
        self.materialize(self.make_schedule())
        response = APIClient().get("/api/calendar/public/upcoming/?limit=3")
        self.assertEqual(response.status_code, 200)
        events = response.json()["data"]["events"]
        self.assertEqual(len(events), 3)
        self.assertEqual(set(events[0]), {"id", "title", "course", "starts_at", "ends_at", "date", "timezone", "host", "status", "kind"})

    @override_settings(FEATURE_FORCE={"attendance": False})
    def test_switch_off(self):
        features.invalidate_cache()
        self.assertEqual(self.as_user(self.student).get("/api/calendar/me/events/").status_code, 403)
        self.assertEqual(APIClient().get("/api/calendar/public/upcoming/").json()["data"]["events"], [])


class FeedTests(CalendarCase):
    def feed_url(self):
        response = self.as_user(self.student).post("/api/calendar/me/feed/")
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertTrue(data["webcal_url"].startswith("webcal://"))
        return data["url"].split("testserver", 1)[1]

    def test_feed_is_valid_icalendar(self):
        schedule = self.make_schedule()
        self.materialize(schedule)
        ScheduleException.objects.create(
            schedule=schedule, kind="cancelled", date=ScheduledClass.objects.order_by("starts_at")[1].original_date,
            note="Holiday, sorry; see you",
        )
        self.materialize(schedule)
        response = APIClient().get(self.feed_url())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Type"].startswith("text/calendar"))
        body = response.content.decode("utf-8")
        self.assertTrue(body.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"))
        self.assertTrue(body.endswith("END:VCALENDAR\r\n"))
        lines = body.split("\r\n")
        self.assertTrue(all(len(line.encode("utf-8")) <= 75 for line in lines))
        self.assertNotIn("\n", body.replace("\r\n", ""))
        self.assertEqual(body.count("BEGIN:VEVENT"), body.count("END:VEVENT"))
        self.assertGreaterEqual(body.count("BEGIN:VEVENT"), 30)
        self.assertIn("STATUS:CANCELLED", body)
        unfolded = body.replace("\r\n ", "")
        self.assertRegex(unfolded, r"DTSTART:\d{8}T173000Z")  # 23:00 IST
        self.assertIn("Holiday\\, sorry\\; see you", unfolded)

    def test_rotation_and_revocation(self):
        old = self.feed_url()
        new = self.feed_url()
        self.assertEqual(APIClient().get(old).status_code, 404)
        self.assertEqual(APIClient().get(new).status_code, 200)
        self.assertEqual(self.as_user(self.student).delete("/api/calendar/me/feed/").json()["data"]["active"], False)
        self.assertEqual(APIClient().get(new).status_code, 404)
        self.assertEqual(APIClient().get("/api/calendar/feed/garbage.ics").status_code, 404)

    def test_tampered_token_is_refused(self):
        url = self.feed_url()
        other = f.make_user()
        token = url.rsplit("/", 1)[1][: -len(".ics")]
        forged = token.replace(f"{self.student.pk}.", f"{other.pk}.", 1)
        self.assertEqual(APIClient().get(f"/api/calendar/feed/{forged}.ics").status_code, 404)

    def test_inactive_user_feed_stops(self):
        url = self.feed_url()
        self.student.is_active = False
        self.student.save(update_fields=["is_active"])
        self.assertEqual(APIClient().get(url).status_code, 404)

    def test_line_folding_and_escaping(self):
        self.assertEqual(ics.escape_text("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne")
        folded = ics.fold("SUMMARY:" + "é" * 80)
        self.assertTrue(all(len(part.encode("utf-8")) <= 75 for part in folded.split("\r\n")))
        self.assertEqual(folded.replace("\r\n ", ""), "SUMMARY:" + "é" * 80)
        self.assertFalse(CalendarFeedToken.objects.exists())
