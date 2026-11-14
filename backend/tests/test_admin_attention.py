"""WS-G: admin attention queues, System › Health and the Activity feed.

``GET /api/admin/attention/`` (plan §4.4, Appendix A.3): ten permission-aware
queues (plus the hackpath plans-awaiting-price queue), ≤ 20 SQL queries, 30 s cache with an explicit version bump.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from django.contrib.admin.models import LogEntry
from django.contrib.auth.models import Permission
from django.core.cache import cache
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.console_api import attention
from apps.core.models import OutboxEvent
from apps.courses import enrollment_actions
from apps.courses.experience_models import CourseReview
from apps.courses.models import Enrollment, LectureQuestion, LiveClass, LiveClassEnrollment, PublicEnrollmentLead
from apps.ctf.models import CtfExam
from apps.join_requests.models import JoinApplication
from apps.payments.models import Payment
from apps.realtime.models import RealtimeSession
from apps.realtime.recording.models import ClassRecording
from apps.recording_uploads.models import RecordingUpload
from apps.reports.models import ReportQuarantineRecord, ReportSubmission, ReportSubmissionVersion, ReportTask
from apps.users.models import AsyncJob
from tests.factories import make_admin, make_course, make_lecture, make_payment, make_realtime_session, make_section, make_user


def counts(payload):
    return {queue["key"]: queue["count"] for queue in payload["queues"]}


class AttentionSeedMixin:
    def seed(self):
        now = timezone.now()
        self.course = make_course()
        self.student = make_user(full_name="Sana Student", email="sana@attention.test")
        self.other = make_user(full_name="Bilal Student")
        # enrolment_requests: one course request (3 days old) + one live-class request
        self.enrollment = Enrollment.objects.create(user=self.student, course=self.course, payment_status=Enrollment.STATUS_PENDING)
        Enrollment.objects.filter(pk=self.enrollment.pk).update(enrolled_at=now - timedelta(days=3))
        Enrollment.objects.create(user=self.other, course=self.course, payment_status=Enrollment.STATUS_PAID)
        self.live_class = LiveClass.objects.create(title="OSINT Batch IV", description="Live")
        self.live_request = LiveClassEnrollment.objects.create(user=self.other, live_class=self.live_class)
        # reports_to_grade: one submitted report (a not-submitted row does not count)
        task = ReportTask.objects.create(course=self.course, title="Target: Acme", due_at=now + timedelta(days=2))
        submission = ReportSubmission.objects.create(
            task=task, student=self.student, status=ReportSubmission.STATUS_SUBMITTED, submitted_at=now - timedelta(hours=5)
        )
        version = ReportSubmissionVersion.objects.create(submission=submission, number=1)
        submission.current_version = version
        submission.save(update_fields=["current_version"])
        ReportSubmission.objects.create(task=task, student=self.other, target_key="other")
        # recordings: one needs review, one failed; one failed upload
        ClassRecording.objects.create(source=ClassRecording.SOURCE_SERVER, state=ClassRecording.STATE_PUBLISHED, needs_review=True)
        ClassRecording.objects.create(source=ClassRecording.SOURCE_SERVER, state=ClassRecording.STATE_FAILED, needs_review=True)
        ClassRecording.objects.create(source=ClassRecording.SOURCE_SERVER, state=ClassRecording.STATE_PUBLISHED)
        RecordingUpload.objects.create(
            owner=self.other,
            filename="class.mkv",
            extension="mkv",
            total_bytes=10,
            chunk_bytes=10,
            chunk_count=1,
            status=RecordingUpload.STATUS_FAILED,
            expires_at=now + timedelta(days=1),
        )
        # payments_to_action: awaiting credentials (paid) counts; created/credentials issued do not
        make_payment(course=self.course, status=Payment.STATUS_PAID, provisioning_status=Payment.PROVISION_AWAITING_ADMIN)
        make_payment(course=self.course, status=Payment.STATUS_PAID, provisioning_status=Payment.PROVISION_CREDENTIALS_ISSUED)
        make_payment(course=self.course)
        # exams: a ready draft (not scheduled) and an exam closing within 24 h
        CtfExam.objects.create(slug="draft-ready", title="Draft", content_loaded_at=now)
        CtfExam.objects.create(slug="draft-empty", title="Empty draft")
        CtfExam.objects.create(
            slug="closing", title="Closing", status=CtfExam.STATUS_PUBLISHED, opens_at=now - timedelta(days=1), closes_at=now + timedelta(hours=3)
        )
        # leads: one join form + one public lead
        JoinApplication.objects.create(
            role="student", full_name="Payal", age=20, phone_number="+919999999999", state="Delhi", district="New Delhi", terms_accepted_at=now
        )
        PublicEnrollmentLead.objects.create(email="lead@example.com", phone_number="1", whatsapp_number="1", message="Hi")
        # flagged_content: an unanswered question and a pending review
        lecture = make_lecture(section=make_section(course=self.course))
        LectureQuestion.objects.create(user=self.student, lecture=lecture, question="How?")
        CourseReview.objects.create(course=self.course, student=self.student, rating=4, text="Good", status=CourseReview.STATUS_PENDING)
        # quarantined_files: one recent, one older than the window
        ReportQuarantineRecord.objects.create(source="upload", kind="submission", action="rejected")
        ReportQuarantineRecord.objects.create(source="upload", kind="submission", action="rejected", created_at=now - timedelta(days=30))
        # system_issues: a dead outbox event and a dead async job
        OutboxEvent.objects.create(event_type="test.event", status=OutboxEvent.STATUS_DEAD, last_error="boom")
        OutboxEvent.objects.create(event_type="test.ok", status=OutboxEvent.STATUS_DELIVERED)
        AsyncJob.objects.create(job_type=AsyncJob.TYPE_EMAIL_SEND, status=AsyncJob.STATUS_DEAD, last_error="smtp down")


@override_settings(ADMIN_ATTENTION_CACHE_SECONDS=30)
class AttentionQueueTests(AttentionSeedMixin, APITestCase):
    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.seed()

    def tearDown(self):
        cache.clear()

    def get(self, user):
        self.client.force_authenticate(user)
        response = self.client.get("/api/admin/attention/")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def test_counts_per_queue_for_a_superuser(self):
        data = self.get(self.admin)
        self.assertEqual(
            counts(data),
            {
                "enrolment_requests": 2,
                "reports_to_grade": 1,
                "recordings_to_review": 1,
                "uploads_failed": 2,
                "payments_to_action": 1,
                "exams_to_publish": 2,
                "leads": 2,
                "flagged_content": 2,
                "quarantined_files": 1,
                "system_issues": 2,
                "plans_awaiting_price": 0,
            },
        )
        queues = {queue["key"]: queue for queue in data["queues"]}
        self.assertEqual(tuple(queues), attention.QUEUE_KEYS)
        # The 3-day-old enrolment request is "high"; its oldest_at is reported.
        self.assertEqual(queues["enrolment_requests"]["severity"], "high")
        self.assertIsNotNone(queues["enrolment_requests"]["oldest_at"])
        self.assertEqual(queues["system_issues"]["severity"], "high")
        self.assertEqual(queues["reports_to_grade"]["severity"], "normal")
        self.assertEqual(queues["enrolment_requests"]["href"], "/console/admin/requests")
        self.assertIn("teaching", [switch["key"] for switch in data["switches"]])

    def test_plans_awaiting_price_queue(self):
        """hackpath WS-STAFF: unconfirmed platform plans surface as an admin queue."""
        from apps.payments.models import PlatformPlan

        queue = {q["key"]: q for q in self.get(self.admin)["queues"]}["plans_awaiting_price"]
        self.assertEqual(queue["count"], 0)
        self.assertEqual(queue["severity"], "normal")
        PlatformPlan.objects.create(
            key="hp-attn-labs", product=PlatformPlan.PRODUCT_CTF_LABS, title="Labs", price_inr=Decimal("1649.00"),
            billing_period=PlatformPlan.PERIOD_MONTHLY,
        )
        PlatformPlan.objects.create(
            key="hp-attn-boot", product=PlatformPlan.PRODUCT_PT_BOOTCAMP, title="Bootcamp", price_inr=Decimal("1649.00")
        )
        attention.bump_version()
        queue = {q["key"]: q for q in self.get(self.admin)["queues"]}["plans_awaiting_price"]
        self.assertEqual(queue["count"], 2)
        self.assertEqual(queue["href"], "/admin/payments/platformplan/")
        self.assertEqual(queue["label"], "Plans waiting for price confirmation")
        self.assertIsNone(queue["oldest_at"])
        # Staff without the payments permission do not see the queue at all.
        staff = make_user(is_staff=True)
        self.assertIsNone(counts(self.get(staff))["plans_awaiting_price"])
        # The platform switches block also lists the Pentesting and Memberships switches.
        keys = [switch["key"] for switch in self.get(self.admin)["switches"]]
        self.assertIn("pentesting", keys)
        self.assertIn("memberships", keys)

    def test_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            attention.get_queues(self.admin, use_cache=False)
        self.assertLessEqual(len(ctx.captured_queries), 20, [query["sql"][:120] for query in ctx.captured_queries])

    def test_staff_without_model_permissions_see_console_queues_only(self):
        staff = make_user(is_staff=True)
        data = counts(self.get(staff))
        for hidden in ("enrolment_requests", "payments_to_action", "quarantined_files", "system_issues"):
            self.assertIsNone(data[hidden], hidden)
        self.assertEqual(data["reports_to_grade"], 1)
        self.assertEqual(data["recordings_to_review"], 1)
        self.assertEqual(data["flagged_content"], 1)  # questions only; reviews need courses.view_coursereview
        staff.user_permissions.add(Permission.objects.get(codename="view_enrollment"))
        cache.clear()
        staff = type(staff).objects.get(pk=staff.pk)
        self.assertEqual(counts(self.get(staff))["enrolment_requests"], 1)  # course requests only

    def test_cached_for_thirty_seconds_and_bumped_by_actions(self):
        self.assertEqual(counts(self.get(self.admin))["enrolment_requests"], 2)
        Enrollment.objects.filter(pk=self.enrollment.pk).update(payment_status=Enrollment.STATUS_PAID)
        self.assertEqual(counts(self.get(self.admin))["enrolment_requests"], 2)  # cached
        enrollment_actions.set_status("live_class", self.live_request.pk, "approve", by=self.admin)
        self.assertEqual(counts(self.get(self.admin))["enrolment_requests"], 0)  # the action bumped the version

    def test_live_today_lists_sessions_on_air(self):
        session = make_realtime_session(status=RealtimeSession.STATUS_LIVE, started_at=timezone.now())
        cache.clear()
        live = self.get(self.admin)["live_today"]
        self.assertEqual(live[0]["id"], session.pk)
        self.assertEqual(live[0]["state"], "live")
        self.assertEqual(live[0]["href"], f"/console/admin/classes/{session.pk}/studio")

    def test_non_staff_get_403(self):
        self.client.force_authenticate(self.student)
        self.assertEqual(self.client.get("/api/admin/attention/").status_code, 403)
        self.assertTrue(all(queue["count"] is None for queue in attention.get_queues(self.student)["queues"]))


class HealthTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.dead = OutboxEvent.objects.create(event_type="payments.receipt_email", status=OutboxEvent.STATUS_DEAD, last_error="x" * 900)
        self.job = AsyncJob.objects.create(job_type=AsyncJob.TYPE_EMAIL_SEND, status=AsyncJob.STATUS_DEAD, attempts=5, last_error="smtp")

    def test_lists_failures(self):
        self.client.force_authenticate(self.admin)
        data = self.client.get("/api/admin/system/health/").json()["data"]
        self.assertEqual(data["status"], "attention")
        self.assertEqual(data["failed_outbox"]["count"], 1)
        self.assertLessEqual(len(data["failed_outbox"]["items"][0]["error"]), 400)
        self.assertEqual(data["failed_jobs"]["items"][0]["title"], "Email Send")
        self.assertTrue(data["failed_jobs"]["can_retry"])

    def test_retry_outbox_and_jobs(self):
        self.client.force_authenticate(self.admin)
        response = self.client.post("/api/admin/system/health/retry/", {"kind": "outbox", "ids": [self.dead.pk]}, format="json")
        self.assertEqual(response.json()["data"], {"kind": "outbox", "retried": 1})
        self.dead.refresh_from_db()
        self.assertEqual(self.dead.status, OutboxEvent.STATUS_PENDING)
        response = self.client.post("/api/admin/system/health/retry/", {"kind": "job"}, format="json")
        self.assertEqual(response.json()["data"]["retried"], 1)
        self.job.refresh_from_db()
        self.assertEqual((self.job.status, self.job.attempts), (AsyncJob.STATUS_PENDING, 0))
        self.assertEqual(self.client.post("/api/admin/system/health/retry/", {"kind": "nope"}, format="json").status_code, 400)

    def test_plain_staff_cannot_see_or_retry(self):
        staff = make_user(is_staff=True)
        self.client.force_authenticate(staff)
        data = self.client.get("/api/admin/system/health/").json()["data"]
        self.assertIsNone(data["failed_outbox"])
        self.assertEqual(data["status"], "ok")
        response = self.client.post("/api/admin/system/health/retry/", {"kind": "outbox"}, format="json")
        self.assertEqual(response.status_code, 403)


class ActivityTests(APITestCase):
    def setUp(self):
        self.admin = make_admin()
        self.staff = make_user(is_staff=True)
        self.staff.user_permissions.add(Permission.objects.get(codename="change_liveclassenrollment"))
        self.live_class = LiveClass.objects.create(title="Batch", description="Live")
        self.request_row = LiveClassEnrollment.objects.create(user=make_user(), live_class=self.live_class)
        self.payment = make_payment(amount=Decimal("10.00"))

    def test_feed_lists_admin_changes_with_groups(self):
        enrollment_actions.set_status("live_class", self.request_row.pk, "approve", by=self.admin)
        LogEntry.objects.log_actions(self.admin.pk, [self.payment], 2, change_message="Refunded.", single_object=True)
        self.client.force_authenticate(self.admin)
        data = self.client.get("/api/admin/activity/").json()["data"]
        self.assertEqual(data["scope"], "everyone")
        first, second = data["results"][:2]
        self.assertEqual(first["message"], "Refunded.")
        self.assertEqual(first["group"], "students")
        self.assertIn("Approved", second["message"])
        self.assertTrue(second["href"].startswith("/admin/courses/liveclassenrollment/"))
        only_students = self.client.get("/api/admin/activity/?group=students").json()["data"]["results"]
        self.assertEqual(len(only_students), 2)
        self.assertEqual(self.client.get("/api/admin/activity/?group=content").json()["data"]["results"], [])
        self.assertEqual(self.client.get("/api/admin/activity/?group=bogus").status_code, 400)

    def test_plain_staff_see_their_own_changes(self):
        enrollment_actions.set_status("live_class", self.request_row.pk, "approve", by=self.admin)
        enrollment_actions.set_status("live_class", self.request_row.pk, "reopen", by=self.staff)
        self.client.force_authenticate(self.staff)
        data = self.client.get("/api/admin/activity/").json()["data"]
        self.assertEqual(data["scope"], "mine")
        self.assertEqual([row["actor"]["id"] for row in data["results"]], [self.staff.pk])

    def test_paging(self):
        for _ in range(3):
            LogEntry.objects.log_actions(self.admin.pk, [self.payment], 2, change_message="x", single_object=True)
        self.client.force_authenticate(self.admin)
        page = self.client.get("/api/admin/activity/?limit=2").json()["data"]
        self.assertEqual(len(page["results"]), 2)
        rest = self.client.get(f"/api/admin/activity/?limit=2&before={page['next_before']}").json()["data"]
        self.assertEqual(len(rest["results"]), 1)
        self.assertIsNone(rest["next_before"])


class EnrollmentActionUnitTests(TestCase):
    def test_bump_version_survives_a_missing_key(self):
        cache.clear()
        attention.bump_version()
        attention.bump_version()
        self.assertEqual(cache.get(attention.VERSION_KEY), 2)
