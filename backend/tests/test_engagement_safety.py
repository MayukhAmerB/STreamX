"""Engagement must never break, slow down or roll back an existing flow.

* every hook swallows its own errors (logged + counted): the lecture
  progress save, report submission/grading, exam finalisation, live class
  end and enrolment save all succeed while engagement code raises;
* the hot endpoints run exactly the same queries with engagement on or off
  (lecture progress heartbeat, current user);
* with the switch off (an admin choice; the production default is on)
  nothing is recorded.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from apps.core import features
from apps.core.models import OutboxEvent
from apps.courses.models import LectureProgress
from apps.engagement import buffer, rules
from apps.engagement.models import XpEvent
from tests import factories as f
from tests.engagement_support import reset_engagement_state


def boom(*args, **kwargs):
    raise RuntimeError("engagement exploded")


class SafetyCase(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()
        self.student = f.make_user()
        self.lecture = f.make_lecture(stream_duration_seconds=1000, video_key="videos/s.mp4")
        f.make_enrollment(user=self.student, course=self.lecture.section.course)
        self.client = APIClient()
        self.client.force_authenticate(self.student)

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def put_progress(self, position, **extra):
        return self.client.put(
            f"/api/lectures/{self.lecture.pk}/progress/",
            {"position_seconds": position, "duration_seconds": 1000, **extra},
            format="json",
        )


class FailSafeHookTests(SafetyCase):
    def test_lecture_progress_succeeds_when_engagement_raises(self):
        with mock.patch("apps.engagement.signals.publish", side_effect=boom), mock.patch.object(
            buffer, "incr", side_effect=boom
        ), mock.patch("apps.engagement.signals.record_hook_failure") as counted:
            self.put_progress(10)
            LectureProgress.objects.filter(user=self.student).update(updated_at=timezone.now() - timedelta(minutes=2))
            response = self.put_progress(995, completed=True)
        self.assertEqual(response.status_code, 200, response.content)
        progress = LectureProgress.objects.get(user=self.student, lecture=self.lecture)
        self.assertTrue(progress.completed)
        self.assertEqual(progress.last_position_seconds, 995)
        self.assertTrue(counted.called)
        self.assertNotIn("X-Engagement", response)

    def test_switch_lookup_failure_is_safe(self):
        with mock.patch("apps.engagement.services.is_enabled", side_effect=boom):
            response = self.put_progress(500)
        self.assertEqual(response.status_code, 200)

    def test_report_submission_and_grading_succeed_when_engagement_raises(self):
        from apps.reports.models import ReportGrade, ReportSubmission, ReportTask

        task = ReportTask.objects.create(course=f.make_course(), title="T", due_at=timezone.now() + timedelta(days=1),
                                         status="published", max_marks=Decimal("10"))
        with mock.patch("apps.engagement.signals.publish", side_effect=boom):
            submission = ReportSubmission.objects.create(task=task, student=self.student, status="submitted",
                                                         first_submitted_at=timezone.now())
            ReportGrade.objects.create(submission=submission, final_marks=Decimal("9"))
            submission.status = "graded"
            submission.save(update_fields=["status", "updated_at"])
        self.assertEqual(ReportSubmission.objects.get(pk=submission.pk).status, "graded")

    def test_exam_finalisation_live_end_and_enrolment_succeed_when_engagement_raises(self):
        exam = f.make_ctf_exam()
        session = f.make_realtime_session(status="live", started_at=timezone.now() - timedelta(minutes=30))
        with mock.patch("apps.engagement.signals.publish", side_effect=boom), mock.patch(
            "apps.engagement.leaderboard.member_batch_ids", side_effect=boom
        ):
            exam.status = "closed"
            exam.results_finalized_at = timezone.now()
            exam.save(update_fields=["status", "results_finalized_at", "updated_at"])
            session.status = "ended"
            session.ended_at = timezone.now()
            session.save()
            with self.captureOnCommitCallbacks(execute=True):
                enrollment = f.make_enrollment(user=f.make_user(), course=f.make_course())
        exam.refresh_from_db()
        session.refresh_from_db()
        self.assertIsNotNone(exam.results_finalized_at)
        self.assertEqual(session.status, "ended")
        self.assertTrue(enrollment.pk)

    def test_outbox_database_error_rolls_back_only_its_savepoint(self):
        from django.db import IntegrityError, transaction

        def broken_publish(*args, **kwargs):
            OutboxEvent.objects.create(event_type="x", dedupe_key="dup")
            OutboxEvent.objects.create(event_type="x", dedupe_key="dup")  # IntegrityError inside the savepoint
            raise AssertionError("unreachable")

        with transaction.atomic():
            with mock.patch("apps.engagement.signals.publish", side_effect=broken_publish):
                self.put_progress(10)
                LectureProgress.objects.filter(user=self.student).update(updated_at=timezone.now() - timedelta(minutes=2))
                response = self.put_progress(995, completed=True)
            # The surrounding transaction is still usable.
            self.assertEqual(LectureProgress.objects.filter(user=self.student).count(), 1)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(OutboxEvent.objects.filter(dedupe_key="dup").exists())
        del IntegrityError


class HotPathQueryTests(SafetyCase):
    def _count(self, func):
        with CaptureQueriesContext(connection) as ctx:
            func()
        return len(ctx.captured_queries)

    def _heartbeat_queries(self):
        self.put_progress(1)  # row exists, memos warm
        features.is_enabled(rules.FEATURE_KEY)
        return self._count(lambda: self.put_progress(42))

    def test_progress_heartbeat_runs_the_same_queries_on_and_off(self):
        on = self._heartbeat_queries()
        with override_settings(FEATURE_DEFAULT_OVERRIDES={"teaching": True, "engagement": False}):
            features.invalidate_cache()
            off = self._heartbeat_queries()
        self.assertEqual(on, off)

    def test_current_user_endpoint_runs_the_same_queries_on_and_off(self):
        self.client.get("/api/auth/user/")
        on = self._count(lambda: self.client.get("/api/auth/user/"))
        with override_settings(FEATURE_DEFAULT_OVERRIDES={"teaching": True, "engagement": False}):
            features.invalidate_cache()
            self.client.get("/api/auth/user/")
            off = self._count(lambda: self.client.get("/api/auth/user/"))
        self.assertEqual(on, off)

    def test_watch_time_never_writes_per_heartbeat(self):
        self.put_progress(1)
        LectureProgress.objects.filter(user=self.student).update(updated_at=timezone.now() - timedelta(minutes=1))
        before = OutboxEvent.objects.count()
        self.put_progress(60)
        self.assertEqual(OutboxEvent.objects.count(), before)
        self.assertEqual(sum(buffer.pending_snapshot("watch").values()), 60)


@override_settings(FEATURE_DEFAULT_OVERRIDES={"teaching": True})
class ProductionDefaultTests(SafetyCase):
    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_production_default_is_on(self):
        # Owner decision: rewards are on from release day (registry default).
        features.invalidate_cache()
        self.assertTrue(features.get_feature("engagement").default)
        self.assertTrue(features.is_enabled("engagement"))

    @override_settings(FEATURE_DEFAULT_OVERRIDES={"engagement": False})
    def test_switch_off_records_nothing(self):
        features.invalidate_cache()
        self.assertFalse(features.is_enabled("engagement"))
        self.put_progress(1)
        LectureProgress.objects.filter(user=self.student).update(updated_at=timezone.now() - timedelta(minutes=2))
        response = self.put_progress(995, completed=True)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("X-Engagement", response)
        self.assertFalse(OutboxEvent.objects.filter(event_type__startswith="engagement.").exists())
        self.assertEqual(buffer.pending_snapshot("watch"), {})
        self.assertFalse(XpEvent.objects.exists())
        self.assertEqual(self.client.get("/api/engagement/me/").status_code, 403)
