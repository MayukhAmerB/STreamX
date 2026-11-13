"""CTF admin: scores and every answer are visible to staff, read-only, exportable
(formula-safe CSV), and answer hashes / normalisation never appear."""

from apps.ctf import services
from apps.ctf.models import CtfAttempt, CtfExam, CtfParticipation
from django.contrib.auth.models import Permission
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.urls import reverse

from tests import factories as f

PEPPER = "admin-test-pepper-0123456789abcdefghijklmnopq"
FORMULA = '=HYPERLINK("https://evil.example","click")'


def body(response):
    if hasattr(response, "streaming_content"):
        return b"".join(response.streaming_content).decode("utf-8")
    return response.content.decode("utf-8")


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class CtfAdminTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = f.make_admin()
        self.client.force_login(self.admin)
        self.course = f.make_course(title="OSINT Batch 9", batch="Batch 9")
        self.exam = f.make_ctf_exam(eligible_courses=[self.course], slug="admin-exam")
        self.question = f.make_ctf_question(exam=self.exam, key="q1", order=1, answers=["Right Answer"], points=150)
        self.students = []
        for name, answer in (("Asha Rao", "right answer"), ("Ravi Kumar", FORMULA)):
            student = f.make_user(full_name=name)
            f.make_enrollment(user=student, course=self.course)
            services.start_participation(exam=self.exam, user=student)
            services.submit_attempt(exam=self.exam, user=student, question_key="q1", answer=answer, client_ip="198.51.100.4")
            self.students.append(student)

    def assertNoSecrets(self, html):
        self.assertNotIn("answer_hashes", html)
        self.assertNotIn("normalization", html)
        for digest in self.question.answer_hashes:
            self.assertNotIn(digest, html)

    def test_changelists_and_filters_load(self):
        participation = CtfParticipation.objects.first()
        attempt = CtfAttempt.objects.first()
        urls = [
            reverse("admin:ctf_ctfexam_changelist"),
            reverse("admin:ctf_ctfexam_change", args=[self.exam.pk]),
            reverse("admin:ctf_ctfparticipation_changelist"),
            reverse("admin:ctf_ctfparticipation_changelist") + f"?exam__id__exact={self.exam.pk}&status__exact=active",
            reverse("admin:ctf_ctfparticipation_changelist") + f"?batch_course__id__exact={self.course.pk}&q=asha",
            reverse("admin:ctf_ctfparticipation_change", args=[participation.pk]),
            reverse("admin:ctf_ctfattempt_changelist"),
            reverse("admin:ctf_ctfattempt_changelist")
            + f"?exam__id__exact={self.exam.pk}&question={self.question.pk}&is_correct__exact=1",
            reverse("admin:ctf_ctfattempt_changelist")
            + f"?participation__batch_course__id__exact={self.course.pk}&question__category__exact=geoint",
            reverse("admin:ctf_ctfattempt_changelist") + "?q=Ravi",
            reverse("admin:ctf_ctfattempt_change", args=[attempt.pk]),
        ]
        for url in urls:
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200, url)
                self.assertNoSecrets(response.content.decode())

    def test_scores_are_in_leaderboard_order(self):
        response = self.client.get(reverse("admin:ctf_ctfparticipation_changelist"))
        html = response.content.decode()
        self.assertLess(html.index(self.students[0].email), html.index(self.students[1].email))
        self.assertIn("150", html)

    def test_attempts_cannot_be_added_changed_or_deleted(self):
        attempt = CtfAttempt.objects.first()
        self.assertEqual(self.client.get(reverse("admin:ctf_ctfattempt_add")).status_code, 403)
        change = reverse("admin:ctf_ctfattempt_change", args=[attempt.pk])
        self.client.post(change, {"submitted_answer": "tampered"})
        self.assertEqual(CtfAttempt.objects.get(pk=attempt.pk).submitted_answer, attempt.submitted_answer)
        self.assertEqual(self.client.get(reverse("admin:ctf_ctfattempt_delete", args=[attempt.pk])).status_code, 403)
        self.assertEqual(self.client.get(reverse("admin:ctf_ctfparticipation_add")).status_code, 403)
        self.assertEqual(self.client.get(reverse("admin:ctf_ctfexam_add")).status_code, 403)
        response = self.client.post(
            reverse("admin:ctf_ctfattempt_changelist"),
            {"action": "delete_selected", "_selected_action": [attempt.pk]},
        )
        self.assertIn(response.status_code, (200, 302))
        self.assertEqual(CtfAttempt.objects.count(), 2)

    def test_attempt_csv_escapes_formulas(self):
        response = self.client.post(
            reverse("admin:ctf_ctfattempt_changelist"),
            {"action": "export_attempts_csv", "_selected_action": list(CtfAttempt.objects.values_list("pk", flat=True))},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/csv; charset=utf-8")
        content = body(response)
        self.assertIn("Submitted answer", content)
        self.assertIn("'=HYPERLINK", content)
        self.assertNotIn(',=HYPERLINK', content)
        self.assertIn("right answer", content)
        self.assertNoSecrets(content)

    def test_whole_exam_exports_stream(self):
        attempts = self.client.get(reverse("admin:ctf_ctfexam_attempts_csv", args=[self.exam.pk]))
        self.assertEqual(attempts.status_code, 200)
        self.assertTrue(attempts.streaming)
        self.assertEqual(body(attempts).count("admin-exam"), 2)
        scores = self.client.get(reverse("admin:ctf_ctfexam_scores_csv", args=[self.exam.pk]))
        content = body(scores)
        self.assertIn("Position", content)
        self.assertIn("Batch 9", content)
        self.assertLess(content.index(self.students[0].email), content.index(self.students[1].email))

    def test_scores_export_action(self):
        response = self.client.post(
            reverse("admin:ctf_ctfparticipation_changelist"),
            {
                "action": "export_scores_csv",
                "_selected_action": list(CtfParticipation.objects.values_list("pk", flat=True)),
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("Asha Rao", body(response))

    def test_staff_without_attempt_permission_cannot_export_answers(self):
        staff = f.make_user(is_staff=True)
        staff.user_permissions.add(Permission.objects.get(codename="view_ctfexam"))
        self.client.force_login(staff)
        self.assertEqual(self.client.get(reverse("admin:ctf_ctfexam_attempts_csv", args=[self.exam.pk])).status_code, 404)
        self.assertEqual(self.client.get(reverse("admin:ctf_ctfattempt_changelist")).status_code, 403)

    def test_publish_and_close_actions(self):
        draft = f.make_ctf_exam(status=CtfExam.STATUS_DRAFT, slug="draft-exam")
        url = reverse("admin:ctf_ctfexam_changelist")
        self.client.post(url, {"action": "publish_selected", "_selected_action": [draft.pk]})
        draft.refresh_from_db()
        self.assertEqual(draft.status, CtfExam.STATUS_DRAFT)  # no questions yet: refused
        f.make_ctf_question(exam=draft)
        CtfExam.objects.filter(pk=draft.pk).update(answer_key_id="ffffffffffffffff")
        self.client.post(url, {"action": "publish_selected", "_selected_action": [draft.pk]})
        draft.refresh_from_db()
        self.assertEqual(draft.status, CtfExam.STATUS_DRAFT)  # stale answer key: refused
        from apps.ctf.answers import answer_key_id

        CtfExam.objects.filter(pk=draft.pk).update(answer_key_id=answer_key_id())
        self.client.post(url, {"action": "publish_selected", "_selected_action": [draft.pk]})
        draft.refresh_from_db()
        self.assertEqual(draft.status, CtfExam.STATUS_PUBLISHED)
        self.client.post(url, {"action": "close_selected", "_selected_action": [draft.pk]})
        draft.refresh_from_db()
        self.assertEqual(draft.status, CtfExam.STATUS_CLOSED)

    def test_exam_schedule_is_editable_but_content_is_not(self):
        url = reverse("admin:ctf_ctfexam_change", args=[self.exam.pk])
        response = self.client.get(url)
        html = response.content.decode()
        self.assertIn('name="status"', html)
        self.assertIn('name="time_limit_minutes"', html)
        self.assertNotIn('name="title"', html)
        self.assertNotIn('name="slug"', html)

    def test_staff_preview_runs_can_be_reset(self):
        services.start_participation(exam=self.exam, user=self.admin)
        services.submit_attempt(exam=self.exam, user=self.admin, question_key="q1", answer="nope")
        self.client.post(
            reverse("admin:ctf_ctfparticipation_changelist"),
            {
                "action": "delete_staff_previews",
                "_selected_action": list(CtfParticipation.objects.values_list("pk", flat=True)),
            },
        )
        self.assertFalse(CtfParticipation.objects.filter(is_staff_preview=True).exists())
        self.assertEqual(CtfParticipation.objects.count(), 2)
        self.assertEqual(CtfAttempt.objects.count(), 2)
