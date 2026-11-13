"""CTF records: database constraints, append-only attempts, and scoring once
under concurrent submissions."""

import threading
import time
from unittest import mock

from apps.core.errors import Conflict
from apps.ctf import services
from apps.ctf.models import AppendOnlyError, CtfAttempt, CtfExam, CtfParticipation, CtfQuestion
from django.db import IntegrityError, OperationalError, close_old_connections, connection, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from tests import factories as f

PEPPER = "concurrency-test-pepper-0123456789abcdefghijkl"


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class ConstraintTests(TestCase):
    def setUp(self):
        self.course = f.make_course()
        self.student = f.make_user()
        f.make_enrollment(user=self.student, course=self.course)
        self.exam = f.make_ctf_exam(eligible_courses=[self.course])
        self.question = f.make_ctf_question(exam=self.exam, answers=["right"], points=50)
        self.participation, _ = services.start_participation(exam=self.exam, user=self.student)

    def attempt(self, **overrides):
        fields = {
            "participation": self.participation,
            "exam": self.exam,
            "user": self.student,
            "question": self.question,
            "attempt_number": 1,
            "submitted_answer": "x",
        }
        fields.update(overrides)
        return CtfAttempt.objects.create(**fields)

    def assertIntegrity(self, func):
        with self.assertRaises(IntegrityError), transaction.atomic():
            func()

    def test_attempts_are_append_only(self):
        attempt = self.attempt()
        attempt.submitted_answer = "changed"
        with self.assertRaises(AppendOnlyError):
            attempt.save()
        with self.assertRaises(AppendOnlyError):
            attempt.delete()
        with self.assertRaises(AppendOnlyError):
            CtfAttempt.objects.filter(pk=attempt.pk).update(is_correct=True)
        with self.assertRaises(AppendOnlyError):
            CtfAttempt.objects.all().delete()
        self.assertEqual(CtfAttempt.objects.get().submitted_answer, "x")

    def test_one_correct_attempt_per_question(self):
        self.attempt(attempt_number=1, is_correct=True, points_awarded=50)
        self.assertIntegrity(lambda: self.attempt(attempt_number=2, is_correct=True, points_awarded=50))
        self.attempt(attempt_number=2, is_correct=False)  # wrong rows are still fine

    def test_attempt_number_is_unique_and_positive(self):
        self.attempt(attempt_number=1)
        self.assertIntegrity(lambda: self.attempt(attempt_number=1))
        self.assertIntegrity(lambda: self.attempt(attempt_number=0))

    def test_points_only_for_correct_answers(self):
        self.assertIntegrity(lambda: self.attempt(is_correct=False, points_awarded=10))

    def test_answered_question_cannot_be_deleted(self):
        self.attempt()
        from django.db.models import ProtectedError

        with self.assertRaises(ProtectedError):
            self.question.delete()

    def test_exam_and_question_constraints(self):
        now = timezone.now()
        self.assertIntegrity(lambda: f.make_ctf_exam(opens_at=now, closes_at=now))
        self.assertIntegrity(lambda: f.make_ctf_exam(time_limit_minutes=0))
        self.assertIntegrity(lambda: f.make_ctf_exam(status="archived"))
        self.assertIntegrity(lambda: f.make_ctf_question(exam=self.exam, points=0))
        self.assertIntegrity(lambda: f.make_ctf_question(exam=self.exam, difficulty="easy"))
        self.assertIntegrity(lambda: f.make_ctf_question(exam=self.exam, key=self.question.key))
        self.assertIntegrity(lambda: f.make_ctf_question(exam=self.exam, order=self.question.order))
        # A retired question may keep an order a live question now uses.
        f.make_ctf_question(exam=self.exam, order=self.question.order, is_active=False)
        self.assertIntegrity(
            lambda: CtfParticipation.objects.create(exam=self.exam, user=self.student, started_at=now)
        )

    def test_race_past_the_checks_is_caught_by_the_constraint(self):
        """Another transaction records a correct answer between our checks and
        our insert: the partial unique index refuses the second correct row and
        no points are added twice."""
        real_verify = services.answers.verify

        def verify_and_race(*args, **kwargs):
            CtfAttempt.objects.create(
                participation=self.participation,
                exam=self.exam,
                user=self.student,
                question=self.question,
                attempt_number=7,
                submitted_answer="right",
                is_correct=True,
                points_awarded=50,
            )
            return real_verify(*args, **kwargs)

        with mock.patch.object(services.answers, "verify", side_effect=verify_and_race):
            with self.assertRaises(Conflict) as caught:
                services.submit_attempt(exam=self.exam, user=self.student, question_key=self.question.key, answer="right")
        self.assertEqual(caught.exception.code, "ctf_attempt_conflict")
        self.assertEqual(CtfAttempt.objects.filter(is_correct=True).count(), 1)
        self.participation.refresh_from_db()
        self.assertEqual((self.participation.score, self.participation.solved_count), (0, 0))


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class ParallelSubmissionTests(TransactionTestCase):
    THREADS = 6

    def setUp(self):
        self.course = f.make_course()
        self.student = f.make_user()
        f.make_enrollment(user=self.student, course=self.course)
        self.exam = f.make_ctf_exam(eligible_courses=[self.course], default_max_attempts=20)
        self.question = f.make_ctf_question(exam=self.exam, answers=["right"], points=70)
        services.start_participation(exam=self.exam, user=self.student)

    def _submit_with_retry(self, results, barrier):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            for _ in range(50):
                try:
                    services.submit_attempt(
                        exam=CtfExam.objects.get(pk=self.exam.pk),
                        user=self.student,
                        question_key=self.question.key,
                        answer="right",
                    )
                    results.append("scored")
                    return
                except Conflict as exc:
                    results.append(exc.code)
                    return
                except OperationalError:
                    # SQLite's table lock (Postgres would block on the row lock).
                    time.sleep(0.02)
            results.append("gave_up")
        finally:
            connection.close()

    def test_parallel_correct_answers_score_exactly_once(self):
        results = []
        barrier = threading.Barrier(self.THREADS)
        threads = [
            threading.Thread(target=self._submit_with_retry, args=(results, barrier)) for _ in range(self.THREADS)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        self.assertEqual(len(results), self.THREADS, results)
        self.assertEqual(results.count("scored"), 1, results)
        self.assertTrue(
            all(item in {"scored", "ctf_question_already_solved", "ctf_attempt_conflict"} for item in results), results
        )
        self.assertEqual(CtfAttempt.objects.filter(is_correct=True).count(), 1)
        participation = CtfParticipation.objects.get()
        self.assertEqual((participation.score, participation.solved_count), (70, 1))
        self.assertEqual(participation.attempt_count, CtfAttempt.objects.count())
        self.assertEqual(CtfQuestion.objects.count(), 1)
