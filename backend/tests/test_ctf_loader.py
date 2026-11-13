"""``manage.py load_ctf_exam``: validation, hashing, idempotent upserts, and the
guarantee that no plaintext answer (or instructor note) reaches the database."""

import copy
import io
import json
import tempfile
from pathlib import Path

from apps.ctf import services
from apps.ctf.models import CtfAttempt, CtfExam, CtfQuestion
from django.core import serializers
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from tests import factories as f

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ctf_exam_sample.json"
PEPPER = "loader-test-pepper-0123456789abcdefghijklmnop"
PLAINTEXT = ["Zzfixture Harbour", "Port Zzfixture", "zzfixture_handle", "1999-12-31", "19991231"]
INSTRUCTOR_ONLY = ["FIXTURE-SOLUTION-TEXT-MUST-NEVER-BE-STORED", "example.invalid/", "Not real"]


def fixture_document():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class LoaderTestCase(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, document, name="exam.json"):
        path = Path(self.tmp.name) / name
        path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        return str(path)

    def load(self, document=None, *args):
        out = io.StringIO()
        path = str(FIXTURE) if document is None else self.write(document)
        call_command("load_ctf_exam", "--file", path, *args, stdout=out)
        return out.getvalue()

    def load_error(self, document, *args):
        with self.assertRaises(CommandError) as caught:
            self.load(document, *args)
        return str(caught.exception)


class LoadTests(LoaderTestCase):
    def test_valid_file_loads_exam_and_questions(self):
        output = self.load()
        exam = CtfExam.objects.get(slug="fixture-exam")
        self.assertEqual(exam.status, CtfExam.STATUS_DRAFT)  # publishing is a separate admin step
        self.assertEqual(exam.title, "Fixture OSINT Exam")
        self.assertEqual(exam.title_ur, "فکسچر امتحان")
        self.assertEqual(exam.time_limit_minutes, 120)
        self.assertEqual(exam.default_max_attempts, 5)
        self.assertEqual(len(exam.content_sha256), 64)
        self.assertEqual(len(exam.answer_key_id), 16)
        questions = list(exam.questions.order_by("order"))
        self.assertEqual([q.key for q in questions], ["q01-fake-harbour", "q02-fake-handle", "q03-fake-date"])
        self.assertEqual([q.points for q in questions], [300, 200, 500])
        self.assertEqual([q.max_attempts for q in questions], [3, None, None])
        self.assertEqual(len(questions[0].answer_hashes), 2)
        for question in questions:
            for digest in question.answer_hashes:
                self.assertRegex(digest, r"^[0-9a-f]{64}$")
        self.assertEqual(questions[0].materials[0]["kind"], "image")
        self.assertIn("Questions: 3 in file, 3 new", output)
        self.assertIn("Total points: 1000", output)
        for text in PLAINTEXT:
            self.assertNotIn(text, output)

    def test_no_answer_or_instructor_text_reaches_any_column(self):
        self.load()
        dump = serializers.serialize("json", [*CtfExam.objects.all(), *CtfQuestion.objects.all()])
        for text in PLAINTEXT + INSTRUCTOR_ONLY:
            self.assertNotIn(text, dump)
            self.assertNotIn(text.casefold(), dump)
        self.assertNotIn('"sources"', dump)
        self.assertNotIn('"solution"', dump)

    def test_loaded_hashes_verify_the_fixture_answers(self):
        self.load()
        exam = CtfExam.objects.get(slug="fixture-exam")
        exam.status = CtfExam.STATUS_PUBLISHED
        exam.save()
        student = f.make_user()
        services.start_participation(exam=exam, user=student)
        outcome = services.submit_attempt(exam=exam, user=student, question_key="q01-fake-harbour", answer="port  ZZFIXTURE!")
        self.assertTrue(outcome.attempt.is_correct)
        outcome = services.submit_attempt(exam=exam, user=student, question_key="q02-fake-handle", answer="zzfixture-handle")
        self.assertFalse(outcome.attempt.is_correct)
        outcome = services.submit_attempt(
            exam=exam, user=student, question_key="q02-fake-handle", answer="https://www.@ZZFIXTURE_HANDLE/"
        )
        self.assertTrue(outcome.attempt.is_correct)  # scheme, www, trailing slash and @ are all stripped
        outcome = services.submit_attempt(exam=exam, user=student, question_key="q03-fake-date", answer="31.12.1999")
        self.assertFalse(outcome.attempt.is_correct)
        outcome = services.submit_attempt(exam=exam, user=student, question_key="q03-fake-date", answer="1999/12/31")
        self.assertTrue(outcome.attempt.is_correct)

    def test_reload_is_idempotent(self):
        self.load()
        before = {q.key: (q.pk, q.answer_hashes, q.updated_at) for q in CtfQuestion.objects.all()}
        output = self.load()
        self.assertIn("0 new, 0 changed, 3 unchanged", output)
        after = {q.key: (q.pk, q.answer_hashes) for q in CtfQuestion.objects.all()}
        self.assertEqual({key: value[:2] for key, value in before.items()}, after)
        self.assertEqual(CtfExam.objects.count(), 1)

    def test_stdin_and_dry_run(self):
        out = io.StringIO()
        call_command(
            "load_ctf_exam", "--file", "-", "--dry-run", stdin=io.BytesIO(FIXTURE.read_bytes()), stdout=out
        )
        self.assertIn("[dry run, nothing saved]", out.getvalue())
        self.assertFalse(CtfExam.objects.exists())
        self.assertFalse(CtfQuestion.objects.exists())
        call_command("load_ctf_exam", "--file", "-", stdin=io.BytesIO(FIXTURE.read_bytes()), stdout=io.StringIO())
        self.assertEqual(CtfQuestion.objects.count(), 3)

    def test_eligible_courses_are_set_only_when_listed(self):
        course = f.make_course()
        document = fixture_document()
        document["exam"]["eligible_course_ids"] = [course.pk]
        self.load(document)
        exam = CtfExam.objects.get(slug="fixture-exam")
        self.assertEqual(list(exam.eligible_courses.all()), [course])
        document["exam"].pop("eligible_course_ids")
        self.load(document)
        self.assertEqual(list(exam.eligible_courses.all()), [course])  # unchanged when omitted

    def test_questions_can_swap_order(self):
        self.load()
        document = fixture_document()
        document["questions"][0]["order"], document["questions"][1]["order"] = 2, 1
        self.load(document)
        orders = dict(CtfQuestion.objects.values_list("key", "order"))
        self.assertEqual(orders["q01-fake-harbour"], 2)
        self.assertEqual(orders["q02-fake-handle"], 1)

    def test_question_without_attempts_is_removed_when_dropped(self):
        self.load()
        document = fixture_document()
        document["questions"] = document["questions"][:2]
        output = self.load(document)
        self.assertIn("1 removed", output)
        self.assertFalse(CtfQuestion.objects.filter(key="q03-fake-date").exists())

    def test_material_files_can_be_checked(self):
        error = self.load_error(fixture_document(), "--materials-root", self.tmp.name)
        self.assertIn("harbour.jpg not found", error)
        folder = Path(self.tmp.name) / "materials" / "exams" / "fixture-exam-0123456789abcdef0123456789abcdef"
        folder.mkdir(parents=True)
        (folder / "harbour.jpg").write_bytes(b"\xff\xd8\xff")
        self.load(fixture_document(), "--materials-root", self.tmp.name)

    @override_settings(CTF_ANSWER_PEPPER="", APP_ENV="production")
    def test_production_without_pepper_refuses(self):
        with self.assertRaises(CommandError) as caught:
            self.load()
        self.assertIn("CTF_ANSWER_PEPPER", str(caught.exception))
        self.assertFalse(CtfExam.objects.exists())


class ProtectedQuestionTests(LoaderTestCase):
    def setUp(self):
        super().setUp()
        self.load()
        self.exam = CtfExam.objects.get(slug="fixture-exam")
        self.exam.status = CtfExam.STATUS_PUBLISHED
        self.exam.save()
        self.student = f.make_user()
        services.start_participation(exam=self.exam, user=self.student)
        services.submit_attempt(exam=self.exam, user=self.student, question_key="q01-fake-harbour", answer="wrong")

    def test_content_change_is_refused_once_answered(self):
        document = fixture_document()
        document["questions"][0]["points"] = 999
        error = self.load_error(document)
        self.assertIn("q01-fake-harbour", error)
        self.assertEqual(CtfQuestion.objects.get(key="q01-fake-harbour").points, 300)
        # Answer changes are content changes too.
        document = fixture_document()
        document["questions"][0]["answers"] = ["Another Answer"]
        self.load_error(document)

    def test_unanswered_questions_can_still_change(self):
        document = fixture_document()
        document["questions"][1]["points"] = 250
        self.load(document)
        self.assertEqual(CtfQuestion.objects.get(key="q02-fake-handle").points, 250)

    def test_flag_allows_change_and_answered_questions_are_only_deactivated(self):
        document = fixture_document()
        document["questions"] = document["questions"][1:]
        self.load_error(document)
        output = self.load(document, "--allow-content-change")
        self.assertIn("1 deactivated", output)
        question = CtfQuestion.objects.get(key="q01-fake-harbour")
        self.assertFalse(question.is_active)
        self.assertEqual(CtfAttempt.objects.filter(question=question).count(), 1)
        # Re-adding it reactivates the same row (attempts stay attached).
        self.load(fixture_document(), "--allow-content-change")
        question.refresh_from_db()
        self.assertTrue(question.is_active)

    def test_pepper_rotation_counts_as_content_change(self):
        with override_settings(CTF_ANSWER_PEPPER=PEPPER + "-rotated"):
            error = self.load_error(fixture_document())
            self.assertIn("q01-fake-harbour", error)
            self.load(fixture_document(), "--allow-content-change")
            self.exam.refresh_from_db()
            from apps.ctf.answers import answer_key_id

            self.assertEqual(self.exam.answer_key_id, answer_key_id())


class ValidationTests(LoaderTestCase):
    def mutated(self, mutate):
        document = copy.deepcopy(fixture_document())
        mutate(document)
        return document

    def assertRejected(self, mutate, *fragments):
        error = self.load_error(self.mutated(mutate))
        for fragment in fragments:
            self.assertIn(fragment, error)
        for text in PLAINTEXT:
            self.assertNotIn(text, error)  # errors never echo answers
        self.assertFalse(CtfExam.objects.exists())
        return error

    def test_rejects_bad_files(self):
        self.assertRejected(lambda d: d.update(schema_version=2), "schema_version")
        self.assertRejected(lambda d: d["questions"][0].pop("answers"), "questions[0].answers")
        self.assertRejected(lambda d: d["questions"][0].update(answers=[]), "questions[0].answers")
        self.assertRejected(lambda d: d["questions"][0].update(answers=["!!!"], normalization=["strip_punctuation"]))
        self.assertRejected(lambda d: d["questions"][0].update(category="magic"), "questions[0].category")
        self.assertRejected(lambda d: d["questions"][0].update(difficulty="easy"), "questions[0].difficulty")
        self.assertRejected(lambda d: d["questions"][0].update(points=0), "questions[0].points")
        self.assertRejected(lambda d: d["questions"][0].update(normalization=["eval"]), "unknown normalisation")
        self.assertRejected(lambda d: d["questions"][1].update(key="q01-fake-harbour"), "used twice")
        self.assertRejected(lambda d: d["questions"][1].update(order=1), "used twice")
        self.assertRejected(lambda d: d["questions"][0].update(hints=["x"]), "unknown field(s) hints")
        self.assertRejected(lambda d: d["questions"][0]["prompt"]["en"].update(answerFormat="x"), "answerFormat")
        self.assertRejected(lambda d: d["exam"].update(opens_at="2026-01-01T09:00:00"), "UTC offset")
        self.assertRejected(lambda d: d["exam"].update(closes_at="2025-01-01T09:00:00+00:00"), "after exam.opens_at")
        self.assertRejected(lambda d: d["exam"].update(slug="Bad Slug"), "exam.slug")
        self.assertRejected(lambda d: d["exam"].update(eligible_course_ids=[987654]), "unknown course id")
        self.assertRejected(lambda d: d["questions"][0].update(answers=["x" * 513]), "longer than 512")

    def test_rejects_unsafe_material_paths(self):
        folder = "/materials/exams/fixture-exam-0123456789abcdef0123456789abcdef"
        for path in (
            "/materials/exams/other-exam-0123456789abcdef0123456789abcdef/a.jpg",
            "/materials/exams/fixture-exam-notrandom/a.jpg",
            f"{folder}/../../../private/key.jpg",
            f"{folder}/page.html",
            f"{folder}/image.svg",
            f"{folder}/script.js",
            "https://evil.example/a.jpg",
        ):
            with self.subTest(path=path):
                self.assertRejected(lambda d, p=path: d["questions"][0]["materials"][0].update(path=p), "path")

    def test_rejects_non_json_and_duplicate_keys(self):
        path = Path(self.tmp.name) / "broken.json"
        path.write_text('{"schema_version": 1, "schema_version": 1}', encoding="utf-8")
        with self.assertRaises(CommandError) as caught:
            call_command("load_ctf_exam", "--file", str(path), stdout=io.StringIO())
        self.assertIn("duplicate key", str(caught.exception))
        path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(CommandError) as caught:
            call_command("load_ctf_exam", "--file", str(path), stdout=io.StringIO())
        self.assertIn("invalid JSON", str(caught.exception))
        with self.assertRaises(CommandError):
            call_command("load_ctf_exam", "--file", str(Path(self.tmp.name) / "missing.json"), stdout=io.StringIO())
