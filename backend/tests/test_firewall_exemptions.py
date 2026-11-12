"""The input firewall lets SQL/HTML-looking text through ONLY in the free-text
fields listed in config.security.FIREWALL_EXEMPTIONS (report task text, grading
feedback, submission notes, lecture comments). Everything else stays blocked."""

import uuid
from datetime import timedelta

from apps.courses.engagement.models import LectureComment
from apps.reports.models import ReportCriterion, ReportGrade, ReportSubmissionVersion, ReportTask
from config.security import FIREWALL_EXEMPTIONS
from django.urls import reverse
from django.utils import timezone

from tests import factories as f
from tests.test_reports_api import ReportsTestCase

SQL_PROSE = "Select the sources from the leak where the target's email appears, then UNION them with the WHOIS data."
UNION = "UNION SELECT username, password FROM users"
SCRIPT = "<script>alert(1)</script>"
TAUTOLOGY = "' OR 1=1 --"
OSINT_BRIEF = "\n".join(
    [
        "# Week 3: data breach correlation",
        SQL_PROSE,
        f"Document payloads you meet literally, e.g. `{UNION}`, `{SCRIPT}` and `{TAUTOLOGY}`.",
        f"Unquoted too: {SCRIPT} and {TAUTOLOGY}",
        "DROP TABLE is an attack, not an instruction.",
    ]
)
BLOCKED = "Suspicious input detected."


def blocked(response):
    return response.status_code == 400 and response.json().get("errors", {}).get("detail") == BLOCKED


class ExemptFieldsTests(ReportsTestCase):
    def task_payload(self, **overrides):
        payload = {
            "course": self.course.pk,
            "title": f"Target {TAUTOLOGY}",
            "brief": OSINT_BRIEF,
            "due_at": (timezone.now() + timedelta(days=5)).isoformat(),
            "max_marks": "10",
            "criteria": [
                {"name": "Sources", "description": f"{SQL_PROSE} {SCRIPT}", "max_marks": "6"},
                {"name": f"Query {UNION}"[:120], "description": TAUTOLOGY, "max_marks": "4"},
            ],
        }
        payload.update(overrides)
        return payload

    def test_osint_brief_and_rubric_save_verbatim(self):
        self.as_user(self.instructor)
        response = self.client.post(reverse("reports-manage-tasks"), self.task_payload(), format="json")
        self.assertEqual(response.status_code, 201, response.content)
        task = ReportTask.objects.get(pk=response.data["data"]["id"])
        self.assertEqual(task.brief, OSINT_BRIEF)  # stored as text, not escaped or stripped
        self.assertEqual(task.title, f"Target {TAUTOLOGY}")
        self.assertEqual(
            list(ReportCriterion.objects.filter(task=task).values_list("description", flat=True)),
            [f"{SQL_PROSE} {SCRIPT}", TAUTOLOGY],
        )
        # Students receive it as a JSON string; the client renders it as text
        # through the safe Markdown renderer (see markdown.test.jsx).
        task.status = ReportTask.STATUS_PUBLISHED
        task.save()
        detail = self.detail(task=task)
        self.assertEqual(detail["brief"], OSINT_BRIEF)

        self.as_user(self.instructor)
        edited = self.client.patch(
            reverse("reports-manage-task-detail", args=[task.pk]),
            {"brief": OSINT_BRIEF + "\n" + UNION},
            format="json",
        )
        self.assertEqual(edited.status_code, 200, edited.content)
        task.refresh_from_db()
        self.assertTrue(task.brief.endswith(UNION))

    def test_grading_feedback_and_submission_note(self):
        self.as_user(self.student)
        file_id = self.upload().data["data"]["id"]
        response = self.client.post(
            reverse("reports-task-submit", args=[self.task.pk]),
            {"file_ids": [file_id], "note": f"Found it via {UNION}; {TAUTOLOGY} {SCRIPT}"},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertIn(SCRIPT, ReportSubmissionVersion.objects.get().note)
        submission = self.task.submissions.get()
        feedback = f"Your query `{UNION}` was right; {SQL_PROSE} {SCRIPT}"
        graded = self.grade(submission, action="draft", feedback=feedback)
        self.assertEqual(graded.status_code, 200, graded.content)
        self.assertEqual(ReportGrade.objects.get().feedback, feedback)
        submission.refresh_from_db()
        returned = self.grade(submission, action="return", feedback=TAUTOLOGY)
        self.assertEqual(returned.status_code, 200, returned.content)
        self.assertEqual(ReportGrade.objects.get().revision_feedback, TAUTOLOGY)
        # multipart grading (with an annotated file) uses form fields.
        submission.refresh_from_db()
        self.as_user(self.instructor)
        multipart = self.client.post(
            reverse("reports-manage-submission-grade", args=[submission.pk]),
            {"action": "draft", "expected_revision": submission.revision, "feedback": f"{SCRIPT} {UNION}"},
            format="multipart",
        )
        self.assertEqual(multipart.status_code, 200, multipart.content)

    def test_same_text_is_still_blocked_everywhere_else(self):
        self.as_user(self.student)
        for value in (SCRIPT, UNION, TAUTOLOGY, "select name from users where id=1"):
            with self.subTest(value=value):
                # Profile name.
                self.assertTrue(blocked(self.client.patch(reverse("auth-profile"), {"full_name": value}, format="json")))
                # Contact form.
                self.assertTrue(
                    blocked(
                        self.client.post(
                            reverse("auth-contact"),
                            {"name": value, "email": "a@example.com", "subject": "Hi", "message": "hello"},
                            format="json",
                        )
                    )
                )
                # An exempt field NAME on a route that is not exempt.
                self.assertTrue(
                    blocked(self.client.patch(reverse("auth-profile"), {"brief": value, "note": value}, format="json"))
                )
                # A non-exempt field on an exempt route.
                self.assertTrue(
                    blocked(
                        self.client.post(
                            reverse("reports-task-submit", args=[self.task.pk]),
                            {"file_ids": [1], "note": "ok", "extra": value},
                            format="json",
                            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
                        )
                    )
                )
                # The exempt field nested one level down is not the exempt field.
                self.assertTrue(
                    blocked(
                        self.client.post(
                            reverse("reports-task-submit", args=[self.task.pk]),
                            {"file_ids": [1], "note": {"inner": value}},
                            format="json",
                            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
                        )
                    )
                )
                # Query strings are never exempt.
                self.assertTrue(blocked(self.client.get(reverse("reports-tasks"), {"course": value})))

    def test_wrong_method_and_overlong_values_are_not_exempt(self):
        self.as_user(self.instructor)
        task_url = reverse("reports-manage-task-detail", args=[self.task.pk])
        # PUT is not an exempt method (and not allowed anyway); the firewall answers first.
        self.assertTrue(blocked(self.client.put(task_url, {"brief": SCRIPT}, format="json")))
        self.as_user(self.student)
        too_long = f"{UNION} " + "x" * 2001  # longer than the note limit
        response = self.client.post(
            reverse("reports-task-submit", args=[self.task.pk]),
            {"file_ids": [1], "note": too_long},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        self.assertTrue(blocked(response))

    def test_exempt_fields_keep_their_length_limits(self):
        self.as_user(self.instructor)
        response = self.client.post(
            reverse("reports-manage-tasks"), self.task_payload(title="T" * 201, criteria=[]), format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("title", response.data["errors"])

    def test_allowlist_is_exactly_the_approved_fields(self):
        listed = {
            (exemption.url_name, tuple(sorted(exemption.methods)), pattern.pattern, limit)
            for exemption in FIREWALL_EXEMPTIONS
            for pattern, limit in exemption.fields
        }
        task_fields = {
            ("(?:json|form):title", 200),
            ("(?:json|form):brief", 20000),
            (r"(?:json|form):criteria\[\d{1,2}\]:name", 120),
            (r"(?:json|form):criteria\[\d{1,2}\]:description", 2000),
        }
        expected = (
            {("reports-manage-tasks", ("POST",), pattern, limit) for pattern, limit in task_fields}
            | {("reports-manage-task-detail", ("PATCH",), pattern, limit) for pattern, limit in task_fields}
            | {
                ("reports-manage-submission-grade", ("POST",), "(?:json|form):feedback", 10000),
                ("reports-task-submit", ("POST",), "(?:json|form):note", 2000),
                ("lecture-comments", ("POST",), "(?:json|form):body", 2000),
                ("lecture-comment-detail", ("PATCH",), "(?:json|form):body", 2000),
            }
        )
        self.assertEqual(listed, expected)


class LectureCommentExemptionTests(ReportsTestCase):
    def setUp(self):
        super().setUp()
        section = f.make_section(course=self.course)
        self.lecture = f.make_lecture(section=section)
        self.url = reverse("lecture-comments", kwargs={"pk": self.lecture.pk})

    def test_comment_create_and_edit_accept_sql_like_text_and_strip_html(self):
        self.as_user(self.student)
        response = self.client.post(self.url, {"body": f"{SQL_PROSE} {TAUTOLOGY} {SCRIPT}"}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        comment = LectureComment.objects.get()
        # HTML is stripped server-side (as before); the SQL-looking prose is kept.
        self.assertEqual(comment.body, f"{SQL_PROSE} {TAUTOLOGY} alert(1)")
        self.assertNotIn("<script", response.content.decode())
        detail = reverse("lecture-comment-detail", kwargs={"comment_id": comment.pk})
        edited = self.client.patch(detail, {"body": UNION}, format="json")
        self.assertEqual(edited.status_code, 200, edited.content)
        comment.refresh_from_db()
        self.assertEqual(comment.body, UNION)

    def test_comment_active_content_is_still_rejected_by_the_model_check(self):
        self.as_user(self.student)
        response = self.client.post(self.url, {"body": "see javascript:alert(1)"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(LectureComment.objects.exists())

    def test_lecture_questions_stay_protected(self):
        self.as_user(self.student)
        response = self.client.post(
            reverse("lecture-questions", kwargs={"pk": self.lecture.pk}), {"question": TAUTOLOGY}, format="json"
        )
        self.assertTrue(blocked(response))
