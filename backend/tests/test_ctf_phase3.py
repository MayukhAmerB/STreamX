"""Phase 3 exams: readiness checklist, Console endpoints (upload dry run,
schedule, publish, close, results), ctf.scheduler idempotency, eligibility
reasons, protected evidence files, the pepper check and the permissions of
students, instructors and staff."""

import io
import json
import shutil
import tempfile
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.ctf import checks, readiness, scheduler
from apps.ctf.models import CtfAttempt, CtfExam, CtfExamResult, CtfMaterial, CtfParticipation
from apps.ctf.services import start_participation, submit_attempt
from apps.notifications.models import Notification, NotificationRecipient
from apps.users.terms import TERMS_VERSION
from django.core.cache import cache
from django.core.checks import WARNING
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from tests import factories as f

PEPPER = "phase3-test-pepper-0123456789abcdefghijklmnop"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ctf_exam_sample.json"
MATERIAL_PATH = "/materials/exams/fixture-exam-0123456789abcdef0123456789abcdef/harbour.jpg"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 60
FORBIDDEN_KEYS = {"answers", "answer_hashes", "normalization", "solution", "sources"}


def walk_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from walk_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_keys(item)


def fixture_bytes(**exam_overrides):
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    document["exam"].update(exam_overrides)
    return json.dumps(document, ensure_ascii=False).encode("utf-8")


def accept_terms(*users):
    for user in users:
        user.terms_accepted_version = TERMS_VERSION
        user.save(update_fields=["terms_accepted_version"])


class _MediaMixin:
    def setUp(self):
        super().setUp()
        cache.clear()
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, True)
        media_override = override_settings(MEDIA_ROOT=self.media, COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=False)
        media_override.enable()
        self.addCleanup(media_override.disable)


# ---------------------------------------------------------------------------
# Readiness checklist
# ---------------------------------------------------------------------------
@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class ReadinessTests(TestCase):
    def setUp(self):
        self.course = f.make_course()
        self.exam = f.make_ctf_exam(status=CtfExam.STATUS_DRAFT, eligible_courses=[self.course])
        f.make_ctf_question(exam=self.exam)

    def ids_failing(self, exam=None):
        return [item.id for item in readiness.check_exam(exam or self.exam).blocking]

    def test_complete_exam_is_ready(self):
        result = readiness.check_exam(self.exam)
        self.assertTrue(result.ready, result.reasons())
        self.assertEqual([item.id for item in result.items], ["pepper", "answer_key", "questions", "window", "batches", "materials"])

    def test_each_missing_item_blocks_with_a_reason(self):
        exam = f.make_ctf_exam(status=CtfExam.STATUS_DRAFT, opens_at=None, closes_at=None, answer_key_id="")
        result = readiness.check_exam(exam)
        self.assertFalse(result.ready)
        self.assertEqual(self.ids_failing(exam), ["answer_key", "questions", "window", "batches"])
        self.assertTrue(all(result.reasons()))

    @override_settings(CTF_ANSWER_PEPPER="", APP_ENV="production")
    def test_missing_pepper_in_production_blocks(self):
        failing = self.ids_failing()
        self.assertIn("pepper", failing)
        self.assertIn("answer_key", failing)
        exam = CtfExam.objects.get(pk=self.exam.pk)
        pepper = next(item for item in readiness.check_exam(exam).items if item.id == "pepper")
        self.assertIn("not set", pepper.detail)

    @override_settings(CTF_ANSWER_PEPPER="too-short", APP_ENV="production")
    def test_weak_pepper_in_production_blocks_with_the_reason(self):
        failing = self.ids_failing()
        self.assertIn("pepper", failing)
        self.assertIn("answer_key", failing)
        pepper = next(item for item in readiness.check_exam(self.exam).items if item.id == "pepper")
        self.assertIn("shorter than 32 characters", pepper.detail)

    def test_rotated_pepper_blocks_until_reloaded(self):
        CtfExam.objects.filter(pk=self.exam.pk).update(answer_key_id="0" * 16)
        self.exam.refresh_from_db()
        self.assertEqual(self.ids_failing(), ["answer_key"])

    def test_window_in_the_past_blocks(self):
        now = timezone.now()
        CtfExam.objects.filter(pk=self.exam.pk).update(opens_at=now - timedelta(days=2), closes_at=now - timedelta(days=1))
        self.exam.refresh_from_db()
        self.assertEqual(self.ids_failing(), ["window"])

    def test_referenced_evidence_must_be_uploaded(self):
        f.make_ctf_question(
            exam=self.exam,
            materials=[{"label": {"en": "Photo"}, "path": MATERIAL_PATH, "kind": "image"}],
        )
        self.assertEqual(self.ids_failing(), ["materials"])
        CtfMaterial.objects.create(exam=self.exam, path=MATERIAL_PATH, file="ctf_materials/x/y.jpg", size=1)
        self.assertEqual(self.ids_failing(), [])


# ---------------------------------------------------------------------------
# Console API
# ---------------------------------------------------------------------------
@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class ConsoleApiTests(_MediaMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.staff = f.make_admin()
        self.instructor = f.make_instructor()
        self.student = f.make_user()
        accept_terms(self.staff, self.instructor, self.student)
        self.course = f.make_course(title="Batch Nine", instructor=self.instructor)
        self.other_course = f.make_course(title="Batch Ten")
        f.make_enrollment(user=self.student, course=self.course)

    def upload(self, url_name, raw=None, **extra):
        self.client.force_authenticate(self.staff)
        upload = SimpleUploadedFile("exam.json", raw or fixture_bytes(), content_type="application/json")
        return self.client.post(reverse(url_name), {"file": upload, **extra}, format="multipart")

    def test_dry_run_reports_counts_and_saves_nothing(self):
        response = self.upload("ctf-admin-exam-preview")
        self.assertEqual(response.status_code, 200, response.content)
        report = response.json()["data"]["report"]
        self.assertTrue(report["dry_run"])
        self.assertTrue(report["exam_created"])
        self.assertEqual(report["question_count"], 3)
        self.assertEqual(report["created"], 3)
        self.assertEqual(report["total_points"], 1000)
        self.assertEqual(report["materials_referenced"], 1)
        self.assertIsNone(response.json()["data"]["exam"])
        self.assertFalse(CtfExam.objects.filter(slug="fixture-exam").exists())
        body = response.content.decode("utf-8")
        for text in ["Zzfixture Harbour", "zzfixture_handle", "FIXTURE-SOLUTION-TEXT-MUST-NEVER-BE-STORED"]:
            self.assertNotIn(text, body)

    def test_dry_run_accepts_json_content_too(self):
        self.client.force_authenticate(self.staff)
        response = self.client.post(
            reverse("ctf-admin-exam-preview"), {"content": fixture_bytes().decode("utf-8")}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["report"]["question_count"], 3)

    def test_invalid_file_lists_every_problem(self):
        document = json.loads(fixture_bytes())
        document["questions"][0]["category"] = "nonsense"
        document["questions"][1]["points"] = 0
        response = self.upload("ctf-admin-exam-preview", json.dumps(document).encode())
        self.assertEqual(response.status_code, 400)
        problems = response.json()["errors"]["problems"]
        self.assertEqual(len(problems), 2)
        self.assertEqual(response.json()["errors"]["code"], "ctf_exam_file_invalid")

    def test_upload_then_schedule_publish_flow(self):
        response = self.upload("ctf-admin-exam-upload")
        self.assertEqual(response.status_code, 200, response.content)
        detail = response.json()["data"]["exam"]
        self.assertEqual(detail["state"], "draft")
        self.assertFalse(detail["readiness"]["ready"])
        for key in walk_keys(response.json()):
            self.assertNotIn(key, FORBIDDEN_KEYS)

        # Publish is refused with every reason while the checklist fails.
        publish_url = reverse("ctf-admin-exam-publish", args=["fixture-exam"])
        refused = self.client.post(publish_url)
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(refused.json()["errors"]["code"], "ctf_exam_not_ready")
        self.assertTrue(refused.json()["errors"]["reasons"])

        # Choose batches by slug, set a future window.
        opens = timezone.now() + timedelta(hours=3)
        patch = self.client.patch(
            reverse("ctf-admin-exam-detail", args=["fixture-exam"]),
            {
                "opens_at": opens.isoformat(),
                "closes_at": (opens + timedelta(hours=2)).isoformat(),
                "batch_slugs": [self.course.slug],
            },
            format="json",
        )
        self.assertEqual(patch.status_code, 200, patch.content)
        self.assertEqual([b["id"] for b in patch.json()["data"]["batches"]], [self.course.pk])
        failing = [item["id"] for item in patch.json()["data"]["readiness"]["items"] if not item["ok"]]
        self.assertEqual(failing, ["materials"])

        material = self.client.post(
            reverse("ctf-admin-exam-materials", args=["fixture-exam"]),
            {"path": MATERIAL_PATH, "file": SimpleUploadedFile("harbour.jpg", JPEG, content_type="image/jpeg")},
            format="multipart",
        )
        self.assertEqual(material.status_code, 201, material.content)

        published = self.client.post(publish_url)
        self.assertEqual(published.status_code, 200, published.content)
        self.assertEqual(published.json()["data"]["state"], "scheduled")
        exam = CtfExam.objects.get(slug="fixture-exam")
        self.assertEqual(exam.status, CtfExam.STATUS_DRAFT)
        self.assertTrue(exam.auto_publish)

        # Re-uploading the questions keeps the Console schedule.
        document = json.loads(fixture_bytes())
        del document["exam"]["opens_at"], document["exam"]["closes_at"]
        again = self.upload("ctf-admin-exam-upload", json.dumps(document).encode())
        self.assertEqual(again.status_code, 200, again.content)
        exam.refresh_from_db()
        self.assertEqual(exam.opens_at, opens.replace(microsecond=opens.microsecond))

    def test_publish_now_when_already_open_notifies_students(self):
        exam = f.make_ctf_exam(status=CtfExam.STATUS_DRAFT, eligible_courses=[self.course])
        f.make_ctf_question(exam=exam)
        self.client.force_authenticate(self.staff)
        response = self.client.post(reverse("ctf-admin-exam-publish", args=[exam.slug]))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["state"], "published")
        drain_outbox()
        notification = Notification.objects.get(event_key=f"ctf-exam-published:{exam.pk}")
        self.assertEqual(list(notification.recipients.values_list("user_id", flat=True)), [self.student.pk])
        self.assertIn("labs", notification.action_url)

    def test_open_exam_can_extend_its_close_but_not_move_its_opening(self):
        exam = f.make_ctf_exam(eligible_courses=[self.course])
        self.client.force_authenticate(self.staff)
        url = reverse("ctf-admin-exam-detail", args=[exam.slug])
        later = (exam.closes_at + timedelta(hours=1)).replace(second=0, microsecond=0)
        # The Console sends the unchanged opening time at minute precision.
        response = self.client.patch(
            url,
            {"opens_at": exam.opens_at.replace(second=0, microsecond=0).isoformat(), "closes_at": later.isoformat()},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        exam.refresh_from_db()
        self.assertEqual(exam.closes_at, later)
        moved = self.client.patch(url, {"opens_at": (exam.opens_at - timedelta(hours=1)).isoformat()}, format="json")
        self.assertEqual(moved.status_code, 409)
        self.assertEqual(moved.json()["errors"]["code"], "ctf_exam_open")
        past = self.client.patch(url, {"closes_at": (timezone.now() - timedelta(minutes=5)).isoformat()}, format="json")
        self.assertEqual(past.status_code, 400)

    def test_bad_material_uploads_are_refused(self):
        self.upload("ctf-admin-exam-upload")
        url = reverse("ctf-admin-exam-materials", args=["fixture-exam"])
        html = SimpleUploadedFile("harbour.jpg", b"<html><script>alert(1)</script>", content_type="image/jpeg")
        response = self.client.post(url, {"path": MATERIAL_PATH, "file": html}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["errors"]["code"], "ctf_material_bad_content")
        unknown = SimpleUploadedFile("x.jpg", JPEG, content_type="image/jpeg")
        response = self.client.post(url, {"path": "/materials/other.jpg", "file": unknown}, format="multipart")
        self.assertEqual(response.json()["errors"]["code"], "ctf_material_unknown_path")
        png = SimpleUploadedFile("harbour.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, content_type="image/png")
        response = self.client.post(url, {"path": MATERIAL_PATH, "file": png}, format="multipart")
        self.assertEqual(response.json()["errors"]["code"], "ctf_material_wrong_type")

    def test_close_writes_results_and_expires_active_students(self):
        exam = f.make_ctf_exam(eligible_courses=[self.course])
        question = f.make_ctf_question(exam=exam, points=50, answers=["right"])
        start_participation(exam=exam, user=self.student)
        submit_attempt(exam=exam, user=self.student, question_key=question.key, answer="right")
        self.client.force_authenticate(self.staff)
        response = self.client.post(reverse("ctf-admin-exam-close", args=[exam.slug]))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["state"], "closed")
        participation = CtfParticipation.objects.get(exam=exam, user=self.student)
        self.assertEqual(participation.status, CtfParticipation.STATUS_EXPIRED)
        result = CtfExamResult.objects.get(exam=exam, user=self.student)
        self.assertEqual((result.score, result.total_points, result.rank), (50, 50, 1))

    def test_results_show_solve_rates_and_wrong_answer_clusters(self):
        exam = f.make_ctf_exam(eligible_courses=[self.course])
        question = f.make_ctf_question(exam=exam, answers=["right"], max_attempts=5)
        start_participation(exam=exam, user=self.student)
        for answer in ["Wrong  One", "wrong one", "other"]:
            submit_attempt(exam=exam, user=self.student, question_key=question.key, answer=answer)
        self.client.force_authenticate(self.staff)
        response = self.client.get(reverse("ctf-admin-exam-results", args=[exam.slug]))
        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertEqual(data["stats"]["participants"], 1)
        stats = data["questions"][0]
        self.assertEqual((stats["attempted"], stats["solved"], stats["solve_rate"]), (1, 0, 0.0))
        self.assertEqual(stats["wrong_answers"][0]["count"], 2)
        csv_response = self.client.get(reverse("ctf-admin-exam-results-csv", args=[exam.slug]))
        self.assertEqual(csv_response.status_code, 200)
        self.assertIn(self.student.email, b"".join(csv_response.streaming_content).decode("utf-8"))

    # --- permissions --------------------------------------------------------
    def test_students_cannot_open_the_console(self):
        exam = f.make_ctf_exam(eligible_courses=[self.course])
        self.client.force_authenticate(self.student)
        for method, url in [
            ("get", reverse("ctf-admin-exams")),
            ("get", reverse("ctf-admin-exam-detail", args=[exam.slug])),
            ("get", reverse("ctf-admin-exam-results", args=[exam.slug])),
            ("post", reverse("ctf-admin-exam-publish", args=[exam.slug])),
            ("post", reverse("ctf-admin-exam-preview")),
            ("get", reverse("ctf-admin-batches")),
        ]:
            response = getattr(self.client, method)(url)
            self.assertEqual(response.status_code, 403, url)

    def test_instructors_read_only_their_own_batches(self):
        own = f.make_ctf_exam(eligible_courses=[self.course])
        f.make_ctf_question(exam=own)
        other = f.make_ctf_exam(eligible_courses=[self.other_course])
        outsider = f.make_user()
        f.make_enrollment(user=outsider, course=self.other_course)
        own.eligible_courses.add(self.other_course)
        start_participation(exam=own, user=self.student)
        start_participation(exam=own, user=outsider)
        self.client.force_authenticate(self.instructor)
        listing = self.client.get(reverse("ctf-admin-exams"))
        self.assertEqual(listing.status_code, 200)
        self.assertEqual([row["slug"] for row in listing.json()["data"]["results"]], [own.slug])
        self.assertFalse(listing.json()["data"]["can_manage"])
        self.assertEqual(self.client.get(reverse("ctf-admin-exam-detail", args=[other.slug])).status_code, 404)
        results = self.client.get(reverse("ctf-admin-exam-results", args=[own.slug])).json()["data"]
        self.assertEqual([row["student"]["id"] for row in results["participants"]], [self.student.pk])
        detail = self.client.get(reverse("ctf-admin-exam-detail", args=[own.slug])).json()["data"]
        self.assertIsNone(detail["readiness"])
        for method, name in [("post", "ctf-admin-exam-publish"), ("post", "ctf-admin-exam-close"), ("patch", "ctf-admin-exam-detail")]:
            response = getattr(self.client, method)(reverse(name, args=[own.slug]), {}, format="json")
            self.assertEqual(response.status_code, 403, name)

    def test_console_is_not_reachable_with_a_labs_origin_write(self):
        self.client.force_authenticate(self.staff)
        response = self.client.post(
            reverse("ctf-admin-exam-preview"),
            {"content": "{}"},
            format="json",
            HTTP_ORIGIN="https://labs.alsyedinitiative.com",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "labs_origin_forbidden")


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------
@override_settings(CTF_ANSWER_PEPPER=PEPPER, CTF_SCHEDULER_ENABLED=True)
class SchedulerTests(TestCase):
    def setUp(self):
        cache.clear()
        self.course = f.make_course()
        self.students = [f.make_user() for _ in range(3)]
        for student in self.students:
            f.make_enrollment(user=student, course=self.course)

    def scheduled_exam(self, opens_in=timedelta(minutes=-1), **overrides):
        now = timezone.now()
        exam = f.make_ctf_exam(
            status=CtfExam.STATUS_DRAFT,
            auto_publish=True,
            opens_at=now + opens_in,
            closes_at=now + opens_in + timedelta(hours=2),
            eligible_courses=[self.course],
            **overrides,
        )
        f.make_ctf_question(exam=exam, points=100, answers=["right"])
        return exam

    def run_twice(self, now=None):
        first = scheduler.run_scheduler(now)
        drain_outbox()
        second = scheduler.run_scheduler(now)
        drain_outbox()
        return first, second

    def test_auto_publish_at_opening_is_idempotent(self):
        exam = self.scheduled_exam()
        first, second = self.run_twice()
        self.assertEqual(first["published"], 1)
        self.assertEqual(second["published"], 0)
        exam.refresh_from_db()
        self.assertEqual(exam.status, CtfExam.STATUS_PUBLISHED)
        self.assertFalse(exam.auto_publish)
        self.assertIsNotNone(exam.publish_notified_at)
        self.assertEqual(Notification.objects.filter(event_key=f"ctf-exam-published:{exam.pk}").count(), 1)
        self.assertEqual(NotificationRecipient.objects.filter(notification__event_key=f"ctf-exam-published:{exam.pk}").count(), 3)

    def test_not_ready_exam_stays_draft_and_staff_are_told_once(self):
        staff = f.make_admin(is_staff=True)
        exam = self.scheduled_exam()
        exam.eligible_courses.clear()
        self.run_twice()
        exam.refresh_from_db()
        self.assertEqual(exam.status, CtfExam.STATUS_DRAFT)
        alert = Notification.objects.get(event_key__startswith=f"ctf-exam-not-ready:{exam.pk}:")
        self.assertEqual(list(alert.recipients.values_list("user_id", flat=True)), [staff.pk])

    def test_scheduled_exam_whose_window_passed_unready_is_unscheduled(self):
        exam = self.scheduled_exam(opens_in=timedelta(hours=-5))
        exam.eligible_courses.clear()
        self.run_twice()
        exam.refresh_from_db()
        self.assertEqual((exam.status, exam.auto_publish), (CtfExam.STATUS_DRAFT, False))
        self.assertFalse(scheduler.has_work())

    def test_console_unschedule_and_manual_publish_notice(self):
        exam = self.scheduled_exam(opens_in=timedelta(hours=2))
        from apps.ctf import console

        console.unschedule_exam(exam)
        exam.refresh_from_db()
        self.assertFalse(exam.auto_publish)
        self.run_twice()
        exam.refresh_from_db()
        self.assertEqual(exam.status, CtfExam.STATUS_DRAFT)
        self.assertIsNone(exam.opening_soon_notified_at)

    def test_opening_soon_notice_once(self):
        exam = self.scheduled_exam(opens_in=timedelta(minutes=30))
        first, second = self.run_twice()
        self.assertEqual(first["opening_soon"], 1)
        self.assertEqual(second["opening_soon"], 0)
        exam.refresh_from_db()
        self.assertIsNotNone(exam.opening_soon_notified_at)
        self.assertEqual(Notification.objects.filter(event_key__startswith=f"ctf-exam-opening-soon:{exam.pk}:").count(), 1)

    def test_close_expire_finalize_and_notify_results_once(self):
        exam = f.make_ctf_exam(eligible_courses=[self.course], published_at=timezone.now(), publish_notified_at=timezone.now())
        question = f.make_ctf_question(exam=exam, points=100, answers=["right"])
        first_student, second_student, _absent = self.students
        start_participation(exam=exam, user=first_student)
        start_participation(exam=exam, user=second_student)
        submit_attempt(exam=exam, user=first_student, question_key=question.key, answer="right")
        staff = f.make_admin()
        start_participation(exam=exam, user=staff)  # preview: never in results

        later = exam.closes_at + timedelta(minutes=1)
        first, second = self.run_twice(later)
        self.assertEqual((first["closed"], first["finalized"]), (1, 1))
        self.assertEqual((second["closed"], second["finalized"], second["expired"]), (0, 0, 0))
        exam.refresh_from_db()
        self.assertEqual(exam.status, CtfExam.STATUS_CLOSED)
        self.assertFalse(CtfParticipation.objects.filter(exam=exam, is_staff_preview=False, status="active").exists())
        results = {item.user_id: item for item in CtfExamResult.objects.filter(exam=exam)}
        self.assertEqual(set(results), {first_student.pk, second_student.pk})
        self.assertEqual((results[first_student.pk].score, results[first_student.pk].rank), (100, 1))
        self.assertEqual((results[second_student.pk].score, results[second_student.pk].rank), (0, 2))
        # Results notice: once per student, even when the handler runs again.
        scheduler.send_result_notices(exam.pk)
        notices = Notification.objects.filter(event_key__startswith=f"ctf-result:{exam.pk}:")
        self.assertEqual(notices.count(), 2)
        self.assertIn("100 / 100", notices.get(event_key=f"ctf-result:{exam.pk}:{first_student.pk}").body)

    def test_expires_participations_whose_time_ran_out(self):
        exam = f.make_ctf_exam(eligible_courses=[self.course], time_limit_minutes=10)
        f.make_ctf_question(exam=exam)
        participation, _ = start_participation(exam=exam, user=self.students[0])
        stats = scheduler.run_scheduler(participation.deadline_at + timedelta(seconds=1))
        self.assertEqual(stats["expired"], 1)
        participation.refresh_from_db()
        self.assertEqual(participation.status, CtfParticipation.STATUS_EXPIRED)

    def test_old_closed_exams_are_finalized_silently(self):
        long_ago = timezone.now() - timedelta(days=30)
        exam = f.make_ctf_exam(
            eligible_courses=[self.course], opens_at=long_ago - timedelta(hours=2), closes_at=long_ago
        )
        f.make_ctf_question(exam=exam)
        CtfParticipation.objects.create(
            exam=exam, user=self.students[0], status="submitted", started_at=long_ago - timedelta(hours=1)
        )
        self.run_twice()
        self.assertEqual(CtfExamResult.objects.filter(exam=exam).count(), 1)
        self.assertFalse(Notification.objects.filter(event_key__startswith=f"ctf-result:{exam.pk}:").exists())
        self.assertFalse(Notification.objects.filter(event_key=f"ctf-exam-published:{exam.pk}").exists())

    def test_periodic_hook_publishes_one_deduplicated_tick_only_when_due(self):
        self.assertIsNone(scheduler.schedule_tick())
        self.scheduled_exam()
        now = timezone.now()
        first = scheduler.schedule_tick(now)
        second = scheduler.schedule_tick(now)
        self.assertIsNotNone(first)
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(OutboxEvent.objects.filter(event_type=scheduler.EVENT_TICK).count(), 1)

    @override_settings(CTF_SCHEDULER_ENABLED=False)
    def test_flag_turns_the_scheduler_off(self):
        self.scheduled_exam()
        self.assertIsNone(scheduler.schedule_tick())


# ---------------------------------------------------------------------------
# Eligibility and protected evidence (student side, used by labs)
# ---------------------------------------------------------------------------
@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class EligibilityAndMaterialTests(_MediaMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.course = f.make_course()
        self.student = f.make_user()
        accept_terms(self.student)

    def eligibility(self, user=None):
        self.client.force_authenticate(user or self.student)
        response = self.client.get(reverse("ctf-eligibility"))
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def test_no_batch(self):
        data = self.eligibility()
        self.assertEqual((data["enabled"], data["reason"]), (False, "no_batch"))
        self.assertEqual(data["action"]["label"], "Browse courses")

    def test_access_expired(self):
        f.make_enrollment(
            user=self.student,
            course=self.course,
            access_type="installment",
            access_expires_at=timezone.now() - timedelta(days=1),
        )
        data = self.eligibility()
        self.assertEqual((data["enabled"], data["reason"]), (False, "access_expired"))
        self.assertEqual(data["action"]["label"], "Renew access")

    def test_not_assigned_mentions_a_scheduled_exam(self):
        f.make_enrollment(user=self.student, course=self.course)
        data = self.eligibility()
        self.assertEqual((data["enabled"], data["reason"]), (False, "not_assigned"))
        opens = timezone.now() + timedelta(days=1)
        f.make_ctf_exam(
            status=CtfExam.STATUS_DRAFT, auto_publish=True, opens_at=opens, closes_at=opens + timedelta(hours=1),
            eligible_courses=[self.course], title="Week 5 exam",
        )
        data = self.eligibility()
        self.assertEqual(data["reason"], "not_assigned")
        self.assertIn("Week 5 exam", data["message"])
        self.assertEqual(data["next_exam"]["title"]["en"], "Week 5 exam")

    def test_ok_points_at_the_open_exam_and_start_reasons(self):
        f.make_enrollment(user=self.student, course=self.course)
        exam = f.make_ctf_exam(eligible_courses=[self.course])
        f.make_ctf_question(exam=exam)
        upcoming = f.make_ctf_exam(
            eligible_courses=[self.course],
            opens_at=timezone.now() + timedelta(days=1),
            closes_at=timezone.now() + timedelta(days=2),
        )
        f.make_ctf_question(exam=upcoming)
        data = self.eligibility()
        self.assertEqual((data["enabled"], data["reason"], data["exam"]["slug"]), (True, "ok", exam.slug))
        listing = {item["slug"]: item for item in self.client.get(reverse("ctf-exams")).json()["data"]["results"]}
        self.assertEqual((listing[exam.slug]["can_start"], listing[exam.slug]["start_reason"]), (True, "ok"))
        self.assertEqual((listing[upcoming.slug]["can_start"], listing[upcoming.slug]["start_reason"]), (False, "not_open"))
        start_participation(exam=exam, user=self.student)
        listing = {item["slug"]: item for item in self.client.get(reverse("ctf-exams")).json()["data"]["results"]}
        self.assertEqual(listing[exam.slug]["start_reason"], "started")

    def test_anonymous_is_refused(self):
        response = self.client.get(reverse("ctf-eligibility"))
        self.assertEqual(response.status_code, 401)

    def test_evidence_only_through_signed_urls_after_start(self):
        f.make_enrollment(user=self.student, course=self.course)
        exam = f.make_ctf_exam(eligible_courses=[self.course])
        f.make_ctf_question(exam=exam, materials=[{"label": {"en": "Photo"}, "path": MATERIAL_PATH, "kind": "image"}])
        material = CtfMaterial(exam=exam, path=MATERIAL_PATH, size=len(JPEG))
        material.file.save("harbour.jpg", io.BytesIO(JPEG), save=False)
        material.save()
        self.client.force_authenticate(self.student)
        detail_url = reverse("ctf-exam-detail", args=[exam.slug])
        self.assertEqual(self.client.get(detail_url).json()["data"]["questions"], [])
        refresh_url = reverse("ctf-exam-material-url", args=[exam.slug, material.pk])
        self.assertEqual(self.client.get(refresh_url).status_code, 404)  # not started

        start_participation(exam=exam, user=self.student)
        item = self.client.get(detail_url).json()["data"]["questions"][0]["materials"][0]
        self.assertEqual(item["id"], material.pk)
        self.assertIn("/api/ctf/materials/", item["url"])
        self.assertNotIn("ctf_materials", item["url"])

        self.client.force_authenticate(None)
        file_response = self.client.get(item["url"])
        self.assertEqual(file_response.status_code, 200)
        self.assertEqual(b"".join(file_response.streaming_content), JPEG)
        self.assertEqual(file_response["Content-Type"], "image/jpeg")
        self.assertEqual(file_response["Cross-Origin-Resource-Policy"], "same-site")
        self.assertEqual(file_response["X-Content-Type-Options"], "nosniff")

        tampered = item["url"].rstrip("/") + "x/"
        self.assertEqual(self.client.get(tampered).status_code, 403)
        with override_settings(CTF_MATERIAL_URL_TTL_SECONDS=60):
            from unittest.mock import patch

            with patch("django.core.signing.time.time", return_value=timezone.now().timestamp() + 3600):
                self.assertEqual(self.client.get(item["url"]).status_code, 403)

        self.client.force_authenticate(self.student)
        refreshed = self.client.get(refresh_url)
        self.assertEqual(refreshed.status_code, 200)
        self.assertIn("/api/ctf/materials/", refreshed.json()["data"]["url"])

        # The participation is re-checked on every request.
        signed = refreshed.json()["data"]["url"]
        CtfAttempt.objects.filter(exam=exam)  # append-only rows are untouched
        CtfParticipation.objects.filter(exam=exam, user=self.student).delete()
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(signed).status_code, 404)

    def test_material_x_accel_redirect_in_production_mode(self):
        f.make_enrollment(user=self.student, course=self.course)
        exam = f.make_ctf_exam(eligible_courses=[self.course])
        f.make_ctf_question(exam=exam, materials=[{"label": {"en": "Photo"}, "path": MATERIAL_PATH, "kind": "image"}])
        material = CtfMaterial(exam=exam, path=MATERIAL_PATH, size=len(JPEG))
        material.file.save("harbour.jpg", io.BytesIO(JPEG), save=False)
        material.save()
        start_participation(exam=exam, user=self.student)
        from apps.ctf.materials import issue_token

        with override_settings(COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True):
            response = self.client.get(reverse("ctf-material-file", args=[issue_token(material, self.student)]))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["X-Accel-Redirect"].startswith("/_protected_media/ctf_materials/"))


# ---------------------------------------------------------------------------
# Pepper check (production)
# ---------------------------------------------------------------------------
class PepperCheckTests(TestCase):
    @override_settings(CTF_ANSWER_PEPPER="", APP_ENV="production")
    def test_missing_pepper_with_a_published_exam_is_reported_but_never_blocks_startup(self):
        self.assertEqual([item.id for item in checks.check_answer_pepper()], ["ctf.I001"])
        with override_settings(CTF_ANSWER_PEPPER=PEPPER, APP_ENV="development"):
            f.make_ctf_exam()
        messages = checks.check_answer_pepper()
        self.assertEqual([item.id for item in messages], ["ctf.I001", "ctf.I002"])
        self.assertTrue(all(item.level < WARNING for item in messages))
        self.assert_entrypoint_check_passes_and_prints(["ctf.I001", "ctf.I002"])

    @override_settings(CTF_ANSWER_PEPPER="too-short", APP_ENV="production")
    def test_weak_pepper_with_a_published_exam_is_reported_but_never_blocks_startup(self):
        with override_settings(CTF_ANSWER_PEPPER=PEPPER, APP_ENV="development"):
            f.make_ctf_exam()
        self.assertEqual([item.id for item in checks.check_answer_pepper()], ["ctf.I003", "ctf.I002"])
        self.assert_entrypoint_check_passes_and_prints(["ctf.I003", "ctf.I002"])

    def assert_entrypoint_check_passes_and_prints(self, ids):
        """entrypoint.sh runs ``check --deploy --fail-level WARNING`` before every
        backend/worker/recorder start: the pepper must not fail it, and the
        deploy log must still show why exams are off."""
        out = io.StringIO()
        call_command("check", "--deploy", "--fail-level", "WARNING", "--tag", "ctf", stdout=out, stderr=out)
        for check_id in ids:
            self.assertIn(f"({check_id})", out.getvalue())

    @override_settings(CTF_ANSWER_PEPPER="", APP_ENV="development")
    def test_development_needs_no_pepper(self):
        with override_settings(CTF_ANSWER_PEPPER=PEPPER):
            f.make_ctf_exam()
        self.assertEqual(checks.check_answer_pepper(), [])


# ---------------------------------------------------------------------------
# Unified gradebook
# ---------------------------------------------------------------------------
@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class GradebookTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.instructor = f.make_instructor()
        self.staff = f.make_admin()
        self.course = f.make_course(title="Batch G", instructor=self.instructor)
        self.other_course = f.make_course(title="Batch H")
        self.student = f.make_user(full_name="Gina Student")
        self.peer = f.make_user(full_name="Peer Student")
        accept_terms(self.instructor, self.staff, self.student, self.peer)
        f.make_enrollment(user=self.student, course=self.course)
        f.make_enrollment(user=self.peer, course=self.course)
        self.exam = f.make_ctf_exam(eligible_courses=[self.course], title="Midterm CTF")
        question = f.make_ctf_question(exam=self.exam, points=40, answers=["right"])
        start_participation(exam=self.exam, user=self.student)
        submit_attempt(exam=self.exam, user=self.student, question_key=question.key, answer="right")
        self.task = self.make_graded_report(self.student, Decimal("8.00"))

    def make_graded_report(self, student, marks):
        from apps.reports.models import ReportGrade, ReportSubmission, ReportTask

        task = ReportTask.objects.create(
            course=self.course,
            title="Target: Acme",
            week_number=1,
            due_at=timezone.now() - timedelta(days=1),
            max_marks=Decimal("10.00"),
            status=ReportTask.STATUS_PUBLISHED,
        )
        submission = ReportSubmission.objects.create(
            task=task, student=student, status=ReportSubmission.STATUS_GRADED, submitted_at=timezone.now()
        )
        ReportGrade.objects.create(submission=submission, raw_marks=marks, final_marks=marks, graded_at=timezone.now())
        return task

    def close_exam(self):
        later = self.exam.closes_at + timedelta(minutes=1)
        scheduler.run_scheduler(later)

    def test_batch_gradebook_has_reports_and_exams(self):
        self.close_exam()
        self.client.force_authenticate(self.instructor)
        response = self.client.get(reverse("gradebook-course", args=[self.course.pk]))
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual([column["kind"] for column in data["columns"]], ["report", "exam"])
        rows = {row["student"]["id"]: row for row in data["rows"]}
        mine = rows[self.student.pk]
        self.assertEqual([cell["value"] for cell in mine["cells"]], [8.0, 40.0])
        self.assertEqual(mine["totals"]["reports"]["percentage"], 80.0)
        self.assertEqual(mine["totals"]["exams"]["percentage"], 100.0)
        self.assertEqual(mine["totals"]["overall_percentage"], 90.0)
        peer_cells = rows[self.peer.pk]["cells"]
        self.assertEqual([cell["status"] for cell in peer_cells], ["missing", "absent"])

        export = self.client.get(reverse("gradebook-course-csv", args=[self.course.pk]))
        self.assertEqual(export.status_code, 200)
        text = b"".join(export.streaming_content).decode("utf-8")
        self.assertIn("Exam: Midterm CTF /40", text)
        self.assertIn("Gina Student", text)

    def test_exam_cell_is_pending_until_finalized(self):
        self.client.force_authenticate(self.staff)
        data = self.client.get(reverse("gradebook-course", args=[self.course.pk])).json()["data"]
        rows = {row["student"]["id"]: row for row in data["rows"]}
        self.assertEqual(rows[self.student.pk]["cells"][1]["status"], "in_progress")

    def test_student_sees_only_their_own(self):
        self.close_exam()
        self.client.force_authenticate(self.student)
        data = self.client.get(reverse("gradebook-me")).json()["data"]
        self.assertEqual(data["student"]["id"], self.student.pk)
        section = data["courses"][0]
        self.assertEqual([cell["value"] for cell in section["cells"]], [8.0, 40.0])
        for name, args in [
            ("gradebook-courses", []),
            ("gradebook-course", [self.course.pk]),
            ("gradebook-student", [self.peer.pk]),
            ("gradebook-course-csv", [self.course.pk]),
        ]:
            self.assertEqual(self.client.get(reverse(name, args=args)).status_code, 403, name)

    def test_unreleased_report_marks_stay_hidden_from_the_student(self):
        from apps.reports.models import ReportTask

        ReportTask.objects.filter(pk=self.task.pk).update(
            marks_visibility=ReportTask.MARKS_ON_RELEASE, marks_released_at=None
        )
        self.client.force_authenticate(self.student)
        data = self.client.get(reverse("gradebook-me")).json()["data"]
        self.assertIsNone(data["courses"][0]["cells"][0]["value"])
        # Staff still see the marks.
        self.client.force_authenticate(self.staff)
        book = self.client.get(reverse("gradebook-course", args=[self.course.pk])).json()["data"]
        rows = {row["student"]["id"]: row for row in book["rows"]}
        self.assertEqual(rows[self.student.pk]["cells"][0]["value"], 8.0)

    def test_instructor_scope(self):
        self.client.force_authenticate(self.instructor)
        courses = self.client.get(reverse("gradebook-courses")).json()["data"]["results"]
        self.assertEqual([item["id"] for item in courses], [self.course.pk])
        self.assertEqual(self.client.get(reverse("gradebook-course", args=[self.other_course.pk])).status_code, 404)
        outsider = f.make_user()
        f.make_enrollment(user=outsider, course=self.other_course)
        self.assertEqual(self.client.get(reverse("gradebook-student", args=[outsider.pk])).status_code, 404)
        student_view = self.client.get(reverse("gradebook-student", args=[self.student.pk]))
        self.assertEqual(student_view.status_code, 200)
        self.assertEqual(student_view.json()["data"]["courses"][0]["course"]["id"], self.course.pk)
