"""CTF exam API: access, start, every answer recorded, scoring once, limits,
deadlines, idempotency, throttling and response hygiene (no answers/hashes)."""

import json
import re
import uuid
from datetime import timedelta
from unittest.mock import patch

from apps.ctf.models import CtfAttempt, CtfExam, CtfParticipation
from apps.users.terms import TERMS_VERSION
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.test import APITestCase

from tests import factories as f

PEPPER = "api-test-pepper-0123456789abcdefghijklmnopqrstu"
FORBIDDEN_KEYS = {"answers", "answer_hashes", "normalization", "solution", "sources", "normalized_answer"}
HEX64 = re.compile(r"\b[0-9a-f]{64}\b")


def walk_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from walk_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_keys(item)


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class CtfApiTestCase(APITestCase):
    def setUp(self):
        cache.clear()
        self.course = f.make_course(title="OSINT Batch 7", batch="Batch 7")
        self.student = f.make_user(full_name="Asha Rao")
        f.make_enrollment(user=self.student, course=self.course)
        self.exam = f.make_ctf_exam(eligible_courses=[self.course], slug="final-exam")
        self.q1 = f.make_ctf_question(
            exam=self.exam, key="q1-harbour", order=1, points=300, max_attempts=3, answers=["Zz Harbour", "Port Zz"],
            materials=[
                {
                    "label": {"en": "Photo", "ur": ""},
                    "path": "/materials/exams/final-exam-0123456789abcdef0123456789abcdef/photo.jpg",
                    "kind": "image",
                    "alt": {"en": "Harbour"},
                }
            ],
        )
        self.q2 = f.make_ctf_question(exam=self.exam, key="q2-handle", order=2, points=200, answers=["zz_handle"])

    # --- helpers ---------------------------------------------------------
    def as_user(self, user):
        self.client.force_authenticate(user)

    def url(self, name, *args):
        return reverse(name, args=args)

    def start(self, user=None, exam=None):
        self.as_user(user or self.student)
        return self.client.post(self.url("ctf-exam-start", (exam or self.exam).slug), format="json")

    def answer(self, value, question=None, key=None, user=None, exam=None):
        if user is not None:
            self.as_user(user)
        question = question or self.q1
        return self.client.post(
            self.url("ctf-question-attempts", (exam or self.exam).slug, question.key),
            {"answer": value},
            format="json",
            HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
            HTTP_USER_AGENT="LabsTest/1.0",
            REMOTE_ADDR="203.0.113.9",
        )

    def detail(self, user=None):
        self.as_user(user or self.student)
        response = self.client.get(self.url("ctf-exam-detail", self.exam.slug))
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def code(self, response):
        return response.json().get("errors", {}).get("code")


class AccessTests(CtfApiTestCase):
    def test_anonymous_gets_401_everywhere(self):
        self.client.force_authenticate(None)
        for response in (
            self.client.get(self.url("ctf-exams")),
            self.client.get(self.url("ctf-exam-detail", self.exam.slug)),
            self.client.post(self.url("ctf-exam-start", self.exam.slug)),
            self.client.post(
                self.url("ctf-question-attempts", self.exam.slug, self.q1.key),
                {"answer": "x"},
                format="json",
                HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
            ),
            self.client.post(self.url("ctf-exam-submit", self.exam.slug)),
        ):
            self.assertEqual(response.status_code, 401)
        self.assertFalse(CtfAttempt.objects.exists())

    def test_student_outside_the_batch_gets_404(self):
        stranger = f.make_user()
        f.make_enrollment(user=stranger, course=f.make_course())
        self.as_user(stranger)
        listing = self.client.get(self.url("ctf-exams"))
        self.assertEqual(listing.json()["data"]["results"], [])
        self.assertEqual(self.client.get(self.url("ctf-exam-detail", self.exam.slug)).status_code, 404)
        response = self.start(user=stranger)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.code(response), "ctf_exam_not_found")
        self.assertEqual(self.answer("Zz Harbour", user=stranger).status_code, 404)
        self.assertFalse(CtfParticipation.objects.exists())

    def test_unpaid_enrollment_is_not_eligible(self):
        pending = f.make_user()
        f.make_enrollment(user=pending, course=self.course, payment_status="pending")
        self.assertEqual(self.start(user=pending).status_code, 404)

    def test_draft_exam_is_hidden_from_students_but_staff_can_preview(self):
        self.exam.status = CtfExam.STATUS_DRAFT
        self.exam.save()
        self.assertEqual(self.start().status_code, 404)
        admin = f.make_admin()
        self.as_user(admin)
        listing = self.client.get(self.url("ctf-exams")).json()["data"]["results"]
        self.assertEqual([item["slug"] for item in listing], ["final-exam"])
        response = self.start(user=admin)
        self.assertEqual(response.status_code, 201, response.content)
        participation = CtfParticipation.objects.get(user=admin)
        self.assertTrue(participation.is_staff_preview)
        self.assertIsNone(participation.batch_course)
        self.assertTrue(self.answer("zz harbour", user=admin).json()["data"]["attempt"]["correct"])

    def test_exam_not_open_yet_is_visible_but_cannot_start(self):
        self.exam.opens_at = timezone.now() + timedelta(hours=2)
        self.exam.save()
        data = self.detail()
        self.assertEqual(data["exam"]["window"], "not_open")
        self.assertFalse(data["exam"]["can_start"])
        self.assertEqual(data["questions"], [])
        response = self.start()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "ctf_exam_not_open")

    def test_closed_exam_cannot_start(self):
        self.exam.closes_at = timezone.now() - timedelta(minutes=1)
        self.exam.opens_at = timezone.now() - timedelta(hours=3)
        self.exam.save()
        response = self.start()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "ctf_exam_closed")

    def test_terms_must_be_accepted(self):
        user = f.make_user(email="terms-ctf@test.com", password="StrongPass@123456")
        f.make_enrollment(user=user, course=self.course)
        self.client.force_authenticate(None)
        login = self.client.post(
            reverse("auth-login"), {"email": user.email, "password": "StrongPass@123456"}, format="json"
        )
        self.assertEqual(login.status_code, 200, login.content)
        blocked = self.client.get(self.url("ctf-exams"))
        self.assertEqual(blocked.status_code, 403)
        self.assertIn("terms_acceptance_required", blocked.content.decode())
        user.terms_accepted_version = TERMS_VERSION
        user.save(update_fields=["terms_accepted_version"])
        self.assertEqual(self.client.get(self.url("ctf-exams")).status_code, 200)


class StartAndDetailTests(CtfApiTestCase):
    def test_list_shows_totals_and_start_state(self):
        self.as_user(self.student)
        item = self.client.get(self.url("ctf-exams")).json()["data"]["results"][0]
        self.assertEqual(item["slug"], "final-exam")
        self.assertEqual(item["question_count"], 2)
        self.assertEqual(item["total_points"], 500)
        self.assertEqual(item["window"], "open")
        self.assertTrue(item["can_start"])
        self.assertIsNone(item["participation"])
        self.assertEqual(item["title"], {"en": self.exam.title, "ur": self.exam.title})  # Urdu falls back

    def test_start_is_idempotent_and_snapshots_the_batch(self):
        first = self.start()
        self.assertEqual(first.status_code, 201, first.content)
        second = self.start()
        self.assertEqual(second.status_code, 200)
        self.assertEqual(CtfParticipation.objects.count(), 1)
        participation = CtfParticipation.objects.get()
        self.assertEqual(participation.batch_course, self.course)
        self.assertFalse(participation.is_staff_preview)
        self.assertAlmostEqual(
            (participation.deadline_at - participation.started_at).total_seconds(), 60 * 60, delta=1
        )
        self.assertEqual(first.json()["data"]["participation"]["status"], "active")

    def test_deadline_is_capped_by_closing_time(self):
        self.exam.closes_at = timezone.now() + timedelta(minutes=10)
        self.exam.save()
        self.start()
        participation = CtfParticipation.objects.get()
        self.assertEqual(participation.deadline_at, self.exam.closes_at)

    def test_questions_appear_only_after_start_and_never_leak_answers(self):
        self.assertEqual(self.detail()["questions"], [])
        self.start()
        self.answer("wrong guess")
        data = self.detail()
        self.assertEqual([q["key"] for q in data["questions"]], ["q1-harbour", "q2-handle"])
        question = data["questions"][0]
        self.assertEqual(question["max_attempts"], 3)
        self.assertEqual(question["attempts_used"], 1)
        self.assertFalse(question["solved"])
        self.assertEqual(question["materials"][0]["url"], self.q1.materials[0]["path"])
        self.assertEqual(question["prompt"]["ur"]["task"], question["prompt"]["en"]["task"])
        body = json.dumps(data)
        self.assertFalse(FORBIDDEN_KEYS & set(walk_keys(data)), FORBIDDEN_KEYS & set(walk_keys(data)))
        self.assertIsNone(HEX64.search(body))
        for digest in self.q1.answer_hashes:
            self.assertNotIn(digest, body)
        self.assertNotIn("Zz Harbour", body)


class AttemptTests(CtfApiTestCase):
    def setUp(self):
        super().setUp()
        self.assertEqual(self.start().status_code, 201)

    def test_wrong_answer_is_recorded_verbatim(self):
        response = self.answer("  Wrong Harbour  ")
        self.assertEqual(response.status_code, 201, response.content)
        data = response.json()["data"]
        self.assertEqual(
            data["attempt"], {"attempt_number": 1, "correct": False, "points_awarded": 0, "attempts_remaining": 2}
        )
        self.assertEqual(data["participation"]["wrong_count"], 1)
        attempt = CtfAttempt.objects.get()
        self.assertEqual(attempt.submitted_answer, "  Wrong Harbour  ")
        self.assertEqual(attempt.normalized_answer, "wrong harbour")
        self.assertFalse(attempt.is_correct)
        self.assertRegex(attempt.client_ip_hash, r"^[0-9a-f]{64}$")
        self.assertNotIn("203.0.113.9", attempt.client_ip_hash)
        self.assertEqual(attempt.user_agent, "LabsTest/1.0")
        self.assertEqual(attempt.user, self.student)
        self.assertEqual(attempt.exam, self.exam)

    def test_correct_answer_scores_once(self):
        response = self.answer("port zz")
        self.assertEqual(response.status_code, 201)
        data = response.json()["data"]
        self.assertTrue(data["attempt"]["correct"])
        self.assertEqual(data["attempt"]["points_awarded"], 300)
        self.assertEqual(data["participation"]["score"], 300)
        again = self.answer("Zz Harbour")
        self.assertEqual(again.status_code, 409)
        self.assertEqual(self.code(again), "ctf_question_already_solved")
        self.assertEqual(CtfAttempt.objects.count(), 1)
        participation = CtfParticipation.objects.get()
        self.assertEqual((participation.score, participation.solved_count, participation.attempt_count), (300, 1, 1))
        self.assertIsNotNone(participation.last_correct_at)

    def test_wrong_then_correct_keeps_both_rows(self):
        self.answer("nope")
        self.answer("zz_handle", question=self.q2)
        self.answer("ZZ HARBOUR")
        rows = list(CtfAttempt.objects.order_by("id").values_list("question__key", "attempt_number", "is_correct"))
        self.assertEqual(rows, [("q1-harbour", 1, False), ("q2-handle", 1, True), ("q1-harbour", 2, True)])
        participation = CtfParticipation.objects.get()
        self.assertEqual((participation.score, participation.wrong_count, participation.solved_count), (500, 1, 2))

    def test_attempt_limit(self):
        for number in range(3):
            self.assertEqual(self.answer(f"guess {number}").status_code, 201)
        response = self.answer("Zz Harbour")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "ctf_attempts_exhausted")
        self.assertEqual(CtfAttempt.objects.count(), 3)
        # The exam default (5) applies to questions without their own limit.
        for number in range(5):
            self.assertEqual(self.answer(f"guess {number}", question=self.q2).status_code, 201)
        self.assertEqual(self.code(self.answer("x", question=self.q2)), "ctf_attempts_exhausted")

    def test_time_limit_ends_the_exam(self):
        CtfParticipation.objects.update(deadline_at=timezone.now() - timedelta(seconds=1))
        response = self.answer("Zz Harbour")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "ctf_exam_time_over")
        self.assertEqual(CtfParticipation.objects.get().status, CtfParticipation.STATUS_EXPIRED)
        self.assertFalse(CtfAttempt.objects.exists())
        self.assertEqual(self.detail()["participation"]["status"], "expired")

    def test_closing_time_ends_the_exam_even_if_moved_after_start(self):
        CtfExam.objects.filter(pk=self.exam.pk).update(closes_at=timezone.now() - timedelta(seconds=1))
        response = self.answer("Zz Harbour")
        self.assertEqual(self.code(response), "ctf_exam_time_over")
        self.assertFalse(CtfAttempt.objects.exists())

    def test_closed_by_admin(self):
        CtfExam.objects.filter(pk=self.exam.pk).update(status=CtfExam.STATUS_CLOSED)
        response = self.answer("Zz Harbour")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "ctf_exam_closed")

    def test_finish_early_then_no_more_answers(self):
        response = self.client.post(self.url("ctf-exam-submit", self.exam.slug))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["participation"]["status"], "submitted")
        self.assertEqual(self.code(self.answer("Zz Harbour")), "ctf_participation_submitted")
        self.assertEqual(self.client.post(self.url("ctf-exam-submit", self.exam.slug)).status_code, 200)
        self.assertFalse(CtfAttempt.objects.exists())

    def test_must_start_first(self):
        other = f.make_user()
        f.make_enrollment(user=other, course=self.course)
        response = self.answer("Zz Harbour", user=other)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "ctf_not_started")

    def test_unknown_or_retired_question_is_404(self):
        self.as_user(self.student)
        response = self.client.post(
            self.url("ctf-question-attempts", self.exam.slug, "no-such-question"),
            {"answer": "x"},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.code(response), "ctf_question_not_found")
        self.q2.is_active = False
        self.q2.save()
        self.assertEqual(self.answer("zz_handle", question=self.q2).status_code, 404)

    def test_idempotency_key_replays_without_a_second_row(self):
        key = str(uuid.uuid4())
        first = self.answer("wrong once", key=key)
        second = self.answer("wrong once", key=key)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second["Idempotent-Replayed"], "true")
        self.assertEqual(first.json(), second.json())
        self.assertEqual(CtfAttempt.objects.count(), 1)
        missing = self.client.post(
            self.url("ctf-question-attempts", self.exam.slug, self.q1.key), {"answer": "x"}, format="json"
        )
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(CtfAttempt.objects.count(), 1)

    def test_answer_length_and_blank_are_validated(self):
        self.assertEqual(self.answer("a" * 513).status_code, 400)
        self.assertEqual(self.answer("   ").status_code, 400)
        self.assertEqual(self.answer("a" * 512).status_code, 201)
        self.assertEqual(CtfAttempt.objects.count(), 1)

    def test_sql_html_and_url_answers_are_recorded(self):
        for value in (
            "' OR 1=1 --",
            "UNION SELECT username, password FROM users",
            "<script>alert(1)</script>",
            'site:example.org inurl:"admin" -filetype:pdf',
        ):
            with self.subTest(value=value):
                response = self.answer(value, question=self.q2)
                self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(
            list(CtfAttempt.objects.order_by("id").values_list("submitted_answer", flat=True))[:3],
            ["' OR 1=1 --", "UNION SELECT username, password FROM users", "<script>alert(1)</script>"],
        )

    def test_answer_key_mismatch_refuses_without_recording(self):
        CtfExam.objects.filter(pk=self.exam.pk).update(answer_key_id="0000000000000000")
        response = self.answer("Zz Harbour")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.code(response), "ctf_answer_key_mismatch")
        self.assertFalse(CtfAttempt.objects.exists())

    def test_attempts_are_throttled(self):
        with patch.dict(SimpleRateThrottle.THROTTLE_RATES, {"ctf_attempt": "2/minute"}):
            cache.clear()  # forget the Start request made in setUp
            self.assertEqual(self.answer("one").status_code, 201)
            self.assertEqual(self.answer("two").status_code, 201)
            response = self.answer("three")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(CtfAttempt.objects.count(), 2)
