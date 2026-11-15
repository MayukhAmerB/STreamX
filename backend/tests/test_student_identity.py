"""Owner rule: the student identity block (roll number, real name, handle, stats)
leads every place a submission is saved or shown, in that exact order.

Covers the shared helper (apps.users.identity), the snapshots taken at
submission time, the chunked backfill, every CSV export, the staff/grader
APIs, the student's own header (/api/me/identity/), admin lists and the
query budget (no N+1).
"""

from __future__ import annotations

import csv
import io
import shutil
import tempfile
import uuid
import zipfile
from datetime import timedelta
from decimal import Decimal

from apps.ctf import exports as ctf_exports
from apps.ctf import scheduler
from apps.ctf.models import CtfExamResult, CtfParticipation
from apps.ctf.services import start_participation, submit_attempt
from apps.profiles.models import StudentProfile
from apps.reports import exports as report_exports
from apps.reports.models import ReportGrade, ReportSubmission, ReportTask
from apps.users import identity
from apps.users.terms import TERMS_VERSION
from django.core.management import call_command
from django.db import connection, transaction
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from tests import factories as f
from tests import report_files as rf

PEPPER = "identity-test-pepper-0123456789abcdefghijklmnop"
BLOCK_KEYS = [
    "roll_number",
    "real_name",
    "handle",
    "handle_most_recent",
    "handle_changed",
    "stats",
    "snapshot",
    "user_id",
]


CONSOLE_BLOCK_KEYS = [
    "roll_number",
    "handle",
    "handle_most_recent",
    "handle_changed",
    "label",
    "stats",
    "snapshot",
    "user_id",
]
PII_KEYS = {"real_name", "full_name", "email", "phone", "phone_number"}


def pii_keys(value):
    """Every personal-data key anywhere in a JSON payload (recursive)."""
    found = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key in PII_KEYS:
                found.add(key)
            found |= pii_keys(item)
    elif isinstance(value, list):
        for item in value:
            found |= pii_keys(item)
    return found


def assert_console_header(case, header):
    case.assertEqual(header[: len(identity.CONSOLE_IDENTITY_HEADER)], identity.CONSOLE_IDENTITY_HEADER)
    case.assertNotIn("Real name", header)
    case.assertFalse([name for name in header if "mail" in name.lower()], header)


def accept_terms(*users):
    for user in users:
        user.terms_accepted_version = TERMS_VERSION
        user.save(update_fields=["terms_accepted_version"])


def give_handle(user, handle):
    profile, _created = StudentProfile.objects.update_or_create(user=user, defaults={"handle": handle})
    return profile


def csv_rows(text):
    return list(csv.reader(io.StringIO(text.lstrip("﻿"))))


def assert_identity_header(case, header):
    case.assertEqual(header[: len(identity.IDENTITY_HEADER)], identity.IDENTITY_HEADER)


class HelperTests(TestCase):
    def test_roll_number_is_canonical(self):
        self.assertEqual(identity.roll_number(42), "AL-SYD-00042")
        user = f.make_user()
        self.assertEqual(identity.roll_number(user), f"AL-SYD-{user.pk:05d}")
        self.assertEqual(identity.roll_number({"id": 7}), "AL-SYD-00007")

    def test_review_roll_number_uses_the_shared_helper(self):
        from apps.courses.experience_views import review_roll_number

        class Review:
            student_id = 314

        self.assertEqual(review_roll_number(Review()), "AL-SYD-00314")

    def test_block_keys_are_in_owner_order(self):
        user = f.make_user(full_name="Asha Rao")
        block = identity.block_for_user(user)
        self.assertEqual(list(block), BLOCK_KEYS)
        self.assertEqual(block["roll_number"], identity.roll_number(user))
        self.assertEqual(block["real_name"], "Asha Rao")
        self.assertIsNone(block["handle"])
        cells = identity.identity_cells(block)
        self.assertEqual(len(cells), len(identity.IDENTITY_HEADER))
        self.assertEqual(cells[:4], [identity.roll_number(user), "Asha Rao", "—", "—"])

    def test_snapshot_handle_and_most_recent_handle(self):
        user = f.make_user(full_name="Asha Rao")
        give_handle(user, "quiet_falcon")
        submission_like = type("Record", (), {})()
        for name, value in identity.snapshot_values(user).items():
            setattr(submission_like, name, value)
        give_handle(user, "amber_lynx")
        block = identity.block_for_user(user, record=submission_like)
        self.assertEqual(block["handle"], "quiet_falcon")
        self.assertEqual(block["handle_most_recent"], "amber_lynx")
        self.assertTrue(block["handle_changed"])
        self.assertTrue(block["snapshot"])
        self.assertEqual(identity.identity_cells(block)[2:4], ["quiet_falcon", "amber_lynx"])

    @override_settings(FEATURE_FORCE={"engagement": False})
    def test_stats_without_engagement_have_no_xp(self):
        user = f.make_user()
        stats = identity.stats_for([user.pk])[user.pk]
        self.assertIsNone(stats["xp"])
        self.assertIsNone(stats["rank"])
        self.assertEqual(stats["reports_submitted"], 0)

    def test_blocks_are_bulk_loaded(self):
        users = [f.make_user() for _ in range(3)]
        for user in users:
            give_handle(user, f"h_{user.pk}")
        with CaptureQueriesContext(connection) as small:
            identity.identity_blocks([(user, None) for user in users[:1]])
        many = users + [f.make_user() for _ in range(17)]
        with CaptureQueriesContext(connection) as large:
            identity.identity_blocks([(user, None) for user in many])
        self.assertEqual(len(small.captured_queries), len(large.captured_queries))
        self.assertLessEqual(len(large.captured_queries), 14)


class ReportsTestBase(APITestCase):
    def setUp(self):
        self.private_root = tempfile.mkdtemp(prefix="identity-reports-")
        self._override = override_settings(REPORTS_PRIVATE_ROOT=self.private_root, REPORTS_MIN_FREE_BYTES=0)
        self._override.enable()
        self.instructor = f.make_instructor()
        self.course = f.make_course(instructor=self.instructor, title="OSINT Pro")
        self.student = f.make_user(full_name="Asha Rao")
        self.other = f.make_user(full_name="Ravi Kumar")
        accept_terms(self.instructor, self.student, self.other)
        for user in (self.student, self.other):
            f.make_enrollment(user=user, course=self.course)
        give_handle(self.student, "quiet_falcon")
        self.task = ReportTask.objects.create(
            course=self.course,
            title="Target: Acme Corp",
            due_at=timezone.now() + timedelta(days=3),
            status=ReportTask.STATUS_PUBLISHED,
            max_marks=Decimal("10.00"),
            created_by=self.instructor,
        )

    def tearDown(self):
        self._override.disable()
        shutil.rmtree(self.private_root, ignore_errors=True)

    def submit_pdf(self, user):
        self.client.force_authenticate(user)
        response = self.client.post(
            reverse("reports-task-uploads", args=[self.task.pk]), {"file": rf.pdf("report.pdf")}, format="multipart"
        )
        self.assertEqual(response.status_code, 201, response.data)
        response = self.client.post(
            reverse("reports-task-submit", args=[self.task.pk]),
            {"file_ids": [response.data["data"]["id"]], "note": ""},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        self.assertEqual(response.status_code, 201, response.data)
        return ReportSubmission.objects.get(task=self.task, student=user)


class ReportIdentityTests(ReportsTestBase):
    def test_submission_snapshots_identity_once(self):
        submission = self.submit_pdf(self.student)
        self.assertEqual(submission.student_roll_number, identity.roll_number(self.student))
        self.assertEqual(submission.student_name_snapshot, "Asha Rao")
        self.assertEqual(submission.student_handle_snapshot, "quiet_falcon")
        give_handle(self.student, "amber_lynx")
        self.student.full_name = "Asha R."
        self.student.save(update_fields=["full_name"])
        submission = self.submit_pdf(self.student)  # a new version keeps the first snapshot
        self.assertEqual(submission.student_handle_snapshot, "quiet_falcon")
        self.assertEqual(submission.student_name_snapshot, "Asha Rao")

    def test_queue_detail_and_gradebook_lead_with_identity(self):
        submission = self.submit_pdf(self.student)
        give_handle(self.student, "amber_lynx")
        self.client.force_authenticate(self.instructor)
        queue = self.client.get(reverse("reports-manage-submissions")).data["data"]["results"]
        self.assertEqual(list(queue[0])[0], "identity")
        self.assertEqual(list(queue[0]["identity"]), CONSOLE_BLOCK_KEYS)
        self.assertEqual(queue[0]["identity"]["handle"], "quiet_falcon")
        self.assertEqual(queue[0]["identity"]["handle_most_recent"], "amber_lynx")
        self.assertEqual(queue[0]["identity"]["label"], "@quiet_falcon")
        detail = self.client.get(reverse("reports-manage-submission-detail", args=[submission.pk])).data["data"]
        self.assertEqual(list(detail)[0], "identity")
        self.assertEqual(detail["identity"]["roll_number"], identity.roll_number(self.student))
        self.assertEqual(detail["identity"]["stats"]["reports_submitted"], 1)
        book = self.client.get(reverse("reports-manage-gradebook"), {"course": self.course.pk}).data["data"]
        self.assertTrue(all(list(row)[0] == "identity" for row in book["rows"]))

    def test_csv_exports_lead_with_identity(self):
        submission = self.submit_pdf(self.student)
        self.client.force_authenticate(self.instructor)
        grade = self.client.post(
            reverse("reports-manage-submission-grade", args=[submission.pk]),
            {"action": "grade", "expected_revision": submission.revision, "marks": "8"},
            format="json",
        )
        self.assertEqual(grade.status_code, 200, grade.data)
        for params in ({"course": self.course.pk}, {"task": self.task.pk}):
            text = self.client.get(reverse("reports-manage-export"), params).content.decode("utf-8-sig")
            rows = csv_rows(text)
            # Owner rule (Console): handles only; no real name and no e-mail column.
            assert_console_header(self, rows[0])
            self.assertNotIn("Asha Rao", text)
            self.assertNotIn(self.student.email, text)
            mine = next(row for row in rows[1:] if row[0] == identity.roll_number(self.student))
            self.assertEqual(mine[1:3], ["quiet_falcon", "quiet_falcon"])
            self.assertEqual(mine[identity.CONSOLE_IDENTITY_HEADER.index("Reports graded average %")], "80.0")

    def test_zip_manifest_leads_with_identity(self):
        self.submit_pdf(self.student)
        archive = zipfile.ZipFile(io.BytesIO(b"".join(report_exports.iter_task_zip(self.task))))
        manifest = archive.read("manifest.csv").decode("utf-8-sig")
        rows = csv_rows(manifest)
        assert_console_header(self, rows[0])
        self.assertEqual(rows[1][0], identity.roll_number(self.student))
        self.assertNotIn("Asha Rao", manifest)
        self.assertNotIn(self.student.email, manifest)
        names = archive.namelist()
        self.assertTrue(any(name.startswith(f"@quiet_falcon ({identity.roll_number(self.student)})/") for name in names))
        self.assertFalse(any("Asha" in name for name in names))

    def test_console_grader_payloads_carry_no_personal_data(self):
        submission = self.submit_pdf(self.student)
        other = self.submit_pdf(self.other)  # no handle yet
        self.client.force_authenticate(self.instructor)
        queue = self.client.get(reverse("reports-manage-submissions")).data["data"]
        detail = self.client.get(reverse("reports-manage-submission-detail", args=[submission.pk])).data["data"]
        book = self.client.get(reverse("reports-manage-gradebook"), {"course": self.course.pk}).data["data"]
        for payload in (queue, detail, book):
            self.assertEqual(pii_keys(payload), set())
            text = str(payload)
            for secret in ("Asha Rao", "Ravi Kumar", self.student.email, self.other.email):
                self.assertNotIn(secret, text)
        labels = {item["student"]["id"]: item["student"]["label"] for item in queue["results"]}
        self.assertEqual(labels[self.student.pk], "@quiet_falcon")
        self.assertEqual(labels[self.other.pk], f"{identity.roll_number(self.other)} (no handle)")
        self.assertEqual(
            set(queue["results"][0]["student"]), {"id", "roll_number", "handle", "label"}
        )
        # Graders find students by handle or roll number, never by name or e-mail.
        url = reverse("reports-manage-submissions")
        found = self.client.get(url, {"q": "quiet_fal"}).data["data"]["results"]
        self.assertEqual([item["id"] for item in found], [submission.pk])
        found = self.client.get(url, {"q": identity.roll_number(self.other)}).data["data"]["results"]
        self.assertEqual([item["id"] for item in found], [other.pk])
        self.assertEqual(self.client.get(url, {"q": "Asha"}).data["data"]["results"], [])

    def test_grading_queue_search_by_handle_with_or_without_at_any_case(self):
        submission = self.submit_pdf(self.student)
        other = self.submit_pdf(self.other)
        give_handle(self.other, "stone_owl")
        self.client.force_authenticate(self.instructor)
        url = reverse("reports-manage-submissions")

        def ids(query):
            response = self.client.get(url, {"q": query})
            self.assertEqual(response.status_code, 200, response.data)
            return [item["id"] for item in response.data["data"]["results"]]

        for query in ("@quiet_falcon", "quiet_falcon", "@QUIET_Falcon", "Quiet_Fal", " @quiet_falcon "):
            self.assertEqual(ids(query), [submission.pk], query)
        for query in ("@stone_owl", "STONE_OWL"):
            self.assertEqual(ids(query), [other.pk], query)
        roll = identity.roll_number(self.student)
        self.assertEqual(ids(roll.lower()), [submission.pk])
        self.assertEqual(ids("@nobody_here"), [])
        # Real names and e-mails are not searchable from the Console.
        self.assertEqual(ids("asha rao"), [])
        self.assertEqual(ids(self.student.email), [])

    def test_own_header_hides_unreleased_marks(self):
        self.task.marks_visibility = ReportTask.MARKS_ON_RELEASE
        self.task.save(update_fields=["marks_visibility"])
        submission = self.submit_pdf(self.student)
        submission.status = ReportSubmission.STATUS_GRADED
        submission.save(update_fields=["status"])
        ReportGrade.objects.create(submission=submission, raw_marks=Decimal("5"), final_marks=Decimal("5"))
        self.client.force_authenticate(self.student)
        data = self.client.get(reverse("me-identity")).data["data"]
        self.assertEqual(list(data), BLOCK_KEYS)
        self.assertEqual(data["roll_number"], identity.roll_number(self.student))
        self.assertEqual(data["handle"], "quiet_falcon")
        self.assertIsNone(data["stats"]["reports_graded_average"])
        staff_view = identity.block_for_user(self.student)
        self.assertEqual(staff_view["stats"]["reports_graded_average"], 50.0)

    def test_me_identity_requires_login(self):
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(reverse("me-identity")).status_code, (401, 403))


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class CtfIdentityTests(APITestCase):
    def setUp(self):
        self.staff = f.make_admin()
        self.student = f.make_user(full_name="Zara Khan")
        accept_terms(self.staff, self.student)
        self.course = f.make_course(title="Batch Nine")
        f.make_enrollment(user=self.student, course=self.course)
        give_handle(self.student, "lunar_heron")
        self.exam = f.make_ctf_exam(eligible_courses=[self.course])
        self.question = f.make_ctf_question(exam=self.exam, answers=("right",))

    def play(self):
        participation, _created = start_participation(exam=self.exam, user=self.student)
        submit_attempt(exam=self.exam, user=self.student, question_key=self.question.key, answer="right")
        return CtfParticipation.objects.get(pk=participation.pk)

    def test_participation_and_result_snapshot(self):
        participation = self.play()
        self.assertEqual(participation.student_roll_number, identity.roll_number(self.student))
        self.assertEqual(participation.student_name_snapshot, "Zara Khan")
        self.assertEqual(participation.student_handle_snapshot, "lunar_heron")
        CtfParticipation.objects.filter(pk=participation.pk).update(status=CtfParticipation.STATUS_SUBMITTED)
        self.exam.closes_at = timezone.now() - timedelta(minutes=1)
        self.exam.status = self.exam.STATUS_CLOSED
        self.exam.save(update_fields=["closes_at", "status"])
        scheduler.finalize_exam_results(self.exam, timezone.now())
        result = CtfExamResult.objects.get(exam=self.exam, user=self.student)
        self.assertEqual(result.student_roll_number, identity.roll_number(self.student))
        self.assertEqual(result.student_handle_snapshot, "lunar_heron")

    def test_ctf_csvs_lead_with_identity(self):
        self.play()
        give_handle(self.student, "tidal_wren")
        text = "".join(ctf_exports.iter_participations_csv(CtfParticipation.objects.filter(exam=self.exam)))
        rows = csv_rows(text)
        assert_identity_header(self, rows[0])
        self.assertEqual(rows[1][:4], [identity.roll_number(self.student), "Zara Khan", "lunar_heron", "tidal_wren"])
        self.assertNotIn("Student name", rows[0])
        text = "".join(ctf_exports.iter_attempts_csv(self.exam.attempts.all()))
        rows = csv_rows(text)
        assert_identity_header(self, rows[0])
        self.assertEqual(rows[1][2], "lunar_heron")

    def test_console_results_and_gradebook_lead_with_identity(self):
        self.play()
        self.client.force_authenticate(self.staff)
        data = self.client.get(reverse("ctf-admin-exam-results", args=[self.exam.slug])).data["data"]
        row = data["participants"][0]
        self.assertEqual(list(row)[0], "identity")
        self.assertEqual(row["identity"]["handle"], "lunar_heron")
        self.assertEqual(list(row["identity"]), CONSOLE_BLOCK_KEYS)
        book = self.client.get(reverse("gradebook-course", args=[self.course.pk])).data["data"]
        self.assertTrue(book["rows"])
        self.assertEqual(list(book["rows"][0])[0], "identity")
        response = self.client.get(reverse("gradebook-course-csv", args=[self.course.pk]))
        rows = csv_rows(
            b"".join(response.streaming_content).decode("utf-8")
            if response.streaming
            else response.content.decode("utf-8")
        )
        assert_console_header(self, rows[0])
        student = self.client.get(reverse("gradebook-student", args=[self.student.pk])).data["data"]
        self.assertEqual(list(student)[0], "identity")
        self.client.force_authenticate(self.student)
        mine = self.client.get(reverse("gradebook-me")).data["data"]
        self.assertEqual(list(mine)[0], "identity")
        self.assertEqual(mine["identity"]["roll_number"], identity.roll_number(self.student))

    def test_console_exam_payloads_and_csvs_carry_no_personal_data(self):
        self.play()
        nameless = f.make_user(full_name="Omar Farooq")
        accept_terms(nameless)
        f.make_enrollment(user=nameless, course=self.course)
        start_participation(exam=self.exam, user=nameless)
        self.client.force_authenticate(self.staff)
        secrets = ("Zara Khan", "Omar Farooq", self.student.email, nameless.email)
        payloads = [
            self.client.get(reverse("ctf-admin-exam-results", args=[self.exam.slug])).data["data"],
            self.client.get(reverse("gradebook-course", args=[self.course.pk])).data["data"],
            self.client.get(reverse("gradebook-student", args=[self.student.pk])).data["data"],
        ]
        for payload in payloads:
            self.assertEqual(pii_keys(payload), set())
            for secret in secrets:
                self.assertNotIn(secret, str(payload))
        labels = {row["student"]["id"]: row["student"]["label"] for row in payloads[0]["participants"]}
        self.assertEqual(labels[self.student.pk], "@lunar_heron")
        self.assertEqual(labels[nameless.pk], f"{identity.roll_number(nameless)} (no handle)")
        for name in ("ctf-admin-exam-results-csv", "gradebook-course-csv"):
            args = [self.exam.slug] if name.startswith("ctf") else [self.course.pk]
            response = self.client.get(reverse(name, args=args))
            self.assertEqual(response.status_code, 200)
            text = b"".join(response.streaming_content).decode("utf-8")
            rows = csv_rows(text)
            assert_console_header(self, rows[0])
            for secret in secrets:
                self.assertNotIn(secret, text)
            by_roll = {row[0]: row for row in rows[1:]}
            self.assertEqual(by_roll[identity.roll_number(self.student)][1], "lunar_heron")
            self.assertEqual(
                by_roll[identity.roll_number(nameless)][1], f"{identity.roll_number(nameless)} (no handle)"
            )
        # The student's own gradebook adds only their own real name (no e-mail, nobody else's name).
        self.client.force_authenticate(self.student)
        mine = self.client.get(reverse("gradebook-me")).data["data"]
        self.assertEqual(pii_keys(mine), {"real_name"})
        self.assertNotIn(self.student.email, str(mine))
        self.assertNotIn("Omar Farooq", str(mine))

    def test_my_gradebook_shows_own_real_name_and_handle(self):
        self.play()
        other = f.make_user(full_name="Omar Farooq")
        accept_terms(other)
        f.make_enrollment(user=other, course=self.course)
        give_handle(other, "stone_owl")
        self.client.force_authenticate(self.student)
        mine = self.client.get(reverse("gradebook-me")).data["data"]
        self.assertEqual(list(mine["identity"]), ["roll_number", "real_name", *CONSOLE_BLOCK_KEYS[1:]])
        self.assertEqual(mine["identity"]["real_name"], "Zara Khan")
        self.assertEqual(mine["identity"]["handle_most_recent"], "lunar_heron")
        self.assertEqual(mine["identity"]["roll_number"], identity.roll_number(self.student))
        # Only the identity block names the owner; the student reference stays handle-only.
        self.assertEqual(set(mine["student"]), {"id", "roll_number", "handle", "label"})
        self.assertEqual(pii_keys(mine), {"real_name"})
        # Another student's /me is about themselves only.
        self.client.force_authenticate(other)
        theirs = self.client.get(reverse("gradebook-me")).data["data"]
        self.assertEqual(theirs["identity"]["real_name"], "Omar Farooq")
        self.assertNotIn("Zara Khan", str(theirs))
        # Staff and instructor gradebook payloads never carry a real name, full name or e-mail.
        self.client.force_authenticate(self.staff)
        for payload in (
            self.client.get(reverse("gradebook-course", args=[self.course.pk])).data["data"],
            self.client.get(reverse("gradebook-student", args=[self.student.pk])).data["data"],
        ):
            self.assertEqual(pii_keys(payload), set())
            for secret in ("Zara Khan", "Omar Farooq", self.student.email, other.email):
                self.assertNotIn(secret, str(payload))

    def test_admin_results_csv_keeps_the_full_identity(self):
        self.play()
        self.client.force_login(self.staff)
        response = self.client.get(reverse("admin:ctf_ctfexam_scores_csv", args=[self.exam.pk]))
        self.assertEqual(response.status_code, 200)
        rows = csv_rows(b"".join(response.streaming_content).decode("utf-8"))
        self.assertEqual(rows[0], ctf_exports.PARTICIPATION_HEADER)
        assert_identity_header(self, rows[0])
        self.assertIn("Student email", rows[0])
        self.assertEqual(rows[1][:3], [identity.roll_number(self.student), "Zara Khan", "lunar_heron"])
        self.assertIn(self.student.email, rows[1])

    def test_admin_lists_show_identity_and_find_roll_numbers(self):
        self.play()
        self.client.force_login(self.staff)
        url = reverse("admin:ctf_ctfparticipation_changelist")
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        self.assertIn(identity.roll_number(self.student), body)
        self.assertLess(body.index("Roll number"), body.index("Real name"))
        self.assertLess(body.index("Real name"), body.index("Handle"))
        found = self.client.get(url, {"q": identity.roll_number(self.student)})
        self.assertContains(found, "Zara Khan")
        none = self.client.get(url, {"q": "AL-SYD-99999"})
        self.assertNotContains(none, "Zara Khan")
        for name in ("admin:ctf_ctfattempt_changelist", "admin:ctf_ctfexamresult_changelist"):
            self.assertEqual(self.client.get(reverse(name)).status_code, 200)


class BackfillTests(TestCase):
    @override_settings(CTF_ANSWER_PEPPER=PEPPER)
    def test_backfill_is_dry_by_default_and_idempotent(self):
        student = f.make_user(full_name="Old Record")
        give_handle(student, "old_record")
        course = f.make_course()
        exam = f.make_ctf_exam(eligible_courses=[course])
        participation = CtfParticipation.objects.create(exam=exam, user=student)
        self.assertIsNone(participation.student_roll_number)
        out = io.StringIO()
        call_command("backfill_identity_snapshots", stdout=out)
        self.assertIn("Dry run", out.getvalue())
        participation.refresh_from_db()
        self.assertIsNone(participation.student_roll_number)
        call_command("backfill_identity_snapshots", "--apply", "--chunk-size", "1", stdout=io.StringIO())
        participation.refresh_from_db()
        self.assertEqual(participation.student_roll_number, identity.roll_number(student))
        self.assertEqual(participation.student_name_snapshot, "Old Record")
        self.assertEqual(participation.student_handle_snapshot, "old_record")
        give_handle(student, "new_record")
        call_command("backfill_identity_snapshots", "--apply", stdout=io.StringIO())
        participation.refresh_from_db()
        self.assertEqual(participation.student_handle_snapshot, "old_record")  # never overwritten


@override_settings(CTF_ANSWER_PEPPER=PEPPER, CTF_LABS_ORIGINS=["https://labs.alsyedinitiative.com"])
class ExamCandidateIdentityTests(APITestCase):
    LABS = "https://labs.alsyedinitiative.com"

    def setUp(self):
        self.student = f.make_user(full_name="Noor Ali")
        accept_terms(self.student)
        self.course = f.make_course()
        f.make_enrollment(user=self.student, course=self.course)
        give_handle(self.student, "silver_owl")
        self.exam = f.make_ctf_exam(eligible_courses=[self.course])
        f.make_ctf_question(exam=self.exam, answers=("right",))
        self.url = reverse("ctf-exam-identity", args=[self.exam.slug])

    def test_candidate_block_before_and_after_start_with_labs_cors(self):
        self.client.force_authenticate(self.student)
        response = self.client.get(self.url, HTTP_ORIGIN=self.LABS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Access-Control-Allow-Origin"], self.LABS)
        data = response.json()["data"]
        self.assertEqual(list(data), BLOCK_KEYS)
        self.assertFalse(data["snapshot"])
        self.assertEqual(data["handle"], "silver_owl")
        start_participation(exam=self.exam, user=self.student)
        give_handle(self.student, "ivory_wren")
        data = self.client.get(self.url).json()["data"]
        self.assertTrue(data["snapshot"])
        self.assertEqual(data["roll_number"], identity.roll_number(self.student))
        self.assertEqual(data["real_name"], "Noor Ali")
        self.assertEqual(data["handle"], "silver_owl")
        self.assertEqual(data["handle_most_recent"], "ivory_wren")
        self.assertTrue(data["handle_changed"])

    def test_anonymous_is_refused(self):
        self.assertIn(self.client.get(self.url).status_code, (401, 403))


class SeasonEntrySnapshotTests(TestCase):
    def test_monthly_ctf_entry_snapshots_identity(self):
        from apps.ctf.season_models import CtfSeasonEntry
        from apps.ctf.season_services import _entry_for_update

        student = f.make_user(full_name="Season Player")
        give_handle(student, "season_player")
        season = self._season()
        with transaction.atomic():
            entry = _entry_for_update(season, student, timezone.now())
        entry = CtfSeasonEntry.objects.get(pk=entry.pk)
        self.assertEqual(entry.student_roll_number, identity.roll_number(student))
        self.assertEqual(entry.student_name_snapshot, "Season Player")
        self.assertEqual(entry.student_handle_snapshot, "season_player")

    def _season(self):
        from apps.ctf.season_models import CtfSeason

        fields = {field.name for field in CtfSeason._meta.get_fields()}
        now = timezone.now()
        data = {
            "slug": "2026-11",
            "month": now.date(),
            "title": "November case",
            "brief": "A case file.",
            "question": "Which city?",
            "opens_at": now - timedelta(days=1),
            "closes_at": now + timedelta(days=1),
        }
        return CtfSeason.objects.create(**{key: value for key, value in data.items() if key in fields})
