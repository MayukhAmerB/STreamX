"""Attendance (apps.attendance): presence buffering + flush, finalisation,
the 40-minute rule, short sessions, overrides with audit, permissions, CSV,
fail-safe hooks and query counts."""

from __future__ import annotations

import time
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance import buffer, flush, hooks, policy, presence, queries, services
from apps.attendance.models import (
    AttendanceAudit,
    AttendanceFlushLog,
    AttendancePolicy,
    AttendanceRecord,
    SessionAttendance,
)
from apps.core import features
from apps.realtime.models import RealtimeSession

from . import factories as f
from .engagement_support import FakeRedis


class FakeAttendanceRedis(FakeRedis):
    """Adds the commands attendance uses on top of the engagement fake."""

    def hsetnx(self, key, field, value):
        self._log("hsetnx")
        bucket = self.data.setdefault(key, {})
        if field in bucket:
            return 0
        bucket[field] = value
        return 1

    def hset(self, key, field, value):
        self._log("hset")
        self.data.setdefault(key, {})[field] = value
        return 1

    def mget(self, keys):
        return [self.data.get(key) for key in keys]


def reset_attendance_state():
    from django.core.cache import cache

    cache.clear()
    features._pending.dirty = False
    features.invalidate_cache()
    buffer.reset_local_for_tests()
    buffer._client_override = None


class AttendanceCase(TestCase):
    def setUp(self):
        reset_attendance_state()
        from apps.courses.models import LiveClass

        self.instructor = f.make_instructor()
        self.course = f.make_course(instructor=self.instructor, title="OSINT Batch 7", batch="B7")
        self.live_class = LiveClass.objects.create(
            title="OSINT live", description="Weekly classes", linked_course=self.course
        )
        self.students = [f.make_user(full_name=f"Student {n}") for n in range(3)]
        for student in self.students:
            f.make_enrollment(user=student, course=self.course)
        from apps.courses.models import Enrollment

        Enrollment.objects.filter(course=self.course).update(enrolled_at=timezone.now() - timedelta(days=30))
        self.staff = f.make_admin()
        self.host = self.instructor

    def tearDown(self):
        reset_attendance_state()

    def live_session(self, minutes_ago=60, **overrides):
        fields = {
            "linked_live_class": self.live_class,
            "linked_course": self.course,
            "session_type": RealtimeSession.TYPE_MEETING,
            "status": RealtimeSession.STATUS_LIVE,
            "started_at": timezone.now() - timedelta(minutes=minutes_ago),
        }
        fields.update(overrides)
        return f.make_realtime_session(host=self.host, **fields)

    def end(self, session, *, on_air_minutes):
        RealtimeSession.objects.filter(pk=session.pk).update(
            status=RealtimeSession.STATUS_ENDED,
            ended_at=session.started_at + timedelta(minutes=on_air_minutes),
        )
        session.refresh_from_db()
        return session

    def as_user(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def present_for(self, session, user, seconds, *, joined=True):
        """Buffer `seconds` of presence for user (as the pings would)."""
        now_ts = time.time()
        buffer.record(session.pk, user.pk, seconds=seconds, ts=now_ts)


# --- the rule (pure) ------------------------------------------------------------------------------
class RuleTests(TestCase):
    rule = policy.Rule(present_min_minutes=40, short_session_ratio=0.8)

    def test_forty_minutes_live_is_present(self):
        self.assertEqual(policy.classify(seconds_present=40 * 60, joined=True, on_air_seconds=3600, rule=self.rule)[0], "present")
        self.assertEqual(policy.classify(seconds_present=40 * 60 - 1, joined=True, on_air_seconds=3600, rule=self.rule)[0], "partial")
        self.assertEqual(policy.classify(seconds_present=0, joined=False, on_air_seconds=3600, rule=self.rule)[0], "absent")
        self.assertEqual(policy.classify(seconds_present=0, joined=True, on_air_seconds=3600, rule=self.rule)[0], "partial")

    def test_short_session_uses_eighty_percent_of_on_air_time(self):
        status, threshold = policy.classify(seconds_present=24 * 60, joined=True, on_air_seconds=30 * 60, rule=self.rule)
        self.assertEqual((status, threshold.short_session, threshold.seconds), ("present", True, 24 * 60))
        status, _ = policy.classify(seconds_present=24 * 60 - 1, joined=True, on_air_seconds=30 * 60, rule=self.rule)
        self.assertEqual(status, "partial")
        self.assertFalse(policy.threshold_for(40 * 60, self.rule).short_session)

    def test_presence_is_capped_at_on_air_time(self):
        self.assertEqual(policy.percent(5000, 3600), 100.0)
        status, _ = policy.classify(seconds_present=10_000, joined=True, on_air_seconds=30 * 60, rule=self.rule)
        self.assertEqual(status, "present")

    def test_streaks_skip_excused(self):
        self.assertEqual(policy.streaks(["present", "excused", "present", "absent", "present", "present", "present"]), (2, 3))
        self.assertEqual(policy.streaks([]), (0, 0))
        self.assertEqual(policy.streaks(["partial", "present"]), (0, 1))

    def test_label(self):
        self.assertEqual(self.rule.label(), "Attended = 40+ minutes live")


# --- presence: buffered in Redis, never per-heartbeat database writes ---------------------------------------
class PresenceTests(AttendanceCase):
    def url(self, session, kind="presence"):
        return f"/api/attendance/sessions/{session.pk}/{kind}/"

    def test_pings_never_write_to_the_database(self):
        session = self.live_session()
        client = self.as_user(self.students[0])
        client.post(self.url(session))  # warm caches (status, access, switch)
        with CaptureQueriesContext(connection) as ctx:
            for _ in range(5):
                response = client.post(self.url(session))
                self.assertEqual(response.status_code, 200, response.content)
        writes = [
            q["sql"]
            for q in ctx.captured_queries
            if "attendance_" in q["sql"] and q["sql"].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
        ]
        self.assertEqual(writes, [])
        self.assertFalse(AttendanceRecord.objects.exists())
        self.assertIn((session.pk, self.students[0].pk), buffer.pending_snapshot())

    def test_a_warm_ping_costs_no_query(self):
        session = self.live_session()
        student = self.students[0]
        presence.ping(session.pk, student)
        with self.assertNumQueries(0):
            result = presence.ping(session.pk, student)
        self.assertTrue(result.counted)

    def test_first_ping_credits_a_minute_and_then_wall_clock(self):
        session = self.live_session()
        response = self.as_user(self.students[0]).post(self.url(session))
        self.assertEqual(response.json()["data"]["credited_seconds"], 60)
        self.assertTrue(response.json()["data"]["counted"])
        second = self.as_user(self.students[0]).post(self.url(session))
        self.assertLessEqual(second.json()["data"]["credited_seconds"], 1)

    def test_a_long_gap_is_capped(self):
        session = self.live_session()
        start = time.time()
        presence.credit_ping(session.pk, self.students[0].pk, now_ts=start)
        credit = presence.credit_ping(session.pk, self.students[0].pk, now_ts=start + 600)
        self.assertEqual(credit, 90)

    def test_join_starts_the_clock_and_leave_stops_it(self):
        session = self.live_session()
        start = time.time()
        self.assertEqual(presence.credit_join(session.pk, self.students[0].pk, now_ts=start), 0)
        self.assertEqual(presence.credit_ping(session.pk, self.students[0].pk, now_ts=start + 60), 60)
        self.assertEqual(presence.credit_leave(session.pk, self.students[0].pk, now_ts=start + 90), 30)
        # After leaving, the next ping starts fresh (first-ping credit), not from the leave.
        self.assertEqual(presence.credit_ping(session.pk, self.students[0].pk, now_ts=start + 1000), 60)

    def test_leave_endpoint(self):
        session = self.live_session()
        client = self.as_user(self.students[0])
        client.post(self.url(session))
        response = client.post(self.url(session, "leave"))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json()["data"]["counted"])

    def test_not_live_hosts_outsiders_and_missing(self):
        scheduled = self.live_session(status=RealtimeSession.STATUS_SCHEDULED, started_at=None)
        response = self.as_user(self.students[0]).post(self.url(scheduled))
        self.assertEqual(response.json()["data"], {"counted": False, "credited_seconds": 0, "reason": "not_live", "interval_seconds": 60})
        session = self.live_session()
        host = self.as_user(self.host).post(self.url(session))
        self.assertEqual(host.json()["data"]["reason"], "host_or_staff")
        outsider = self.as_user(f.make_user()).post(self.url(session))
        self.assertEqual(outsider.status_code, 403)
        self.assertEqual(self.as_user(self.students[0]).post("/api/attendance/sessions/999999/presence/").status_code, 404)
        self.assertIn(self.client.post(self.url(session)).status_code, (401, 403))

    @override_settings(FEATURE_FORCE={"attendance": False})
    def test_switch_off_refuses(self):
        features.invalidate_cache()
        session = self.live_session()
        response = self.as_user(self.students[0]).post(self.url(session))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "feature_disabled")


class FlushTests(AttendanceCase):
    def test_flush_writes_one_row_per_student(self):
        session = self.live_session()
        start = time.time()
        presence.credit_join(session.pk, self.students[0].pk, now_ts=start)
        for step in range(1, 6):
            presence.credit_ping(session.pk, self.students[0].pk, now_ts=start + 60 * step)
        presence.credit_ping(session.pk, self.students[1].pk, now_ts=start)
        stats = flush.flush()
        self.assertEqual(stats["rows"], 2)
        record = AttendanceRecord.objects.get(session_ref_id=session.pk, user=self.students[0])
        self.assertEqual(record.seconds_present, 300)
        self.assertEqual(record.course_id, self.course.pk)
        self.assertEqual(record.status, "partial")  # provisional while live
        self.assertIsNotNone(record.first_joined_at)
        self.assertEqual(flush.flush()["batches"], 0)  # nothing pending: nothing written

    def test_flush_through_redis_is_applied_exactly_once(self):
        fake = FakeAttendanceRedis()
        buffer._client_override = fake
        session = self.live_session()
        start = time.time()
        presence.credit_ping(session.pk, self.students[0].pk, now_ts=start)
        presence.credit_ping(session.pk, self.students[0].pk, now_ts=start + 60)
        self.assertEqual(set(fake.commands) & {"hincrby", "hsetnx", "hset", "set"}, {"hincrby", "hsetnx", "hset", "set"})
        batches = buffer.take_batches()
        self.assertEqual(len(batches), 1)
        token, data = batches[0]
        # A ping arriving during the flush lands in a fresh pending hash.
        presence.credit_ping(session.pk, self.students[0].pk, now_ts=start + 120)
        # Simulate a worker that committed but died before acknowledging.
        with self.captureOnCommitCallbacks(execute=True):
            AttendanceFlushLog.objects.create(token=token, rows=1)
            flush.apply_pairs(buffer.parse_batch(data))
        stats = flush.flush()  # sees the leftover batch (already applied) and the new one
        self.assertEqual(stats["batches"], 2)
        record = AttendanceRecord.objects.get(session_ref_id=session.pk, user=self.students[0])
        self.assertEqual(record.seconds_present, 120 + 60)
        self.assertEqual(buffer.take_batches(), [])

    @override_settings(
        CACHES={
            "default": {
                "BACKEND": "django.core.cache.backends.redis.RedisCache",
                "LOCATION": "redis://127.0.0.1:6399/9",
            }
        }
    )
    def test_production_redis_cache_backs_the_buffer(self):
        # Regression (production, Nov 2026): the check looked at the
        # ``django.core.cache.cache`` ConnectionProxy, which is never a
        # RedisCache, so every web process buffered presence in its own memory
        # and the worker flushed nothing (AttendanceFlushLog stayed empty).
        import redis

        client = buffer.redis_client()  # building the client never connects
        self.assertIsInstance(client, redis.Redis)
        self.assertTrue(buffer.uses_redis())

    def test_locmem_cache_uses_the_in_process_buffer(self):
        self.assertIsNone(buffer.redis_client())
        self.assertFalse(buffer.uses_redis())

    def test_presence_buffered_by_a_web_process_is_flushed_by_the_worker(self):
        # The real resolution path (no _client_override): a RedisCache backend
        # whose client is the shared fake. The web process pings, the in-process
        # buffer stays empty, and a flush (the worker) writes the record.
        from django.core.cache.backends.redis import RedisCache

        shared = FakeAttendanceRedis()
        backend = RedisCache("redis://127.0.0.1:6399/9", {})
        backend.__dict__["_cache"] = SimpleNamespace(get_client=lambda key=None, write=False: shared)
        session = self.live_session()
        start = time.time()
        with patch("apps.attendance.buffer.caches", {"default": backend}):
            presence.credit_join(session.pk, self.students[0].pk, now_ts=start)
            for step in range(1, 42):
                presence.credit_ping(session.pk, self.students[0].pk, now_ts=start + 60 * step)
            self.assertEqual(buffer._local.pending, {})  # nothing stranded in this process
            self.assertIn(buffer.PENDING_KEY, shared.data)
            stats = flush.flush()
        self.assertEqual(stats["batches"], 1)
        self.assertEqual(AttendanceFlushLog.objects.count(), 1)
        record = AttendanceRecord.objects.get(session_ref_id=session.pk, user=self.students[0])
        self.assertEqual(record.seconds_present, 41 * 60)
        self.assertEqual(record.status, "present")  # provisional: over the 40-minute bar

    def test_a_late_ping_after_finalisation_restatuses_the_record(self):
        session = self.live_session(minutes_ago=60)
        self.present_for(session, self.students[0], 30 * 60)
        self.end(session, on_air_minutes=60)
        services.finalize_session(session.pk)
        self.assertEqual(AttendanceRecord.objects.get(session_ref_id=session.pk, user=self.students[0]).status, "partial")
        self.present_for(session, self.students[0], 11 * 60)
        flush.flush()
        record = AttendanceRecord.objects.get(session_ref_id=session.pk, user=self.students[0])
        self.assertEqual(record.status, "present")
        self.assertEqual(SessionAttendance.objects.get(session_ref_id=session.pk).present_count, 1)


# --- finalisation ------------------------------------------------------------------------------------------
class FinalizeTests(AttendanceCase):
    def test_statuses_and_absent_rows_for_non_joiners(self):
        session = self.live_session(minutes_ago=70)
        present, partial, never = self.students
        self.present_for(session, present, 41 * 60)
        self.present_for(session, partial, 39 * 60)
        self.end(session, on_air_minutes=60)
        summary = services.finalize_session(session.pk)
        statuses = dict(AttendanceRecord.objects.filter(session_ref_id=session.pk).values_list("user_id", "status"))
        self.assertEqual(statuses, {present.pk: "present", partial.pk: "partial", never.pk: "absent"})
        self.assertNotIn(self.host.pk, statuses)  # hosts/instructors are never on the roster
        self.assertEqual(
            (summary.roster_count, summary.present_count, summary.partial_count, summary.absent_count),
            (3, 1, 1, 1),
        )
        self.assertFalse(summary.short_session)
        self.assertEqual(summary.threshold_seconds, 40 * 60)
        absent = AttendanceRecord.objects.get(session_ref_id=session.pk, user=never)
        self.assertEqual((absent.source, absent.seconds_present), ("roster", 0))

    def test_finalisation_is_idempotent(self):
        session = self.live_session(minutes_ago=70)
        self.present_for(session, self.students[0], 45 * 60)
        self.end(session, on_air_minutes=60)
        services.finalize_session(session.pk)
        first = list(AttendanceRecord.objects.filter(session_ref_id=session.pk).order_by("pk").values("pk", "status", "seconds_present"))
        summary = services.finalize_session(session.pk)
        second = list(AttendanceRecord.objects.filter(session_ref_id=session.pk).order_by("pk").values("pk", "status", "seconds_present"))
        self.assertEqual(first, second)
        self.assertEqual(summary.finalize_count, 2)
        self.assertEqual(SessionAttendance.objects.filter(session_ref_id=session.pk).count(), 1)

    def test_short_session_is_flagged_and_uses_eighty_percent(self):
        session = self.live_session(minutes_ago=40)
        self.present_for(session, self.students[0], 25 * 60)
        self.present_for(session, self.students[1], 20 * 60)
        self.end(session, on_air_minutes=30)
        summary = services.finalize_session(session.pk)
        self.assertTrue(summary.short_session)
        self.assertEqual(summary.threshold_seconds, 24 * 60)
        statuses = dict(AttendanceRecord.objects.filter(session_ref_id=session.pk).values_list("user_id", "status"))
        self.assertEqual(statuses[self.students[0].pk], "present")
        self.assertEqual(statuses[self.students[1].pk], "partial")

    def test_policy_row_changes_the_bar(self):
        policy_row = AttendancePolicy.current()
        policy_row.present_min_minutes = 30
        policy_row.save()
        session = self.live_session(minutes_ago=70)
        self.present_for(session, self.students[0], 31 * 60)
        self.end(session, on_air_minutes=60)
        services.finalize_session(session.pk)
        self.assertEqual(AttendanceRecord.objects.get(session_ref_id=session.pk, user=self.students[0]).status, "present")

    def test_never_started_or_still_live_sessions_are_not_finalised(self):
        live = self.live_session()
        self.assertIsNone(services.finalize_session(live.pk))
        never = f.make_realtime_session(host=self.host, status=RealtimeSession.STATUS_ENDED, linked_live_class=self.live_class)
        self.assertIsNone(services.finalize_session(never.pk))
        self.assertFalse(SessionAttendance.objects.exists())

    def test_classes_on_air_before_tracking_started_are_never_finalised(self):
        # A class left on air from before the attendance release (no presence
        # was recorded) must not mark the whole batch absent when it ends.
        old = self.live_session(minutes_ago=600)
        self.end(old, on_air_minutes=590)
        RealtimeSession.objects.filter(pk=old.pk).update(ended_at=timezone.now() - timedelta(minutes=10))
        since = (timezone.now() - timedelta(minutes=120)).isoformat()
        with override_settings(ATTENDANCE_TRACKING_SINCE=since):
            self.assertIsNone(services.finalize_session(old.pk))
            self.assertEqual(services.finalize_pending_sessions(), [])
            new = self.live_session(minutes_ago=70)
            self.end(new, on_air_minutes=60)
            self.assertIsNotNone(services.finalize_session(new.pk))
        self.assertFalse(AttendanceRecord.objects.filter(session_ref_id=old.pk).exists())
        self.assertFalse(SessionAttendance.objects.filter(session_ref_id=old.pk).exists())
        self.assertTrue(AttendanceRecord.objects.filter(session_ref_id=new.pk, status="absent").exists())

    def test_tracking_since_accepts_a_date_in_ist_and_ignores_garbage(self):
        from apps.attendance import conf

        with override_settings(ATTENDANCE_TRACKING_SINCE="2026-11-16"):
            value = conf.tracking_since()
        self.assertEqual(value.isoformat(), "2026-11-16T00:00:00+05:30")
        with override_settings(ATTENDANCE_TRACKING_SINCE="not a date"):
            self.assertIsNone(conf.tracking_since())
        with override_settings(ATTENDANCE_TRACKING_SINCE=""):
            self.assertIsNone(conf.tracking_since())

    def test_students_enrolled_after_the_class_are_not_marked_absent(self):
        session = self.live_session(minutes_ago=70)
        self.end(session, on_air_minutes=60)
        late = f.make_user()
        from apps.courses.models import Enrollment

        enrolment = f.make_enrollment(user=late, course=self.course)
        Enrollment.objects.filter(pk=enrolment.pk).update(enrolled_at=timezone.now() + timedelta(minutes=5))
        services.finalize_session(session.pk)
        self.assertFalse(AttendanceRecord.objects.filter(session_ref_id=session.pk, user=late).exists())

    def test_watching_a_recording_never_counts(self):
        session = self.live_session(minutes_ago=70)
        self.end(session, on_air_minutes=60)
        services.finalize_session(session.pk)
        lecture = f.make_lecture(section=f.make_section(course=self.course))
        from apps.courses.models import LectureProgress

        LectureProgress.objects.create(user=self.students[0], lecture=lecture, last_position_seconds=3600, max_position_seconds=3600, completed=True)
        services.finalize_session(session.pk)
        self.assertEqual(AttendanceRecord.objects.get(session_ref_id=session.pk, user=self.students[0]).status, "absent")
        # And the presence endpoint refuses once the class is not live.
        presence.forget_session_status(session.pk)
        response = self.as_user(self.students[0]).post(f"/api/attendance/sessions/{session.pk}/presence/")
        self.assertFalse(response.json()["data"]["counted"])

    def test_session_end_queues_a_delayed_finalise_event(self):
        from apps.core.models import OutboxEvent
        from apps.realtime.lifecycle import end_session

        session = self.live_session(minutes_ago=50)
        end_session(session, reason="host")
        event = OutboxEvent.objects.get(dedupe_key=f"att-finalize:{session.pk}")
        self.assertGreater(event.available_at, timezone.now() + timedelta(seconds=60))
        end_session(session, reason="host")  # idempotent end: still one event
        self.assertEqual(OutboxEvent.objects.filter(dedupe_key=f"att-finalize:{session.pk}").count(), 1)
        from apps.attendance.outbox_handlers import handle_finalize

        handle_finalize(SimpleNamespace(payload={"session_id": session.pk}))
        self.assertEqual(SessionAttendance.objects.get(session_ref_id=session.pk).absent_count, 3)

    def test_ending_a_class_survives_a_broken_attendance_hook(self):
        from apps.realtime.lifecycle import end_session

        session = self.live_session(minutes_ago=50)
        with patch("apps.attendance.signals.publish_finalize", side_effect=RuntimeError("boom")):
            result = end_session(session, reason="host")
        self.assertTrue(result.transitioned)
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_ENDED)

    def test_ending_a_class_survives_a_database_error_in_the_hook(self):
        from django.db import IntegrityError

        from apps.realtime.lifecycle import end_session

        session = self.live_session(minutes_ago=50)
        with patch("apps.attendance.signals.publish_finalize", side_effect=IntegrityError("forced")):
            end_session(session, reason="host")
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_ENDED)

    def test_sweep_finalises_ends_written_without_signals(self):
        session = self.live_session(minutes_ago=70)
        RealtimeSession.objects.filter(pk=session.pk).update(
            status=RealtimeSession.STATUS_ENDED, ended_at=timezone.now() - timedelta(minutes=10)
        )
        done = services.finalize_pending_sessions()
        self.assertEqual(done, [session.pk])
        self.assertEqual(services.finalize_pending_sessions(), [])


# --- overrides and audit ------------------------------------------------------------------------------------
class OverrideTests(AttendanceCase):
    def setUp(self):
        super().setUp()
        self.session = self.live_session(minutes_ago=70)
        self.end(self.session, on_air_minutes=60)
        services.finalize_session(self.session.pk)
        self.url = f"/api/attendance/staff/sessions/{self.session.pk}/override/"

    def test_staff_excuse_is_audited_and_survives_refinalisation(self):
        student = self.students[0]
        response = self.as_user(self.staff).post(
            self.url, {"user_id": student.pk, "status": "excused", "reason": "Medical leave"}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        record = AttendanceRecord.objects.get(session_ref_id=self.session.pk, user=student)
        self.assertEqual((record.status, record.manual_override, record.overridden_by_id), ("excused", True, self.staff.pk))
        audit = AttendanceAudit.objects.get(record=record)
        self.assertEqual((audit.from_status, audit.to_status, audit.reason, audit.actor_id), ("absent", "excused", "Medical leave", self.staff.pk))
        services.finalize_session(self.session.pk)
        self.assertEqual(AttendanceRecord.objects.get(pk=record.pk).status, "excused")
        self.assertEqual(SessionAttendance.objects.get(session_ref_id=self.session.pk).excused_count, 1)

    def test_auto_removes_the_override(self):
        student = self.students[0]
        client = self.as_user(self.staff)
        client.post(self.url, {"user_id": student.pk, "status": "present", "reason": "Was in the room"}, format="json")
        client.post(self.url, {"user_id": student.pk, "status": "auto", "reason": "Mistake"}, format="json")
        record = AttendanceRecord.objects.get(session_ref_id=self.session.pk, user=student)
        self.assertEqual((record.status, record.manual_override), ("absent", False))
        self.assertEqual(AttendanceAudit.objects.filter(record=record).count(), 2)

    def test_reason_is_required(self):
        response = self.as_user(self.staff).post(
            self.url, {"user_id": self.students[0].pk, "status": "excused", "reason": " "}, format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(AttendanceAudit.objects.exists())

    def test_instructor_of_the_batch_may_override_others_may_not(self):
        ok = self.as_user(self.instructor).post(
            self.url, {"user_id": self.students[0].pk, "status": "excused", "reason": "Family event"}, format="json"
        )
        self.assertEqual(ok.status_code, 200, ok.content)
        other = f.make_instructor()
        denied = self.as_user(other).post(
            self.url, {"user_id": self.students[1].pk, "status": "excused", "reason": "Family event"}, format="json"
        )
        self.assertEqual(denied.status_code, 403)
        student = self.as_user(self.students[1]).post(
            self.url, {"user_id": self.students[1].pk, "status": "present", "reason": "I was there"}, format="json"
        )
        self.assertEqual(student.status_code, 403)

    def test_student_outside_the_batch_cannot_be_added(self):
        response = self.as_user(self.staff).post(
            self.url, {"user_id": f.make_user().pk, "status": "present", "reason": "Guest"}, format="json"
        )
        self.assertEqual(response.status_code, 400)


# --- student API ----------------------------------------------------------------------------------------------
class StudentApiTests(AttendanceCase):
    def _class(self, seconds_by_student, *, on_air=60, minutes_ago=None):
        session = self.live_session(minutes_ago=minutes_ago or on_air + 10)
        for student, seconds in seconds_by_student.items():
            self.present_for(session, student, seconds)
        self.end(session, on_air_minutes=on_air)
        services.finalize_session(session.pk)
        return session

    def test_summary_breakdown_and_streak(self):
        me, other = self.students[0], self.students[1]
        self._class({me: 45 * 60, other: 45 * 60}, minutes_ago=300)
        self._class({me: 10 * 60}, minutes_ago=200)
        self._class({me: 50 * 60}, minutes_ago=100)
        response = self.as_user(me).get("/api/attendance/me/summary/")
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual((data["attended"], data["total"], data["partial"]), (2, 3, 1))
        self.assertEqual(data["percent"], 66.7)
        self.assertEqual(data["streak"], {"current": 1, "best": 1})
        self.assertEqual(data["rule"]["label"], "Attended = 40+ minutes live")
        self.assertEqual(data["rule"]["present_min_minutes"], 40)
        self.assertTrue(data["low_attendance"])
        self.assertEqual(data["courses"][0]["course"]["title"], "OSINT Batch 7")

    def test_class_list_is_own_rows_only_with_recording_link(self):
        me = self.students[0]
        session = self._class({me: 45 * 60, self.students[1]: 5 * 60})
        from apps.realtime.recording.models import ClassRecording

        lecture = f.make_lecture(section=f.make_section(course=self.course), is_published=True)
        ClassRecording.objects.create(session=session, lecture=lecture, source="server", state="published")
        response = self.as_user(me).get("/api/attendance/me/classes/")
        rows = response.json()["data"]["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "present")
        self.assertEqual(rows[0]["minutes_present"], 45)
        self.assertEqual(rows[0]["recording"]["url"], f"/learn/{self.course.pk}?lesson={lecture.pk}")
        self.assertEqual(self.as_user(f.make_user()).get("/api/attendance/me/classes/").json()["data"]["results"], [])

    def test_student_cannot_open_staff_endpoints(self):
        client = self.as_user(self.students[0])
        for url in (
            "/api/attendance/staff/sessions/",
            f"/api/attendance/staff/matrix/?course={self.course.pk}",
            "/api/attendance/staff/low-attendance/",
            "/api/attendance/staff/courses/",
        ):
            self.assertEqual(client.get(url).status_code, 403, url)


# --- staff API ----------------------------------------------------------------------------------------------
class StaffApiTests(AttendanceCase):
    def setUp(self):
        super().setUp()
        self.session = self.live_session(minutes_ago=70)
        self.present_for(self.session, self.students[0], 50 * 60)
        self.present_for(self.session, self.students[1], 5 * 60)
        self.end(self.session, on_air_minutes=60)
        services.finalize_session(self.session.pk)
        # A second batch the instructor does not teach.
        self.other_course = f.make_course(title="Other batch")
        self.other_student = f.make_user()
        f.make_enrollment(user=self.other_student, course=self.other_course)
        from apps.courses.models import Enrollment

        Enrollment.objects.filter(course=self.other_course).update(enrolled_at=timezone.now() - timedelta(days=30))
        self.other_session = f.make_realtime_session(
            linked_course=self.other_course, status=RealtimeSession.STATUS_LIVE,
            started_at=timezone.now() - timedelta(minutes=70),
        )
        self.end(self.other_session, on_air_minutes=60)
        services.finalize_session(self.other_session.pk)

    def test_staff_see_every_batch_instructors_their_own(self):
        staff_rows = self.as_user(self.staff).get("/api/attendance/staff/sessions/").json()["data"]["results"]
        self.assertEqual({row["session_id"] for row in staff_rows}, {self.session.pk, self.other_session.pk})
        mine = self.as_user(self.instructor).get("/api/attendance/staff/sessions/").json()["data"]["results"]
        self.assertEqual([row["session_id"] for row in mine], [self.session.pk])
        self.assertEqual(mine[0]["counts"], {"roster": 3, "present": 1, "partial": 1, "absent": 1, "excused": 0})
        denied = self.as_user(self.instructor).get(f"/api/attendance/staff/sessions/{self.other_session.pk}/roster/")
        self.assertEqual(denied.status_code, 403)

    def test_roster_after_the_class(self):
        data = self.as_user(self.instructor).get(f"/api/attendance/staff/sessions/{self.session.pk}/roster/").json()["data"]
        self.assertFalse(data["live"])
        self.assertEqual({row["status"] for row in data["rows"]}, {"present", "partial", "absent"})
        self.assertEqual(data["summary"]["threshold_minutes"], 40)

    def test_live_roster_merges_pending_presence(self):
        live = self.live_session(minutes_ago=10)
        presence.credit_ping(live.pk, self.students[2].pk)
        data = self.as_user(self.staff).get(f"/api/attendance/staff/sessions/{live.pk}/roster/").json()["data"]
        self.assertTrue(data["live"])
        rows = {row["user"]["id"]: row for row in data["rows"]}
        self.assertEqual(rows[self.students[2].pk]["status"], "partial")
        self.assertTrue(rows[self.students[2].pk]["online"])
        self.assertEqual(rows[self.students[0].pk]["status"], "not_joined")
        live_list = self.as_user(self.instructor).get("/api/attendance/staff/sessions/").json()["data"]["live"]
        self.assertEqual([row["session_id"] for row in live_list], [live.pk])

    def test_matrix_and_csv(self):
        data = self.as_user(self.staff).get(f"/api/attendance/staff/matrix/?course={self.course.pk}").json()["data"]
        self.assertEqual(len(data["sessions"]), 1)
        cells = {row["user"]["id"]: row["cells"] for row in data["students"]}
        self.assertEqual(cells[self.students[0].pk], ["present"])
        response = self.as_user(self.staff).get(f"/api/attendance/staff/matrix/?course={self.course.pk}&export=csv")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Type"].startswith("text/csv"))
        body = response.content.decode("utf-8-sig")
        # Owner rule: the identity block (roll number, real name, handle, stats) leads, then Email.
        self.assertTrue(body.splitlines()[0].startswith("Roll number,Real name,Handle,Handle (most recent),XP,Rank,"))
        self.assertIn("Exam score %,Email,", body.splitlines()[0])
        self.assertIn(f"AL-SYD-{self.students[0].pk:05d}", body)
        self.assertIn("present", body)
        self.assertEqual(
            self.as_user(self.instructor).get(f"/api/attendance/staff/matrix/?course={self.other_course.pk}").status_code,
            403,
        )

    def test_low_attendance_list(self):
        data = self.as_user(self.instructor).get("/api/attendance/staff/low-attendance/").json()["data"]
        flagged = {row["user"]["id"] for row in data["results"]}
        self.assertEqual(flagged, {self.students[1].pk, self.students[2].pk})
        self.assertEqual(data["threshold"], 75)
        csv_response = self.as_user(self.staff).get("/api/attendance/staff/low-attendance/?export=csv")
        self.assertEqual(csv_response.status_code, 200)

    def test_csv_cells_cannot_inject_formulas(self):
        self.students[0].full_name = "=HYPERLINK(\"http://evil\")"
        self.students[0].save(update_fields=["full_name"])
        response = self.as_user(self.staff).get(f"/api/attendance/staff/sessions/{self.session.pk}/roster/?export=csv")
        self.assertIn("'=HYPERLINK", response.content.decode("utf-8-sig"))

    @override_settings(FEATURE_DEFAULT_OVERRIDES={"teaching": False})
    def test_instructors_need_the_teaching_switch(self):
        features.invalidate_cache()
        response = self.as_user(self.instructor).get("/api/attendance/staff/sessions/")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "feature_disabled")
        self.assertEqual(self.as_user(self.staff).get("/api/attendance/staff/sessions/").status_code, 200)

    def test_policy_read_and_staff_update(self):
        self.assertEqual(self.as_user(self.instructor).get("/api/attendance/staff/policy/").json()["data"]["present_min_minutes"], 40)
        denied = self.as_user(self.instructor).patch("/api/attendance/staff/policy/", {"present_min_minutes": 30}, format="json")
        self.assertEqual(denied.status_code, 403)
        ok = self.as_user(self.staff).patch("/api/attendance/staff/policy/", {"present_min_minutes": 45, "short_session_percent": 75}, format="json")
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()["data"]["label"], "Attended = 45+ minutes live")
        self.assertEqual(AttendancePolicy.current().updated_by_id, self.staff.pk)


# --- hooks into other apps: fail-safe, no extra queries ---------------------------------------------------------
@override_settings(LIVEKIT_URL="ws://livekit.test", LIVEKIT_API_KEY="devkey", LIVEKIT_API_SECRET="secret")
@patch("apps.realtime.views.build_participant_token", return_value="lk.token")
@patch("apps.realtime.views.get_room_participant_count", return_value=3)
class JoinHookTests(AttendanceCase):
    def join(self, session, user):
        return self.as_user(user).post(
            reverse("realtime-session-join", kwargs={"pk": session.pk}), {"display_name": "Student"}, format="json"
        )

    def test_join_starts_the_attendance_clock(self, _count, _token):
        session = self.live_session(minutes_ago=5)
        response = self.join(session, self.students[0])
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn((session.pk, self.students[0].pk), buffer.pending_snapshot())
        flush.flush()
        record = AttendanceRecord.objects.get(session_ref_id=session.pk, user=self.students[0])
        self.assertEqual((record.source, record.seconds_present), ("join", 0))

    def test_join_survives_a_broken_attendance_hook(self, _count, _token):
        session = self.live_session(minutes_ago=5)
        with patch("apps.attendance.presence.credit_join", side_effect=RuntimeError("boom")):
            response = self.join(session, self.students[0])
        self.assertEqual(response.status_code, 200, response.content)
        with patch("apps.attendance.hooks.on_live_join", side_effect=RuntimeError("boom")):
            response = self.join(session, self.students[1])
        self.assertEqual(response.status_code, 200, response.content)

    def test_join_runs_no_extra_queries(self, _count, _token):
        session = self.live_session(minutes_ago=5)
        self.join(session, self.students[0])  # warm caches
        with CaptureQueriesContext(connection) as with_hook:
            self.join(session, self.students[0])
        with patch("apps.attendance.hooks.on_live_join"):
            with CaptureQueriesContext(connection) as without_hook:
                self.join(session, self.students[0])
        self.assertEqual(len(with_hook.captured_queries), len(without_hook.captured_queries))

    def test_hosts_are_not_on_the_clock(self, _count, _token):
        session = self.live_session(minutes_ago=5)
        self.join(session, self.host)
        self.assertNotIn((session.pk, self.host.pk), buffer.pending_snapshot())


class EngagementBridgeTests(AttendanceCase):
    def test_engagement_alias_also_records_attendance(self):
        session = self.live_session(minutes_ago=5)
        response = self.as_user(self.students[0]).post(f"/api/engagement/live/{session.pk}/presence/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"], {"counted": True, "credited_seconds": 60})
        self.assertIn((session.pk, self.students[0].pk), buffer.pending_snapshot())

    def test_engagement_alias_survives_a_broken_attendance(self):
        session = self.live_session(minutes_ago=5)
        with patch("apps.attendance.presence.ping", side_effect=RuntimeError("boom")):
            response = self.as_user(self.students[0]).post(f"/api/engagement/live/{session.pk}/presence/")
        self.assertEqual(response.status_code, 200, response.content)

    def test_live_xp_follows_attendance(self):
        from apps.engagement import outbox_handlers
        from apps.engagement.models import XpEvent

        session = self.live_session(minutes_ago=70)
        self.present_for(session, self.students[0], 41 * 60)  # present: 40+ live minutes
        self.present_for(session, self.students[1], 39 * 60)  # partial
        self.end(session, on_air_minutes=60)
        outbox_handlers.handle_live_ended(SimpleNamespace(payload={"session_id": session.pk}))
        self.assertTrue(XpEvent.objects.filter(user=self.students[0], kind="live_attended").exists())
        self.assertFalse(XpEvent.objects.filter(user=self.students[1], kind="live_attended").exists())
        outbox_handlers.handle_live_ended(SimpleNamespace(payload={"session_id": session.pk}))
        self.assertEqual(XpEvent.objects.filter(user=self.students[0], kind="live_attended").count(), 1)


class AdminTests(AttendanceCase):
    def test_admin_pages_render(self):
        session = self.live_session(minutes_ago=70)
        self.end(session, on_air_minutes=60)
        services.finalize_session(session.pk)
        admin_user = f.make_admin(is_superuser=True)
        self.client.force_login(admin_user)
        for name in (
            "attendancerecord",
            "sessionattendance",
            "attendanceaudit",
            "attendancepolicy",
            "classschedule",
            "scheduledclass",
            "calendarfeedtoken",
            "attendanceflushlog",
        ):
            response = self.client.get(f"/admin/attendance/{name}/")
            self.assertEqual(response.status_code, 200, name)

    def test_admin_excuse_action_is_audited(self):
        session = self.live_session(minutes_ago=70)
        self.end(session, on_air_minutes=60)
        services.finalize_session(session.pk)
        admin_user = f.make_admin(is_superuser=True)
        self.client.force_login(admin_user)
        record = AttendanceRecord.objects.filter(session_ref_id=session.pk).first()
        response = self.client.post(
            "/admin/attendance/attendancerecord/",
            {"action": "mark_excused", "_selected_action": [record.pk]},
        )
        self.assertEqual(response.status_code, 302)
        record.refresh_from_db()
        self.assertEqual(record.status, "excused")
        self.assertTrue(AttendanceAudit.objects.filter(record=record, actor=admin_user).exists())


class QueryCountTests(AttendanceCase):
    def test_student_summary_query_count_is_flat(self):
        for minutes_ago in (300, 200, 100):
            session = self.live_session(minutes_ago=minutes_ago)
            self.present_for(session, self.students[0], 45 * 60)
            self.end(session, on_air_minutes=60)
            services.finalize_session(session.pk)
        AttendancePolicy.current()
        with self.assertNumQueries(3):  # policy, records, courses
            queries.student_summary(self.students[0])


# --- repair command -------------------------------------------------------------------------------------------
class RepairCommandTests(AttendanceCase):
    """``manage.py attendance_repair``: dry run by default, idempotent with --apply."""

    def run_repair(self, *args):
        from io import StringIO

        from django.core.management import call_command

        out = StringIO()
        call_command("attendance_repair", *args, stdout=out)
        return out.getvalue()

    def setUp(self):
        super().setUp()
        # Production shape: a class on air before tracking was finalised with
        # everyone absent; a tracked class has presence waiting in the buffer.
        self.cutoff = timezone.now() - timedelta(hours=3)
        self.untracked = self.live_session(minutes_ago=600)
        self.end(self.untracked, on_air_minutes=500)
        services.finalize_session(self.untracked.pk)  # finalised before the cut-off existed
        self.assertEqual(SessionAttendance.objects.get(session_ref_id=self.untracked.pk).absent_count, 3)
        self.tracked = self.live_session(minutes_ago=90)
        self.present_for(self.tracked, self.students[0], 45 * 60)
        self.present_for(self.tracked, self.students[1], 10 * 60)
        self.end(self.tracked, on_air_minutes=60)
        self.args = ("--tracking-since", self.cutoff.isoformat())

    def test_dry_run_writes_nothing(self):
        before = (AttendanceRecord.objects.count(), SessionAttendance.objects.count(), AttendanceFlushLog.objects.count())
        output = self.run_repair(*self.args)
        self.assertIn("DRY RUN", output)
        self.assertIn(f"Void: session {self.untracked.pk}", output)
        self.assertIn(f"Re-finalise: session {self.tracked.pk}", output)
        after = (AttendanceRecord.objects.count(), SessionAttendance.objects.count(), AttendanceFlushLog.objects.count())
        self.assertEqual(before, after)
        self.assertIn((self.tracked.pk, self.students[0].pk), buffer.pending_snapshot())

    def test_apply_voids_untracked_and_refinalises_tracked_idempotently(self):
        self.run_repair(*self.args, "--apply")
        self.assertFalse(AttendanceRecord.objects.filter(session_ref_id=self.untracked.pk).exists())
        self.assertFalse(SessionAttendance.objects.filter(session_ref_id=self.untracked.pk).exists())
        statuses = dict(AttendanceRecord.objects.filter(session_ref_id=self.tracked.pk).values_list("user_id", "status"))
        self.assertEqual(
            statuses,
            {self.students[0].pk: "present", self.students[1].pk: "partial", self.students[2].pk: "absent"},
        )
        first = list(AttendanceRecord.objects.order_by("pk").values("pk", "status", "seconds_present"))
        output = self.run_repair(*self.args, "--apply")  # second run changes nothing
        self.assertEqual(first, list(AttendanceRecord.objects.order_by("pk").values("pk", "status", "seconds_present")))
        self.assertIn("voided=0", output)
        summary = SessionAttendance.objects.get(session_ref_id=self.tracked.pk)
        self.assertEqual((summary.present_count, summary.partial_count, summary.absent_count), (1, 1, 1))
        # The untracked class is not re-finalised by the sweep either.
        with override_settings(ATTENDANCE_TRACKING_SINCE=self.cutoff.isoformat()):
            services.finalize_pending_sessions()
        self.assertFalse(SessionAttendance.objects.filter(session_ref_id=self.untracked.pk).exists())

    def test_a_class_with_a_staff_override_is_left_for_review(self):
        services.override_status(
            session_ref_id=self.untracked.pk, user_id=self.students[0].pk, status="excused", reason="Medical leave", actor=self.staff
        )
        output = self.run_repair(*self.args, "--apply")
        self.assertIn("review it by hand", output)
        self.assertEqual(AttendanceRecord.objects.filter(session_ref_id=self.untracked.pk).count(), 3)
        self.assertTrue(SessionAttendance.objects.filter(session_ref_id=self.untracked.pk).exists())

    def test_without_a_cut_off_nothing_is_voided(self):
        output = self.run_repair("--apply")
        self.assertIn("Void: skipped", output)
        self.assertEqual(SessionAttendance.objects.get(session_ref_id=self.untracked.pk).absent_count, 3)


# --- batch rule (ATTENDANCE_FROM_COURSE_ID) -------------------------------------------------------------------
class CourseRuleTests(AttendanceCase):
    """Owner rule: attendance applies only to Batch 4 (course 28) and later.

    Here ``self.course`` plays an old batch (Batch 3) and ``self.new_course``
    (created later, so a higher id) plays Batch 4."""

    def setUp(self):
        super().setUp()
        from apps.courses.models import Enrollment, LiveClass

        self.new_course = f.make_course(instructor=self.instructor, title="OSINT Batch 8", batch="B8")
        self.assertGreater(self.new_course.pk, self.course.pk)
        self.new_live_class = LiveClass.objects.create(
            title="OSINT live B8", description="Weekly classes", linked_course=self.new_course
        )
        for student in self.students:
            f.make_enrollment(user=student, course=self.new_course)
        Enrollment.objects.filter(course=self.new_course).update(enrolled_at=timezone.now() - timedelta(days=30))
        self.rule = override_settings(ATTENDANCE_FROM_COURSE_ID=str(self.new_course.pk))

    def new_session(self, minutes_ago=60, **overrides):
        return self.live_session(
            minutes_ago=minutes_ago, linked_course=self.new_course, linked_live_class=self.new_live_class, **overrides
        )

    def test_setting_parsing(self):
        from apps.attendance import conf

        for raw, expected in (("", None), ("0", None), ("abc", None), ("-3", None), ("28", 28), (28, 28)):
            with override_settings(ATTENDANCE_FROM_COURSE_ID=raw):
                self.assertEqual(conf.from_course_id(), expected, raw)
        with override_settings(ATTENDANCE_FROM_COURSE_ID="28"):
            self.assertEqual([conf.course_tracked(pk) for pk in (11, 27, 28, 29, None)], [False, False, True, True, False])
        with override_settings(ATTENDANCE_FROM_COURSE_ID=""):
            self.assertTrue(conf.course_tracked(11))
            self.assertTrue(conf.course_tracked(None))

    def test_pings_for_an_excluded_batch_are_ignored_cheaply(self):
        old = self.live_session()
        new = self.new_session()
        with self.rule:
            response = self.as_user(self.students[0]).post(f"/api/attendance/sessions/{old.pk}/presence/")
            self.assertEqual(response.status_code, 200, response.content)
            self.assertEqual(response.json()["data"]["reason"], "not_tracked")
            self.assertFalse(response.json()["data"]["counted"])
            with self.assertNumQueries(0):  # warm: status and batch flag are cached
                self.assertEqual(presence.ping(old.pk, self.students[0]).reason, "not_tracked")
            self.assertTrue(presence.ping(new.pk, self.students[0]).counted)
        pending = buffer.pending_snapshot()
        self.assertNotIn((old.pk, self.students[0].pk), pending)
        self.assertIn((new.pk, self.students[0].pk), pending)

    def test_a_live_class_without_its_own_course_uses_the_live_class_batch(self):
        new = self.live_session(linked_course=None, linked_live_class=self.new_live_class)
        old = self.live_session(linked_course=None, linked_live_class=self.live_class)
        with self.rule:
            self.assertTrue(presence.session_tracked(new.pk))
            self.assertFalse(presence.session_tracked(old.pk))

    def test_join_hook_ignores_an_excluded_batch(self):
        old = self.live_session()
        with self.rule:
            hooks.on_live_join(session=old, user=self.students[0])
        self.assertEqual(buffer.pending_snapshot(), {})

    def test_flush_drops_presence_buffered_for_an_excluded_batch(self):
        old = self.live_session()
        new = self.new_session()
        self.present_for(old, self.students[0], 45 * 60)
        self.present_for(new, self.students[0], 45 * 60)
        with self.rule:
            flush.flush()
        self.assertFalse(AttendanceRecord.objects.filter(session_ref_id=old.pk).exists())
        self.assertTrue(AttendanceRecord.objects.filter(session_ref_id=new.pk).exists())

    def test_finalise_and_sweep_skip_excluded_batches(self):
        old = self.live_session(minutes_ago=70)
        new = self.new_session(minutes_ago=70)
        for session in (old, new):
            RealtimeSession.objects.filter(pk=session.pk).update(
                status=RealtimeSession.STATUS_ENDED, ended_at=timezone.now() - timedelta(minutes=5)
            )
        with self.rule:
            self.assertIsNone(services.finalize_session(old.pk))
            self.assertEqual(services.finalize_pending_sessions(), [new.pk])
            self.assertEqual(services.finalize_pending_sessions(), [])
        self.assertFalse(SessionAttendance.objects.filter(session_ref_id=old.pk).exists())
        self.assertFalse(AttendanceRecord.objects.filter(session_ref_id=old.pk).exists())
        self.assertEqual(SessionAttendance.objects.get(session_ref_id=new.pk).absent_count, 3)

    def _finalised_pair(self):
        """Both batches finalised before the rule existed (production shape)."""
        old = self.live_session(minutes_ago=200)
        self.end(old, on_air_minutes=60)
        services.finalize_session(old.pk)
        new = self.new_session(minutes_ago=100)
        self.present_for(new, self.students[0], 45 * 60)
        self.end(new, on_air_minutes=60)
        services.finalize_session(new.pk)
        return old, new

    def test_student_and_staff_pages_show_only_tracked_batches(self):
        old, new = self._finalised_pair()
        live_old = self.live_session(minutes_ago=5)
        live_new = self.new_session(minutes_ago=5)
        student = self.as_user(self.students[0])
        staff = self.as_user(self.staff)
        with self.rule:
            summary = student.get("/api/attendance/me/summary/").json()["data"]
            self.assertEqual([row["course"]["id"] for row in summary["courses"]], [self.new_course.pk])
            self.assertEqual((summary["attended"], summary["total"]), (1, 1))
            classes = student.get("/api/attendance/me/classes/").json()["data"]["results"]
            self.assertEqual([row["session_id"] for row in classes], [new.pk])

            sessions = staff.get("/api/attendance/staff/sessions/").json()["data"]
            self.assertEqual([row["session_id"] for row in sessions["results"]], [new.pk])
            self.assertEqual([row["session_id"] for row in sessions["live"]], [live_new.pk])
            self.assertNotIn(live_old.pk, [row["session_id"] for row in sessions["live"]])

            courses = staff.get("/api/attendance/staff/courses/").json()["data"]["courses"]
            self.assertNotIn(self.course.pk, [row["id"] for row in courses])
            self.assertIn(self.new_course.pk, [row["id"] for row in courses])

            low = staff.get("/api/attendance/staff/low-attendance/").json()["data"]["results"]
            self.assertEqual({row["course"]["id"] for row in low}, {self.new_course.pk})

            self.assertEqual(staff.get(f"/api/attendance/staff/sessions/{old.pk}/roster/").status_code, 404)
            self.assertEqual(staff.get(f"/api/attendance/staff/matrix/?course={self.course.pk}").status_code, 404)
            self.assertEqual(staff.get(f"/api/attendance/staff/sessions/{new.pk}/roster/").status_code, 200)
            override = staff.post(
                f"/api/attendance/staff/sessions/{old.pk}/override/",
                {"user_id": self.students[1].pk, "status": "excused", "reason": "Medical leave"},
                format="json",
            )
            self.assertEqual(override.status_code, 404)
        # Without the rule the old batch shows again (data kept, nothing deleted by reads).
        summary = student.get("/api/attendance/me/summary/").json()["data"]
        self.assertEqual(summary["total"], 2)

    def test_repair_voids_excluded_batches_and_keeps_tracked_ones(self):
        from io import StringIO

        from django.core.management import call_command

        old, new = self._finalised_pair()
        before = list(AttendanceRecord.objects.order_by("pk").values_list("pk", "status", "finalized_at"))
        out = StringIO()
        with self.rule:
            call_command("attendance_repair", stdout=out)  # dry run
            self.assertIn(f"Void: session {old.pk}", out.getvalue())
            self.assertIn(f"batch {self.course.pk} not tracked", out.getvalue())
            self.assertNotIn(f"Void: session {new.pk}", out.getvalue())
            self.assertEqual(before, list(AttendanceRecord.objects.order_by("pk").values_list("pk", "status", "finalized_at")))

            call_command("attendance_repair", "--apply", stdout=StringIO())
            self.assertFalse(AttendanceRecord.objects.filter(session_ref_id=old.pk).exists())
            self.assertFalse(SessionAttendance.objects.filter(session_ref_id=old.pk).exists())
            summary = SessionAttendance.objects.get(session_ref_id=new.pk)
            self.assertEqual((summary.present_count, summary.absent_count), (1, 2))

            snapshot = list(AttendanceRecord.objects.order_by("pk").values_list("pk", "status"))
            again = StringIO()
            call_command("attendance_repair", "--apply", stdout=again)
            self.assertIn("voided=0", again.getvalue())
            self.assertEqual(snapshot, list(AttendanceRecord.objects.order_by("pk").values_list("pk", "status")))

    def test_repair_batch_rule_from_the_command_line(self):
        from io import StringIO

        from django.core.management import call_command

        old, _new = self._finalised_pair()
        out = StringIO()
        call_command("attendance_repair", "--from-course-id", str(self.new_course.pk), "--apply", stdout=out)
        self.assertIn("voided=1", out.getvalue())
        self.assertFalse(SessionAttendance.objects.filter(session_ref_id=old.pk).exists())
