"""Weekly reports: permissions, deadlines, versioning, grading, marks, exports, notifications."""

import io
import shutil
import tempfile
import uuid
import zipfile
from datetime import timedelta
from decimal import Decimal
from io import StringIO
from pathlib import Path

from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.courses.models import Enrollment
from apps.notifications.models import NotificationRecipient
from apps.reports import services
from apps.reports.models import (
    ReportCriterion,
    ReportFile,
    ReportGradeAudit,
    ReportSubmission,
    ReportSubmissionVersion,
    ReportTask,
)
from apps.reports.storage import private_report_storage
from django.conf import settings
from django.core.management import call_command
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from tests import factories as f
from tests import report_files as rf


class ReportsTestCase(APITestCase):
    def setUp(self):
        self.private_root = tempfile.mkdtemp(prefix="reports-test-")
        self._override = override_settings(REPORTS_PRIVATE_ROOT=self.private_root, REPORTS_MIN_FREE_BYTES=0)
        self._override.enable()
        self.instructor = f.make_instructor()
        self.course = f.make_course(instructor=self.instructor, title="OSINT Pro")
        self.student = f.make_user(full_name="Asha Rao")
        self.other_student = f.make_user(full_name="Ravi Kumar")
        f.make_enrollment(user=self.student, course=self.course)
        f.make_enrollment(user=self.other_student, course=self.course)
        self.now = timezone.now()
        self.task = self.make_task()

    def tearDown(self):
        self._override.disable()
        shutil.rmtree(self.private_root, ignore_errors=True)

    # --- helpers ---------------------------------------------------------
    def make_task(self, **overrides):
        fields = {
            "course": self.course,
            "title": "Target: Acme Corp",
            "brief": "Find the **CEO**.",
            "due_at": timezone.now() + timedelta(days=3),
            "status": ReportTask.STATUS_PUBLISHED,
            "max_marks": Decimal("10.00"),
            "created_by": self.instructor,
        }
        fields.update(overrides)
        return ReportTask.objects.create(**fields)

    def as_user(self, user):
        self.client.force_authenticate(user)

    def upload(self, task=None, file=None, user=None):
        if user is not None:
            self.as_user(user)
        task = task or self.task
        return self.client.post(
            reverse("reports-task-uploads", args=[task.pk]), {"file": file or rf.pdf()}, format="multipart"
        )

    def submit(self, file_ids, task=None, note="", key=None):
        task = task or self.task
        return self.client.post(
            reverse("reports-task-submit", args=[task.pk]),
            {"file_ids": file_ids, "note": note},
            format="json",
            HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
        )

    def submit_pdf(self, user=None, task=None, name="report.pdf"):
        user = user or self.student
        response = self.upload(task=task, file=rf.pdf(name), user=user)
        self.assertEqual(response.status_code, 201, response.data)
        file_id = response.data["data"]["id"]
        response = self.submit([file_id], task=task)
        self.assertEqual(response.status_code, 201, response.data)
        return ReportSubmission.objects.get(task=task or self.task, student=user)

    def grade(self, submission, action="grade", user=None, **data):
        self.as_user(user or self.instructor)
        payload = {"action": action, "expected_revision": submission.revision, **data}
        return self.client.post(
            reverse("reports-manage-submission-grade", args=[submission.pk]), payload, format="json"
        )

    def detail(self, user=None, task=None):
        self.as_user(user or self.student)
        response = self.client.get(reverse("reports-task-detail", args=[(task or self.task).pk]))
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["data"]

    def deliver_outbox(self):
        OutboxEvent.objects.update(available_at=timezone.now() - timedelta(seconds=1))
        return drain_outbox(batch_size=100)


class PermissionTests(ReportsTestCase):
    def test_unenrolled_user_gets_404_everywhere(self):
        stranger = f.make_user()
        submission = self.submit_pdf()
        file_id = submission.current_version.files.first().pk
        self.as_user(stranger)
        self.assertEqual(self.client.get(reverse("reports-task-detail", args=[self.task.pk])).status_code, 404)
        self.assertEqual(self.upload(user=stranger).status_code, 404)
        self.assertEqual(self.submit([file_id]).status_code, 404)
        self.assertEqual(self.client.get(reverse("reports-file-download", args=[file_id])).status_code, 404)
        listing = self.client.get(reverse("reports-tasks")).data["data"]
        self.assertEqual(listing["results"], [])

    def test_anonymous_is_rejected(self):
        response = self.client.get(reverse("reports-tasks"))
        self.assertIn(response.status_code, (401, 403))

    def test_expired_installment_loses_access(self):
        student = f.make_user()
        f.make_enrollment(
            user=student,
            course=self.course,
            access_type=Enrollment.ACCESS_INSTALLMENT,
            access_expires_at=timezone.now() - timedelta(days=1),
        )
        self.as_user(student)
        self.assertEqual(self.client.get(reverse("reports-task-detail", args=[self.task.pk])).status_code, 404)

    def test_student_cannot_see_other_students_files_or_marks(self):
        theirs = self.submit_pdf(user=self.other_student)
        self.assertEqual(self.grade(theirs, marks="8").status_code, 200)
        their_file = theirs.current_version.files.first().pk
        self.as_user(self.student)
        self.assertEqual(self.client.get(reverse("reports-file-download", args=[their_file])).status_code, 404)
        self.assertEqual(self.client.get(reverse("reports-feedback-file-download", args=[theirs.pk])).status_code, 404)
        detail = self.detail(self.student)
        self.assertIsNone(detail["submission"])
        self.assertIsNone(detail["grade"])
        # Using someone else's staged/submitted file id in my submission fails.
        response = self.submit([their_file])
        self.assertEqual(response.status_code, 400)
        marks = self.client.get(reverse("reports-my-marks")).data["data"]["courses"][0]
        self.assertEqual(marks["totals"]["graded_count"], 0)

    def test_students_are_not_graders(self):
        self.as_user(self.student)
        for name in ("reports-manage-courses", "reports-manage-tasks", "reports-manage-submissions"):
            self.assertEqual(self.client.get(reverse(name)).status_code, 403, name)

    def test_instructor_limited_to_own_courses(self):
        submission = self.submit_pdf()
        other = f.make_instructor()
        f.make_course(instructor=other)
        self.as_user(other)
        self.assertEqual(self.client.get(reverse("reports-manage-task-detail", args=[self.task.pk])).status_code, 404)
        queue = self.client.get(reverse("reports-manage-submissions")).data["data"]
        self.assertEqual(queue["results"], [])
        self.assertEqual(
            self.client.get(reverse("reports-manage-submission-detail", args=[submission.pk])).status_code, 404
        )
        self.assertEqual(self.grade(submission, user=other, marks="5").status_code, 404)
        self.assertEqual(
            self.client.get(reverse("reports-manage-gradebook"), {"course": self.course.pk}).status_code, 404
        )
        self.assertEqual(self.client.get(reverse("reports-manage-export"), {"course": self.course.pk}).status_code, 404)
        self.assertEqual(self.client.get(reverse("reports-manage-task-zip", args=[self.task.pk])).status_code, 404)
        file_id = submission.current_version.files.first().pk
        self.assertEqual(self.client.get(reverse("reports-file-download", args=[file_id])).status_code, 404)
        created = self.client.post(
            reverse("reports-manage-tasks"),
            {"course": self.course.pk, "title": "Mine now", "due_at": (timezone.now() + timedelta(days=2)).isoformat()},
            format="json",
        )
        self.assertEqual(created.status_code, 400)

    def test_staff_can_grade_any_course(self):
        submission = self.submit_pdf()
        admin = f.make_admin()
        self.assertEqual(self.grade(submission, user=admin, marks="7").status_code, 200)
        file_id = submission.current_version.files.first().pk
        self.assertEqual(self.client.get(reverse("reports-file-download", args=[file_id])).status_code, 200)


class FileStorageTests(ReportsTestCase):
    def test_every_type_can_be_uploaded_and_submitted(self):
        self.task.max_files = 20
        self.task.max_total_size_mb = 500
        self.task.save()
        self.as_user(self.student)
        ids = []
        for name, data in rf.every_type():
            response = self.upload(file=rf.upload(name, data))
            self.assertEqual(response.status_code, 201, (name, response.data))
            ids.append(response.data["data"]["id"])
        self.assertEqual(self.submit(ids).status_code, 201)

    def test_large_upload_streams_through_a_temporary_file(self):
        big = rf.PDF_BYTES + b"%" + b"0" * (3 * 1024 * 1024)
        response = self.upload(file=rf.upload("big.pdf", big), user=self.student)
        self.assertEqual(response.status_code, 201, response.data)
        stored = ReportFile.objects.get()
        self.assertEqual(stored.size, len(big))
        self.assertEqual(Path(stored.file.path).stat().st_size, len(big))
        big_zip = rf.zip_bytes(
            [("Vault/a.png", rf.image_bytes()), ("Vault/blob.pdf", __import__("os").urandom(3 * 1024 * 1024))]
        )
        response = self.upload(file=rf.upload("vault.zip", big_zip))
        self.assertEqual(response.status_code, 201, response.data)

    def test_rejected_upload_returns_field_error(self):
        response = self.upload(file=rf.upload("deck.pptx", rf.ooxml_bytes("pptx", vba=True)), user=self.student)
        self.assertEqual(response.status_code, 400)
        self.assertIn("macros", response.data["errors"]["file"][0])
        self.assertFalse(ReportFile.objects.exists())

    def test_task_allowed_types_are_enforced(self):
        self.task.allowed_file_types = ["pdf"]
        self.task.save()
        response = self.upload(file=rf.upload("n.md", b"# hi"), user=self.student)
        self.assertEqual(response.status_code, 400)
        self.assertIn(".pdf", response.data["errors"]["file"][0])

    def test_max_files_and_total_size(self):
        self.task.max_files = 1
        self.task.save()
        self.assertEqual(self.upload(user=self.student).status_code, 201)
        response = self.upload()
        self.assertEqual(response.status_code, 400)
        self.assertIn("up to 1 file", response.data["message"])

    def test_files_are_private_with_random_names(self):
        self.as_user(self.student)
        self.upload(file=rf.pdf("My Secret Report.pdf"))
        stored = ReportFile.objects.get()
        self.assertNotIn("Secret", stored.file.name)
        path = Path(stored.file.path).resolve()
        self.assertTrue(path.is_relative_to(Path(self.private_root).resolve()))
        self.assertFalse(path.is_relative_to(Path(settings.MEDIA_ROOT).resolve()))
        self.assertEqual(len(stored.sha256), 64)
        with self.assertRaises(ValueError):
            private_report_storage().url(stored.file.name)

    def test_download_headers(self):
        self.as_user(self.student)
        pdf_id = self.upload(file=rf.pdf()).data["data"]["id"]
        svg_id = self.upload(file=rf.upload("graph.svg", rf.SVG_TEXT.encode())).data["data"]["id"]
        url = reverse("reports-file-download", args=[pdf_id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Disposition"].startswith("attachment;"))
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")
        self.assertIn("sandbox", response["Content-Security-Policy"])
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertEqual(b"".join(response.streaming_content), rf.PDF_BYTES)
        inline = self.client.get(url, {"inline": "1"})
        self.assertTrue(inline["Content-Disposition"].startswith("inline;"))
        self.assertEqual(inline["Content-Type"], "application/pdf")
        self.assertEqual(inline["X-Frame-Options"], "SAMEORIGIN")
        self.assertNotIn("sandbox", inline["Content-Security-Policy"])
        svg = self.client.get(reverse("reports-file-download", args=[svg_id]), {"inline": "1"})
        self.assertTrue(svg["Content-Disposition"].startswith("attachment;"))
        self.assertEqual(svg["Content-Type"], "application/octet-stream")
        self.assertIn("sandbox", svg["Content-Security-Policy"])

    def test_remove_staged_upload(self):
        self.as_user(self.student)
        file_id = self.upload().data["data"]["id"]
        path = ReportFile.objects.get(pk=file_id).file.path
        response = self.client.delete(reverse("reports-task-upload-delete", args=[self.task.pk, file_id]))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(ReportFile.objects.exists())
        self.assertFalse(Path(path).exists())
        response = self.client.delete(reverse("reports-task-upload-delete", args=[self.task.pk, file_id]))
        self.assertEqual(response.status_code, 404)

    @override_settings(REPORTS_MIN_FREE_BYTES=10**18)
    def test_low_disk_space_refuses_upload(self):
        response = self.upload(user=self.student)
        self.assertEqual(response.status_code, 507)
        self.assertEqual(response.data["code"], "storage_full")

    @override_settings(REPORTS_ANTIVIRUS_SCANNER="tests.test_reports_api.fake_infected_scanner")
    def test_antivirus_hook_rejects_infected(self):
        response = self.upload(user=self.student)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "file_infected")

    @override_settings(REPORTS_ANTIVIRUS_SCANNER="tests.test_reports_api.fake_broken_scanner")
    def test_antivirus_outage_fails_closed(self):
        self.assertEqual(self.upload(user=self.student).status_code, 503)


def fake_infected_scanner(file_obj, *, filename):
    from apps.reports.antivirus import InfectedFile

    raise InfectedFile("Eicar-Test-Signature")


def fake_broken_scanner(file_obj, *, filename):
    raise ConnectionError("clamd down")


class DeadlineTests(ReportsTestCase):
    def test_task_hidden_before_opens_at_and_drafts_hidden(self):
        future = self.make_task(opens_at=timezone.now() + timedelta(days=1), due_at=timezone.now() + timedelta(days=4))
        draft = self.make_task(status=ReportTask.STATUS_DRAFT)
        self.as_user(self.student)
        for task in (future, draft):
            self.assertEqual(self.client.get(reverse("reports-task-detail", args=[task.pk])).status_code, 404)
        ids = [item["id"] for item in self.client.get(reverse("reports-tasks")).data["data"]["results"]]
        self.assertEqual(ids, [self.task.pk])

    def test_on_time_submission(self):
        submission = self.submit_pdf()
        self.assertEqual(submission.status, ReportSubmission.STATUS_SUBMITTED)
        self.assertFalse(submission.is_late)
        self.assertEqual(submission.minutes_late, 0)
        listing = self.client.get(reverse("reports-tasks")).data["data"]
        self.assertEqual(listing["results"][0]["status"], "submitted")
        self.assertIsNone(listing["next_due"])

    def test_next_due_is_the_soonest_open_unsubmitted(self):
        later = self.make_task(title="Later", due_at=timezone.now() + timedelta(days=9))
        self.as_user(self.student)
        data = self.client.get(reverse("reports-tasks")).data["data"]
        self.assertEqual(data["next_due"]["id"], self.task.pk)
        self.assertEqual({item["id"] for item in data["results"]}, {self.task.pk, later.pk})

    def test_after_deadline_without_late_policy_is_rejected(self):
        self.as_user(self.student)
        file_id = self.upload().data["data"]["id"]
        ReportTask.objects.filter(pk=self.task.pk).update(due_at=timezone.now() - timedelta(minutes=1))
        response = self.submit([file_id])
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "submission_locked")
        self.assertEqual(self.upload().status_code, 409)

    def test_late_window_flags_minutes_late(self):
        task = self.make_task(
            due_at=timezone.now() - timedelta(minutes=90),
            late_policy=ReportTask.LATE_ALLOWED,
            late_until=timezone.now() + timedelta(days=1),
        )
        submission = self.submit_pdf(task=task)
        self.assertTrue(submission.is_late)
        self.assertIn(submission.minutes_late, (90, 91))
        self.assertTrue(submission.current_version.is_late)

    def test_after_late_cutoff_is_rejected(self):
        task = self.make_task(
            due_at=timezone.now() - timedelta(days=2),
            late_policy=ReportTask.LATE_ALLOWED,
            late_until=timezone.now() - timedelta(minutes=1),
        )
        self.assertEqual(self.upload(task=task, user=self.student).status_code, 409)

    def test_closed_task_rejects(self):
        self.as_user(self.student)
        file_id = self.upload().data["data"]["id"]
        services.close_task(task=self.task)
        response = self.submit([file_id])
        self.assertEqual(response.status_code, 409)
        self.assertIn("closed", response.data["message"])

    def test_revision_after_return_allowed_past_deadline_and_keeps_lateness(self):
        task = self.make_task(
            due_at=timezone.now() - timedelta(minutes=30),
            late_policy=ReportTask.LATE_ALLOWED,
            late_until=timezone.now() + timedelta(hours=1),
        )
        submission = self.submit_pdf(task=task)
        minutes = submission.minutes_late
        response = self.grade(submission, action="return", feedback="Add sources.")
        self.assertEqual(response.status_code, 200, response.data)
        ReportTask.objects.filter(pk=task.pk).update(late_until=timezone.now() - timedelta(minutes=1))
        detail = self.detail(task=task)
        self.assertEqual(detail["status"], "returned_for_revision")
        self.assertEqual(detail["revision_feedback"], "Add sources.")
        self.assertTrue(detail["can_submit"])
        submission = self.submit_pdf(task=task, name="v2.pdf")
        self.assertEqual(submission.status, ReportSubmission.STATUS_RESUBMITTED)
        self.assertEqual(submission.version_count, 2)
        self.assertTrue(submission.current_version.is_revision)
        self.assertEqual(submission.minutes_late, minutes)
        self.assertTrue(submission.is_late)


class PenaltyTests(ReportsTestCase):
    def test_penalty_math(self):
        task = ReportTask(max_marks=Decimal("10"), late_penalty_percent_per_day=Decimal("10"), due_at=timezone.now())
        self.assertEqual(task.late_penalty_for(0, Decimal("8")), Decimal("0.00"))
        self.assertEqual(task.late_penalty_for(1, Decimal("8")), Decimal("1.00"))
        self.assertEqual(task.late_penalty_for(25 * 60, Decimal("8")), Decimal("2.00"))
        self.assertEqual(task.late_penalty_for(30 * 24 * 60, Decimal("3.5")), Decimal("3.50"))
        self.assertEqual(task.late_penalty_for(10, None), Decimal("0.00"))
        task.late_penalty_percent_per_day = Decimal("0")
        self.assertEqual(task.late_penalty_for(9999, Decimal("8")), Decimal("0.00"))
        task.max_marks = Decimal("7.5")
        task.late_penalty_percent_per_day = Decimal("12.5")
        self.assertEqual(task.late_penalty_for(1, Decimal("7")), Decimal("0.94"))

    def test_minutes_late_rounds_up(self):
        due = timezone.now()
        task = ReportTask(due_at=due)
        self.assertEqual(task.minutes_late(due), 0)
        self.assertEqual(task.minutes_late(due + timedelta(seconds=1)), 1)
        self.assertEqual(task.minutes_late(due + timedelta(minutes=61)), 61)

    def test_graded_late_submission_applies_penalty(self):
        task = self.make_task(
            due_at=timezone.now() - timedelta(hours=25),
            late_policy=ReportTask.LATE_ALLOWED,
            late_until=timezone.now() + timedelta(days=1),
            late_penalty_percent_per_day=Decimal("10"),
        )
        submission = self.submit_pdf(task=task)
        response = self.grade(submission, marks="8.5")
        self.assertEqual(response.status_code, 200, response.data)
        grade = response.data["data"]["grade"]
        self.assertEqual(grade["raw_marks"], "8.50")
        self.assertEqual(grade["late_penalty"], "2.00")
        self.assertEqual(grade["final_marks"], "6.50")
        student_grade = self.detail(task=task)["grade"]
        self.assertEqual(student_grade["final_marks"], "6.50")
        self.assertEqual(student_grade["late_penalty"], "2.00")


class VersioningTests(ReportsTestCase):
    def test_replace_files_creates_new_version_and_keeps_old(self):
        submission = self.submit_pdf(name="v1.pdf")
        v1_file = submission.current_version.files.get()
        self.as_user(self.student)
        new_id = self.upload(file=rf.upload("map.canvas", rf.canvas_bytes())).data["data"]["id"]
        # Carry the current file over and add the new one.
        response = self.submit([v1_file.pk, new_id], note="Added the canvas")
        self.assertEqual(response.status_code, 201, response.data)
        submission.refresh_from_db()
        self.assertEqual(submission.version_count, 2)
        self.assertEqual(set(submission.current_version.files.values_list("pk", flat=True)), {v1_file.pk, new_id})
        detail = response.data["data"]["task"]
        self.assertEqual([item["number"] for item in detail["submission"]["versions"]], [2, 1])
        self.assertEqual(detail["submission"]["current_version"]["note"], "Added the canvas")
        # Replace everything: v3 without v1's file; v1 stays downloadable by the grader.
        third = self.upload(file=rf.pdf("v3.pdf")).data["data"]["id"]
        self.assertEqual(self.submit([third]).status_code, 201)
        self.assertEqual(ReportSubmissionVersion.objects.filter(submission=submission).count(), 3)
        self.as_user(self.instructor)
        self.assertEqual(self.client.get(reverse("reports-file-download", args=[v1_file.pk])).status_code, 200)
        # A file that is in an old (not current) version cannot be reused.
        self.as_user(self.student)
        self.assertEqual(self.submit([v1_file.pk]).status_code, 400)

    def test_staged_file_of_another_task_is_rejected(self):
        other_task = self.make_task(title="Other")
        self.as_user(self.student)
        foreign = self.upload(task=other_task).data["data"]["id"]
        response = self.submit([foreign])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "validation_files_missing")

    def test_review_and_grading_lock_replacement(self):
        submission = self.submit_pdf()
        self.assertEqual(self.grade(submission, action="draft", marks="5").status_code, 200)
        self.as_user(self.student)
        self.assertEqual(self.upload().status_code, 409)
        submission.refresh_from_db()
        self.assertEqual(self.grade(submission, marks="5").status_code, 200)
        self.as_user(self.student)
        file_id = submission.current_version.files.first().pk
        response = self.submit([file_id], note="change")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "submission_locked")

    def test_empty_submission_rejected(self):
        self.as_user(self.student)
        self.assertEqual(self.submit([]).status_code, 400)


class IdempotencyTests(ReportsTestCase):
    def test_missing_key_is_rejected(self):
        self.as_user(self.student)
        file_id = self.upload().data["data"]["id"]
        response = self.client.post(
            reverse("reports-task-submit", args=[self.task.pk]), {"file_ids": [file_id]}, format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "idempotency_key_required")
        self.assertFalse(ReportSubmission.objects.exclude(status="not_submitted").exists())

    def test_same_key_replays(self):
        self.as_user(self.student)
        file_id = self.upload().data["data"]["id"]
        key = str(uuid.uuid4())
        first = self.submit([file_id], key=key)
        second = self.submit([file_id], key=key)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second["Idempotent-Replayed"], "true")
        self.assertEqual(ReportSubmissionVersion.objects.count(), 1)

    def test_new_key_with_identical_content_does_not_duplicate(self):
        self.as_user(self.student)
        file_id = self.upload().data["data"]["id"]
        self.assertEqual(self.submit([file_id], note="n").status_code, 201)
        again = self.submit([file_id], note="n")
        self.assertEqual(again.status_code, 200)
        self.assertFalse(again.data["data"]["created"])
        self.assertEqual(ReportSubmissionVersion.objects.count(), 1)


class GradingTests(ReportsTestCase):
    def add_rubric(self):
        ReportCriterion.objects.create(task=self.task, name="Sources", max_marks=Decimal("6"), order=1)
        ReportCriterion.objects.create(task=self.task, name="Write-up", max_marks=Decimal("4"), order=2)
        return list(self.task.criteria.all())

    def test_rubric_marks_sum(self):
        sources, writeup = self.add_rubric()
        submission = self.submit_pdf()
        response = self.grade(
            submission, criteria_marks={str(sources.pk): "5.5", str(writeup.pk): "3.25"}, feedback="Good."
        )
        self.assertEqual(response.status_code, 200, response.data)
        grade = response.data["data"]["grade"]
        self.assertEqual(grade["final_marks"], "8.75")
        self.assertEqual([item["marks"] for item in grade["criteria"]], ["5.50", "3.25"])
        student = self.detail()["grade"]
        self.assertEqual(student["final_marks"], "8.75")
        self.assertEqual(student["feedback"], "Good.")

    def test_rubric_requires_every_criterion_when_grading(self):
        sources, _writeup = self.add_rubric()
        submission = self.submit_pdf()
        response = self.grade(submission, criteria_marks={str(sources.pk): "5"})
        self.assertEqual(response.status_code, 400)
        # A draft may be partial.
        self.assertEqual(self.grade(submission, action="draft", criteria_marks={str(sources.pk): "5"}).status_code, 200)

    def test_criterion_over_its_max_rejected(self):
        sources, writeup = self.add_rubric()
        submission = self.submit_pdf()
        response = self.grade(submission, criteria_marks={str(sources.pk): "7", str(writeup.pk): "1"})
        self.assertEqual(response.status_code, 400)

    def test_marks_validation(self):
        submission = self.submit_pdf()
        for value in ("10.5", "-1", "8.123", "abc"):
            with self.subTest(value=value):
                self.assertEqual(self.grade(submission, marks=value).status_code, 400)
        self.assertEqual(self.grade(submission).status_code, 400)
        submission.refresh_from_db()
        self.assertEqual(submission.status, ReportSubmission.STATUS_SUBMITTED)

    def test_draft_hides_marks_until_graded(self):
        submission = self.submit_pdf()
        self.assertEqual(self.grade(submission, action="draft", marks="6", feedback="wip").status_code, 200)
        detail = self.detail()
        self.assertEqual(detail["status"], "under_review")
        self.assertIsNone(detail["grade"])
        self.assertIsNone(detail["final_marks"])
        submission.refresh_from_db()
        self.assertEqual(self.grade(submission, marks="6").status_code, 200)
        detail = self.detail()
        self.assertEqual(detail["status"], "graded")
        self.assertEqual(detail["final_marks"], "6.00")

    def test_stale_revision_conflicts_and_changes_nothing(self):
        submission = self.submit_pdf()
        stale = submission.revision
        self.assertEqual(self.grade(submission, marks="7").status_code, 200)
        self.as_user(self.instructor)
        response = self.client.post(
            reverse("reports-manage-submission-grade", args=[submission.pk]),
            {"action": "grade", "expected_revision": stale, "marks": "3"},
            format="json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "grade_conflict")
        submission.refresh_from_db()
        self.assertEqual(submission.grade.final_marks, Decimal("7.00"))
        self.assertEqual(ReportGradeAudit.objects.filter(submission=submission).count(), 1)

    def test_audit_records_changes(self):
        submission = self.submit_pdf()
        self.grade(submission, marks="7")
        submission.refresh_from_db()
        self.grade(submission, marks="8.5")
        entries = list(ReportGradeAudit.objects.filter(submission=submission).order_by("created_at", "id"))
        self.assertEqual([entry.action for entry in entries], ["graded", "regraded"])
        self.assertEqual(entries[1].old_final_marks, Decimal("7.00"))
        self.assertEqual(entries[1].new_final_marks, Decimal("8.50"))
        self.assertEqual(entries[1].actor, self.instructor)
        detail = self.client.get(reverse("reports-manage-submission-detail", args=[submission.pk])).data["data"]
        self.assertEqual(detail["audit"][0]["action"], "regraded")

    def test_return_requires_feedback(self):
        submission = self.submit_pdf()
        self.assertEqual(self.grade(submission, action="return").status_code, 400)
        response = self.grade(submission, action="return", feedback="Cite your sources.")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["data"]["status"], "returned_for_revision")

    def test_annotated_file_visibility(self):
        submission = self.submit_pdf()
        self.as_user(self.instructor)
        response = self.client.post(
            reverse("reports-manage-submission-grade", args=[submission.pk]),
            {
                "action": "draft",
                "expected_revision": submission.revision,
                "marks": "5",
                "annotated_file": rf.pdf("annotated.pdf"),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["data"]["grade"]["annotated_file"]["name"], "annotated.pdf")
        url = reverse("reports-feedback-file-download", args=[submission.pk])
        self.assertEqual(self.client.get(url).status_code, 200)
        self.as_user(self.student)
        self.assertEqual(self.client.get(url).status_code, 404)  # draft: not visible yet
        submission.refresh_from_db()
        self.grade(submission, marks="5")
        self.as_user(self.student)
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.detail()["grade"]["annotated_file"]["name"], "annotated.pdf")

    def test_max_marks_and_rubric_frozen_after_grading(self):
        submission = self.submit_pdf()
        self.grade(submission, marks="5")
        url = reverse("reports-manage-task-detail", args=[self.task.pk])
        response = self.client.patch(url, {"max_marks": "20"}, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "task_has_grades")
        response = self.client.patch(url, {"criteria": [{"name": "All", "max_marks": "10"}]}, format="json")
        self.assertEqual(response.status_code, 409)
        # Other fields still editable.
        response = self.client.patch(url, {"title": "Renamed"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)

    def test_nothing_to_grade(self):
        submission = ReportSubmission.objects.create(task=self.task, student=self.student)
        self.assertEqual(self.grade(submission, marks="5").status_code, 409)

    def test_queue_filters_and_neighbours(self):
        first = self.submit_pdf()
        second = self.submit_pdf(user=self.other_student)
        self.as_user(self.instructor)
        queue = self.client.get(reverse("reports-manage-submissions"), {"task": self.task.pk, "status": "awaiting"})
        data = queue.data["data"]
        self.assertEqual([item["id"] for item in data["results"]], [first.pk, second.pk])
        self.assertEqual(data["counts"]["students"], 2)
        self.assertEqual(data["counts"]["awaiting"], 2)
        detail = self.client.get(
            reverse("reports-manage-submission-detail", args=[first.pk]), {"task": self.task.pk}
        ).data["data"]
        self.assertEqual(detail["neighbours"]["next_ungraded_id"], second.pk)
        self.assertEqual(detail["neighbours"]["position"], 1)
        late = self.client.get(reverse("reports-manage-submissions"), {"late": "1"}).data["data"]
        self.assertEqual(late["results"], [])


class VisibilityTests(ReportsTestCase):
    def test_on_release_hides_marks_until_released(self):
        self.task.marks_visibility = ReportTask.MARKS_ON_RELEASE
        self.task.save()
        submission = self.submit_pdf()
        self.assertEqual(self.grade(submission, marks="9", feedback="Great").status_code, 200)
        detail = self.detail()
        self.assertEqual(detail["status"], "graded")
        self.assertTrue(detail["marks_hidden_until_release"])
        self.assertIsNone(detail["grade"])
        self.assertIsNone(detail["final_marks"])
        listing = self.client.get(reverse("reports-tasks")).data["data"]["results"][0]
        self.assertIsNone(listing["final_marks"])
        self.assertFalse(listing["marks_visible"])
        marks = self.client.get(reverse("reports-my-marks")).data["data"]["courses"][0]
        self.assertIsNone(marks["cells"][0]["final_marks"])
        self.assertEqual(marks["totals"]["graded_count"], 0)

        self.as_user(self.instructor)
        response = self.client.post(reverse("reports-manage-task-release-marks", args=[self.task.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.data["data"]["marks_released_at"])
        self.assertTrue(
            ReportGradeAudit.objects.filter(
                submission=submission, action=ReportGradeAudit.ACTION_MARKS_RELEASED
            ).exists()
        )
        detail = self.detail()
        self.assertFalse(detail["marks_hidden_until_release"])
        self.assertEqual(detail["grade"]["final_marks"], "9.00")
        marks = self.client.get(reverse("reports-my-marks")).data["data"]["courses"][0]
        self.assertEqual(marks["totals"]["total_marks"], "9.00")

    def test_release_only_for_held_marks(self):
        self.as_user(self.instructor)
        response = self.client.post(reverse("reports-manage-task-release-marks", args=[self.task.pk]))
        self.assertEqual(response.status_code, 409)


class GradebookTests(ReportsTestCase):
    def test_gradebook_math(self):
        past = self.make_task(title="Week 1", due_at=timezone.now() + timedelta(hours=1), max_marks=Decimal("10"))
        week2 = self.make_task(title="Week 2", due_at=timezone.now() + timedelta(hours=2), max_marks=Decimal("7.5"))
        first = self.submit_pdf(task=past)
        second = self.submit_pdf(task=week2)
        self.assertEqual(self.grade(first, marks="8.5").status_code, 200)
        self.assertEqual(self.grade(second, marks="5").status_code, 200)
        ReportTask.objects.filter(pk__in=[past.pk, week2.pk]).update(due_at=timezone.now() - timedelta(hours=1))
        ReportSubmission.objects.filter(pk=second.pk).update(is_late=True, minutes_late=12)
        # The setUp task (due in 3 days) is not missing yet for anyone.
        response = self.client.get(reverse("reports-manage-gradebook"), {"course": self.course.pk})
        self.assertEqual(response.status_code, 200)
        data = response.data["data"]
        rows = {row["student"]["id"]: row for row in data["rows"]}
        mine = rows[self.student.pk]["totals"]
        self.assertEqual(mine["total_marks"], "13.50")
        self.assertEqual(mine["max_marks"], "17.50")
        self.assertEqual(mine["percentage"], "77.14")
        self.assertEqual(mine["missing_count"], 0)
        self.assertEqual(mine["late_count"], 1)
        theirs = rows[self.other_student.pk]["totals"]
        self.assertEqual(theirs["missing_count"], 2)
        self.assertIsNone(theirs["percentage"])
        services.close_task(task=self.task)
        data = self.client.get(reverse("reports-manage-gradebook"), {"course": self.course.pk}).data["data"]
        rows = {row["student"]["id"]: row for row in data["rows"]}
        self.assertEqual(rows[self.other_student.pk]["totals"]["missing_count"], 3)

    def test_missing_only_after_late_window(self):
        task = self.make_task(
            due_at=timezone.now() - timedelta(hours=1),
            late_policy=ReportTask.LATE_ALLOWED,
            late_until=timezone.now() + timedelta(hours=1),
        )
        book = services.course_gradebook(self.course)
        cell = next(c for c in book["rows"][0]["cells"] if c["task_id"] == task.pk)
        self.assertFalse(cell["is_missing"])
        later = services.course_gradebook(self.course, now=timezone.now() + timedelta(hours=2))
        cell = next(c for c in later["rows"][0]["cells"] if c["task_id"] == task.pk)
        self.assertTrue(cell["is_missing"])

    def test_percent_helper(self):
        self.assertEqual(services.percent(Decimal("2"), Decimal("3")), Decimal("66.67"))
        self.assertIsNone(services.percent(Decimal("0"), Decimal("0")))


class ExportTests(ReportsTestCase):
    def test_course_and_task_csv(self):
        evil = f.make_user(full_name="=cmd|' /C calc'!A0")
        f.make_enrollment(user=evil, course=self.course)
        submission = self.submit_pdf(user=evil)
        self.grade(submission, marks="7.5", feedback="+1 nice")
        self.as_user(self.instructor)
        response = self.client.get(reverse("reports-manage-export"), {"course": self.course.pk})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Type"].startswith("text/csv"))
        self.assertIn("attachment;", response["Content-Disposition"])
        text = response.content.decode("utf-8-sig")
        self.assertIn("Student,Email,Target: Acme Corp (/10)", text)
        self.assertIn("'=cmd", text)
        self.assertIn("7.5", text)
        response = self.client.get(reverse("reports-manage-export"), {"task": self.task.pk})
        text = response.content.decode("utf-8-sig")
        self.assertIn("Final marks", text.splitlines()[0])
        self.assertIn("'+1 nice", text)
        self.assertEqual(self.client.get(reverse("reports-manage-export")).status_code, 400)

    def test_zip_download(self):
        self.as_user(self.instructor)
        self.assertEqual(self.client.get(reverse("reports-manage-task-zip", args=[self.task.pk])).status_code, 404)
        self.submit_pdf(name="../../etc/passwd.pdf")
        self.submit_pdf(user=self.other_student, name="report.pdf")
        self.as_user(self.instructor)
        response = self.client.get(reverse("reports-manage-task-zip", args=[self.task.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/zip")
        archive = zipfile.ZipFile(io.BytesIO(b"".join(response.streaming_content)))
        self.assertIsNone(archive.testzip())
        names = archive.namelist()
        self.assertIn("manifest.csv", names)
        self.assertTrue(any(name.startswith(f"Asha Rao ({self.student.pk})/v1/") for name in names))
        self.assertTrue(any(name.startswith(f"Ravi Kumar ({self.other_student.pk})/v1/") for name in names))
        for name in names:
            self.assertFalse(name.startswith("/"))
            self.assertNotIn("..", name.split("/"))
        pdfs = [name for name in names if name.endswith(".pdf")]
        self.assertEqual(len(pdfs), 2)
        self.assertEqual(archive.read(pdfs[0]), rf.PDF_BYTES)


class NotificationTests(ReportsTestCase):
    def recipients(self, title_fragment):
        return set(
            NotificationRecipient.objects.filter(notification__title__icontains=title_fragment).values_list(
                "user_id", flat=True
            )
        )

    def test_publish_notifies_and_schedules_reminder(self):
        task = self.make_task(status=ReportTask.STATUS_DRAFT, due_at=timezone.now() + timedelta(days=2))
        self.as_user(self.instructor)
        response = self.client.post(reverse("reports-manage-task-publish", args=[task.pk]))
        self.assertEqual(response.status_code, 200, response.data)
        published = OutboxEvent.objects.get(event_type=services.EVENT_TASK_PUBLISHED)
        reminder = OutboxEvent.objects.get(event_type=services.EVENT_DUE_REMINDER)
        expected = task.due_at - timedelta(hours=24)
        self.assertLess(abs((reminder.available_at - expected).total_seconds()), 5)
        self.assertEqual(published.payload["task_id"], task.pk)
        # Only the published event is due now.
        drain_outbox(batch_size=50)
        self.assertEqual(self.recipients("New weekly report"), {self.student.pk, self.other_student.pk})
        self.assertEqual(self.recipients("due soon"), set())

    def test_reminder_only_for_unsubmitted_and_skipped_when_moved(self):
        task = self.make_task(status=ReportTask.STATUS_DRAFT, due_at=timezone.now() + timedelta(days=2))
        services.publish_task(task=task, actor=self.instructor)
        self.submit_pdf(task=task)
        ReportTask.objects.filter(pk=task.pk).update(due_at=timezone.now() + timedelta(hours=20))
        self.deliver_outbox()
        self.assertEqual(self.recipients("due soon"), set())  # payload due_at no longer matches
        task.refresh_from_db()
        services.schedule_due_reminder(task)
        self.deliver_outbox()
        self.assertEqual(self.recipients("due soon"), {self.other_student.pk})

    def test_reminder_not_queued_too_close_to_deadline(self):
        task = self.make_task(status=ReportTask.STATUS_DRAFT, due_at=timezone.now() + timedelta(minutes=30))
        services.publish_task(task=task, actor=self.instructor)
        self.assertFalse(OutboxEvent.objects.filter(event_type=services.EVENT_DUE_REMINDER).exists())

    def test_graded_notification_only_when_visible(self):
        submission = self.submit_pdf()
        self.grade(submission, marks="8")
        self.deliver_outbox()
        self.assertEqual(self.recipients("Report marked"), {self.student.pk})

        held = self.make_task(title="Held", marks_visibility=ReportTask.MARKS_ON_RELEASE)
        other = self.submit_pdf(user=self.other_student, task=held)
        self.grade(other, marks="6")
        self.assertFalse(
            OutboxEvent.objects.filter(
                event_type=services.EVENT_SUBMISSION_GRADED, payload__submission_id=other.pk
            ).exists()
        )
        self.client.post(reverse("reports-manage-task-release-marks", args=[held.pk]))
        self.deliver_outbox()
        self.assertEqual(self.recipients("Marks released"), {self.other_student.pk})

    def test_returned_notification(self):
        submission = self.submit_pdf()
        self.grade(submission, action="return", feedback="Fix it")
        self.deliver_outbox()
        self.assertEqual(self.recipients("returned for revision"), {self.student.pk})

    def test_late_digest_notifies_instructor_once(self):
        task = self.make_task(
            due_at=timezone.now() - timedelta(minutes=5),
            late_policy=ReportTask.LATE_ALLOWED,
            late_until=timezone.now() + timedelta(days=1),
        )
        first = self.submit_pdf(task=task)
        self.submit_pdf(task=task, user=self.other_student)
        events = OutboxEvent.objects.filter(event_type=services.EVENT_LATE_DIGEST)
        self.assertEqual(events.count(), 1)
        self.assertGreater(events.get().available_at, timezone.now())
        self.deliver_outbox()
        self.assertEqual(self.recipients("late report"), {self.instructor.pk})
        notification = NotificationRecipient.objects.get(notification__title__icontains="late report").notification
        self.assertIn("2 late reports", notification.title)
        first.refresh_from_db()
        self.assertIsNotNone(first.late_digest_sent_at)
        self.deliver_outbox()
        self.assertEqual(NotificationRecipient.objects.filter(notification__title__icontains="late report").count(), 1)

    def test_reminder_command_is_idempotent_and_prunes_staged(self):
        task = self.make_task(due_at=timezone.now() + timedelta(hours=10))
        self.as_user(self.student)
        self.upload(task=task)
        ReportFile.objects.update(created_at=timezone.now() - timedelta(days=5))
        out = StringIO()
        call_command("send_report_reminders", stdout=out)
        self.assertIn("staged_pruned=1", out.getvalue())
        call_command("send_report_reminders", stdout=StringIO())
        self.assertEqual(self.recipients("due soon"), {self.student.pk, self.other_student.pk})
        self.assertEqual(NotificationRecipient.objects.filter(notification__title__icontains="due soon").count(), 2)
        self.assertFalse(ReportFile.objects.exists())


class TaskManagementTests(ReportsTestCase):
    def payload(self, **overrides):
        data = {
            "course": self.course.pk,
            "title": "Target: Jane Doe",
            "brief": "Map her footprint.",
            "due_at": (timezone.now() + timedelta(days=5)).isoformat(),
            "max_marks": "10",
            "criteria": [{"name": "Sources", "max_marks": "6"}, {"name": "Analysis", "max_marks": "4"}],
        }
        data.update(overrides)
        return data

    def test_create_and_rubric_validation(self):
        self.as_user(self.instructor)
        response = self.client.post(reverse("reports-manage-tasks"), self.payload(), format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["data"]["status"], "draft")
        self.assertEqual(len(response.data["data"]["criteria_detail"]), 2)
        bad = self.client.post(reverse("reports-manage-tasks"), self.payload(max_marks="9.5"), format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.data["code"], "validation_rubric_total")
        late = self.client.post(
            reverse("reports-manage-tasks"), self.payload(late_policy="allow_late", criteria=[]), format="json"
        )
        self.assertEqual(late.status_code, 400)
        self.assertIn("late_until", late.data["errors"])
        past = self.client.post(
            reverse("reports-manage-tasks"),
            self.payload(due_at=(timezone.now() - timedelta(days=1)).isoformat()),
            format="json",
        )
        self.assertEqual(past.status_code, 400)

    def test_duplicate_publish_close_reopen_delete(self):
        ReportCriterion.objects.create(task=self.task, name="All", max_marks=Decimal("10"))
        self.task.week_number = 3
        self.task.save()
        self.as_user(self.instructor)
        response = self.client.post(reverse("reports-manage-task-duplicate", args=[self.task.pk]))
        self.assertEqual(response.status_code, 201)
        copy = ReportTask.objects.get(pk=response.data["data"]["id"])
        self.assertEqual(copy.status, ReportTask.STATUS_DRAFT)
        self.assertEqual(copy.week_number, 4)
        self.assertEqual(copy.due_at - self.task.due_at, timedelta(days=7))
        self.assertEqual(list(copy.criteria.values_list("name", flat=True)), ["All"])
        delete = self.client.delete(reverse("reports-manage-task-detail", args=[copy.pk]))
        self.assertEqual(delete.status_code, 200)
        self.assertFalse(ReportTask.objects.filter(pk=copy.pk).exists())
        self.assertEqual(
            self.client.delete(reverse("reports-manage-task-detail", args=[self.task.pk])).status_code, 409
        )

        close = self.client.post(reverse("reports-manage-task-close", args=[self.task.pk]))
        self.assertEqual(close.data["data"]["status"], "closed")
        reopen = self.client.post(reverse("reports-manage-task-reopen", args=[self.task.pk]))
        self.assertEqual(reopen.data["data"]["status"], "published")

    def test_publish_with_past_deadline_rejected(self):
        draft = self.make_task(status=ReportTask.STATUS_DRAFT, due_at=timezone.now() - timedelta(hours=1))
        self.as_user(self.instructor)
        response = self.client.post(reverse("reports-manage-task-publish", args=[draft.pk]))
        self.assertEqual(response.status_code, 400)
        self.assertIn("due_at", response.data["errors"])

    def test_attachments(self):
        self.as_user(self.instructor)
        response = self.client.post(
            reverse("reports-manage-task-attachments", args=[self.task.pk]),
            {"file": rf.pdf("brief.pdf")},
            format="multipart",
        )
        self.assertEqual(response.status_code, 201, response.data)
        attachment_id = response.data["data"]["attachment"]["id"]
        self.as_user(self.student)
        detail = self.detail()
        self.assertEqual(detail["attachments"][0]["name"], "brief.pdf")
        url = reverse("reports-attachment-download", args=[attachment_id])
        download = self.client.get(url)
        self.assertEqual(download.status_code, 200)
        download.close()
        self.as_user(f.make_user())
        self.assertEqual(self.client.get(url).status_code, 404)
        self.as_user(self.instructor)
        self.assertEqual(
            self.client.delete(reverse("reports-manage-attachment-delete", args=[attachment_id])).status_code, 200
        )

    def test_courses_endpoint(self):
        f.make_section(course=self.course, title="Module 1")
        self.task.week_number = 2
        self.task.save()
        self.as_user(self.instructor)
        data = self.client.get(reverse("reports-manage-courses")).data["data"]["results"]
        self.assertEqual([item["id"] for item in data], [self.course.pk])
        self.assertEqual(data[0]["next_week_number"], 3)
        self.assertEqual(data[0]["sections"][0]["title"], "Module 1")

    def test_due_date_change_reschedules_reminder(self):
        self.as_user(self.instructor)
        new_due = timezone.now() + timedelta(days=6)
        response = self.client.patch(
            reverse("reports-manage-task-detail", args=[self.task.pk]), {"due_at": new_due.isoformat()}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(OutboxEvent.objects.filter(event_type=services.EVENT_DUE_REMINDER).count(), 1)


class AdminTests(ReportsTestCase):
    def test_admin_pages_render_and_download(self):
        submission = self.submit_pdf()
        self.grade(submission, marks="7")
        self.as_user(self.instructor)
        self.client.post(
            reverse("reports-manage-task-attachments", args=[self.task.pk]),
            {"file": rf.pdf("brief.pdf")},
            format="multipart",
        )
        admin = f.make_admin()
        self.client.force_login(admin)
        report_file = submission.current_version.files.get()
        pages = [
            ("admin:reports_reporttask_changelist", []),
            ("admin:reports_reporttask_change", [self.task.pk]),
            ("admin:reports_reporttask_add", []),
            ("admin:reports_reportsubmission_changelist", []),
            ("admin:reports_reportsubmission_change", [submission.pk]),
            ("admin:reports_reportsubmissionversion_change", [submission.current_version_id]),
            ("admin:reports_reportfile_changelist", []),
            ("admin:reports_reportfile_change", [report_file.pk]),
            ("admin:reports_reportgrade_change", [submission.grade.pk]),
            ("admin:reports_reportgradeaudit_changelist", []),
            ("admin:reports_reportattachment_changelist", []),
        ]
        for name, args in pages:
            with self.subTest(page=name):
                response = self.client.get(reverse(name, args=args))
                self.assertEqual(response.status_code, 200)
        download = self.client.get(reverse("admin:reports_reportfile_download", args=[report_file.pk]))
        self.assertEqual(download.status_code, 200)
        self.assertTrue(download["Content-Disposition"].startswith("attachment;"))
        download.close()
        student = self.student
        self.client.force_login(student)
        response = self.client.get(reverse("admin:reports_reportfile_download", args=[report_file.pk]))
        self.assertEqual(response.status_code, 302)  # admin login redirect
