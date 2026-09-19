from datetime import timedelta
from decimal import Decimal
from importlib import import_module
from unittest.mock import patch

from apps.courses.admin import CourseReviewAdmin
from apps.courses.models import Course, CourseReview, Enrollment, Lecture, PentestingApplication, Section
from apps.payments.models import Payment
from apps.payments.provisioning import provision_paid_payment
from apps.users.models import User
from django.apps import apps
from django.contrib import admin
from django.core.cache import cache
from django.test import RequestFactory, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from tests.test_api import mark_terms_accepted


@override_settings(DIRECT_COURSE_PAYMENTS_ENABLED=True)
class CourseExperienceTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.course = Course.objects.create(
            title="OSINT", description="Practical investigations", price=3500, is_published=True
        )
        self.pentesting = Course.objects.create(
            title="Pentesting", description="Web security", price=5000, category="web_pentesting", is_published=True
        )
        self.student = User.objects.create_user(
            email="student@example.com", password="Strong-test-123!", full_name="Private Name"
        )
        mark_terms_accepted(self.student)
        self.application_data = dict(
            full_name="Example Student",
            email="applicant@example.com",
            phone="+919876543210",
            is_student=True,
            institution="Example College",
            education="Computer science",
            skill_level="beginner",
            experience="No previous experience",
            motivation="Learn testing",
            consent=True,
        )

    def experience(self, course=None):
        return self.client.get(f"/api/courses/{(course or self.course).pk}/experience/")

    def test_count_uses_paid_course_enrollments_and_is_fresh(self):
        enrollment = Enrollment.objects.create(course=self.course, user=self.student, payment_status="pending")
        self.assertEqual(self.experience().data["data"]["enrolled_students"], 0)
        enrollment.payment_status = "paid"
        enrollment.save()
        self.assertEqual(self.experience().data["data"]["enrolled_students"], 1)
        self.assertEqual(self.experience(self.pentesting).data["data"]["enrolled_students"], 0)
        enrollment.payment_status = "failed"
        enrollment.save()
        self.assertEqual(self.experience().data["data"]["enrolled_students"], 0)

    def test_curriculum_exposes_topics_without_playback_assets(self):
        Section.objects.create(course=self.course, title="Search", topics=["Search operators", "Evidence capture"])
        module = self.experience().data["data"]["modules"][0]
        self.assertEqual(module["topics"], ["Search operators", "Evidence capture"])
        self.assertNotIn("video", str(module))

    def test_application_throttle_is_independent_of_general_user_traffic(self):
        import time

        cache.set("throttle_user_127.0.0.1", [time.time()] * 1000)
        response = self.client.post(f"/api/courses/{self.pentesting.pk}/applications/", self.application_data)
        self.assertEqual(response.status_code, 201)

    def test_application_checkout_is_private_and_course_bound(self):
        self.client.force_authenticate(self.student)
        response = self.client.post(f"/api/courses/{self.pentesting.pk}/applications/", self.application_data)
        reference = response.data["data"]["reference"]
        self.client.force_authenticate(None)
        self.assertEqual(
            self.client.post(
                f"/api/courses/{self.pentesting.pk}/application-checkout/", {"reference": reference}
            ).status_code,
            403,
        )
        self.client.force_authenticate(self.student)
        self.assertEqual(
            self.client.post(
                f"/api/courses/{self.course.pk}/application-checkout/", {"reference": reference}
            ).status_code,
            404,
        )
        response = self.client.post(
            f"/api/courses/{self.pentesting.pk}/application-checkout/", {"reference": reference}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data["data"]), {"status", "payment_status"})

    def test_setup_is_idempotent_and_does_not_change_existing_courses(self):
        from io import StringIO

        from django.core.management import call_command

        call_command("setup_course_experience", stdout=StringIO())
        call_command("setup_course_experience", stdout=StringIO())
        self.assertEqual(Course.objects.filter(is_flagship=True).count(), 2)
        self.assertFalse(Course.objects.filter(is_flagship=True, is_published=True).exists())
        self.course.refresh_from_db()
        self.assertEqual(self.course.title, "OSINT")

    def test_review_requires_active_access_and_publishes_immediately(self):
        url = f"/api/courses/{self.course.pk}/reviews/"
        payload = {"rating": 5, "text": "Useful practical instruction."}
        self.assertIn(self.client.post(url, payload).status_code, (401, 403))
        self.client.force_authenticate(self.student)
        self.assertEqual(self.client.post(url, payload).status_code, 403)
        enrollment = Enrollment.objects.create(course=self.course, user=self.student, payment_status="pending")
        self.assertEqual(self.client.post(url, payload).status_code, 403)
        enrollment.payment_status = "paid"
        enrollment.access_type = Enrollment.ACCESS_INSTALLMENT
        enrollment.access_expires_at = timezone.now() - timedelta(minutes=1)
        enrollment.save()
        self.assertEqual(self.client.post(url, payload).status_code, 403)
        enrollment.access_expires_at = timezone.now() + timedelta(days=30)
        enrollment.save(update_fields=["access_expires_at"])
        self.assertEqual(self.client.post(url, {**payload, "rating": 6}).status_code, 400)
        response = self.client.post(url, payload)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["message"], "Your review has been published.")
        self.assertEqual(self.client.post(url, payload).status_code, 400)
        review = CourseReview.objects.get()
        self.assertEqual(review.status, CourseReview.STATUS_APPROVED)
        self.client.force_authenticate(None)
        data = self.experience().data["data"]
        self.assertEqual(data["average_rating"], 5)
        self.assertEqual(data["review_count"], 1)
        self.assertNotIn(self.student.email, str(data))
        self.assertNotIn(self.student.full_name, str(data))
        self.assertEqual(set(data["reviews"][0]), {"rating", "text", "author", "verified", "date"})
        review.edit_allowed = True
        review.save()
        self.client.force_authenticate(self.student)
        self.assertEqual(self.client.post(url, {**payload, "rating": 4}).status_code, 201)
        review.refresh_from_db()
        self.assertEqual(review.status, CourseReview.STATUS_APPROVED)
        self.assertFalse(review.edit_allowed)

    def test_hidden_and_unconfirmed_reviews_excluded_and_page_validated(self):
        CourseReview.objects.create(
            course=self.course, student=self.student, rating=1, text="Unconfirmed", status="approved"
        )
        self.assertEqual(self.experience().data["data"]["review_count"], 0)
        self.assertEqual(self.client.get(f"/api/courses/{self.course.pk}/experience/?page=bad").status_code, 400)
        self.course.is_published = False
        self.course.save()
        self.assertEqual(self.experience().status_code, 404)

    def test_catalog_exposes_fresh_verified_ratings_and_real_lesson_counts(self):
        section = Section.objects.create(course=self.course, title="Search")
        Lecture.objects.create(
            section=section,
            title="Evidence collection",
            description="Capture evidence safely.",
            video_key="courses/evidence-collection.mp4",
        )
        Enrollment.objects.create(
            course=self.course,
            user=self.student,
            payment_status=Enrollment.STATUS_PAID,
        )
        approved_review = CourseReview.objects.create(
            course=self.course,
            student=self.student,
            rating=5,
            text="Clear, practical, and useful.",
            status="approved",
        )
        unverified_student = User.objects.create_user(
            email="unverified@example.com",
            password="Strong-test-123!",
            full_name="Unverified Student",
        )
        CourseReview.objects.create(
            course=self.course,
            student=unverified_student,
            rating=1,
            text="This must not affect the public rating.",
            status="approved",
        )

        response = self.client.get("/api/courses/")
        course_data = next(item for item in response.data["data"] if item["id"] == self.course.pk)
        self.assertEqual(course_data["section_count"], 1)
        self.assertEqual(course_data["lecture_count"], 1)
        self.assertEqual(course_data["average_rating"], 5.0)
        self.assertEqual(course_data["review_count"], 1)

        approved_review.delete()
        response = self.client.get("/api/courses/")
        course_data = next(item for item in response.data["data"] if item["id"] == self.course.pk)
        self.assertIsNone(course_data["average_rating"])
        self.assertEqual(course_data["review_count"], 0)

    def test_admin_can_delete_reviews_without_a_moderation_queue(self):
        self.student.is_staff = True
        self.student.is_superuser = True
        self.student.save(update_fields=["is_staff", "is_superuser"])
        request = RequestFactory().get("/admin/courses/coursereview/")
        request.user = self.student
        review_admin = CourseReviewAdmin(CourseReview, admin.site)

        self.assertTrue(review_admin.has_delete_permission(request))
        actions = review_admin.get_actions(request)
        self.assertIn("delete_selected", actions)
        self.assertNotIn("approve_reviews", actions)
        self.assertNotIn("hide_reviews", actions)

        enrollment = Enrollment.objects.create(
            course=self.course,
            user=self.student,
            payment_status=Enrollment.STATUS_PAID,
        )
        review = CourseReview.objects.create(
            course=self.course,
            student=self.student,
            rating=4,
            text="A published review that an administrator can remove.",
        )
        review_admin.delete_queryset(request, CourseReview.objects.filter(pk=review.pk))
        self.assertFalse(CourseReview.objects.filter(pk=review.pk).exists())
        self.assertTrue(Enrollment.objects.filter(pk=enrollment.pk).exists())

    def test_review_migration_publishes_only_pending_reviews_with_active_access(self):
        active_review = CourseReview.objects.create(
            course=self.course,
            student=self.student,
            rating=5,
            text="Eligible pending review.",
            status=CourseReview.STATUS_PENDING,
        )
        Enrollment.objects.create(
            course=self.course,
            user=self.student,
            payment_status=Enrollment.STATUS_PAID,
        )
        inactive_student = User.objects.create_user(
            email="inactive-reviewer@example.com",
            password="Strong-test-123!",
        )
        inactive_review = CourseReview.objects.create(
            course=self.course,
            student=inactive_student,
            rating=3,
            text="Ineligible pending review.",
            status=CourseReview.STATUS_PENDING,
        )
        hidden_student = User.objects.create_user(
            email="hidden-reviewer@example.com",
            password="Strong-test-123!",
        )
        hidden_review = CourseReview.objects.create(
            course=self.course,
            student=hidden_student,
            rating=2,
            text="Previously hidden review.",
            status=CourseReview.STATUS_HIDDEN,
        )
        Enrollment.objects.create(
            course=self.course,
            user=hidden_student,
            payment_status=Enrollment.STATUS_PAID,
        )

        migration = import_module(
            "apps.courses.migrations.0031_publish_authorized_course_reviews"
        )
        migration.publish_authorized_pending_reviews(apps, None)

        active_review.refresh_from_db()
        inactive_review.refresh_from_db()
        hidden_review.refresh_from_db()
        self.assertEqual(active_review.status, CourseReview.STATUS_APPROVED)
        self.assertEqual(inactive_review.status, CourseReview.STATUS_PENDING)
        self.assertEqual(hidden_review.status, CourseReview.STATUS_HIDDEN)

    def test_application_conditional_validation_and_separate_storage(self):
        url = f"/api/courses/{self.pentesting.pk}/applications/"
        self.assertEqual(self.client.post(url, {**self.application_data, "institution": ""}).status_code, 400)
        self.assertEqual(self.client.post(url, {**self.application_data, "consent": False}).status_code, 400)
        response = self.client.post(url, {**self.application_data, "is_student": False})
        self.assertEqual(response.status_code, 201, response.data)
        application = PentestingApplication.objects.get()
        self.assertEqual(application.institution, "")
        self.assertEqual(Enrollment.objects.count(), 0)
        self.assertEqual(User.objects.count(), 1)
        self.assertEqual(self.client.get(url).status_code, 405)
        self.assertEqual(
            self.client.post(f"/api/courses/{self.course.pk}/applications/", self.application_data).status_code, 404
        )

    @patch("apps.payments.views.create_razorpay_order")
    def test_payment_requires_matching_application_and_verified_payment_enrolls(self, gateway):
        gateway.return_value = {"id": "order_application123", "currency": "INR", "amount": 500000}
        payload = {
            "course_id": self.pentesting.pk,
            "plan": "full",
            "buyer_name": "Example Student",
            "buyer_email": "applicant@example.com",
            "whatsapp_number": "+919876543210",
        }
        url = "/api/payment/create-order/"
        self.assertEqual(self.client.post(url, payload, format="json").status_code, 403)
        gateway.assert_not_called()
        reference = self.client.post(f"/api/courses/{self.pentesting.pk}/applications/", self.application_data).data[
            "data"
        ]["reference"]
        payload["application_reference"] = reference
        self.assertEqual(
            self.client.post(url, {**payload, "buyer_email": "other@example.com"}, format="json").status_code, 403
        )
        response = self.client.post(url, payload, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        payment = Payment.objects.get()
        self.assertEqual(payment.amount, Decimal("5000"))
        self.assertIsNotNone(payment.application_id)
        self.assertIsNone(provision_paid_payment(payment))
        self.assertFalse(Enrollment.objects.exists())
        payment.status = "paid"
        payment.razorpay_payment_id = "pay_application123"
        payment.save()
        provision_paid_payment(payment)
        payment.refresh_from_db()
        self.assertEqual(payment.application.status, "enrolled")
        self.assertEqual(payment.application.student_id, payment.user_id)
        self.assertEqual(payment.application.payment_status, "paid")
        self.assertEqual(Enrollment.objects.get().payment_status, "paid")
