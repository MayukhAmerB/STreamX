import json
import os
import tempfile
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace
from urllib.parse import urlparse
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from django.urls import reverse
from django.test import override_settings
from rest_framework.test import APITestCase
from PIL import Image

from apps.courses.models import (
    Course,
    Enrollment,
    Lecture,
    LectureProgress,
    LiveClass,
    LiveClassEnrollment,
    PublicEnrollmentLead,
    Section,
)
from apps.courses.serializers import LectureSerializer
from apps.courses.services import transcode_lecture_to_hls
from apps.payments.models import Payment
from apps.realtime.models import RealtimeSession, RealtimeSessionRecording
from apps.users.models import AuthConfiguration, User
from apps.users.serializers import ProfileUpdateSerializer


class BaseAPITestCase(APITestCase):
    def setUp(self):
        # Reset throttling/cache state per test to avoid cross-test bleed.
        cache.clear()
        self.instructor = User.objects.create_user(
            email="instructor@test.com",
            password="StrongPass@123",
            full_name="Instructor Test",
            role=User.ROLE_INSTRUCTOR,
        )
        self.student = User.objects.create_user(
            email="student@test.com",
            password="StrongPass@123",
            full_name="Student Test",
            role=User.ROLE_STUDENT,
        )
        self.course = Course.objects.create(
            title="Test Course",
            description="Course description",
            price=Decimal("499.00"),
            instructor=self.instructor,
            is_published=True,
        )
        self.section = Section.objects.create(course=self.course, title="Section 1", order=1)
        self.lecture = Lecture.objects.create(
            section=self.section,
            title="Lecture 1",
            description="Intro lecture",
            video_key="videos/test.mp4",
            order=1,
            is_preview=False,
        )

    def login(self, email, password="StrongPass@123"):
        response = self.client.post(
            reverse("auth-login"),
            {"email": email, "password": password},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        return response


class AuthTests(APITestCase):
    def test_csrf_endpoint_returns_token_payload_and_cookie(self):
        response = self.client.get(reverse("auth-csrf"))
        self.assertEqual(response.status_code, 200)
        self.assertIn("csrftoken", response.cookies)
        self.assertTrue(response.data["csrf_token"])
        self.assertEqual(response.headers.get("X-CSRFToken"), response.data["csrf_token"])

    def test_current_user_endpoint_unauthenticated_returns_401(self):
        response = self.client.get(reverse("auth-user"))
        self.assertEqual(response.status_code, 401)
        self.assertFalse(response.data["success"])
        self.assertTrue(response.data["csrf_token"])

    def test_auth_config_endpoint_reflects_registration_toggle(self):
        config = AuthConfiguration.get_solo()
        config.registration_enabled = False
        config.save(update_fields=["registration_enabled", "updated_at"])
        response = self.client.get(reverse("auth-config"))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["data"]["registration_enabled"])

    def test_register_and_login_sets_jwt_cookies(self):
        config = AuthConfiguration.get_solo()
        config.registration_enabled = True
        config.save(update_fields=["registration_enabled", "updated_at"])

        register_resp = self.client.post(
            reverse("auth-register"),
            {
                "email": "newuser@test.com",
                "full_name": "New User",
                "password": "StrongPass@123",
                "role": "student",
            },
            format="json",
        )
        self.assertEqual(register_resp.status_code, 200)
        self.assertIn("access_token", register_resp.cookies)
        self.assertIn("refresh_token", register_resp.cookies)
        self.assertIn("csrftoken", register_resp.cookies)

        self.client.post(reverse("auth-logout"))
        login_resp = self.client.post(
            reverse("auth-login"),
            {"email": "newuser@test.com", "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(login_resp.status_code, 200)
        self.assertTrue(login_resp.data["success"])
        self.assertIn("csrftoken", login_resp.cookies)

    def test_register_is_blocked_when_disabled(self):
        config = AuthConfiguration.get_solo()
        config.registration_enabled = False
        config.save(update_fields=["registration_enabled", "updated_at"])

        response = self.client.post(
            reverse("auth-register"),
            {
                "email": "blocked@test.com",
                "full_name": "Blocked User",
                "password": "StrongPass@123",
                "role": "student",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertFalse(response.data["success"])

    def test_login_rejects_credentials_in_url_query_string(self):
        user = User.objects.create_user(
            email="querylogin@test.com",
            password="StrongPass@123",
            full_name="Query Login",
            role=User.ROLE_STUDENT,
        )
        response = self.client.post(
            f"{reverse('auth-login')}?email={user.email}&password=StrongPass@123",
            {"email": user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.data["success"])
        self.assertEqual(
            response.data["errors"]["detail"],
            "Credentials must not be sent in URL query parameters.",
        )

    def test_login_rejects_sqli_payload(self):
        user = User.objects.create_user(
            email="sqli-login@test.com",
            password="StrongPass@123",
            full_name="SQLi Login",
            role=User.ROLE_STUDENT,
        )
        response = self.client.post(
            reverse("auth-login"),
            {"email": user.email, "password": "' OR 1=1 --"},
            format="json",
        )
        payload = response.json()
        self.assertEqual(response.status_code, 400)
        self.assertFalse(payload["success"])

    @override_settings(
        EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
        DEFAULT_FROM_EMAIL="noreply@test.com",
        CONTACT_RECEIVER_EMAIL="contact@test.com",
    )
    def test_contact_endpoint_sends_email(self):
        response = self.client.post(
            reverse("auth-contact"),
            {
                "name": "Visitor",
                "email": "visitor@test.com",
                "subject": "Need help",
                "message": "I want to know more about your courses and pricing.",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["success"])
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("[Contact] Need help", mail.outbox[0].subject)
        self.assertEqual(mail.outbox[0].to, ["contact@test.com"])

    @override_settings(
        EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
        DEFAULT_FROM_EMAIL="noreply@test.com",
        FRONTEND_URL="http://localhost:5173",
    )
    def test_password_reset_request_and_confirm_updates_password(self):
        user = User.objects.create_user(
            email="resetme@test.com",
            password="StrongPass@123",
            full_name="Reset Me",
            role=User.ROLE_STUDENT,
        )
        request_resp = self.client.post(
            reverse("auth-password-reset"),
            {"email": user.email},
            format="json",
        )
        self.assertEqual(request_resp.status_code, 200)
        self.assertTrue(request_resp.data["success"])
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Reset your Al syed Initiative password", mail.outbox[0].subject)

        uid = urlsafe_base64_encode(force_bytes(user.pk))
        token = default_token_generator.make_token(user)
        confirm_resp = self.client.post(
            reverse("auth-password-reset-confirm"),
            {
                "uid": uid,
                "token": token,
                "new_password": "NewStrongPass@123",
            },
            format="json",
        )
        self.assertEqual(confirm_resp.status_code, 200)
        self.client.post(reverse("auth-logout"))
        login_resp = self.client.post(
            reverse("auth-login"),
            {"email": user.email, "password": "NewStrongPass@123"},
            format="json",
        )
        self.assertEqual(login_resp.status_code, 200)


class RateLimitTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            email="ratelimit@test.com",
            password="StrongPass@123",
            full_name="Rate Limit User",
            role=User.ROLE_STUDENT,
        )

    def test_login_endpoint_is_throttled(self):
        status_codes = []
        max_failures = int(getattr(settings, 'AUTH_LOGIN_MAX_FAILURES', 3))
        for _ in range(max_failures + 1):
            response = self.client.post(
                reverse("auth-login"),
                {"email": self.user.email, "password": "WrongPass@123"},
                format="json",
            )
            status_codes.append(response.status_code)
        self.assertEqual(status_codes[:max_failures], [400] * max_failures)
        self.assertEqual(status_codes[max_failures], 429)

    @override_settings(AUTH_LOGIN_MAX_FAILURES=1, AUTH_LOGIN_LOCKOUT_SECONDS=120)
    def test_login_is_temporarily_locked_after_repeated_failures(self):
        first = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "WrongPass@123"},
            format="json",
        )
        self.assertEqual(first.status_code, 400)

        second = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "WrongPass@123"},
            format="json",
        )
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second.data["errors"]["code"], "login_temporarily_locked")


class UploadValidationTests(APITestCase):
    def test_lecture_serializer_rejects_invalid_video_extension(self):
        instructor = User.objects.create_user(
            email="vid@test.com",
            password="StrongPass@123",
            full_name="Vid Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        course = Course.objects.create(
            title="Video Course",
            description="Course description",
            price=Decimal("100.00"),
            instructor=instructor,
            is_published=True,
        )
        section = Section.objects.create(course=course, title="Module 1", order=1)
        bad_video = SimpleUploadedFile("bad.exe", b"not-a-video", content_type="application/octet-stream")

        serializer = LectureSerializer(
            data={
                "section": section.id,
                "title": "Bad Lecture",
                "description": "Invalid file",
                "order": 1,
                "is_preview": False,
                "video_file": bad_video,
            }
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("video_file", serializer.errors)

    def test_profile_serializer_rejects_invalid_image_extension(self):
        user = User.objects.create_user(
            email="profile@test.com",
            password="StrongPass@123",
            full_name="Profile User",
            role=User.ROLE_STUDENT,
        )
        bad_image = SimpleUploadedFile("avatar.gif", b"GIF89a", content_type="image/gif")
        serializer = ProfileUpdateSerializer(
            user,
            data={"full_name": "Profile User", "profile_image": bad_image},
            partial=True,
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("profile_image", serializer.errors)

    def test_profile_serializer_rejects_non_image_payload_with_jpg_extension(self):
        user = User.objects.create_user(
            email="profile-binary@test.com",
            password="StrongPass@123",
            full_name="Profile User Binary",
            role=User.ROLE_STUDENT,
        )
        fake_jpg = SimpleUploadedFile("avatar.jpg", b"<script>alert('x')</script>", content_type="image/jpeg")
        serializer = ProfileUpdateSerializer(
            user,
            data={"full_name": "Profile User Binary", "profile_image": fake_jpg},
            partial=True,
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("profile_image", serializer.errors)

    def test_lecture_serializer_rejects_non_video_payload_with_mp4_extension(self):
        instructor = User.objects.create_user(
            email="vid-binary@test.com",
            password="StrongPass@123",
            full_name="Vid Instructor Binary",
            role=User.ROLE_INSTRUCTOR,
        )
        course = Course.objects.create(
            title="Video Binary Course",
            description="Course description",
            price=Decimal("100.00"),
            instructor=instructor,
            is_published=True,
        )
        section = Section.objects.create(course=course, title="Module 1", order=1)
        fake_video = SimpleUploadedFile("bad.mp4", b"not-a-real-video-container", content_type="video/mp4")

        serializer = LectureSerializer(
            data={
                "section": section.id,
                "title": "Bad Lecture Binary",
                "description": "Invalid video binary",
                "order": 1,
                "is_preview": False,
                "video_file": fake_video,
            }
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("video_file", serializer.errors)


class SecurityHeaderTests(APITestCase):
    def test_api_responses_include_security_headers(self):
        response = self.client.get(reverse("course-list-create"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response["Referrer-Policy"], "strict-origin-when-cross-origin")
        self.assertEqual(response["X-Frame-Options"], "DENY")
        self.assertIn("default-src 'none'", response["Content-Security-Policy"])
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertIn("payment=()", response["Permissions-Policy"])


class RequestFirewallTests(APITestCase):
    def test_blocks_sqli_in_query_params(self):
        response = self.client.get(
            reverse("course-list-create"),
            {"search": "' OR 1=1 --"},
        )
        payload = response.json()
        self.assertEqual(response.status_code, 400)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["message"], "Request blocked by security policy.")

    def test_blocks_url_encoded_sqli_payload(self):
        response = self.client.get(
            reverse("course-list-create"),
            {"search": "%27%20OR%201%3D1%20--"},
        )
        payload = response.json()
        self.assertEqual(response.status_code, 400)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["message"], "Request blocked by security policy.")

    @override_settings(
        EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
        DEFAULT_FROM_EMAIL="noreply@test.com",
        CONTACT_RECEIVER_EMAIL="contact@test.com",
    )
    def test_blocks_sqli_in_json_body(self):
        response = self.client.post(
            reverse("auth-contact"),
            {
                "name": "Visitor",
                "email": "visitor@test.com",
                "subject": "Need help",
                "message": "' UNION SELECT password FROM auth_user --",
            },
            format="json",
        )
        payload = response.json()
        self.assertEqual(response.status_code, 400)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["message"], "Request blocked by security policy.")


class PaginationTests(APITestCase):
    def setUp(self):
        self.instructor = User.objects.create_user(
            email="pagination-instructor@test.com",
            password="StrongPass@123",
            full_name="Pagination Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        for i in range(3):
            Course.objects.create(
                title=f"Course {i}",
                description="Course description",
                price=Decimal("100.00"),
                instructor=self.instructor,
                is_published=True,
            )
        for i in range(3):
            LiveClass.objects.create(
                title=f"Live Class {i}",
                description="Live class description",
                month_number=i + 1,
                level=LiveClass.LEVEL_BEGINNER if i == 0 else (LiveClass.LEVEL_INTERMEDIATE if i == 1 else LiveClass.LEVEL_ADVANCED),
                is_active=True,
            )

    def test_course_list_optional_pagination(self):
        response = self.client.get(reverse("course-list-create"), {"paginate": 1, "page": 1, "page_size": 2})
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data["data"], dict)
        self.assertIn("results", response.data["data"])
        self.assertIn("pagination", response.data["data"])
        self.assertEqual(len(response.data["data"]["results"]), 2)
        self.assertEqual(response.data["data"]["pagination"]["total"], 3)

    def test_live_class_list_optional_pagination(self):
        response = self.client.get(reverse("live-class-list"), {"paginate": 1, "page": 1, "page_size": 2})
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data["data"], dict)
        self.assertEqual(len(response.data["data"]["results"]), 2)
        self.assertEqual(response.data["data"]["pagination"]["total"], 3)

    def test_course_list_rejects_unknown_query_params(self):
        response = self.client.get(reverse("course-list-create"), {"unknown_field": "id"})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.data["success"])
        self.assertEqual(response.data["errors"]["detail"], "Unsupported query parameters.")

    def test_live_class_list_rejects_unknown_query_params(self):
        response = self.client.get(reverse("live-class-list"), {"order_by": "created_at"})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.data["success"])
        self.assertEqual(response.data["errors"]["detail"], "Unsupported query parameters.")


class PermissionTests(BaseAPITestCase):
    def test_student_cannot_create_course_but_instructor_can(self):
        self.login(self.student.email)
        student_resp = self.client.post(
            reverse("course-list-create"),
            {
                "title": "Student Course",
                "description": "Not allowed",
                "price": "100.00",
                "thumbnail": "",
                "is_published": False,
            },
            format="json",
        )
        self.assertEqual(student_resp.status_code, 403)

        self.client.post(reverse("auth-logout"))
        self.login(self.instructor.email)
        instructor_resp = self.client.post(
            reverse("course-list-create"),
            {
                "title": "Instructor Course",
                "description": "Allowed",
                "price": "100.00",
                "thumbnail": "",
                "is_published": False,
            },
            format="json",
        )
        self.assertEqual(instructor_resp.status_code, 201)
        self.assertTrue(instructor_resp.data["success"])

    def test_instructor_cannot_create_course_with_private_thumbnail_url(self):
        self.login(self.instructor.email)
        response = self.client.post(
            reverse("course-list-create"),
            {
                "title": "Private Thumbnail URL",
                "description": "Should be blocked",
                "price": "100.00",
                "thumbnail": "http://127.0.0.1/internal-image.png",
                "is_published": False,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("thumbnail", response.data["errors"])


class HostingerMediaUploadTests(BaseAPITestCase):
    @staticmethod
    def _build_thumbnail_file():
        image_buffer = BytesIO()
        Image.new("RGB", (64, 64), color="#2b8a3e").save(image_buffer, format="JPEG")
        image_buffer.seek(0)
        return SimpleUploadedFile("thumbnail.jpg", image_buffer.read(), content_type="image/jpeg")

    def test_instructor_can_create_course_with_uploaded_thumbnail(self):
        self.login(self.instructor.email)
        thumbnail = self._build_thumbnail_file()
        response = self.client.post(
            reverse("course-list-create"),
            {
                "title": "Uploaded Thumbnail Course",
                "description": "Course with local thumbnail upload",
                "price": "149.00",
                "thumbnail": "",
                "thumbnail_file": thumbnail,
                "is_published": False,
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201)
        created_course = Course.objects.get(title="Uploaded Thumbnail Course")
        self.assertTrue(bool(created_course.thumbnail_file))

    def test_instructor_can_create_lecture_with_uploaded_video_file(self):
        self.login(self.instructor.email)
        video_file = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom",
            content_type="video/mp4",
        )
        response = self.client.post(
            reverse("lecture-create"),
            {
                "section": self.section.id,
                "title": "Uploaded Lecture",
                "description": "Lecture with local file upload",
                "video_key": "",
                "video_file": video_file,
                "order": 2,
                "is_preview": False,
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 201)
        lecture = Lecture.objects.get(title="Uploaded Lecture")
        self.assertTrue(bool(lecture.video_file))
        self.assertEqual(lecture.video_key, "")


class InstructorDeletionSafetyTests(APITestCase):
    def test_deleting_instructor_keeps_course_with_null_instructor(self):
        instructor = User.objects.create_user(
            email="delete-instructor@test.com",
            password="StrongPass@123",
            full_name="Delete Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        course = Course.objects.create(
            title="Instructor Deletion Safe Course",
            description="Course should survive instructor deletion.",
            price=Decimal("199.00"),
            instructor=instructor,
            is_published=True,
            launch_status=Course.STATUS_COMING_SOON,
            category=Course.CATEGORY_OSINT,
            level=Course.LEVEL_BEGINNER,
        )

        instructor.delete()
        self.assertTrue(Course.objects.filter(pk=course.pk).exists())

        course.refresh_from_db()
        self.assertIsNone(course.instructor_id)

        response = self.client.get(reverse("course-list-create"))
        self.assertEqual(response.status_code, 200)
        returned_ids = {item["id"] for item in response.data["data"]}
        self.assertIn(course.id, returned_ids)


class PaymentVerificationTests(BaseAPITestCase):
    @patch("apps.payments.views.verify_razorpay_signature")
    def test_verify_payment_creates_enrollment(self, mock_verify):
        mock_verify.return_value = True
        payment = Payment.objects.create(
            user=self.student,
            course=self.course,
            razorpay_order_id="order_test_123",
            amount=self.course.price,
            currency="INR",
            status=Payment.STATUS_CREATED,
        )
        self.login(self.student.email)
        response = self.client.post(
            reverse("payment-verify"),
            {
                "course_id": self.course.id,
                "razorpay_order_id": payment.razorpay_order_id,
                "razorpay_payment_id": "pay_test_123",
                "razorpay_signature": "sig_test_123",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertTrue(
            Enrollment.objects.filter(
                user=self.student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            ).exists()
        )


class MyCoursesViewTests(BaseAPITestCase):
    def test_my_courses_returns_purchased_and_granted_courses_for_current_user(self):
        granted_course = Course.objects.create(
            title="Granted Course",
            description="Approved directly by admin.",
            price=Decimal("299.00"),
            instructor=self.instructor,
            is_published=True,
        )

        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        Payment.objects.create(
            user=self.student,
            course=self.course,
            razorpay_order_id="order_paid_library",
            razorpay_payment_id="pay_paid_library",
            razorpay_signature="sig_paid_library",
            amount=self.course.price,
            currency="INR",
            status=Payment.STATUS_PAID,
        )
        Enrollment.objects.create(
            user=self.student,
            course=granted_course,
            payment_status=Enrollment.STATUS_PAID,
        )
        Enrollment.objects.create(
            user=self.instructor,
            course=granted_course,
            payment_status=Enrollment.STATUS_PAID,
        )

        self.login(self.student.email)
        response = self.client.get(reverse("my-courses"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data["data"]), 2)

        returned = {item["id"]: item for item in response.data["data"]}
        self.assertEqual(returned[self.course.id]["access_source"], "purchased")
        self.assertEqual(returned[self.course.id]["access_label"], "Purchased")
        self.assertEqual(returned[self.course.id]["section_count"], 1)
        self.assertEqual(returned[self.course.id]["lecture_count"], 1)

        self.assertEqual(returned[granted_course.id]["access_source"], "granted")
        self.assertEqual(returned[granted_course.id]["access_label"], "Granted Access")

    def test_my_courses_excludes_pending_enrollments(self):
        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PENDING,
        )

        self.login(self.student.email)
        response = self.client.get(reverse("my-courses"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["data"], [])


class EnrollmentApprovalFlowTests(BaseAPITestCase):
    def test_course_enroll_request_creates_pending_enrollment(self):
        self.login(self.student.email)
        response = self.client.post(
            reverse("course-enroll"),
            {"course_id": self.course.id},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["data"]["enrollment_status"], Enrollment.STATUS_PENDING)
        self.assertFalse(response.data["data"]["is_enrolled"])
        enrollment = Enrollment.objects.get(user=self.student, course=self.course)
        self.assertEqual(enrollment.payment_status, Enrollment.STATUS_PENDING)

    def test_live_class_enroll_request_creates_pending_enrollment(self):
        live_class = LiveClass.objects.create(
            title="Approval Live Class",
            description="Live class approval flow",
            level=LiveClass.LEVEL_BEGINNER,
            month_number=1,
            is_active=True,
        )
        self.login(self.student.email)
        response = self.client.post(
            reverse("live-class-enroll"),
            {"live_class_id": live_class.id},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["data"]["enrollment_status"], LiveClassEnrollment.STATUS_PENDING)
        self.assertFalse(response.data["data"]["enrolled"])
        enrollment = LiveClassEnrollment.objects.get(user=self.student, live_class=live_class)
        self.assertEqual(enrollment.status, LiveClassEnrollment.STATUS_PENDING)


class PublicEnrollmentLeadTests(BaseAPITestCase):
    def test_guest_can_submit_course_enrollment_lead(self):
        response = self.client.post(
            reverse("public-enrollment-lead-create"),
            {
                "course_id": self.course.id,
                "email": "guest@example.com",
                "phone_number": "+91 90000 11111",
                "whatsapp_number": "+91 90000 22222",
                "message": "I want to join this course to build practical OSINT skills.",
                "source_path": "/courses/1",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["success"])
        self.assertEqual(response.data["data"]["target_type"], "course")
        self.assertTrue(
            PublicEnrollmentLead.objects.filter(
                course=self.course,
                email="guest@example.com",
                status=PublicEnrollmentLead.STATUS_NEW,
            ).exists()
        )

    def test_guest_can_submit_live_class_enrollment_lead(self):
        live_class = LiveClass.objects.create(
            title="Guest Lead Live Class",
            description="Live class for guest lead test",
            level=LiveClass.LEVEL_BEGINNER,
            month_number=1,
            is_active=True,
        )
        response = self.client.post(
            reverse("public-enrollment-lead-create"),
            {
                "live_class_id": live_class.id,
                "email": "guest.live@example.com",
                "phone_number": "+91 95555 11111",
                "whatsapp_number": "+91 95555 22222",
                "message": "I prefer interactive live classes and want to enroll this month.",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["data"]["target_type"], "live_class")
        self.assertTrue(
            PublicEnrollmentLead.objects.filter(
                live_class=live_class,
                email="guest.live@example.com",
            ).exists()
        )

    def test_guest_enrollment_lead_requires_single_target_and_message(self):
        response = self.client.post(
            reverse("public-enrollment-lead-create"),
            {
                "course_id": self.course.id,
                "live_class_id": 1,
                "email": "invalid@example.com",
                "phone_number": "+91 90000 11111",
                "whatsapp_number": "+91 90000 22222",
                "message": "",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.data["success"])
        self.assertIn("message", response.data["errors"])

class LectureVideoAccessTests(BaseAPITestCase):
    @patch("apps.courses.views.generate_signed_video_url")
    def test_enrolled_student_can_get_signed_url_and_unenrolled_cannot(self, mock_signed):
        mock_signed.return_value = "https://signed.example.com/video"
        self.login(self.student.email)
        denied = self.client.get(reverse("lecture-video", kwargs={"pk": self.lecture.id}))
        self.assertEqual(denied.status_code, 403)

        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        allowed = self.client.get(reverse("lecture-video", kwargs={"pk": self.lecture.id}))
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.data["data"]["signed_url"], "https://signed.example.com/video")

    def test_local_uploaded_lecture_returns_protected_playback_url(self):
        with tempfile.TemporaryDirectory() as temp_dir, override_settings(
            MEDIA_ROOT=temp_dir,
            COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True,
        ):
            lecture = Lecture.objects.create(
                section=self.section,
                title="Uploaded Lecture",
                description="Protected local video",
                video_file=SimpleUploadedFile("lesson.mp4", b"fake video payload", content_type="video/mp4"),
                order=2,
                is_preview=False,
            )
            Enrollment.objects.create(
                user=self.student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            )

            self.login(self.student.email)
            response = self.client.get(reverse("lecture-video", kwargs={"pk": lecture.id}))
            self.assertEqual(response.status_code, 200)
            playback_url = response.data["data"]["playback_url"]
            self.assertIn(f"/api/lectures/{lecture.id}/playback/", playback_url)
            self.assertNotIn("/media/", playback_url)

            protected_response = self.client.get(urlparse(playback_url).path)
            self.assertEqual(protected_response.status_code, 200)
            self.assertEqual(
                protected_response.headers.get("X-Accel-Redirect"),
                f"/_protected_media/{lecture.video_file.name}",
            )

    def test_legacy_local_video_key_uses_expected_upload_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir, override_settings(
            MEDIA_ROOT=temp_dir,
            COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True,
        ):
            expected_rel_path = os.path.join(
                "lecture_videos",
                self.course.slug,
                f"module_{self.section.id}",
                "legacy-lesson.mp4",
            )
            expected_abs_path = os.path.join(temp_dir, expected_rel_path)
            os.makedirs(os.path.dirname(expected_abs_path), exist_ok=True)
            with open(expected_abs_path, "wb") as handle:
                handle.write(b"legacy-video")

            lecture = Lecture.objects.create(
                section=self.section,
                title="Legacy Uploaded Lecture",
                description="Legacy key points to local upload directory",
                video_key="qwerty",
                order=2,
                is_preview=False,
            )
            Enrollment.objects.create(
                user=self.student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            )

            self.login(self.student.email)
            response = self.client.get(reverse("lecture-video", kwargs={"pk": lecture.id}))
            self.assertEqual(response.status_code, 200)
            playback_url = response.data["data"]["playback_url"]
            self.assertIn(f"/api/lectures/{lecture.id}/playback/", playback_url)

            protected_response = self.client.get(urlparse(playback_url).path)
            self.assertEqual(protected_response.status_code, 200)
            self.assertEqual(
                protected_response.headers.get("X-Accel-Redirect"),
                f"/_protected_media/{expected_rel_path.replace(os.sep, '/')}",
            )

    def test_local_hls_manifest_returns_protected_playback_url(self):
        with tempfile.TemporaryDirectory() as temp_dir, override_settings(
            MEDIA_ROOT=temp_dir,
            COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True,
        ):
            manifest_path = os.path.join("streams", "test-course", "lecture_99", "master.m3u8")
            segment_path = os.path.join("streams", "test-course", "lecture_99", "segment_000.ts")
            os.makedirs(os.path.dirname(os.path.join(temp_dir, manifest_path)), exist_ok=True)
            with open(os.path.join(temp_dir, manifest_path), "w", encoding="utf-8") as handle:
                handle.write("#EXTM3U\n#EXTINF:6.0,\nsegment_000.ts\n")
            with open(os.path.join(temp_dir, segment_path), "wb") as handle:
                handle.write(b"segment-bytes")

            lecture = Lecture.objects.create(
                section=self.section,
                title="HLS Lecture",
                description="Protected local HLS",
                video_key="videos/source.mp4",
                stream_status=Lecture.STREAM_READY,
                stream_manifest_key=manifest_path.replace("\\", "/"),
                order=3,
                is_preview=False,
            )
            Enrollment.objects.create(
                user=self.student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            )

            self.login(self.student.email)
            response = self.client.get(reverse("lecture-video", kwargs={"pk": lecture.id}))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data["data"]["playback_type"], "hls")
            playback_url = response.data["data"]["playback_url"]
            self.assertIn(f"/api/lectures/{lecture.id}/playback/", playback_url)

            protected_response = self.client.get(urlparse(playback_url).path)
            self.assertEqual(protected_response.status_code, 200)
            self.assertEqual(
                protected_response.headers.get("X-Accel-Redirect"),
                f"/_protected_media/{lecture.stream_manifest_key}",
            )

    def test_course_detail_hides_uploaded_video_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir, override_settings(MEDIA_ROOT=temp_dir):
            lecture = Lecture.objects.create(
                section=self.section,
                title="Uploaded Lecture",
                description="Should not leak file paths",
                video_file=SimpleUploadedFile("hidden.mp4", b"video", content_type="video/mp4"),
                order=2,
                is_preview=False,
            )

            response = self.client.get(reverse("course-detail", kwargs={"pk": self.course.id}))
            self.assertEqual(response.status_code, 200)
            lectures = response.data["data"]["sections"][0]["lectures"]
            payload = next(item for item in lectures if item["id"] == lecture.id)
            self.assertNotIn("video_file", payload)
            self.assertNotIn("video_file_url", payload)

    def test_live_class_approval_does_not_grant_course_video_access(self):
        linked_live_class = LiveClass.objects.create(
            title="Linked Live Class",
            description="Live access only",
            level=LiveClass.LEVEL_BEGINNER,
            month_number=1,
            is_active=True,
            linked_course=self.course,
        )
        LiveClassEnrollment.objects.create(
            user=self.student,
            live_class=linked_live_class,
            status=LiveClassEnrollment.STATUS_APPROVED,
        )

        self.login(self.student.email)
        denied = self.client.get(reverse("lecture-video", kwargs={"pk": self.lecture.id}))
        self.assertEqual(denied.status_code, 403)


class LectureProgressTests(BaseAPITestCase):
    def test_enrolled_student_can_save_and_fetch_lecture_progress(self):
        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        self.login(self.student.email)

        update_response = self.client.put(
            reverse("lecture-progress", kwargs={"pk": self.lecture.id}),
            {
                "position_seconds": 147,
                "duration_seconds": 600,
            },
            format="json",
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.data["data"]["last_position_seconds"], 147)
        self.assertEqual(update_response.data["data"]["percent_complete"], 24)
        self.assertFalse(update_response.data["data"]["completed"])

        detail_response = self.client.get(reverse("course-detail", kwargs={"pk": self.course.id}))
        self.assertEqual(detail_response.status_code, 200)
        lecture_payload = detail_response.data["data"]["sections"][0]["lectures"][0]
        self.assertEqual(lecture_payload["progress"]["last_position_seconds"], 147)
        self.assertEqual(lecture_payload["progress"]["resume_position_seconds"], 147)

        fetch_response = self.client.get(reverse("lecture-progress", kwargs={"pk": self.lecture.id}))
        self.assertEqual(fetch_response.status_code, 200)
        self.assertEqual(fetch_response.data["data"]["last_position_seconds"], 147)

    def test_progress_update_marks_completion_and_blocks_unenrolled_student(self):
        self.login(self.student.email)
        denied = self.client.put(
            reverse("lecture-progress", kwargs={"pk": self.lecture.id}),
            {"position_seconds": 40, "duration_seconds": 120},
            format="json",
        )
        self.assertEqual(denied.status_code, 403)

        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        completed = self.client.put(
            reverse("lecture-progress", kwargs={"pk": self.lecture.id}),
            {"position_seconds": 118, "duration_seconds": 120},
            format="json",
        )
        self.assertEqual(completed.status_code, 200)
        self.assertTrue(completed.data["data"]["completed"])

        progress = LectureProgress.objects.get(user=self.student, lecture=self.lecture)
        self.assertTrue(progress.completed)
        self.assertEqual(progress.resume_position_seconds(), 0)


class AdaptiveHLSTranscodeTests(BaseAPITestCase):
    @patch("apps.courses.services.subprocess.run")
    def test_transcode_lecture_to_hls_generates_master_playlist_and_duration(self, mock_run):
        with tempfile.TemporaryDirectory() as temp_dir, override_settings(MEDIA_ROOT=temp_dir):
            lecture = Lecture.objects.create(
                section=self.section,
                title="Adaptive Lecture",
                description="Adaptive stream generation",
                video_file=SimpleUploadedFile("adaptive.mp4", b"source-bytes", content_type="video/mp4"),
                order=2,
            )

            def fake_run(cmd, check=False, capture_output=False, text=False):
                executable = os.path.basename(str(cmd[0]))
                if executable == "ffprobe":
                    return SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(
                            {
                                "streams": [
                                    {"codec_type": "video", "width": 1280, "height": 720},
                                    {"codec_type": "audio"},
                                ],
                                "format": {"duration": "612.4"},
                            }
                        ),
                        stderr="",
                    )

                output_path = cmd[-1]
                segment_pattern = cmd[cmd.index("-hls_segment_filename") + 1]
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                with open(output_path, "w", encoding="utf-8") as handle:
                    handle.write("#EXTM3U\n#EXTINF:6.0,\nsegment_000.ts\n")
                with open(segment_pattern.replace("%03d", "000"), "wb") as handle:
                    handle.write(b"segment")
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            mock_run.side_effect = fake_run
            transcode_lecture_to_hls(lecture)
            lecture.refresh_from_db()

            self.assertEqual(lecture.stream_status, Lecture.STREAM_READY)
            self.assertEqual(lecture.stream_duration_seconds, 612)
            self.assertTrue(lecture.stream_manifest_key.endswith("master.m3u8"))

            master_playlist_path = os.path.join(temp_dir, lecture.stream_manifest_key)
            self.assertTrue(os.path.exists(master_playlist_path))
            with open(master_playlist_path, "r", encoding="utf-8") as handle:
                master_playlist = handle.read()
            self.assertIn("360p/index.m3u8", master_playlist)
            self.assertIn("540p/index.m3u8", master_playlist)
            self.assertIn("720p/index.m3u8", master_playlist)


class RealtimeSessionTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.host = User.objects.create_user(
            email="host@test.com",
            password="StrongPass@123",
            full_name="Host User",
            role=User.ROLE_INSTRUCTOR,
            is_staff=True,
        )
        self.viewer = User.objects.create_user(
            email="viewer@test.com",
            password="StrongPass@123",
            full_name="Viewer User",
            role=User.ROLE_STUDENT,
        )
        self.meeting_course = Course.objects.create(
            title="Realtime Meeting Course",
            description="Course used to gate realtime meetings in tests.",
            price=Decimal("999.00"),
            instructor=self.host,
            is_published=True,
        )
        self.live_class = LiveClass.objects.create(
            title="Realtime Meeting Live Class",
            description="Live class linked to realtime meeting tests.",
            level=LiveClass.LEVEL_BEGINNER,
            month_number=1,
            is_active=True,
            linked_course=self.meeting_course,
        )
        LiveClassEnrollment.objects.create(
            user=self.viewer,
            live_class=self.live_class,
            status=LiveClassEnrollment.STATUS_APPROVED,
        )

    def login(self, email, password="StrongPass@123"):
        response = self.client.post(
            reverse("auth-login"),
            {"email": email, "password": password},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        return response

    def test_realtime_create_rejects_private_rtmp_target_url(self):
        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "Unsafe RTMP",
                "description": "Should be blocked",
                "session_type": "broadcasting",
                "linked_live_class_id": self.live_class.id,
                "meeting_capacity": 100,
                "max_audience": 1000,
                "rtmp_target_url": "rtmp://127.0.0.1:1935/live/key",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("rtmp_target_url", response.data["errors"])

    def test_broadcast_create_requires_linked_live_class(self):
        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "Broadcast Without Live Class",
                "description": "Should be blocked",
                "session_type": "broadcasting",
                "meeting_capacity": 100,
                "max_audience": 1000,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("linked_live_class_id", response.data["errors"])

    def test_realtime_list_rejects_unknown_query_params(self):
        self.login(self.viewer.email)
        response = self.client.get(reverse("realtime-session-list-create"), {"filter": "host"})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.data["success"])
        self.assertEqual(response.data["errors"]["detail"], "Unsupported query parameters.")

    def test_realtime_list_requires_authentication(self):
        response = self.client.get(reverse("realtime-session-list-create"), {"status": "all"})
        self.assertEqual(response.status_code, 401)

    def test_realtime_list_only_shows_permitted_sessions_for_student(self):
        permitted_live_class = self.live_class
        blocked_live_class = LiveClass.objects.create(
            title="Blocked Live Class",
            description="Blocked session",
            level=LiveClass.LEVEL_INTERMEDIATE,
            month_number=2,
            is_active=True,
        )
        allowed_session = RealtimeSession.objects.create(
            title="Allowed Session",
            description="Student should see this",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=permitted_live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )
        RealtimeSession.objects.create(
            title="Blocked Session",
            description="Student should not see this",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=blocked_live_class,
            status=RealtimeSession.STATUS_LIVE,
        )
        allowed_broadcast = RealtimeSession.objects.create(
            title="Allowed Broadcast",
            description="Student should see this broadcast",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=permitted_live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )
        blocked_broadcast = RealtimeSession.objects.create(
            title="Blocked Broadcast",
            description="Student should not see this broadcast",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=blocked_live_class,
            status=RealtimeSession.STATUS_LIVE,
        )

        self.login(self.viewer.email)
        response = self.client.get(reverse("realtime-session-list-create"), {"status": "all"})
        self.assertEqual(response.status_code, 200)
        returned_ids = {item["id"] for item in response.data["data"]}
        self.assertIn(allowed_session.id, returned_ids)
        self.assertIn(allowed_broadcast.id, returned_ids)
        self.assertNotIn(blocked_broadcast.id, returned_ids)

    def test_unapproved_student_cannot_fetch_or_join_broadcast_session(self):
        blocked_user = User.objects.create_user(
            email="blocked-broadcast@test.com",
            password="StrongPass@123",
            full_name="Blocked Broadcast Viewer",
            role=User.ROLE_STUDENT,
        )
        session = RealtimeSession.objects.create(
            title="Restricted Broadcast",
            description="Only approved students allowed",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            stream_embed_url="https://stream.example.com/embed/video",
        )

        self.login(blocked_user.email)
        detail_response = self.client.get(reverse("realtime-session-detail", kwargs={"pk": session.id}))
        self.assertEqual(detail_response.status_code, 403)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Blocked Broadcast Viewer"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 403)

    def test_unapproved_student_cannot_fetch_or_join_session(self):
        blocked_user = User.objects.create_user(
            email="blocked-viewer@test.com",
            password="StrongPass@123",
            full_name="Blocked Viewer",
            role=User.ROLE_STUDENT,
        )
        session = RealtimeSession.objects.create(
            title="Restricted Meeting",
            description="Only approved students allowed",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )
        self.login(blocked_user.email)
        detail_response = self.client.get(reverse("realtime-session-detail", kwargs={"pk": session.id}))
        self.assertEqual(detail_response.status_code, 403)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Blocked Viewer"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 403)

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_join_meeting_returns_livekit_payload(
        self,
        mock_participant_count,
        mock_build_token,
        mock_build_meet_url,
    ):
        mock_participant_count.return_value = 12
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"

        self.login(self.host.email)
        create_response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "Blue Team Session",
                "description": "Interactive meeting session",
                "session_type": "meeting",
                "linked_live_class_id": self.live_class.id,
                "meeting_capacity": 100,
            },
            format="json",
        )
        self.assertEqual(create_response.status_code, 201)
        session_id = create_response.data["data"]["id"]

        self.client.post(reverse("auth-logout"))
        self.login(self.viewer.email)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session_id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 200)
        self.assertEqual(join_response.data["data"]["mode"], "meeting")
        self.assertEqual(join_response.data["data"]["meeting"]["token"], "lk.token")
        self.assertFalse(join_response.data["data"]["meeting"]["permissions"]["can_speak"])
        self.assertFalse(join_response.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertEqual(mock_build_token.call_count, 1)
        self.assertFalse(mock_build_token.call_args.kwargs["can_publish"])
        self.assertIsNone(mock_build_token.call_args.kwargs["can_publish_sources"])
        self.assertEqual(mock_build_token.call_args.kwargs["participant_metadata"]["user_id"], self.viewer.id)
        self.assertEqual(mock_build_token.call_args.kwargs["participant_metadata"]["role"], User.ROLE_STUDENT)
        self.assertFalse(mock_build_token.call_args.kwargs["participant_metadata"]["is_admin"])
        self.assertEqual(join_response.data["data"]["meeting"]["participant_profile_image_url"], "")

    @patch("apps.realtime.views.get_room_participant_count")
    def test_join_switches_to_broadcast_when_meeting_capacity_reached(self, mock_participant_count):
        mock_participant_count.return_value = 100

        session = RealtimeSession.objects.create(
            title="Overflow Session",
            description="Auto stream fallback",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=100,
            max_audience=50000,
            allow_overflow_broadcast=True,
            stream_embed_url="https://stream.example.com/embed/video",
            chat_embed_url="https://stream.example.com/embed/chat",
        )

        self.login(self.viewer.email)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {},
            format="json",
        )
        self.assertEqual(join_response.status_code, 200)
        self.assertEqual(join_response.data["data"]["mode"], "broadcast")
        self.assertTrue(join_response.data["data"]["overflow_triggered"])
        self.assertEqual(
            join_response.data["data"]["broadcast"]["stream_embed_url"],
            "https://stream.example.com/embed/video",
        )

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
    )
    @patch("apps.realtime.views.build_host_publisher_token")
    def test_host_token_endpoint_allows_only_host(self, mock_build_host_token):
        mock_build_host_token.return_value = {"identity": "host-1", "token": "token-1"}
        session = RealtimeSession.objects.create(
            title="Host Token Session",
            description="Host token checks",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_LIVE,
        )

        self.login(self.viewer.email)
        denied = self.client.post(reverse("realtime-session-host-token", kwargs={"pk": session.id}), {}, format="json")
        self.assertEqual(denied.status_code, 403)

        self.client.post(reverse("auth-logout"))
        self.login(self.host.email)
        allowed = self.client.post(reverse("realtime-session-host-token", kwargs={"pk": session.id}), {}, format="json")
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.data["data"]["token"], "token-1")

    @override_settings(
        OWNCAST_RTMP_TARGET="rtmp://localhost:1935/live/stream-key",
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
    )
    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_start_stream_updates_session_status(self, mock_start_egress):
        mock_start_egress.return_value = "EG_test_123"
        session = RealtimeSession.objects.create(
            title="Go Live Session",
            description="Browser live stream session",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_LIVE,
        )

        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-stream-start", kwargs={"pk": session.id}),
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertEqual(session.livekit_egress_id, "EG_test_123")

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_RECORDING_ENABLED=True,
    )
    @patch("apps.realtime.views.start_room_recording_egress")
    def test_start_recording_creates_recording_entry(self, mock_start_recording):
        mock_start_recording.return_value = {
            "egress_id": "EG_recording_123",
            "output_file_path": "recordings/meeting/session-123.mp4",
            "response": {"egress_id": "EG_recording_123"},
        }
        session = RealtimeSession.objects.create(
            title="Meeting Recording Session",
            description="Recording flow",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )

        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-recording-start", kwargs={"pk": session.id}),
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(RealtimeSessionRecording.objects.filter(session=session).count(), 1)

        recording = RealtimeSessionRecording.objects.get(session=session)
        self.assertEqual(recording.status, RealtimeSessionRecording.STATUS_RECORDING)
        self.assertEqual(recording.livekit_egress_id, "EG_recording_123")

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_RECORDING_ENABLED=True,
    )
    @patch("apps.realtime.views.stop_room_recording_egress")
    def test_stop_recording_marks_recording_completed(self, mock_stop_recording):
        mock_stop_recording.return_value = {
            "egress_id": "EG_recording_999",
            "file_results": [
                {
                    "filename": "recordings/meeting/session-999.mp4",
                    "location": "https://media.example.com/recordings/meeting/session-999.mp4",
                }
            ],
        }
        session = RealtimeSession.objects.create(
            title="Meeting Recording Stop Session",
            description="Recording stop flow",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )
        recording = RealtimeSessionRecording.objects.create(
            session=session,
            recording_type=RealtimeSession.TYPE_MEETING,
            started_by=self.host,
            status=RealtimeSessionRecording.STATUS_RECORDING,
            livekit_egress_id="EG_recording_999",
            output_file_path="recordings/meeting/session-999.mp4",
        )

        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-recording-stop", kwargs={"pk": session.id}),
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        recording.refresh_from_db()
        self.assertEqual(recording.status, RealtimeSessionRecording.STATUS_COMPLETED)
        self.assertEqual(
            recording.output_download_url,
            "https://media.example.com/recordings/meeting/session-999.mp4",
        )

    def test_browser_fallback_upload_creates_completed_recording(self):
        session = RealtimeSession.objects.create(
            title="Browser Fallback Recording Session",
            description="Fallback upload flow",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )
        fallback_file = SimpleUploadedFile(
            "fallback-recording.webm",
            b"\x1a\x45\xdf\xa3\x9fB\x86\x81\x01",
            content_type="video/webm",
        )

        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-recording-browser-upload", kwargs={"pk": session.id}),
            {"video_file": fallback_file},
        )
        self.assertEqual(response.status_code, 201)
        recording = RealtimeSessionRecording.objects.get(session=session)
        self.assertEqual(recording.status, RealtimeSessionRecording.STATUS_COMPLETED)
        self.assertTrue(bool(recording.video_file))

    def test_recording_download_serves_local_egress_output(self):
        with tempfile.TemporaryDirectory() as recordings_root:
            meeting_dir = os.path.join(recordings_root, "meeting")
            os.makedirs(meeting_dir, exist_ok=True)
            file_name = "local-egress-recording.mp4"
            absolute_file_path = os.path.join(meeting_dir, file_name)
            file_bytes = b"\x00\x00\x00\x18ftypmp42test-recording-data"
            with open(absolute_file_path, "wb") as recording_file:
                recording_file.write(file_bytes)

            session = RealtimeSession.objects.create(
                title="Local Recording Download Session",
                description="Download endpoint should stream egress file",
                host=self.host,
                session_type=RealtimeSession.TYPE_MEETING,
                linked_live_class=self.live_class,
                linked_course=self.meeting_course,
                status=RealtimeSession.STATUS_LIVE,
            )
            recording = RealtimeSessionRecording.objects.create(
                session=session,
                recording_type=RealtimeSession.TYPE_MEETING,
                started_by=self.host,
                status=RealtimeSessionRecording.STATUS_COMPLETED,
                output_file_path=f"recordings/meeting/{file_name}",
            )

            self.login(self.host.email)
            with override_settings(LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT=recordings_root):
                response = self.client.get(
                    reverse(
                        "realtime-session-recording-download",
                        kwargs={"recording_id": recording.id},
                    )
                )
            self.assertEqual(response.status_code, 200)
            streamed_content = b"".join(response.streaming_content)
            self.assertEqual(streamed_content, file_bytes)

    def test_recording_download_allows_admin_session_authentication(self):
        recording_file = SimpleUploadedFile(
            "admin-session-recording.webm",
            b"\x1a\x45\xdf\xa3session-download-test",
            content_type="video/webm",
        )
        session = RealtimeSession.objects.create(
            title="Admin Session Recording Download",
            description="Admin should preview/download recordings from changelist",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )
        recording = RealtimeSessionRecording.objects.create(
            session=session,
            recording_type=RealtimeSession.TYPE_MEETING,
            started_by=self.host,
            status=RealtimeSessionRecording.STATUS_COMPLETED,
            video_file=recording_file,
        )

        admin_user = User.objects.create_superuser(
            email="admin-recordings@test.com",
            password="StrongPass@123",
            full_name="Admin Recordings",
        )
        self.client.force_login(admin_user)
        response = self.client.get(
            reverse(
                "realtime-session-recording-download",
                kwargs={"recording_id": recording.id},
            )
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("Content-Disposition"),
            f'inline; filename="{recording.video_file.name.split("/")[-1]}"',
        )

    def test_recording_download_resolves_prefixed_absolute_output_path(self):
        with tempfile.TemporaryDirectory() as recordings_root:
            meeting_dir = os.path.join(recordings_root, "meeting")
            os.makedirs(meeting_dir, exist_ok=True)
            file_name = "prefixed-absolute-egress-recording.mp4"
            absolute_file_path = os.path.join(meeting_dir, file_name)
            file_bytes = b"\x00\x00\x00\x18ftypmp42prefixed-absolute-data"
            with open(absolute_file_path, "wb") as recording_file:
                recording_file.write(file_bytes)

            session = RealtimeSession.objects.create(
                title="Prefixed Absolute Recording Session",
                description="Download endpoint should resolve /recordings prefix to local root",
                host=self.host,
                session_type=RealtimeSession.TYPE_MEETING,
                linked_live_class=self.live_class,
                linked_course=self.meeting_course,
                status=RealtimeSession.STATUS_LIVE,
            )
            recording = RealtimeSessionRecording.objects.create(
                session=session,
                recording_type=RealtimeSession.TYPE_MEETING,
                started_by=self.host,
                status=RealtimeSessionRecording.STATUS_COMPLETED,
                output_file_path=f"/recordings/meeting/{file_name}",
            )

            self.login(self.host.email)
            with override_settings(
                LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT=recordings_root,
                LIVEKIT_RECORDING_FILEPATH_PREFIX="/recordings",
            ):
                response = self.client.get(
                    reverse(
                        "realtime-session-recording-download",
                        kwargs={"recording_id": recording.id},
                    )
                )
            self.assertEqual(response.status_code, 200)
            streamed_content = b"".join(response.streaming_content)
            self.assertEqual(streamed_content, file_bytes)

    def test_recording_download_resolves_host_absolute_output_path_containing_recordings_segment(self):
        with tempfile.TemporaryDirectory() as recordings_root:
            meeting_dir = os.path.join(recordings_root, "meeting")
            os.makedirs(meeting_dir, exist_ok=True)
            file_name = "host-absolute-egress-recording.mp4"
            absolute_file_path = os.path.join(meeting_dir, file_name)
            file_bytes = b"\x00\x00\x00\x18ftypmp42host-absolute-data"
            with open(absolute_file_path, "wb") as recording_file:
                recording_file.write(file_bytes)

            session = RealtimeSession.objects.create(
                title="Host Absolute Recording Session",
                description="Download endpoint should recover recordings segment from host paths",
                host=self.host,
                session_type=RealtimeSession.TYPE_MEETING,
                linked_live_class=self.live_class,
                linked_course=self.meeting_course,
                status=RealtimeSession.STATUS_LIVE,
            )
            recording = RealtimeSessionRecording.objects.create(
                session=session,
                recording_type=RealtimeSession.TYPE_MEETING,
                started_by=self.host,
                status=RealtimeSessionRecording.STATUS_COMPLETED,
                output_file_path=f"/opt/alsyed/StreamX/recordings/meeting/{file_name}",
            )

            self.login(self.host.email)
            with override_settings(
                LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT=recordings_root,
                LIVEKIT_RECORDING_FILEPATH_PREFIX="/recordings",
            ):
                response = self.client.get(
                    reverse(
                        "realtime-session-recording-download",
                        kwargs={"recording_id": recording.id},
                    )
                )
            self.assertEqual(response.status_code, 200)
            streamed_content = b"".join(response.streaming_content)
            self.assertEqual(streamed_content, file_bytes)

    def test_recording_download_redirects_to_public_output_url_when_local_file_is_missing(self):
        session = RealtimeSession.objects.create(
            title="Remote Recording Download Session",
            description="Redirect to public URL when local asset is unavailable",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )
        recording = RealtimeSessionRecording.objects.create(
            session=session,
            recording_type=RealtimeSession.TYPE_MEETING,
            started_by=self.host,
            status=RealtimeSessionRecording.STATUS_COMPLETED,
            output_file_path="/recordings/meeting/missing-file.mp4",
            output_download_url="https://media.example.com/recordings/meeting/missing-file.mp4",
        )

        self.login(self.host.email)
        response = self.client.get(
            reverse(
                "realtime-session-recording-download",
                kwargs={"recording_id": recording.id},
            )
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            response.headers.get("Location"),
            "https://media.example.com/recordings/meeting/missing-file.mp4",
        )

    def test_recording_delete_removes_db_row_and_local_file(self):
        with tempfile.TemporaryDirectory() as recordings_root:
            meeting_dir = os.path.join(recordings_root, "meeting")
            os.makedirs(meeting_dir, exist_ok=True)
            file_name = "delete-me-recording.mp4"
            absolute_file_path = os.path.join(meeting_dir, file_name)
            with open(absolute_file_path, "wb") as recording_file:
                recording_file.write(b"delete-me")

            session = RealtimeSession.objects.create(
                title="Delete Recording Session",
                description="Delete flow",
                host=self.host,
                session_type=RealtimeSession.TYPE_MEETING,
                linked_live_class=self.live_class,
                linked_course=self.meeting_course,
                status=RealtimeSession.STATUS_LIVE,
            )
            recording = RealtimeSessionRecording.objects.create(
                session=session,
                recording_type=RealtimeSession.TYPE_MEETING,
                started_by=self.host,
                status=RealtimeSessionRecording.STATUS_COMPLETED,
                output_file_path=f"/recordings/meeting/{file_name}",
            )

            self.login(self.host.email)
            with override_settings(
                LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT=recordings_root,
                LIVEKIT_RECORDING_FILEPATH_PREFIX="/recordings",
            ):
                response = self.client.delete(
                    reverse(
                        "realtime-session-recording-delete",
                        kwargs={"recording_id": recording.id},
                    )
                )

            self.assertEqual(response.status_code, 200)
            self.assertFalse(
                RealtimeSessionRecording.objects.filter(id=recording.id).exists()
            )
            self.assertFalse(os.path.exists(absolute_file_path))

    def test_recording_delete_rejects_active_recording(self):
        session = RealtimeSession.objects.create(
            title="Active Recording Delete Session",
            description="Delete guard",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )
        recording = RealtimeSessionRecording.objects.create(
            session=session,
            recording_type=RealtimeSession.TYPE_MEETING,
            started_by=self.host,
            status=RealtimeSessionRecording.STATUS_RECORDING,
            livekit_egress_id="EG_active_test",
        )

        self.login(self.host.email)
        response = self.client.delete(
            reverse(
                "realtime-session-recording-delete",
                kwargs={"recording_id": recording.id},
            )
        )
        self.assertEqual(response.status_code, 400)
        self.assertTrue(RealtimeSessionRecording.objects.filter(id=recording.id).exists())

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_student_cannot_receive_stage_access_and_stays_in_viewer_mode(
        self,
        mock_participant_count,
        mock_build_token,
        mock_build_meet_url,
    ):
        mock_participant_count.return_value = 1
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"

        session = RealtimeSession.objects.create(
            title="Permission Session",
            description="Presenter control checks",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=300,
            max_audience=50000,
        )

        self.login(self.viewer.email)
        before_grant = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(before_grant.status_code, 200)
        self.assertFalse(before_grant.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertFalse(before_grant.data["data"]["meeting"]["permissions"]["can_speak"])

        self.client.post(reverse("auth-logout"))
        self.login(self.host.email)
        grant_response = self.client.post(
            reverse(
                "realtime-session-presenter-permission",
                kwargs={"pk": session.id, "permission_action": "grant"},
            ),
            {"user_id": self.viewer.id},
            format="json",
        )
        self.assertEqual(grant_response.status_code, 400)
        self.assertEqual(
            grant_response.data["errors"]["detail"],
            "Only admin or the assigned instructor can use camera and screen share.",
        )

        self.client.post(reverse("auth-logout"))
        self.login(self.viewer.email)
        after_grant = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(after_grant.status_code, 200)
        self.assertFalse(after_grant.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertFalse(after_grant.data["data"]["meeting"]["permissions"]["can_speak"])
        self.assertEqual(mock_build_token.call_count, 2)
        self.assertEqual(
            mock_build_token.call_args_list[0].kwargs["can_publish_sources"],
            None,
        )
        self.assertEqual(
            mock_build_token.call_args_list[1].kwargs["can_publish_sources"],
            None,
        )

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_student_joins_meeting_with_microphone_only_after_speaker_granted(
        self,
        mock_participant_count,
        mock_build_token,
        mock_build_meet_url,
    ):
        mock_participant_count.return_value = 1
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"

        session = RealtimeSession.objects.create(
            title="Speaker Permission Session",
            description="Speaker control checks",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=300,
            max_audience=50000,
        )

        self.login(self.host.email)
        grant_response = self.client.post(
            reverse(
                "realtime-session-speaker-permission",
                kwargs={"pk": session.id, "permission_action": "grant"},
            ),
            {"user_id": self.viewer.id},
            format="json",
        )
        self.assertEqual(grant_response.status_code, 200)
        self.assertIn(self.viewer.id, grant_response.data["data"]["speaker_user_ids"])
        self.assertNotIn(self.viewer.id, grant_response.data["data"]["presenter_user_ids"])

        self.client.post(reverse("auth-logout"))
        self.login(self.viewer.email)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 200)
        self.assertFalse(join_response.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertTrue(join_response.data["data"]["meeting"]["permissions"]["can_speak"])
        self.assertEqual(mock_build_token.call_count, 1)
        self.assertTrue(mock_build_token.call_args.kwargs["can_publish"])
        self.assertEqual(mock_build_token.call_args.kwargs["can_publish_sources"], ["microphone"])

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_assigned_instructor_can_join_and_manage_permissions_without_being_host(
        self,
        mock_participant_count,
        mock_build_token,
    ):
        mock_participant_count.return_value = 1
        mock_build_token.return_value = "lk.token"

        admin_host = User.objects.create_user(
            email="adminhost@test.com",
            password="StrongPass@123",
            full_name="Admin Host",
            role=User.ROLE_INSTRUCTOR,
            is_staff=True,
        )
        session = RealtimeSession.objects.create(
            title="Instructor Managed Session",
            description="Assigned instructor can moderate",
            host=admin_host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=300,
            max_audience=50000,
        )

        self.login(self.host.email)
        detail_response = self.client.get(reverse("realtime-session-detail", kwargs={"pk": session.id}))
        self.assertEqual(detail_response.status_code, 200)
        self.assertTrue(detail_response.data["data"]["can_manage"])

        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Assigned Instructor"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 200)
        self.assertTrue(join_response.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertTrue(join_response.data["data"]["meeting"]["permissions"]["can_speak"])
        self.assertTrue(join_response.data["data"]["meeting"]["permissions"]["can_manage_participants"])

        grant_response = self.client.post(
            reverse(
                "realtime-session-speaker-permission",
                kwargs={"pk": session.id, "permission_action": "grant"},
            ),
            {"user_id": self.viewer.id},
            format="json",
        )
        self.assertEqual(grant_response.status_code, 200)
        self.assertIn(self.viewer.id, grant_response.data["data"]["speaker_user_ids"])

    @override_settings(FRONTEND_PUBLIC_ORIGIN="https://academy.example.com")
    def test_session_join_url_prefers_frontend_public_origin(self):
        session = RealtimeSession.objects.create(
            title="Public Origin Session",
            description="URL generation checks",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            status=RealtimeSession.STATUS_LIVE,
        )
        self.login(self.host.email)
        response = self.client.get(
            reverse("realtime-session-list-create"),
            {"status": "all"},
            HTTP_HOST="localhost:8000",
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["data"])
        self.assertEqual(
            response.data["data"][0]["join_url"],
            f"https://academy.example.com/join-live?session={session.id}",
        )

    @override_settings(
        FRONTEND_URL="http://localhost:5173",
        LIVEKIT_PUBLIC_URL="ws://203.0.113.20:7880",
    )
    def test_session_join_url_uses_livekit_host_when_frontend_url_is_localhost(self):
        session = RealtimeSession.objects.create(
            title="LiveKit Host Fallback Session",
            description="Fallback URL generation checks",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            status=RealtimeSession.STATUS_LIVE,
        )
        self.login(self.host.email)
        response = self.client.get(reverse("realtime-session-list-create"), {"status": "all"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["data"])
        self.assertEqual(
            response.data["data"][0]["join_url"],
            f"http://203.0.113.20:5173/join-live?session={session.id}",
        )

