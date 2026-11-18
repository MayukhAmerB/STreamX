"""Deleting a course from the admin keeps its applications and unpaid orders."""

from decimal import Decimal

from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from apps.courses.models import Course, PentestingApplication
from apps.payments.models import Payment
from tests import factories as f


class CourseDeleteKeepsApplicationsTests(TestCase):
    def setUp(self):
        self.admin = f.make_admin()
        self.course = Course.objects.create(
            title="6-MONTH WEB & API PENTESTING COURSE", description="x", category="web_pentesting",
            launch_status="coming_soon", is_published=True, price=Decimal("18999.00"),
        )
        self.application = PentestingApplication.objects.create(
            course=self.course, full_name="Example Applicant", email="applicant@example.com",
            phone="+919876543210", is_student=False, education="BSc", skill_level="beginner",
            experience="none", motivation="learn", consent_at=timezone.now(),
        )
        self.order = Payment.objects.create(
            course=self.course, course_id_snapshot=self.course.pk, course_title_snapshot=self.course.title,
            application=self.application, buyer_name="Example Applicant", buyer_email="applicant@example.com",
            razorpay_order_id="order_del_1", amount=Decimal("18999.00"), currency="INR",
            status=Payment.STATUS_CREATED,
        )

    def test_snapshot_is_taken_on_create(self):
        self.assertEqual(self.application.course_title_snapshot, self.course.title)

    def test_admin_delete_succeeds_and_keeps_records(self):
        self.client.force_login(self.admin)
        url = reverse("admin:courses_course_delete", args=[self.course.pk])
        page = self.client.get(url)
        self.assertEqual(page.status_code, 200)
        self.assertNotContains(page, "would require deleting the following protected related objects")
        response = self.client.post(url, {"post": "yes"})
        self.assertEqual(response.status_code, 302, response.content[:500])
        self.assertFalse(Course.objects.filter(pk=self.course.pk).exists())

        self.application.refresh_from_db()
        self.assertIsNone(self.application.course_id)
        self.assertEqual(self.application.course_name, "6-MONTH WEB & API PENTESTING COURSE")
        self.order.refresh_from_db()
        self.assertIsNone(self.order.course_id)
        self.assertEqual(self.order.application_id, self.application.pk)
        self.assertEqual(self.order.course_title_snapshot, "6-MONTH WEB & API PENTESTING COURSE")

        changelist = self.client.get(reverse("admin:courses_pentestingapplication_changelist"))
        self.assertEqual(changelist.status_code, 200)
        self.assertContains(changelist, "6-MONTH WEB &amp; API PENTESTING COURSE")
        change = self.client.get(reverse("admin:courses_pentestingapplication_change", args=[self.application.pk]))
        self.assertEqual(change.status_code, 200)
