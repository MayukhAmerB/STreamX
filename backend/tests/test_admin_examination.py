"""Django admin -> Examination: every exam record the Console staff views show,
with the FULL student identity (roll number, real name, handle, stats).

The Console shows handles only (``test_student_identity``); this section is
where staff see real names. Staff only; the full-identity CSVs need the view
permission (or a superuser).
"""

from __future__ import annotations

import csv
import io
from datetime import timedelta

from apps.certification.models import CertificationDecision
from apps.ctf import exports as ctf_exports
from apps.ctf import scheduler
from apps.ctf.models import CtfExamResult, CtfParticipation
from apps.ctf.services import start_participation, submit_attempt
from apps.profiles.models import StudentProfile
from apps.users import identity
from apps.users.terms import TERMS_VERSION
from django.contrib.auth.models import Permission
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from tests import factories as f

PEPPER = "examination-admin-pepper-0123456789abcdefghijk"


def csv_rows(response):
    content = b"".join(response.streaming_content) if response.streaming else response.content
    return list(csv.reader(io.StringIO(content.decode("utf-8").lstrip("﻿"))))


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class ExaminationAdminTests(TestCase):
    def setUp(self):
        self.admin = f.make_admin()
        self.course = f.make_course(title="Batch Seven")
        self.student = f.make_user(full_name="Hina Siddiqui", email="hina@example.test")
        self.nameless = f.make_user(full_name="Bilal Ahmed", email="bilal@example.test")
        for user in (self.admin, self.student, self.nameless):
            user.terms_accepted_version = TERMS_VERSION
            user.save(update_fields=["terms_accepted_version"])
        for user in (self.student, self.nameless):
            f.make_enrollment(user=user, course=self.course)
        StudentProfile.objects.update_or_create(user=self.student, defaults={"handle": "silver_kite"})
        self.exam = f.make_ctf_exam(eligible_courses=[self.course], title="Final CTF")
        self.question = f.make_ctf_question(exam=self.exam, answers=("right",), points=50)
        start_participation(exam=self.exam, user=self.student)
        submit_attempt(exam=self.exam, user=self.student, question_key=self.question.key, answer="right")
        start_participation(exam=self.exam, user=self.nameless)
        submit_attempt(exam=self.exam, user=self.nameless, question_key=self.question.key, answer="wrong")
        self.client.force_login(self.admin)

    def finalize(self):
        CtfParticipation.objects.filter(exam=self.exam).update(status=CtfParticipation.STATUS_SUBMITTED)
        self.exam.closes_at = timezone.now() - timedelta(minutes=1)
        self.exam.status = self.exam.STATUS_CLOSED
        self.exam.save(update_fields=["closes_at", "status"])
        scheduler.finalize_exam_results(self.exam, timezone.now())

    # --- every screen loads and shows the real name ---------------------------------------
    def test_every_examination_screen_loads_with_the_full_identity(self):
        self.finalize()
        CertificationDecision.objects.create(
            exam=self.exam,
            user=self.student,
            outcome=CertificationDecision.OUTCOME_PASSED,
            score=50,
            total_points=50,
            percent=100,
            pass_mark_percent=50,
        )
        exam_filter = f"?exam__id__exact={self.exam.pk}"
        for name in (
            "admin:ctf_ctfparticipation_changelist",
            "admin:ctf_ctfattempt_changelist",
            "admin:ctf_ctfexamresult_changelist",
            "admin:certification_certificationdecision_changelist",
        ):
            with self.subTest(name=name):
                response = self.client.get(reverse(name) + exam_filter)
                self.assertEqual(response.status_code, 200)
                body = response.content.decode()
                self.assertIn(identity.roll_number(self.student), body)
                self.assertIn("Hina Siddiqui", body)
                self.assertIn("@silver_kite", body)
                self.assertLess(body.index("Roll number"), body.index("Real name"))
        for name in (
            "admin:ctf_ctfexam_changelist",
            "admin:ctf_ctfquestion_changelist",
            "admin:ctf_examgradebook_changelist",
            "admin:certification_examcertificationpolicy_changelist",
        ):
            with self.subTest(name=name):
                self.assertEqual(self.client.get(reverse(name)).status_code, 200)
        detail = self.client.get(reverse("admin:ctf_ctfexam_change", args=[self.exam.pk]))
        self.assertContains(detail, "Batch Seven")
        self.assertContains(detail, "Results CSV")

    def test_results_show_rank_times_and_batch(self):
        response = self.client.get(reverse("admin:ctf_ctfparticipation_changelist"))
        self.assertEqual(response.status_code, 200)
        rows = {row.user_id: row for row in response.context["cl"].result_list}
        self.assertEqual(rows[self.student.pk]._rank, 1)
        self.assertEqual(rows[self.nameless.pk]._rank, 2)
        for column in ("Rank", "Deadline at", "Submitted at", "Is staff preview", "Batch course"):
            self.assertContains(response, column)

    def test_results_and_attempts_are_searchable_by_roll_name_handle_and_email(self):
        for name in ("admin:ctf_ctfparticipation_changelist", "admin:ctf_ctfattempt_changelist"):
            url = reverse(name)
            for term in (identity.roll_number(self.student), "Hina", "silver_kite", "hina@example.test"):
                with self.subTest(name=name, term=term):
                    found = self.client.get(url, {"q": term})
                    self.assertEqual({row.user_id for row in found.context["cl"].result_list}, {self.student.pk})

    def test_attempts_filter_by_exam_batch_and_status(self):
        url = reverse("admin:ctf_ctfattempt_changelist")
        params = {
            "exam__id__exact": self.exam.pk,
            "participation__batch_course__id__exact": self.course.pk,
            "participation__status__exact": CtfParticipation.STATUS_ACTIVE,
        }
        response = self.client.get(url, params)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.context["cl"].result_list), 2)

    def test_questions_are_read_only_and_never_show_answers(self):
        response = self.client.get(reverse("admin:ctf_ctfquestion_change", args=[self.question.pk]))
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        self.assertIn("Answers are stored only as peppered hashes", body)
        for secret in self.question.answer_hashes:
            self.assertNotIn(secret, body)
        self.assertNotIn(">right<", body)
        self.assertEqual(self.client.get(reverse("admin:ctf_ctfquestion_add")).status_code, 403)

    # --- gradebook ----------------------------------------------------------------------------
    def test_gradebook_shows_reports_and_exams_with_real_names(self):
        self.finalize()
        response = self.client.get(reverse("admin:ctf_examgradebook_change", args=[self.course.pk]))
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        for value in (
            identity.roll_number(self.student),
            "Hina Siddiqui",
            "@silver_kite",
            "hina@example.test",
            "Bilal Ahmed",
            "Exam: Final CTF",
            "50 / 50 (#1)",
        ):
            self.assertIn(value, body)

    def test_gradebook_csv_columns_have_the_full_identity(self):
        self.finalize()
        response = self.client.get(reverse("admin:ctf_examgradebook_csv", args=[self.course.pk]))
        self.assertEqual(response.status_code, 200)
        rows = csv_rows(response)
        self.assertEqual(
            rows[0],
            [
                *identity.IDENTITY_HEADER,
                "Student email",
                "Exam: Final CTF /50",
                "Reports %",
                "Exams %",
                "Overall %",
                "Missing",
                "Late",
            ],
        )
        mine = next(row for row in rows[1:] if row[0] == identity.roll_number(self.student))
        self.assertEqual(mine[1:3], ["Hina Siddiqui", "silver_kite"])
        self.assertIn("hina@example.test", mine)

    def test_results_csv_columns(self):
        response = self.client.get(reverse("admin:ctf_ctfexam_scores_csv", args=[self.exam.pk]))
        self.assertEqual(response.status_code, 200)
        rows = csv_rows(response)
        self.assertEqual(rows[0], ctf_exports.PARTICIPATION_HEADER)
        self.assertEqual(rows[0][:3], ["Roll number", "Real name", "Handle"])
        for column in ("Student email", "Batch course", "Score", "Solved", "Wrong answers", "Deadline", "Staff preview"):
            self.assertIn(column, rows[0])
        self.assertEqual(rows[1][:3], [identity.roll_number(self.student), "Hina Siddiqui", "silver_kite"])

    def test_console_results_csv_columns_are_handle_only(self):
        self.assertEqual(
            ctf_exports.CONSOLE_PARTICIPATION_HEADER[: len(identity.CONSOLE_IDENTITY_HEADER)],
            identity.CONSOLE_IDENTITY_HEADER,
        )
        self.assertNotIn("Real name", ctf_exports.CONSOLE_PARTICIPATION_HEADER)
        self.assertNotIn("Student email", ctf_exports.CONSOLE_PARTICIPATION_HEADER)
        self.assertEqual(
            ctf_exports.CONSOLE_PARTICIPATION_HEADER[len(identity.CONSOLE_IDENTITY_HEADER) :],
            [name for name in ctf_exports.PARTICIPATION_HEADER[len(identity.IDENTITY_HEADER) :] if name != "Student email"],
        )

    # --- staff only -----------------------------------------------------------------------------
    def test_examination_is_staff_only(self):
        urls = [
            reverse("admin:ctf_ctfparticipation_changelist"),
            reverse("admin:ctf_examgradebook_changelist"),
            reverse("admin:ctf_examgradebook_change", args=[self.course.pk]),
            reverse("admin:ctf_examgradebook_csv", args=[self.course.pk]),
            reverse("admin:ctf_ctfexam_scores_csv", args=[self.exam.pk]),
            reverse("admin:ctf_ctfquestion_changelist"),
        ]
        self.client.force_login(self.student)  # a student: sent to the admin login
        for url in urls:
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 302)
                self.assertIn(reverse("admin:login"), response["Location"])
        self.client.logout()
        for url in urls:
            with self.subTest(url=url, anonymous=True):
                self.assertEqual(self.client.get(url).status_code, 302)

    def test_staff_without_permission_cannot_open_the_full_identity(self):
        staff = f.make_user(is_staff=True)
        staff.terms_accepted_version = TERMS_VERSION
        staff.save(update_fields=["terms_accepted_version"])
        self.client.force_login(staff)
        self.assertEqual(self.client.get(reverse("admin:ctf_examgradebook_changelist")).status_code, 403)
        self.assertEqual(self.client.get(reverse("admin:ctf_examgradebook_change", args=[self.course.pk])).status_code, 404)
        self.assertEqual(self.client.get(reverse("admin:ctf_examgradebook_csv", args=[self.course.pk])).status_code, 404)
        self.assertEqual(self.client.get(reverse("admin:ctf_ctfexam_scores_csv", args=[self.exam.pk])).status_code, 404)
        staff.user_permissions.add(Permission.objects.get(codename="view_examgradebook"))
        staff = type(staff).objects.get(pk=staff.pk)
        self.client.force_login(staff)
        response = self.client.get(reverse("admin:ctf_examgradebook_change", args=[self.course.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Hina Siddiqui")
        self.assertEqual(CtfExamResult.objects.count(), 0)  # nothing written by reading
