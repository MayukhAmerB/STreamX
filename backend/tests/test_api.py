from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from django.urls import reverse
from django.test import override_settings
from rest_framework.test import APITestCase

from apps.courses.models import (
    Course,
    Enrollment,
    Lecture,
    LiveClass,
    LiveClassEnrollment,
    PublicEnrollmentLead,
    Section,
)
from apps.courses.serializers import LectureSerializer
from apps.payments.models import Payment
from apps.realtime.models import RealtimeSession
from apps.users.models import AuthConfiguration, User
from apps.users.serializers import ProfileUpdateSerializer


class BaseAPITestCase(APITestCase):
    def setUp(self):
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
    def test_current_user_endpoint_unauthenticated_returns_401(self):
        response = self.client.get(reverse("auth-user"))
        self.assertEqual(response.status_code, 401)
        self.assertFalse(response.data["success"])

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
        for _ in range(6):
            response = self.client.post(
                reverse("auth-login"),
                {"email": self.user.email, "password": "WrongPass@123"},
                format="json",
            )
            status_codes.append(response.status_code)
        self.assertEqual(status_codes[:5], [400, 400, 400, 400, 400])
        self.assertEqual(status_codes[5], 429)

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
        self.assertTrue(join_response.data["data"]["meeting"]["permissions"]["can_speak"])
        self.assertFalse(join_response.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertEqual(mock_build_token.call_count, 1)
        self.assertTrue(mock_build_token.call_args.kwargs["can_publish"])
        self.assertEqual(mock_build_token.call_args.kwargs["can_publish_sources"], ["microphone"])

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
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_student_joins_meeting_in_viewer_mode_until_presenter_granted(
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
        self.assertTrue(before_grant.data["data"]["meeting"]["permissions"]["can_speak"])

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
        self.assertEqual(grant_response.status_code, 200)
        self.assertIn(self.viewer.id, grant_response.data["data"]["presenter_user_ids"])

        self.client.post(reverse("auth-logout"))
        self.login(self.viewer.email)
        after_grant = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(after_grant.status_code, 200)
        self.assertTrue(after_grant.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertTrue(after_grant.data["data"]["meeting"]["permissions"]["can_speak"])
        self.assertEqual(mock_build_token.call_count, 2)
        self.assertEqual(
            mock_build_token.call_args_list[0].kwargs["can_publish_sources"],
            ["microphone"],
        )
        self.assertEqual(
            mock_build_token.call_args_list[1].kwargs["can_publish_sources"],
            ["camera", "microphone", "screen_share", "screen_share_audio"],
        )

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

