"""Back-office bulk approve/reject goes through enrollment_actions row by row (UI plan §4.6, §4.8)."""

from unittest import mock

from apps.courses.models import Course, Enrollment, LiveClass, LiveClassEnrollment
from django.contrib.admin.models import LogEntry
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase
from django.urls import reverse


class EnrollmentBulkActionTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.admin = User.objects.create_superuser(email="bulk-admin@test.com", password="StrongPass@123", full_name="Admin")
        cls.course = Course.objects.create(title="OSINT Foundations", description="Learn.", price=10)
        cls.students = [
            User.objects.create_user(email=f"student{index}@test.com", password="StrongPass@123", full_name=f"Student {index}")
            for index in range(2)
        ]

    def setUp(self):
        self.client.force_login(self.admin)
        self.enrollments = [
            Enrollment.objects.create(user=student, course=self.course, payment_status=Enrollment.STATUS_PENDING)
            for student in self.students
        ]

    def run_action(self, url, action, ids):
        return self.client.post(url, {"action": action, "_selected_action": [str(pk) for pk in ids], "index": 0})

    def test_bulk_approve_saves_every_row_and_logs_it(self):
        saved = []

        def on_save(sender, instance, **kwargs):
            saved.append(instance.pk)

        post_save.connect(on_save, sender=Enrollment)
        try:
            with self.captureOnCommitCallbacks(execute=True):
                response = self.run_action(
                    reverse("admin:courses_enrollment_changelist"),
                    "approve_enrollment_requests",
                    [enrollment.pk for enrollment in self.enrollments],
                )
        finally:
            post_save.disconnect(on_save, sender=Enrollment)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(sorted(saved), sorted(enrollment.pk for enrollment in self.enrollments))
        self.assertEqual(Enrollment.objects.filter(payment_status=Enrollment.STATUS_PAID).count(), 2)
        self.assertEqual(LogEntry.objects.filter(object_id__in=[str(e.pk) for e in self.enrollments]).count(), 2)

    def test_bulk_reject_uses_the_service(self):
        with mock.patch("apps.courses.enrollment_actions.apply_to_queryset", return_value=2) as service:
            self.run_action(
                reverse("admin:courses_enrollment_changelist"),
                "reject_enrollment_requests",
                [enrollment.pk for enrollment in self.enrollments],
            )
        service.assert_called_once()
        self.assertEqual(service.call_args.args[0], "course")
        self.assertEqual(service.call_args.args[2], "reject")
        self.assertEqual(service.call_args.kwargs["by"], self.admin)

    def test_live_class_requests_use_the_service_too(self):
        live_class = LiveClass.objects.create(title="Friday batch", price=0)
        pending = LiveClassEnrollment.objects.create(user=self.students[0], live_class=live_class, status=LiveClassEnrollment.STATUS_PENDING)
        with self.captureOnCommitCallbacks(execute=True):
            self.run_action(reverse("admin:courses_liveclassenrollment_changelist"), "approve_enrollment_requests", [pending.pk])
        pending.refresh_from_db()
        self.assertEqual(pending.status, LiveClassEnrollment.STATUS_APPROVED)
