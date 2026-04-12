import json
import hashlib
import hmac
import os
import shutil
import tempfile
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

from django.conf import settings
from django.contrib.admin.models import LogEntry
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core import mail, signing
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from django.urls import reverse
from django.test import RequestFactory, override_settings
from rest_framework.test import APITestCase
from PIL import Image

from config.url_utils import get_media_public_url
from apps.courses.models import (
    Course,
    Enrollment,
    GuideVideo,
    Lecture,
    LectureQuestion,
    LectureProgress,
    LectureResource,
    LiveClass,
    LiveClassEnrollment,
    PublicEnrollmentLead,
    Section,
)
from apps.courses.serializers import LectureSerializer
from apps.courses.services import transcode_lecture_to_hls
from apps.payments.models import Payment
from apps.realtime import domain as realtime_domain
from apps.realtime import services as realtime_services
from apps.realtime.models import RealtimeConfiguration, RealtimeSession, RealtimeSessionRecording
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

    def test_login_accepts_lowercased_email_for_mixed_case_stored_account(self):
        user = User.objects.create_user(
            email="Ad195@Test.com",
            password="StrongPass@123",
            full_name="Mixed Case User",
            role=User.ROLE_STUDENT,
        )
        self.assertEqual(user.email, "ad195@test.com")

        login_resp = self.client.post(
            reverse("auth-login"),
            {"email": "ad195@test.com", "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(login_resp.status_code, 200)
        self.assertTrue(login_resp.data["success"])

    @override_settings(GOOGLE_CLIENT_ID="google-client-id")
    @patch("apps.users.views.verify_google_credential")
    def test_google_login_matches_existing_user_case_insensitively(self, mock_verify_google):
        existing_user = User.objects.create_user(
            email="MixedCaseGoogle@Test.com",
            password="StrongPass@123",
            full_name="Existing Google User",
            role=User.ROLE_STUDENT,
        )
        mock_verify_google.return_value = {
            "email": "mixedcasegoogle@test.com",
            "name": "Existing Google User",
            "sub": "google-existing-1",
        }

        response = self.client.post(
            reverse("auth-google"),
            {"credential": "dummy"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(User.objects.filter(email__iexact="mixedcasegoogle@test.com").count(), 1)

        existing_user.refresh_from_db()
        self.assertEqual(existing_user.email, "mixedcasegoogle@test.com")
        self.assertEqual(existing_user.oauth_provider, "google")
        self.assertEqual(existing_user.oauth_provider_uid, "google-existing-1")

    def test_register_cannot_elevate_role_to_instructor(self):
        config = AuthConfiguration.get_solo()
        config.registration_enabled = True
        config.save(update_fields=["registration_enabled", "updated_at"])

        register_resp = self.client.post(
            reverse("auth-register"),
            {
                "email": "rolecheck@test.com",
                "full_name": "Role Check",
                "password": "StrongPass@123",
                "role": "instructor",
            },
            format="json",
        )
        self.assertEqual(register_resp.status_code, 200)
        created_user = User.objects.get(email="rolecheck@test.com")
        self.assertEqual(created_user.role, User.ROLE_STUDENT)

    @override_settings(GOOGLE_CLIENT_ID="google-client-id")
    @patch("apps.users.views.verify_google_credential")
    def test_google_signup_cannot_elevate_role_to_instructor(self, mock_verify_google):
        config = AuthConfiguration.get_solo()
        config.registration_enabled = True
        config.save(update_fields=["registration_enabled", "updated_at"])

        mock_verify_google.return_value = {
            "email": "google-role@test.com",
            "name": "Google Role",
            "sub": "google-subject-1",
        }
        response = self.client.post(
            reverse("auth-google"),
            {"credential": "dummy", "role": "instructor"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        created_user = User.objects.get(email="google-role@test.com")
        self.assertEqual(created_user.role, User.ROLE_STUDENT)

    def test_logout_blacklists_refresh_token(self):
        config = AuthConfiguration.get_solo()
        config.registration_enabled = True
        config.save(update_fields=["registration_enabled", "updated_at"])

        self.client.post(
            reverse("auth-register"),
            {
                "email": "logoutblacklist@test.com",
                "full_name": "Logout Blacklist",
                "password": "StrongPass@123",
                "role": "student",
            },
            format="json",
        )
        issued_refresh = self.client.cookies.get("refresh_token").value

        logout_resp = self.client.post(reverse("auth-logout"), format="json")
        self.assertEqual(logout_resp.status_code, 200)

        attack_client = self.client_class()
        attack_client.cookies["refresh_token"] = issued_refresh
        refresh_resp = attack_client.post(reverse("auth-refresh"), {}, format="json")
        self.assertEqual(refresh_resp.status_code, 401)

    def test_non_admin_second_login_invalidates_first_device_session(self):
        user = User.objects.create_user(
            email="single-session@test.com",
            password="StrongPass@123",
            full_name="Single Session User",
            role=User.ROLE_STUDENT,
        )

        first_client = self.client_class()
        first_login = first_client.post(
            reverse("auth-login"),
            {"email": user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(first_login.status_code, 200)
        first_refresh = first_client.cookies.get("refresh_token").value

        second_client = self.client_class()
        second_login = second_client.post(
            reverse("auth-login"),
            {"email": user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(second_login.status_code, 200)

        stale_current_user = first_client.get(reverse("auth-user"))
        self.assertEqual(stale_current_user.status_code, 401)

        first_client.cookies["refresh_token"] = first_refresh
        stale_refresh = first_client.post(reverse("auth-refresh"), {}, format="json")
        self.assertEqual(stale_refresh.status_code, 401)
        self.assertFalse(stale_refresh.data["success"])

        active_current_user = second_client.get(reverse("auth-user"))
        self.assertEqual(active_current_user.status_code, 200)

    def test_admin_can_keep_concurrent_sessions_across_devices(self):
        admin_user = User.objects.create_user(
            email="admin-multi@test.com",
            password="StrongPass@123",
            full_name="Admin Multi Session",
            role=User.ROLE_INSTRUCTOR,
            is_staff=True,
        )

        first_client = self.client_class()
        first_login = first_client.post(
            reverse("auth-login"),
            {"email": admin_user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(first_login.status_code, 200)
        first_refresh = first_client.cookies.get("refresh_token").value

        second_client = self.client_class()
        second_login = second_client.post(
            reverse("auth-login"),
            {"email": admin_user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(second_login.status_code, 200)

        first_current_user = first_client.get(reverse("auth-user"))
        self.assertEqual(first_current_user.status_code, 200)

        first_client.cookies["refresh_token"] = first_refresh
        first_refresh_response = first_client.post(reverse("auth-refresh"), {}, format="json")
        self.assertEqual(first_refresh_response.status_code, 200)

        second_current_user = second_client.get(reverse("auth-user"))
        self.assertEqual(second_current_user.status_code, 200)

    @override_settings(ACCOUNT_SELF_SERVICE_CREDENTIALS_ENABLED=True)
    def test_change_password_revokes_preexisting_refresh_tokens(self):
        user = User.objects.create_user(
            email="changepass@test.com",
            password="StrongPass@123",
            full_name="Change Password User",
            role=User.ROLE_STUDENT,
        )
        login_resp = self.client.post(
            reverse("auth-login"),
            {"email": user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(login_resp.status_code, 200)
        issued_refresh = self.client.cookies.get("refresh_token").value

        change_resp = self.client.post(
            reverse("auth-change-password"),
            {"current_password": "StrongPass@123", "new_password": "NewStrongPass@123"},
            format="json",
        )
        self.assertEqual(change_resp.status_code, 200)

        stale_client = self.client_class()
        stale_client.cookies["refresh_token"] = issued_refresh
        stale_refresh = stale_client.post(reverse("auth-refresh"), {}, format="json")
        self.assertEqual(stale_refresh.status_code, 401)

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

        stale_client = self.client_class()
        login_before_reset = stale_client.post(
            reverse("auth-login"),
            {"email": user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(login_before_reset.status_code, 200)
        stale_refresh_token = stale_client.cookies.get("refresh_token").value

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

        stale_client.cookies["refresh_token"] = stale_refresh_token
        stale_refresh = stale_client.post(reverse("auth-refresh"), {}, format="json")
        self.assertEqual(stale_refresh.status_code, 401)
        self.client.post(reverse("auth-logout"))
        login_resp = self.client.post(
            reverse("auth-login"),
            {"email": user.email, "password": "NewStrongPass@123"},
            format="json",
        )
        self.assertEqual(login_resp.status_code, 200)


class AdminPasswordVerificationTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.superuser = User.objects.create_superuser(
            email="superadmin@test.com",
            password="StrongPass@123",
            full_name="Super Admin",
        )
        self.staff_user = User.objects.create_user(
            email="staffonly@test.com",
            password="StrongPass@123",
            full_name="Staff User",
            is_staff=True,
            role=User.ROLE_INSTRUCTOR,
        )
        self.target_user = User.objects.create_user(
            email="verifyme@test.com",
            password="VerifyMe@123",
            full_name="Verify Me",
            role=User.ROLE_STUDENT,
        )

    def test_superuser_can_open_password_verification_page(self):
        self.client.force_login(self.superuser)
        response = self.client.get(reverse("admin:users_user_verify_password", args=[self.target_user.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Verify password")
        self.assertContains(response, self.target_user.email)

    def test_superuser_can_verify_existing_user_password(self):
        self.client.force_login(self.superuser)
        candidate_password = "VerifyMe@123"
        response = self.client.post(
            reverse("admin:users_user_verify_password", args=[self.target_user.pk]),
            {"password": candidate_password},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "matches the stored password hash")
        self.assertNotContains(response, candidate_password)
        self.assertTrue(
            LogEntry.objects.filter(
                user_id=self.superuser.pk,
                object_id=str(self.target_user.pk),
                change_message__contains="Password verification attempted.",
            ).exists()
        )

    def test_superuser_sees_failure_for_wrong_password(self):
        self.client.force_login(self.superuser)
        response = self.client.post(
            reverse("admin:users_user_verify_password", args=[self.target_user.pk]),
            {"password": "WrongPassword@123"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "does not match the stored password hash")

    def test_non_superuser_cannot_access_password_verification_page(self):
        self.client.force_login(self.staff_user)
        response = self.client.get(reverse("admin:users_user_verify_password", args=[self.target_user.pk]))
        self.assertEqual(response.status_code, 403)


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
        max_failures = int(getattr(settings, "AUTH_LOGIN_MAX_FAILURES", 10))
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

    @override_settings(AUTH_LOGIN_MAX_FAILURES=2, AUTH_LOGIN_LOCKOUT_SECONDS=120)
    def test_login_lockout_is_scoped_to_target_email(self):
        other_user = User.objects.create_user(
            email="other-login@test.com",
            password="StrongPass@123",
            full_name="Other Login User",
            role=User.ROLE_STUDENT,
        )

        first = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "WrongPass@123"},
            format="json",
        )
        second = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "WrongPass@123"},
            format="json",
        )
        third = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "WrongPass@123"},
            format="json",
        )

        self.assertEqual(first.status_code, 400)
        self.assertEqual(second.status_code, 400)
        self.assertEqual(third.status_code, 429)
        self.assertEqual(third.data["errors"]["code"], "login_temporarily_locked")

        other_login = self.client.post(
            reverse("auth-login"),
            {"email": other_user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(other_login.status_code, 200)

    @override_settings(AUTH_LOGIN_MAX_FAILURES=2, AUTH_LOGIN_LOCKOUT_SECONDS=120)
    def test_login_lockout_is_scoped_to_email_plus_client_ip(self):
        first = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "WrongPass@123"},
            format="json",
            REMOTE_ADDR="198.51.100.10",
        )
        second = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "WrongPass@123"},
            format="json",
            REMOTE_ADDR="198.51.100.10",
        )
        locked = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "WrongPass@123"},
            format="json",
            REMOTE_ADDR="198.51.100.10",
        )
        self.assertEqual(first.status_code, 400)
        self.assertEqual(second.status_code, 400)
        self.assertEqual(locked.status_code, 429)

        unaffected_ip_login = self.client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": "StrongPass@123"},
            format="json",
            REMOTE_ADDR="203.0.113.44",
        )
        self.assertEqual(unaffected_ip_login.status_code, 200)

    @override_settings(
        AUTH_LOGIN_MAX_FAILURES=100,
        AUTH_LOGIN_LOCKOUT_SECONDS=3600,
        TRUST_X_FORWARDED_FOR=False,
    )
    def test_login_throttle_ignores_untrusted_x_forwarded_for_header(self):
        status_codes = []
        for idx in range(11):
            response = self.client.post(
                reverse("auth-login"),
                {"email": self.user.email, "password": "WrongPass@123"},
                format="json",
                REMOTE_ADDR="198.51.100.77",
                HTTP_X_FORWARDED_FOR=f"203.0.113.{idx}, 198.51.100.10",
            )
            status_codes.append(response.status_code)

        self.assertEqual(status_codes[:10], [400] * 10)
        self.assertEqual(status_codes[10], 429)


class UploadValidationTests(APITestCase):
    @staticmethod
    def _make_profile_image(name="avatar.jpg", image_format="JPEG", content_type="image/jpeg"):
        buffer = BytesIO()
        Image.new("RGB", (16, 16), color="white").save(buffer, format=image_format)
        return SimpleUploadedFile(name, buffer.getvalue(), content_type=content_type)

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

    def test_profile_serializer_rejects_dangerous_double_extension_image_name(self):
        user = User.objects.create_user(
            email="profile-double-ext@test.com",
            password="StrongPass@123",
            full_name="Profile User Double Extension",
            role=User.ROLE_STUDENT,
        )
        disguised_image = self._make_profile_image(name="avatar.php.jpg")
        serializer = ProfileUpdateSerializer(
            user,
            data={"full_name": "Profile User Double Extension", "profile_image": disguised_image},
            partial=True,
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("profile_image", serializer.errors)
        self.assertIn("embedded executable or script extensions", str(serializer.errors["profile_image"][0]))

    def test_profile_serializer_rejects_jpeg_extension_even_for_valid_image_binary(self):
        user = User.objects.create_user(
            email="profile-jpeg@test.com",
            password="StrongPass@123",
            full_name="Profile User Jpeg",
            role=User.ROLE_STUDENT,
        )
        jpeg_image = self._make_profile_image(name="avatar.jpeg")
        serializer = ProfileUpdateSerializer(
            user,
            data={"full_name": "Profile User Jpeg", "profile_image": jpeg_image},
            partial=True,
        )
        self.assertFalse(serializer.is_valid())
        self.assertIn("profile_image", serializer.errors)
        self.assertIn("Only JPG or PNG profile images are allowed.", str(serializer.errors["profile_image"][0]))

    def test_profile_serializer_rejects_profile_image_url_value(self):
        user = User.objects.create_user(
            email="profile-url@test.com",
            password="StrongPass@123",
            full_name="Profile User Url",
            role=User.ROLE_STUDENT,
        )
        serializer = ProfileUpdateSerializer(
            user,
            data={"full_name": "Profile User Url", "profile_image": "https://evil.example/avatar.jpg"},
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

    def test_lecture_resource_rejects_invalid_document_extension(self):
        instructor = User.objects.create_user(
            email="resource@test.com",
            password="StrongPass@123",
            full_name="Resource Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        course = Course.objects.create(
            title="Resource Course",
            description="Course description",
            price=Decimal("100.00"),
            instructor=instructor,
            is_published=True,
        )
        section = Section.objects.create(course=course, title="Module 1", order=1)
        lecture = Lecture.objects.create(
            section=section,
            title="Lecture With Resources",
            description="Lecture description",
            video_key="videos/resource.mp4",
            order=1,
            is_preview=False,
        )
        resource = LectureResource(
            lecture=lecture,
            title="Bad Resource",
            resource_file=SimpleUploadedFile(
                "malware.exe",
                b"not-a-document",
                content_type="application/octet-stream",
            ),
            order=1,
        )

        with self.assertRaisesMessage(Exception, "Only TXT, PDF, PPT, PPTX, DOC, or DOCX files are allowed."):
            resource.full_clean()


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


class MediaPublicUrlTests(APITestCase):
    @override_settings(MEDIA_PUBLIC_BASE_URL="https://alsyedinitiative.com/media")
    def test_media_public_url_avoids_duplicate_media_prefix(self):
        self.assertEqual(
            get_media_public_url("/media/course_thumbnails/test.jpg"),
            "https://alsyedinitiative.com/media/course_thumbnails/test.jpg",
        )

    @override_settings(MEDIA_PUBLIC_BASE_URL="https://alsyedinitiative.com")
    def test_media_public_url_supports_origin_only_base(self):
        self.assertEqual(
            get_media_public_url("/media/course_thumbnails/test.jpg"),
            "https://alsyedinitiative.com/media/course_thumbnails/test.jpg",
        )

    def test_course_thumbnail_file_url_falls_back_to_thumbnail_when_file_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with override_settings(
                MEDIA_ROOT=tmpdir,
                MEDIA_PUBLIC_BASE_URL="https://alsyedinitiative.com/media",
                ALLOWED_HOSTS=["api.alsyedinitiative.com", "testserver", "localhost"],
            ):
                instructor = User.objects.create_user(
                    email="thumb-fallback@test.com",
                    password="StrongPass@123",
                    full_name="Thumbnail Fallback Instructor",
                    role=User.ROLE_INSTRUCTOR,
                )
                image_buffer = BytesIO()
                Image.new("RGB", (80, 80), color="#303030").save(image_buffer, format="JPEG")
                image_buffer.seek(0)
                thumbnail_file = SimpleUploadedFile(
                    "thumb.jpg",
                    image_buffer.read(),
                    content_type="image/jpeg",
                )
                course = Course.objects.create(
                    title="Thumbnail Fallback Course",
                    description="Fallback behavior test",
                    price=Decimal("199.00"),
                    instructor=instructor,
                    is_published=True,
                    thumbnail="https://example.com/fallback-thumb.jpg",
                    thumbnail_file=thumbnail_file,
                )

                file_name = course.thumbnail_file.name
                self.assertTrue(course._has_accessible_thumbnail_file())
                self.assertEqual(
                    course.get_thumbnail_url(),
                    f"https://alsyedinitiative.com/media/{file_name}",
                )

                course.thumbnail_file.storage.delete(file_name)
                self.assertFalse(course._has_accessible_thumbnail_file())
                self.assertEqual(course.get_thumbnail_url(), "https://example.com/fallback-thumb.jpg")

    def test_course_thumbnail_endpoint_serves_uploaded_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with override_settings(
                MEDIA_ROOT=tmpdir,
                MEDIA_PUBLIC_BASE_URL="https://alsyedinitiative.com/media",
            ):
                instructor = User.objects.create_user(
                    email="thumb-endpoint@test.com",
                    password="StrongPass@123",
                    full_name="Thumbnail Endpoint Instructor",
                    role=User.ROLE_INSTRUCTOR,
                )
                image_buffer = BytesIO()
                Image.new("RGB", (96, 96), color="#454545").save(image_buffer, format="JPEG")
                image_buffer.seek(0)
                thumbnail_file = SimpleUploadedFile(
                    "thumb-endpoint.jpg",
                    image_buffer.read(),
                    content_type="image/jpeg",
                )
                course = Course.objects.create(
                    title="Thumbnail Endpoint Course",
                    description="Thumbnail endpoint behavior test",
                    price=Decimal("149.00"),
                    instructor=instructor,
                    is_published=True,
                    thumbnail_file=thumbnail_file,
                )

                response = self.client.get(reverse("course-thumbnail", args=[course.id]))
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response["X-Content-Type-Options"], "nosniff")
                self.assertIn("max-age=3600", response["Cache-Control"])
                self.assertGreater(sum(len(chunk) for chunk in response.streaming_content), 0)

    def test_course_thumbnail_url_uses_version_query_when_request_present(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with override_settings(
                MEDIA_ROOT=tmpdir,
                MEDIA_PUBLIC_BASE_URL="https://alsyedinitiative.com/media",
                ALLOWED_HOSTS=["api.alsyedinitiative.com", "testserver", "localhost"],
            ):
                instructor = User.objects.create_user(
                    email="thumb-version@test.com",
                    password="StrongPass@123",
                    full_name="Thumbnail Version Instructor",
                    role=User.ROLE_INSTRUCTOR,
                )
                image_buffer = BytesIO()
                Image.new("RGB", (90, 90), color="#222222").save(image_buffer, format="JPEG")
                image_buffer.seek(0)
                thumbnail_file = SimpleUploadedFile(
                    "thumb-version.jpg",
                    image_buffer.read(),
                    content_type="image/jpeg",
                )
                course = Course.objects.create(
                    title="Thumbnail Version Course",
                    description="URL cache-busting behavior test",
                    price=Decimal("129.00"),
                    instructor=instructor,
                    is_published=True,
                    thumbnail_file=thumbnail_file,
                )

                request = RequestFactory().get(
                    "/",
                    secure=True,
                    HTTP_HOST="api.alsyedinitiative.com",
                )
                thumbnail_url = course.get_thumbnail_url(request=request)

                self.assertIn(f"/api/courses/{course.id}/thumbnail/", thumbnail_url)
                self.assertIn("?v=", thumbnail_url)


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

    @override_settings(RAZORPAY_WEBHOOK_SECRET="whsec_test")
    def test_payment_webhook_marks_payment_paid_and_creates_enrollment(self):
        payment = Payment.objects.create(
            user=self.student,
            course=self.course,
            razorpay_order_id="order_webhook_123",
            amount=self.course.price,
            currency="INR",
            status=Payment.STATUS_CREATED,
        )
        payload = {
            "event": "payment.captured",
            "payload": {
                "payment": {
                    "entity": {
                        "id": "pay_webhook_123",
                        "order_id": payment.razorpay_order_id,
                        "status": "captured",
                        "amount": int(Decimal(self.course.price) * 100),
                    }
                }
            },
        }
        body = json.dumps(payload).encode("utf-8")
        signature = hmac.new(b"whsec_test", body, hashlib.sha256).hexdigest()

        response = self.client.post(
            reverse("payment-webhook"),
            data=body,
            content_type="application/json",
            HTTP_X_RAZORPAY_SIGNATURE=signature,
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["data"]["processed"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(payment.razorpay_payment_id, "pay_webhook_123")
        self.assertTrue(
            Enrollment.objects.filter(
                user=self.student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            ).exists()
        )

    @override_settings(RAZORPAY_WEBHOOK_SECRET="whsec_test")
    def test_payment_webhook_rejects_invalid_signature(self):
        payment = Payment.objects.create(
            user=self.student,
            course=self.course,
            razorpay_order_id="order_webhook_bad_sig",
            amount=self.course.price,
            currency="INR",
            status=Payment.STATUS_CREATED,
        )
        payload = {
            "event": "payment.captured",
            "payload": {
                "payment": {
                    "entity": {
                        "id": "pay_webhook_bad_sig",
                        "order_id": payment.razorpay_order_id,
                        "status": "captured",
                        "amount": int(Decimal(self.course.price) * 100),
                    }
                }
            },
        }
        body = json.dumps(payload).encode("utf-8")

        response = self.client.post(
            reverse("payment-webhook"),
            data=body,
            content_type="application/json",
            HTTP_X_RAZORPAY_SIGNATURE="invalid-signature",
        )

        self.assertEqual(response.status_code, 400)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)
        self.assertFalse(
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


class CourseListAccessTests(BaseAPITestCase):
    def test_authenticated_course_list_includes_enrollment_access_flags(self):
        pending_course = Course.objects.create(
            title="Pending Access Course",
            description="Pending enrollment should stay pending in the catalog.",
            price=Decimal("299.00"),
            instructor=self.instructor,
            is_published=True,
        )
        no_access_course = Course.objects.create(
            title="No Access Course",
            description="No enrollment exists for this course.",
            price=Decimal("199.00"),
            instructor=self.instructor,
            is_published=True,
        )

        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        Enrollment.objects.create(
            user=self.student,
            course=pending_course,
            payment_status=Enrollment.STATUS_PENDING,
        )

        self.login(self.student.email)
        response = self.client.get(reverse("course-list-create"))

        self.assertEqual(response.status_code, 200)
        returned = {item["id"]: item for item in response.data["data"]}

        self.assertTrue(returned[self.course.id]["is_enrolled"])
        self.assertEqual(returned[self.course.id]["enrollment_status"], "approved")

        self.assertFalse(returned[pending_course.id]["is_enrolled"])
        self.assertEqual(returned[pending_course.id]["enrollment_status"], "pending")

        self.assertFalse(returned[no_access_course.id]["is_enrolled"])
        self.assertEqual(returned[no_access_course.id]["enrollment_status"], "none")


class GuideVideoAccessTests(BaseAPITestCase):
    def _guide_media_temp_root(self):
        temp_root = os.path.join(settings.BASE_DIR, ".tmp-tests")
        os.makedirs(temp_root, exist_ok=True)
        return temp_root

    def _guide_media_root(self, name):
        media_root = os.path.join(self._guide_media_temp_root(), name)
        shutil.rmtree(media_root, ignore_errors=True)
        os.makedirs(media_root, exist_ok=True)
        self.addCleanup(lambda: shutil.rmtree(media_root, ignore_errors=True))
        return media_root

    def test_guide_list_requires_auth_and_returns_only_published_guides(self):
        GuideVideo.objects.create(
            title="Published Guide",
            description="Visible to authenticated users.",
            video_file=SimpleUploadedFile(
                "published-guide.mp4",
                b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64,
                content_type="video/mp4",
            ),
            order=1,
            is_published=True,
        )
        draft_guide = GuideVideo.objects.create(
            title="Draft Guide",
            description="Should stay hidden until published.",
            video_file=SimpleUploadedFile(
                "draft-guide.mp4",
                b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64,
                content_type="video/mp4",
            ),
            order=2,
            is_published=False,
        )

        unauthenticated = self.client.get(reverse("guide-list"))
        self.assertEqual(unauthenticated.status_code, 401)

        self.login(self.student.email)
        response = self.client.get(reverse("guide-list"))

        self.assertEqual(response.status_code, 200)
        returned = {item["title"] for item in response.data["data"]}
        self.assertIn("Published Guide", returned)
        self.assertNotIn(draft_guide.title, returned)

    def test_authenticated_user_can_get_protected_local_guide_playback_url(self):
        with override_settings(
            MEDIA_ROOT=self._guide_media_root("guide-playback-local"),
            COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True,
        ):
            guide = GuideVideo.objects.create(
                title="Platform Walkthrough",
                description="How to use the dashboard.",
                video_file=SimpleUploadedFile(
                    "platform-guide.mp4",
                    b"guide-video-bytes",
                    content_type="video/mp4",
                ),
                order=1,
                is_published=True,
            )

            self.login(self.student.email)
            response = self.client.get(reverse("guide-video", kwargs={"pk": guide.id}))

            self.assertEqual(response.status_code, 200)
            playback_url = response.data["data"]["playback_url"]
            self.assertIn(f"/api/guides/{guide.id}/playback/", playback_url)

            protected_response = self.client.get(urlparse(playback_url).path)
            self.assertEqual(protected_response.status_code, 200)
            self.assertEqual(
                protected_response.headers.get("X-Accel-Redirect"),
                f"/_protected_media/{guide.video_file.name}",
            )

    def test_guide_protected_playback_token_is_user_bound(self):
        with override_settings(
            MEDIA_ROOT=self._guide_media_root("guide-playback-user-bound"),
            COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True,
        ):
            guide = GuideVideo.objects.create(
                title="User Bound Guide",
                description="Playback token should stay bound to the issuing user.",
                video_file=SimpleUploadedFile(
                    "user-bound-guide.mp4",
                    b"user-bound-guide-bytes",
                    content_type="video/mp4",
                ),
                order=1,
                is_published=True,
            )

            self.login(self.student.email)
            response = self.client.get(reverse("guide-video", kwargs={"pk": guide.id}))
            self.assertEqual(response.status_code, 200)
            playback_path = urlparse(response.data["data"]["playback_url"]).path

            other_user = User.objects.create_user(
                email="guide-other-user@test.com",
                password="StrongPass@123",
                full_name="Guide Other User",
                role=User.ROLE_STUDENT,
            )
            other_client = self.client_class()
            other_login = other_client.post(
                reverse("auth-login"),
                {"email": other_user.email, "password": "StrongPass@123"},
                format="json",
            )
            self.assertEqual(other_login.status_code, 200)

            denied_response = other_client.get(playback_path)
            self.assertEqual(denied_response.status_code, 404)


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
    def _prepare_media_root(self):
        temp_dir = os.path.join(settings.BASE_DIR, ".codex-temp-tests", self._testMethodName)
        shutil.rmtree(temp_dir, ignore_errors=True)
        os.makedirs(temp_dir, exist_ok=True)
        self.addCleanup(lambda: shutil.rmtree(temp_dir, ignore_errors=True))
        return temp_dir

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
        temp_dir = self._prepare_media_root()
        with override_settings(
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
        temp_dir = self._prepare_media_root()
        with override_settings(
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
        temp_dir = self._prepare_media_root()
        with override_settings(
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

    def test_hls_protected_token_cannot_access_assets_outside_signed_root(self):
        temp_dir = self._prepare_media_root()
        with override_settings(
            MEDIA_ROOT=temp_dir,
            COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True,
        ):
            stream_root = os.path.join("streams", "test-course", "lecture_100")
            manifest_path = os.path.join(stream_root, "master.m3u8")
            segment_path = os.path.join(stream_root, "segment_000.ts")
            outside_path = os.path.join("streams", "test-course", "lecture_999", "segment_000.ts")

            os.makedirs(os.path.dirname(os.path.join(temp_dir, manifest_path)), exist_ok=True)
            os.makedirs(os.path.dirname(os.path.join(temp_dir, outside_path)), exist_ok=True)
            with open(os.path.join(temp_dir, manifest_path), "w", encoding="utf-8") as handle:
                handle.write("#EXTM3U\n#EXTINF:6.0,\nsegment_000.ts\n")
            with open(os.path.join(temp_dir, segment_path), "wb") as handle:
                handle.write(b"segment-inside-root")
            with open(os.path.join(temp_dir, outside_path), "wb") as handle:
                handle.write(b"segment-outside-root")

            lecture = Lecture.objects.create(
                section=self.section,
                title="HLS Scoped Token Lecture",
                description="Token must stay inside signed HLS root",
                video_key="videos/source.mp4",
                stream_status=Lecture.STREAM_READY,
                stream_manifest_key=manifest_path.replace("\\", "/"),
                order=4,
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
            playback_path = urlparse(response.data["data"]["playback_url"]).path
            token = playback_path.split("/playback/", 1)[1].split("/", 1)[0]

            allowed_segment_response = self.client.get(
                reverse(
                    "lecture-playback-asset",
                    kwargs={
                        "pk": lecture.id,
                        "token": token,
                        "asset_path": segment_path.replace("\\", "/"),
                    },
                )
            )
            self.assertEqual(allowed_segment_response.status_code, 200)
            self.assertEqual(
                allowed_segment_response.headers.get("X-Accel-Redirect"),
                f"/_protected_media/{segment_path.replace(os.sep, '/')}",
            )

            denied_segment_response = self.client.get(
                reverse(
                    "lecture-playback-asset",
                    kwargs={
                        "pk": lecture.id,
                        "token": token,
                        "asset_path": outside_path.replace("\\", "/"),
                    },
                )
            )
            self.assertEqual(denied_segment_response.status_code, 404)

    def test_protected_playback_token_is_user_bound(self):
        temp_dir = self._prepare_media_root()
        with override_settings(
            MEDIA_ROOT=temp_dir,
            COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True,
        ):
            lecture = Lecture.objects.create(
                section=self.section,
                title="User Bound Playback Lecture",
                description="Token must be bound to issuing user.",
                video_file=SimpleUploadedFile("bound.mp4", b"bound-video", content_type="video/mp4"),
                order=6,
                is_preview=False,
            )
            Enrollment.objects.create(
                user=self.student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            )
            other_student = User.objects.create_user(
                email="token-other@test.com",
                password="StrongPass@123",
                full_name="Token Other Student",
                role=User.ROLE_STUDENT,
            )
            Enrollment.objects.create(
                user=other_student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            )

            self.login(self.student.email)
            response = self.client.get(reverse("lecture-video", kwargs={"pk": lecture.id}))
            self.assertEqual(response.status_code, 200)
            playback_path = urlparse(response.data["data"]["playback_url"]).path

            self.client.post(reverse("auth-logout"))
            self.login(other_student.email)
            shared_attempt = self.client.get(playback_path)
            self.assertEqual(shared_attempt.status_code, 404)

    def test_course_detail_hides_uploaded_video_paths(self):
        temp_dir = self._prepare_media_root()
        with override_settings(MEDIA_ROOT=temp_dir):
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


class LectureResourceAccessTests(BaseAPITestCase):
    def _prepare_media_root(self):
        temp_dir = os.path.join(settings.BASE_DIR, ".codex-temp-tests", self._testMethodName)
        shutil.rmtree(temp_dir, ignore_errors=True)
        os.makedirs(temp_dir, exist_ok=True)
        self.addCleanup(lambda: shutil.rmtree(temp_dir, ignore_errors=True))
        return temp_dir

    def test_course_detail_only_includes_resources_for_accessible_lectures(self):
        temp_dir = self._prepare_media_root()
        with override_settings(MEDIA_ROOT=temp_dir):
            resource = LectureResource.objects.create(
                lecture=self.lecture,
                title="Investigation Worksheet",
                resource_file=SimpleUploadedFile(
                    "worksheet.pdf",
                    b"%PDF-1.4 worksheet bytes",
                    content_type="application/pdf",
                ),
                order=1,
            )

            public_response = self.client.get(reverse("course-detail", kwargs={"pk": self.course.id}))
            self.assertEqual(public_response.status_code, 200)
            public_lecture_payload = public_response.data["data"]["sections"][0]["lectures"][0]
            self.assertEqual(public_lecture_payload["resources"], [])

            self.login(self.student.email)
            no_access_response = self.client.get(reverse("course-detail", kwargs={"pk": self.course.id}))
            self.assertEqual(no_access_response.status_code, 200)
            no_access_lecture_payload = no_access_response.data["data"]["sections"][0]["lectures"][0]
            self.assertEqual(no_access_lecture_payload["resources"], [])

            Enrollment.objects.create(
                user=self.student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            )
            enrolled_response = self.client.get(reverse("course-detail", kwargs={"pk": self.course.id}))
            self.assertEqual(enrolled_response.status_code, 200)
            lecture_payload = enrolled_response.data["data"]["sections"][0]["lectures"][0]
            self.assertEqual(len(lecture_payload["resources"]), 1)
            self.assertEqual(lecture_payload["resources"][0]["title"], resource.title)
            self.assertIn(
                reverse(
                    "lecture-resource-download",
                    kwargs={"lecture_pk": self.lecture.id, "pk": resource.id},
                ),
                lecture_payload["resources"][0]["download_url"],
            )
            self.assertNotIn("resource_file", lecture_payload["resources"][0])

    def test_enrolled_student_can_download_lecture_resource_and_unenrolled_cannot(self):
        temp_dir = self._prepare_media_root()
        with override_settings(MEDIA_ROOT=temp_dir):
            resource = LectureResource.objects.create(
                lecture=self.lecture,
                title="Cheat Sheet",
                resource_file=SimpleUploadedFile(
                    "cheat-sheet.docx",
                    b"docx-resource-bytes",
                    content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ),
                order=1,
            )

            self.login(self.student.email)
            denied_response = self.client.get(
                reverse(
                    "lecture-resource-download",
                    kwargs={"lecture_pk": self.lecture.id, "pk": resource.id},
                )
            )
            self.assertEqual(denied_response.status_code, 403)

            Enrollment.objects.create(
                user=self.student,
                course=self.course,
                payment_status=Enrollment.STATUS_PAID,
            )
            allowed_response = self.client.get(
                reverse(
                    "lecture-resource-download",
                    kwargs={"lecture_pk": self.lecture.id, "pk": resource.id},
                )
            )
            self.assertEqual(allowed_response.status_code, 200)
            self.assertIn("attachment;", allowed_response["Content-Disposition"])
            self.assertGreater(sum(len(chunk) for chunk in allowed_response.streaming_content), 0)

    def test_enrolled_student_can_access_url_based_lecture_resource(self):
        resource = LectureResource.objects.create(
            lecture=self.lecture,
            title="Reference Link",
            resource_url="https://example.com/osint-reference",
            order=1,
        )

        self.login(self.student.email)
        denied_response = self.client.get(
            reverse(
                "lecture-resource-download",
                kwargs={"lecture_pk": self.lecture.id, "pk": resource.id},
            )
        )
        self.assertEqual(denied_response.status_code, 403)

        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        allowed_response = self.client.get(
            reverse(
                "lecture-resource-download",
                kwargs={"lecture_pk": self.lecture.id, "pk": resource.id},
            )
        )
        self.assertEqual(allowed_response.status_code, 302)
        self.assertEqual(allowed_response["Location"], "https://example.com/osint-reference")

    def test_course_detail_serializes_url_based_lecture_resource_without_file_errors(self):
        LectureResource.objects.create(
            lecture=self.lecture,
            title="Reference Link",
            resource_url="https://example.com/osint-reference",
            order=1,
        )

        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        self.login(self.student.email)
        response = self.client.get(reverse("course-detail", kwargs={"pk": self.course.id}))

        self.assertEqual(response.status_code, 200)
        lecture_payload = response.data["data"]["sections"][0]["lectures"][0]
        self.assertEqual(len(lecture_payload["resources"]), 1)
        resource_payload = lecture_payload["resources"][0]
        self.assertEqual(resource_payload["title"], "Reference Link")
        self.assertEqual(resource_payload["resource_kind"], "url")
        self.assertEqual(resource_payload["file_size"], 0)
        self.assertIn(
            reverse(
                "lecture-resource-download",
                kwargs={"lecture_pk": self.lecture.id, "pk": resource_payload["id"]},
            ),
            resource_payload["download_url"],
        )


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

    def test_identical_progress_update_is_a_noop_for_persistence(self):
        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        self.login(self.student.email)

        first = self.client.put(
            reverse("lecture-progress", kwargs={"pk": self.lecture.id}),
            {
                "position_seconds": 147,
                "duration_seconds": 600,
            },
            format="json",
        )
        self.assertEqual(first.status_code, 200)

        progress = LectureProgress.objects.get(user=self.student, lecture=self.lecture)
        first_updated_at = progress.updated_at

        second = self.client.put(
            reverse("lecture-progress", kwargs={"pk": self.lecture.id}),
            {
                "position_seconds": 147,
                "duration_seconds": 600,
            },
            format="json",
        )
        self.assertEqual(second.status_code, 200)

        progress.refresh_from_db()
        self.assertEqual(progress.last_position_seconds, 147)
        self.assertEqual(progress.duration_seconds, 600)
        self.assertEqual(progress.updated_at, first_updated_at)


class LectureQuestionSecurityTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        Enrollment.objects.create(
            user=self.student,
            course=self.course,
            payment_status=Enrollment.STATUS_PAID,
        )
        self.login(self.student.email)

    def test_lecture_question_rejects_sqli_payload(self):
        response = self.client.post(
            reverse("lecture-questions", kwargs={"pk": self.lecture.id}),
            {"question": "' OR 1=1 --"},
            format="json",
        )
        payload = response.json()
        self.assertEqual(response.status_code, 400)
        self.assertEqual(payload["errors"]["detail"], "Suspicious input detected.")
        self.assertEqual(LectureQuestion.objects.count(), 0)

    def test_lecture_question_rejects_active_content_payload(self):
        response = self.client.post(
            reverse("lecture-questions", kwargs={"pk": self.lecture.id}),
            {"question": "<script>alert('xss')</script>"},
            format="json",
        )
        payload = response.json()
        self.assertEqual(response.status_code, 400)
        self.assertEqual(payload["errors"]["detail"], "Suspicious input detected.")
        self.assertEqual(LectureQuestion.objects.count(), 0)

    def test_lecture_question_accepts_plain_text_question(self):
        response = self.client.post(
            reverse("lecture-questions", kwargs={"pk": self.lecture.id}),
            {"question": "Can you explain the difference between passive and active OSINT?"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(LectureQuestion.objects.count(), 1)


class AdaptiveHLSTranscodeTests(BaseAPITestCase):
    def _prepare_media_root(self):
        temp_dir = os.path.join(settings.BASE_DIR, ".codex-temp-tests", self._testMethodName)
        shutil.rmtree(temp_dir, ignore_errors=True)
        os.makedirs(temp_dir, exist_ok=True)
        self.addCleanup(lambda: shutil.rmtree(temp_dir, ignore_errors=True))
        return temp_dir

    @patch("apps.courses.services.subprocess.run")
    def test_transcode_lecture_to_hls_generates_master_playlist_and_duration(self, mock_run):
        temp_dir = self._prepare_media_root()
        with override_settings(
            MEDIA_ROOT=temp_dir,
            COURSE_HLS_SEGMENT_DURATION_SECONDS=4,
            COURSE_HLS_KEYFRAME_INTERVAL_SECONDS=4,
            COURSE_HLS_X264_PRESET="slow",
            COURSE_HLS_CRF=18,
        ):
            lecture = Lecture.objects.create(
                section=self.section,
                title="Adaptive Lecture",
                description="Adaptive stream generation",
                video_file=SimpleUploadedFile("adaptive.mp4", b"source-bytes", content_type="video/mp4"),
                order=2,
            )
            ffmpeg_commands = []

            def fake_run(cmd, check=False, capture_output=False, text=False):
                executable = os.path.basename(str(cmd[0]))
                if executable == "ffprobe":
                    return SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(
                            {
                                "streams": [
                                    {
                                        "codec_type": "video",
                                        "width": 1280,
                                        "height": 720,
                                        "avg_frame_rate": "30/1",
                                    },
                                    {"codec_type": "audio"},
                                ],
                                "format": {"duration": "612.4"},
                            }
                        ),
                        stderr="",
                    )

                ffmpeg_commands.append(cmd)
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
            self.assertNotIn("1080p/index.m3u8", master_playlist)
            self.assertEqual(len(ffmpeg_commands), 3)

            for cmd in ffmpeg_commands:
                self.assertEqual(cmd[cmd.index("-preset") + 1], "slow")
                self.assertEqual(cmd[cmd.index("-crf") + 1], "18")
                self.assertEqual(cmd[cmd.index("-hls_time") + 1], "4")
                self.assertEqual(cmd[cmd.index("-g") + 1], "120")
                self.assertEqual(cmd[cmd.index("-keyint_min") + 1], "120")
                self.assertEqual(
                    cmd[cmd.index("-force_key_frames") + 1],
                    "expr:gte(t,n_forced*4)",
                )

    @patch("apps.courses.services.subprocess.run")
    def test_transcode_lecture_to_hls_includes_1080p_variant_when_source_supports_it(self, mock_run):
        temp_dir = self._prepare_media_root()
        with override_settings(
            MEDIA_ROOT=temp_dir,
            COURSE_HLS_SEGMENT_DURATION_SECONDS=4,
            COURSE_HLS_KEYFRAME_INTERVAL_SECONDS=4,
            COURSE_HLS_X264_PRESET="slow",
            COURSE_HLS_CRF=18,
        ):
            lecture = Lecture.objects.create(
                section=self.section,
                title="Full HD Lecture",
                description="1080p adaptive stream generation",
                video_file=SimpleUploadedFile("full-hd.mp4", b"source-bytes", content_type="video/mp4"),
                order=3,
            )
            ffmpeg_commands = []

            def fake_run(cmd, check=False, capture_output=False, text=False):
                executable = os.path.basename(str(cmd[0]))
                if executable == "ffprobe":
                    return SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(
                            {
                                "streams": [
                                    {
                                        "codec_type": "video",
                                        "width": 1920,
                                        "height": 1080,
                                        "avg_frame_rate": "30/1",
                                    },
                                    {"codec_type": "audio"},
                                ],
                                "format": {"duration": "845.0"},
                            }
                        ),
                        stderr="",
                    )

                ffmpeg_commands.append(cmd)
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
            self.assertEqual(lecture.stream_duration_seconds, 845)
            self.assertTrue(lecture.stream_manifest_key.endswith("master.m3u8"))

            master_playlist_path = os.path.join(temp_dir, lecture.stream_manifest_key)
            with open(master_playlist_path, "r", encoding="utf-8") as handle:
                master_playlist = handle.read()

            self.assertIn("360p/index.m3u8", master_playlist)
            self.assertIn("540p/index.m3u8", master_playlist)
            self.assertIn("720p/index.m3u8", master_playlist)
            self.assertIn("1080p/index.m3u8", master_playlist)
            self.assertEqual(len(ffmpeg_commands), 4)

    @patch("apps.courses.services.subprocess.run")
    def test_transcode_lecture_to_hls_omits_1080p_when_source_lacks_full_hd_width(self, mock_run):
        temp_dir = self._prepare_media_root()
        with override_settings(
            MEDIA_ROOT=temp_dir,
            COURSE_HLS_SEGMENT_DURATION_SECONDS=4,
            COURSE_HLS_KEYFRAME_INTERVAL_SECONDS=4,
            COURSE_HLS_X264_PRESET="slow",
            COURSE_HLS_CRF=18,
        ):
            lecture = Lecture.objects.create(
                section=self.section,
                title="Width Constrained Lecture",
                description="1080-high source without full HD width",
                video_file=SimpleUploadedFile("width-constrained.mp4", b"source-bytes", content_type="video/mp4"),
                order=4,
            )
            ffmpeg_commands = []

            def fake_run(cmd, check=False, capture_output=False, text=False):
                executable = os.path.basename(str(cmd[0]))
                if executable == "ffprobe":
                    return SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(
                            {
                                "streams": [
                                    {
                                        "codec_type": "video",
                                        "width": 1440,
                                        "height": 1080,
                                        "avg_frame_rate": "30/1",
                                    },
                                    {"codec_type": "audio"},
                                ],
                                "format": {"duration": "720.0"},
                            }
                        ),
                        stderr="",
                    )

                ffmpeg_commands.append(cmd)
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
            self.assertEqual(lecture.stream_duration_seconds, 720)
            self.assertTrue(lecture.stream_manifest_key.endswith("master.m3u8"))

            master_playlist_path = os.path.join(temp_dir, lecture.stream_manifest_key)
            with open(master_playlist_path, "r", encoding="utf-8") as handle:
                master_playlist = handle.read()

            self.assertIn("360p/index.m3u8", master_playlist)
            self.assertIn("540p/index.m3u8", master_playlist)
            self.assertIn("720p/index.m3u8", master_playlist)
            self.assertNotIn("1080p/index.m3u8", master_playlist)
            self.assertEqual(len(ffmpeg_commands), 3)


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

    @override_settings(REALTIME_ENROLLMENT_ACCESS_CACHE_TTL_SECONDS=30)
    def test_join_access_enrollment_lookup_is_cached(self):
        session = RealtimeSession.objects.create(
            title="Cached Enrollment Session",
            description="Enrollment cache should reduce repeated DB exists checks.",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=200,
            max_audience=500,
        )

        with patch(
            "apps.realtime.domain.LiveClassEnrollment.objects.filter",
            wraps=LiveClassEnrollment.objects.filter,
        ) as mocked_filter:
            first = realtime_domain.get_access_decision(session, self.viewer)
            second = realtime_domain.get_access_decision(session, self.viewer)

        self.assertTrue(first.allowed)
        self.assertTrue(second.allowed)
        self.assertEqual(mocked_filter.call_count, 1)

    @override_settings(
        OWNCAST_BASE_URL="https://stream.example.com",
        OWNCAST_STREAM_PUBLIC_BASE_URL="https://stream.example.com",
        OWNCAST_CHAT_PUBLIC_BASE_URL="https://stream.example.com",
        OWNCAST_DEFAULT_STREAM_PATH="/embed/video",
        OWNCAST_DEFAULT_CHAT_PATH="/embed/chat/readwrite",
        REALTIME_BROADCAST_URL_CACHE_TTL_SECONDS=30,
    )
    def test_resolve_broadcast_urls_uses_cache(self):
        session = RealtimeSession.objects.create(
            title="Broadcast URL Cache Session",
            description="Broadcast URL resolution should use short-TTL cache.",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=200,
            max_audience=500,
        )

        with patch(
            "apps.realtime.services._resolve_public_service_base_url",
            wraps=realtime_services._resolve_public_service_base_url,
        ) as mocked_resolver:
            first = realtime_services.resolve_broadcast_urls(session)
            second = realtime_services.resolve_broadcast_urls(session)

        self.assertEqual(first, second)
        self.assertEqual(first["stream_embed_url"], "https://stream.example.com/embed/video")
        self.assertEqual(first["chat_embed_url"], "https://stream.example.com/embed/chat/readwrite")
        self.assertNotIn(":8080", first["stream_embed_url"])
        self.assertNotIn(":8080", first["chat_embed_url"])
        # First call resolves stream + chat bases (2 calls), second call is cache hit.
        self.assertEqual(mocked_resolver.call_count, 2)

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
                "max_audience": 500,
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
                "max_audience": 500,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("linked_live_class_id", response.data["errors"])

    def test_meeting_create_rejects_capacity_above_200(self):
        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "Capacity Above Limit",
                "description": "Should be blocked",
                "session_type": "meeting",
                "linked_live_class_id": self.live_class.id,
                "meeting_capacity": 201,
                "max_audience": 500,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.data["errors"]["meeting_capacity"][0],
            "Meeting capacity cannot exceed 200.",
        )

    def test_meeting_create_rejects_max_audience_above_500(self):
        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "Audience Above Limit",
                "description": "Should be blocked",
                "session_type": "meeting",
                "linked_live_class_id": self.live_class.id,
                "meeting_capacity": 200,
                "max_audience": 501,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.data["errors"]["max_audience"][0],
            "Max audience cannot exceed 500.",
        )

    def test_instructor_can_create_session_for_assigned_live_class(self):
        instructor = User.objects.create_user(
            email="assigned-instructor@test.com",
            password="StrongPass@123",
            full_name="Assigned Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        assigned_course = Course.objects.create(
            title="Assigned Instructor Course",
            description="Instructor-owned course for realtime tests.",
            price=Decimal("499.00"),
            instructor=instructor,
            is_published=True,
        )
        assigned_live_class = LiveClass.objects.create(
            title="Assigned Instructor Live Class",
            description="Live class tied to assigned instructor course.",
            level=LiveClass.LEVEL_BEGINNER,
            month_number=1,
            is_active=True,
            linked_course=assigned_course,
        )

        self.login(instructor.email)
        response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "Instructor Meeting Session",
                "description": "Instructor should be allowed to create this session.",
                "session_type": "meeting",
                "linked_live_class_id": assigned_live_class.id,
                "meeting_capacity": 120,
                "max_audience": 500,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["data"]["host"]["id"], instructor.id)

    def test_instructor_cannot_create_session_for_unassigned_live_class(self):
        outsider_instructor = User.objects.create_user(
            email="outsider-instructor@test.com",
            password="StrongPass@123",
            full_name="Outsider Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        self.login(outsider_instructor.email)
        response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "Forbidden Instructor Session",
                "description": "Instructor should not create sessions for other instructors.",
                "session_type": "meeting",
                "linked_live_class_id": self.live_class.id,
                "meeting_capacity": 120,
                "max_audience": 500,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("assigned to their courses", response.data["errors"]["detail"])

    @override_settings(
        OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
    )
    @patch("apps.realtime.views.sync_owncast_stream_key")
    def test_broadcast_create_obs_mode_syncs_owncast_key(self, mock_sync_key):
        mock_sync_key.return_value = {"success": True}
        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "OBS Create Session",
                "description": "Sync key on create",
                "session_type": "broadcasting",
                "linked_live_class_id": self.live_class.id,
                "stream_service": RealtimeSession.STREAM_SERVICE_OBS,
                "obs_stream_key": "CreateObsKey123",
                "max_audience": 500,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        session_id = response.data["data"]["id"]
        session = RealtimeSession.objects.get(pk=session_id)
        self.assertEqual(session.stream_service, RealtimeSession.STREAM_SERVICE_OBS)
        self.assertEqual(session.obs_stream_key, "default-key")
        mock_sync_key.assert_called_once_with("default-key")

    @override_settings(
        OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
    )
    @patch("apps.realtime.views.sync_owncast_stream_key")
    def test_broadcast_create_obs_mode_fails_when_owncast_sync_fails(self, mock_sync_key):
        mock_sync_key.side_effect = realtime_services.OwncastAdminError("Owncast sync failed")
        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-list-create"),
            {
                "title": "OBS Create Failure Session",
                "description": "Should fail when sync fails",
                "session_type": "broadcasting",
                "linked_live_class_id": self.live_class.id,
                "stream_service": RealtimeSession.STREAM_SERVICE_OBS,
                "obs_stream_key": "CreateObsFailKey123",
                "max_audience": 500,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["message"], "Unable to create OBS broadcast session.")
        self.assertIn("Owncast sync failed", response.data["errors"]["detail"])
        self.assertFalse(RealtimeSession.objects.filter(title="OBS Create Failure Session").exists())

    @override_settings(
        OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
    )
    def test_realtime_session_payload_hides_obs_key_for_non_moderators(self):
        session = RealtimeSession.objects.create(
            title="OBS Hidden Key Session",
            description="OBS key must be hidden from non moderators.",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            obs_stream_key="HiddenObsKey123",
            max_audience=500,
        )

        self.login(self.viewer.email)
        response = self.client.get(reverse("realtime-session-detail", kwargs={"pk": session.id}))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["data"]["obs_stream_key"], "")

        self.client.post(reverse("auth-logout"))
        self.login(self.host.email)
        host_response = self.client.get(reverse("realtime-session-detail", kwargs={"pk": session.id}))
        self.assertEqual(host_response.status_code, 200)
        self.assertEqual(host_response.data["data"]["obs_stream_key"], "default-key")

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

    def test_blocked_user_join_does_not_mark_scheduled_session_live(self):
        blocked_user = User.objects.create_user(
            email="blocked-scheduled@test.com",
            password="StrongPass@123",
            full_name="Blocked Scheduled User",
            role=User.ROLE_STUDENT,
        )
        session = RealtimeSession.objects.create(
            title="Scheduled Restricted Meeting",
            description="Unauthorized join must not transition status",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_SCHEDULED,
        )

        self.login(blocked_user.email)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Blocked Scheduled User"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 403)
        session.refresh_from_db()
        self.assertEqual(session.status, RealtimeSession.STATUS_SCHEDULED)

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

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_join_meeting_low_quality_mode_returns_low_profile(
        self,
        mock_participant_count,
        mock_build_token,
        mock_build_meet_url,
    ):
        mock_participant_count.return_value = 10
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"

        config = RealtimeConfiguration.get_solo()
        config.meeting_quality_mode = RealtimeConfiguration.MEETING_QUALITY_MODE_LOW
        # Even if stale high values exist in DB, low mode must emit low profile.
        config.meeting_camera_capture_width = 1920
        config.meeting_camera_capture_height = 1080
        config.meeting_camera_capture_fps = 30
        config.meeting_camera_max_video_bitrate_kbps = 3500
        config.meeting_screen_capture_width = 1920
        config.meeting_screen_capture_height = 1080
        config.meeting_screen_capture_fps = 30
        config.meeting_screen_max_video_bitrate_kbps = 6000
        config.save(
            update_fields=[
                "meeting_quality_mode",
                "meeting_camera_capture_width",
                "meeting_camera_capture_height",
                "meeting_camera_capture_fps",
                "meeting_camera_max_video_bitrate_kbps",
                "meeting_screen_capture_width",
                "meeting_screen_capture_height",
                "meeting_screen_capture_fps",
                "meeting_screen_max_video_bitrate_kbps",
                "updated_at",
            ]
        )

        session = RealtimeSession.objects.create(
            title="Low Quality Meeting Session",
            description="Low mode should apply deterministic low profile",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=300,
            max_audience=500,
        )

        self.login(self.viewer.email)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 200)
        media_profile = join_response.data["data"]["meeting"]["media_profile"]
        self.assertEqual(media_profile["camera_capture_width"], 854)
        self.assertEqual(media_profile["camera_capture_height"], 480)
        self.assertEqual(media_profile["camera_fps"], 20)
        self.assertEqual(media_profile["camera_max_video_bitrate_kbps"], 850)
        self.assertEqual(media_profile["screen_capture_width"], 854)
        self.assertEqual(media_profile["screen_capture_height"], 480)
        self.assertEqual(media_profile["screen_fps"], 12)
        self.assertEqual(media_profile["screen_max_video_bitrate_kbps"], 1400)

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_join_meeting_adaptive_quality_mode_scales_profile_by_participant_load(
        self,
        mock_participant_count,
        mock_build_token,
        mock_build_meet_url,
    ):
        mock_participant_count.side_effect = [20, 220]
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"

        config = RealtimeConfiguration.get_solo()
        config.meeting_quality_mode = RealtimeConfiguration.MEETING_QUALITY_MODE_ADAPTIVE
        config.save(update_fields=["meeting_quality_mode", "updated_at"])

        session = RealtimeSession.objects.create(
            title="Adaptive Quality Meeting Session",
            description="Adaptive mode should tune profile by participant load",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=300,
            max_audience=500,
        )

        self.login(self.viewer.email)
        low_load_join = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(low_load_join.status_code, 200)
        low_load_profile = low_load_join.data["data"]["meeting"]["media_profile"]
        self.assertEqual(low_load_profile["camera_capture_width"], 1280)
        self.assertEqual(low_load_profile["camera_capture_height"], 720)
        self.assertEqual(low_load_profile["camera_fps"], 24)
        self.assertEqual(low_load_profile["camera_max_video_bitrate_kbps"], 1200)
        self.assertEqual(low_load_profile["screen_capture_width"], 1280)
        self.assertEqual(low_load_profile["screen_capture_height"], 720)
        self.assertEqual(low_load_profile["screen_fps"], 15)
        self.assertEqual(low_load_profile["screen_max_video_bitrate_kbps"], 2500)

        high_load_join = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(high_load_join.status_code, 200)
        high_load_profile = high_load_join.data["data"]["meeting"]["media_profile"]
        self.assertEqual(high_load_profile["camera_capture_width"], 854)
        self.assertEqual(high_load_profile["camera_capture_height"], 480)
        self.assertEqual(high_load_profile["camera_fps"], 20)
        self.assertEqual(high_load_profile["camera_max_video_bitrate_kbps"], 850)
        self.assertEqual(high_load_profile["screen_capture_width"], 854)
        self.assertEqual(high_load_profile["screen_capture_height"], 480)
        self.assertEqual(high_load_profile["screen_fps"], 12)
        self.assertEqual(high_load_profile["screen_max_video_bitrate_kbps"], 1400)

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
            max_audience=500,
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
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    def test_broadcast_join_returns_meeting_mode_for_moderator(self, mock_build_token, mock_build_meet_url):
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"

        session = RealtimeSession.objects.create(
            title="Broadcast Moderator Session",
            description="Moderator should enter interactive stage room",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            stream_embed_url="https://stream.example.com/embed/video",
            chat_embed_url="https://stream.example.com/embed/chat",
        )

        self.login(self.host.email)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Admin Host"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 200)
        self.assertEqual(join_response.data["data"]["mode"], "meeting")
        self.assertTrue(join_response.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertTrue(join_response.data["data"]["meeting"]["permissions"]["can_speak"])
        self.assertEqual(
            mock_build_token.call_args.kwargs["can_publish_sources"],
            ["camera", "screen_share", "screen_share_audio", "microphone"],
        )

    def test_broadcast_join_returns_broadcast_mode_for_regular_viewer(self):
        session = RealtimeSession.objects.create(
            title="Broadcast Viewer Session",
            description="Viewer should stay in stream mode",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            stream_embed_url="https://stream.example.com/embed/video",
            chat_embed_url="https://stream.example.com/embed/chat",
        )

        self.login(self.viewer.email)
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 200)
        self.assertEqual(join_response.data["data"]["mode"], "broadcast")
        self.assertEqual(
            join_response.data["data"]["broadcast"]["stream_embed_url"],
            "https://stream.example.com/embed/video",
        )

    @override_settings(OWNCAST_CHAT_BRIDGE_ENABLED=True)
    @patch("apps.realtime.views.register_owncast_chat_user")
    def test_broadcast_chat_launch_returns_stream_bridge_url(self, mock_register_chat_user):
        mock_register_chat_user.return_value = {
            "access_token": "bridge-access-token-123",
            "display_name": "Viewer User",
            "display_color": "#ffffff",
        }
        session = RealtimeSession.objects.create(
            title="Broadcast Chat Launch Session",
            description="Launch URL should point to stream chat bridge.",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            stream_embed_url="https://stream.example.com/embed/video",
            chat_embed_url="https://stream.example.com/embed/chat/readwrite",
        )

        self.login(self.viewer.email)
        response = self.client.post(
            reverse("realtime-session-owncast-chat-launch", kwargs={"pk": session.id}),
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        launch_url = response.data["data"]["launch_url"]
        parsed_launch_url = urlparse(launch_url)
        self.assertEqual(parsed_launch_url.scheme, "https")
        self.assertEqual(parsed_launch_url.netloc, "stream.example.com")
        self.assertEqual(parsed_launch_url.path, "/api/realtime/owncast/chat-bridge/")

        token_values = parse_qs(parsed_launch_url.query).get("token") or []
        self.assertTrue(token_values)
        signed_payload = signing.loads(
            token_values[0],
            max_age=120,
            salt="realtime.owncast-chat-bridge",
        )
        self.assertEqual(signed_payload["access_token"], "bridge-access-token-123")
        self.assertEqual(signed_payload["display_name"], "Viewer User")
        self.assertEqual(signed_payload["session_id"], session.id)
        self.assertEqual(signed_payload["user_id"], self.viewer.id)

    @override_settings(OWNCAST_CHAT_BRIDGE_ENABLED=True)
    @patch("apps.realtime.views.register_owncast_chat_user")
    def test_broadcast_chat_launch_rejects_non_broadcast_session(self, mock_register_chat_user):
        session = RealtimeSession.objects.create(
            title="Meeting Session",
            description="Chat launch should be blocked for meeting sessions.",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
        )

        self.login(self.viewer.email)
        response = self.client.post(
            reverse("realtime-session-owncast-chat-launch", kwargs={"pk": session.id}),
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("broadcasting sessions", response.data["errors"]["detail"])
        mock_register_chat_user.assert_not_called()

    def test_owncast_chat_bridge_renders_local_storage_bootstrap_html(self):
        signed_token = signing.dumps(
            {
                "access_token": "bridge-access-token-123",
                "display_name": "Viewer User",
                "next_path": "/embed/chat/readwrite/",
                "session_id": 99,
                "user_id": self.viewer.id,
            },
            salt="realtime.owncast-chat-bridge",
            compress=True,
        )

        response = self.client.get(
            reverse("realtime-owncast-chat-bridge"),
            {"token": signed_token},
        )
        self.assertEqual(response.status_code, 200)
        html = response.content.decode("utf-8")
        self.assertIn('localStorage.setItem("accessToken"', html)
        self.assertIn("bridge-access-token-123", html)
        self.assertIn("/embed/chat/readwrite/", html)
        self.assertEqual(response["Cache-Control"], "no-store, max-age=0")

    def test_owncast_chat_bridge_rejects_invalid_signature(self):
        response = self.client.get(
            reverse("realtime-owncast-chat-bridge"),
            {"token": "invalid-token"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["message"], "Invalid chat bridge request.")
        self.assertIn("invalid or expired", response.data["errors"]["detail"])

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.apply_live_presenter_permission_update")
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    def test_broadcast_presenter_grant_allows_stage_join(
        self,
        mock_build_token,
        mock_build_meet_url,
        mock_apply_live_presenter_update,
    ):
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"
        mock_apply_live_presenter_update.return_value = {
            "applied": True,
            "connected_matches": 0,
            "updated_identities": [],
            "errors": [],
        }

        session = RealtimeSession.objects.create(
            title="Broadcast Stage Grant Session",
            description="Presenter grants should work for broadcasting too",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            stream_embed_url="https://stream.example.com/embed/video",
            chat_embed_url="https://stream.example.com/embed/chat",
        )

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
        join_response = self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )
        self.assertEqual(join_response.status_code, 200)
        self.assertEqual(join_response.data["data"]["mode"], "meeting")
        self.assertTrue(join_response.data["data"]["meeting"]["permissions"]["can_present"])
        self.assertFalse(join_response.data["data"]["meeting"]["permissions"]["can_speak"])

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
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
    )
    @patch("apps.realtime.views.build_host_publisher_token")
    def test_host_token_uses_low_broadcast_profile_in_low_mode(self, mock_build_host_token):
        mock_build_host_token.return_value = {"identity": "host-1", "token": "token-1"}
        config = RealtimeConfiguration.get_solo()
        config.broadcast_quality_mode = RealtimeConfiguration.BROADCAST_QUALITY_MODE_LOW
        config.save(update_fields=["broadcast_quality_mode", "updated_at"])

        session = RealtimeSession.objects.create(
            title="Low Broadcast Profile Session",
            description="Low profile check",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_LIVE,
            max_audience=500,
        )

        self.login(self.host.email)
        response = self.client.post(reverse("realtime-session-host-token", kwargs={"pk": session.id}), {}, format="json")
        self.assertEqual(response.status_code, 200)
        profile = response.data["data"]["broadcast_profile"]
        self.assertEqual(profile["capture_width"], 640)
        self.assertEqual(profile["capture_height"], 360)
        self.assertEqual(profile["fps"], 20)
        self.assertEqual(profile["max_video_bitrate_kbps"], 650)

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
    )
    @patch("apps.realtime.views.build_host_publisher_token")
    def test_host_token_uses_adaptive_broadcast_profile_for_high_audience(self, mock_build_host_token):
        mock_build_host_token.return_value = {"identity": "host-1", "token": "token-1"}
        config = RealtimeConfiguration.get_solo()
        config.broadcast_quality_mode = RealtimeConfiguration.BROADCAST_QUALITY_MODE_ADAPTIVE
        config.save(update_fields=["broadcast_quality_mode", "updated_at"])

        session = RealtimeSession.objects.create(
            title="Adaptive Broadcast Profile Session",
            description="Adaptive profile check",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_LIVE,
            max_audience=500,
        )

        self.login(self.host.email)
        response = self.client.post(reverse("realtime-session-host-token", kwargs={"pk": session.id}), {}, format="json")
        self.assertEqual(response.status_code, 200)
        profile = response.data["data"]["broadcast_profile"]
        self.assertEqual(profile["capture_width"], 854)
        self.assertEqual(profile["capture_height"], 480)
        self.assertEqual(profile["fps"], 20)
        self.assertEqual(profile["max_video_bitrate_kbps"], 1100)

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

    @patch("apps.realtime.services._twirp_post")
    @patch("apps.realtime.services._list_room_participants")
    def test_start_room_broadcast_egress_uses_track_composite_for_screen_share(self, mock_list_participants, mock_twirp_post):
        mock_list_participants.return_value = [
            {
                "identity": "host-1-session-77",
                "tracks": [
                    {"sid": "TR_screen_share", "source": "SCREEN_SHARE"},
                    {"sid": "TR_microphone", "source": "MICROPHONE"},
                ],
            }
        ]
        mock_twirp_post.return_value = {"egress_id": "EG_track_composite"}

        egress_id = realtime_services.start_room_broadcast_egress(
            room_name="screen-share-room",
            rtmp_target_url="rtmp://owncast:1935/live/test-key",
            participant_identity="host-1-session-77",
        )

        self.assertEqual(egress_id, "EG_track_composite")
        self.assertEqual(mock_twirp_post.call_count, 1)
        self.assertEqual(mock_twirp_post.call_args.args[0], "livekit.Egress/StartTrackCompositeEgress")
        self.assertEqual(
            mock_twirp_post.call_args.args[1],
            {
                "room_name": "screen-share-room",
                "video_track_id": "TR_screen_share",
                "audio_track_id": "TR_microphone",
                "stream_outputs": [{"urls": ["rtmp://owncast:1935/live/test-key"]}],
            },
        )

    @patch("apps.realtime.services._twirp_post")
    @patch("apps.realtime.services._list_room_participants")
    def test_start_room_broadcast_egress_falls_back_to_participant_egress_without_screen_share(
        self,
        mock_list_participants,
        mock_twirp_post,
    ):
        mock_list_participants.return_value = [
            {
                "identity": "host-1-session-77",
                "tracks": [
                    {"sid": "TR_camera", "source": "CAMERA"},
                    {"sid": "TR_microphone", "source": "MICROPHONE"},
                ],
            }
        ]
        mock_twirp_post.return_value = {"egress_id": "EG_participant_only"}

        egress_id = realtime_services.start_room_broadcast_egress(
            room_name="camera-room",
            rtmp_target_url="rtmp://owncast:1935/live/test-key",
            participant_identity="host-1-session-77",
        )

        self.assertEqual(egress_id, "EG_participant_only")
        self.assertEqual(mock_twirp_post.call_count, 1)
        self.assertEqual(mock_twirp_post.call_args.args[0], "livekit.Egress/StartParticipantEgress")
        self.assertEqual(
            mock_twirp_post.call_args.args[1],
            {
                "room_name": "camera-room",
                "identity": "host-1-session-77",
                "stream_outputs": [{"urls": ["rtmp://owncast:1935/live/test-key"]}],
            },
        )

    @patch("apps.realtime.services._twirp_post")
    @patch("apps.realtime.services._list_room_participants")
    def test_start_room_broadcast_egress_falls_back_when_track_composite_fails(
        self,
        mock_list_participants,
        mock_twirp_post,
    ):
        mock_list_participants.return_value = [
            {
                "identity": "host-1-session-77",
                "tracks": [
                    {"sid": "TR_screen_share", "source": "SCREEN_SHARE"},
                    {"sid": "TR_microphone", "source": "MICROPHONE"},
                ],
            }
        ]
        mock_twirp_post.side_effect = [
            realtime_services.LiveKitEgressError("track composite failed"),
            {"egress_id": "EG_participant_fallback"},
        ]

        egress_id = realtime_services.start_room_broadcast_egress(
            room_name="fallback-room",
            rtmp_target_url="rtmp://owncast:1935/live/test-key",
            participant_identity="host-1-session-77",
        )

        self.assertEqual(egress_id, "EG_participant_fallback")
        self.assertEqual(mock_twirp_post.call_count, 2)
        self.assertEqual(mock_twirp_post.call_args_list[0].args[0], "livekit.Egress/StartTrackCompositeEgress")
        self.assertEqual(mock_twirp_post.call_args_list[1].args[0], "livekit.Egress/StartParticipantEgress")

    @override_settings(
        OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
        OWNCAST_OBS_STREAM_SERVER_URL="rtmp://obs.example.com:1935/live",
    )
    @patch("apps.realtime.views.sync_owncast_stream_key")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_start_stream_obs_mode_skips_livekit_egress(self, mock_start_egress, mock_sync_key):
        mock_sync_key.return_value = {"success": True}
        session = RealtimeSession.objects.create(
            title="OBS Mode Session",
            description="OBS ingest mode stream start",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_LIVE,
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            obs_stream_key="ObsStreamKey123",
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
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
        self.assertEqual(session.livekit_egress_id, "")
        self.assertEqual(session.obs_stream_key, "default-key")
        mock_sync_key.assert_called_once_with("default-key")
        mock_start_egress.assert_not_called()

    @override_settings(
        OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
        OWNCAST_OBS_STREAM_SERVER_URL="rtmp://obs.example.com:1935/live",
    )
    @patch("apps.realtime.views.build_host_publisher_token")
    def test_host_token_returns_obs_payload_for_obs_mode(self, mock_build_host_token):
        mock_build_host_token.return_value = {"identity": "host-1", "token": "token-1"}
        session = RealtimeSession.objects.create(
            title="OBS Host Token Session",
            description="OBS host token payload",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_LIVE,
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            obs_stream_key="ObsTokenKey123",
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
        )

        self.login(self.host.email)
        response = self.client.post(reverse("realtime-session-host-token", kwargs={"pk": session.id}), {}, format="json")
        self.assertEqual(response.status_code, 200)
        payload = response.data["data"]
        self.assertEqual(payload["stream_service"], RealtimeSession.STREAM_SERVICE_OBS)
        self.assertEqual(payload["obs"]["stream_server_url"], "rtmp://obs.example.com:1935/live")
        self.assertEqual(payload["obs"]["stream_key"], "default-key")
        self.assertNotIn("token", payload)
        mock_build_host_token.assert_not_called()

    @override_settings(
        OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
        OWNCAST_OBS_STREAM_SERVER_URL="rtmp://obs.example.com:1935/live",
    )
    @patch("apps.realtime.views.sync_owncast_stream_key")
    def test_rotate_obs_stream_key_endpoint_syncs_fixed_key(self, mock_sync_key):
        mock_sync_key.return_value = {"success": True}
        session = RealtimeSession.objects.create(
            title="Rotate OBS Key Session",
            description="Manual key rotation",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_LIVE,
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            obs_stream_key="RotateMe12345",
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
        )

        self.login(self.host.email)
        response = self.client.post(
            reverse("realtime-session-stream-rotate-key", kwargs={"pk": session.id}),
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["message"], "OBS stream key synced (fixed key mode).")
        session.refresh_from_db()
        self.assertEqual(session.obs_stream_key, "default-key")
        self.assertEqual(session.stream_service, RealtimeSession.STREAM_SERVICE_OBS)
        mock_sync_key.assert_called_once_with("default-key")

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
    @patch("apps.realtime.views.apply_live_presenter_permission_update")
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_student_receives_stage_access_after_presenter_granted(
        self,
        mock_participant_count,
        mock_build_token,
        mock_build_meet_url,
        mock_apply_live_presenter_update,
    ):
        mock_participant_count.return_value = 1
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"
        mock_apply_live_presenter_update.return_value = {
            "applied": True,
            "connected_matches": 0,
            "updated_identities": [],
            "errors": [],
        }

        session = RealtimeSession.objects.create(
            title="Permission Session",
            description="Presenter control checks",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=300,
            max_audience=500,
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
        self.assertFalse(after_grant.data["data"]["meeting"]["permissions"]["can_speak"])
        self.assertEqual(mock_build_token.call_count, 2)
        self.assertEqual(
            mock_build_token.call_args_list[0].kwargs["can_publish_sources"],
            None,
        )
        self.assertEqual(
            mock_build_token.call_args_list[1].kwargs["can_publish_sources"],
            ["camera", "screen_share", "screen_share_audio"],
        )

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.apply_live_presenter_permission_update")
    def test_presenter_stage_limit_is_enforced(self, mock_apply_live_presenter_update):
        mock_apply_live_presenter_update.return_value = {
            "applied": True,
            "connected_matches": 0,
            "updated_identities": [],
            "errors": [],
        }
        session = RealtimeSession.objects.create(
            title="Stage Limit Session",
            description="Stage capacity checks",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=300,
            max_audience=500,
        )
        self.login(self.host.email)
        stage_users = [
            User.objects.create_user(
                email=f"stage{i}@test.com",
                password="StrongPass@123",
                full_name=f"Stage User {i}",
                role=User.ROLE_STUDENT,
            )
            for i in range(1, 7)
        ]
        for stage_user in stage_users[:5]:
            response = self.client.post(
                reverse(
                    "realtime-session-presenter-permission",
                    kwargs={"pk": session.id, "permission_action": "grant"},
                ),
                {"user_id": stage_user.id},
                format="json",
            )
            self.assertEqual(response.status_code, 200)
        overflow_response = self.client.post(
            reverse(
                "realtime-session-presenter-permission",
                kwargs={"pk": session.id, "permission_action": "grant"},
            ),
            {"user_id": stage_users[5].id},
            format="json",
        )
        self.assertEqual(overflow_response.status_code, 400)
        self.assertIn("Stage is full", str(overflow_response.data.get("errors")))

    @override_settings(
        LIVEKIT_URL="ws://livekit.test",
        LIVEKIT_API_KEY="devkey",
        LIVEKIT_API_SECRET="secret",
        LIVEKIT_MEET_URL="https://meet.livekit.io",
    )
    @patch("apps.realtime.views.apply_live_speaker_permission_update")
    @patch("apps.realtime.views.build_meet_embed_url")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_student_joins_meeting_with_microphone_only_after_speaker_granted(
        self,
        mock_participant_count,
        mock_build_token,
        mock_build_meet_url,
        mock_apply_live_speaker_update,
    ):
        mock_participant_count.return_value = 1
        mock_build_token.return_value = "lk.token"
        mock_build_meet_url.return_value = "https://meet.livekit.io/?token=lk.token"
        mock_apply_live_speaker_update.return_value = {
            "applied": True,
            "connected_matches": 0,
            "updated_identities": [],
            "errors": [],
        }

        session = RealtimeSession.objects.create(
            title="Speaker Permission Session",
            description="Speaker control checks",
            host=self.host,
            session_type=RealtimeSession.TYPE_MEETING,
            linked_live_class=self.live_class,
            linked_course=self.meeting_course,
            status=RealtimeSession.STATUS_LIVE,
            meeting_capacity=300,
            max_audience=500,
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
    @patch("apps.realtime.views.apply_live_speaker_permission_update")
    @patch("apps.realtime.views.build_participant_token")
    @patch("apps.realtime.views.get_room_participant_count")
    def test_assigned_instructor_can_join_and_manage_permissions_without_being_host(
        self,
        mock_participant_count,
        mock_build_token,
        mock_apply_live_speaker_update,
    ):
        mock_participant_count.return_value = 1
        mock_build_token.return_value = "lk.token"
        mock_apply_live_speaker_update.return_value = {
            "applied": True,
            "connected_matches": 0,
            "updated_identities": [],
            "errors": [],
        }

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
            max_audience=500,
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



