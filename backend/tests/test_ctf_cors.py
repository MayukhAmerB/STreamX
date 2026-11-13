"""The labs site may call /api/ctf/ (plus CSRF bootstrap and refresh) with the
student's cookies, and nothing else: CORS is path-scoped, other writes from a
labs origin are refused, and CSRF is enforced on cookie-authenticated calls."""

from apps.ctf.models import CtfParticipation
from apps.users.terms import TERMS_VERSION
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APIClient, APITestCase

from tests import factories as f

LABS = "https://labs.alsyedinitiative.com"
EVIL = "https://evil.example"
PEPPER = "cors-test-pepper-0123456789abcdefghijklmnopqrs"


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class LabsCorsTests(APITestCase):
    def setUp(self):
        cache.clear()

    def preflight(self, path, origin=LABS, method="POST"):
        return self.client.options(
            path,
            HTTP_ORIGIN=origin,
            HTTP_ACCESS_CONTROL_REQUEST_METHOD=method,
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS="content-type, x-csrftoken, idempotency-key",
        )

    def test_preflight_is_allowed_on_exam_paths(self):
        for path in (
            "/api/ctf/exams/",
            "/api/ctf/exams/final/questions/q1/attempts/",
            reverse("auth-csrf"),
            "/api/auth/refresh/",
        ):
            with self.subTest(path=path):
                response = self.preflight(path)
                self.assertEqual(response["Access-Control-Allow-Origin"], LABS)
                self.assertEqual(response["Access-Control-Allow-Credentials"], "true")
                allowed = response["Access-Control-Allow-Headers"].lower()
                self.assertIn("idempotency-key", allowed)
                self.assertIn("x-csrftoken", allowed)

    def test_preflight_is_refused_everywhere_else(self):
        for path in ("/api/courses/", "/api/auth/login/", "/api/auth/profile/", "/api/payment/create-order/"):
            with self.subTest(path=path):
                self.assertNotIn("Access-Control-Allow-Origin", self.preflight(path))

    def test_unknown_origin_gets_no_cors(self):
        self.assertNotIn("Access-Control-Allow-Origin", self.preflight("/api/ctf/exams/", origin=EVIL))
        self.assertNotIn(
            "Access-Control-Allow-Origin", self.preflight("/api/ctf/exams/", origin="https://labs.alsyedinitiative.com.evil.example")
        )

    def test_labs_origin_cannot_write_outside_the_exam_api(self):
        for path in ("/api/auth/login/", "/api/auth/profile/", "/api/payment/create-order/", "/api/auth/logout/"):
            with self.subTest(path=path):
                response = self.client.post(path, {}, format="json", HTTP_ORIGIN=LABS)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["errors"]["code"], "labs_origin_forbidden")
        # The same request from the main site is not affected by this guard.
        response = self.client.post("/api/auth/login/", {}, format="json", HTTP_ORIGIN="https://alsyedinitiative.com")
        self.assertNotEqual(response.status_code, 403)

    def test_reads_from_labs_on_exam_api_carry_cors_headers(self):
        student = f.make_user()
        self.client.force_authenticate(student)
        response = self.client.get("/api/ctf/exams/", HTTP_ORIGIN=LABS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Access-Control-Allow-Origin"], LABS)
        response = self.client.get("/api/courses/", HTTP_ORIGIN=LABS)
        self.assertNotIn("Access-Control-Allow-Origin", response)


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class LabsCsrfTests(APITestCase):
    """Real cookie authentication (no force_authenticate), CSRF enforced."""

    def setUp(self):
        cache.clear()
        course = f.make_course()
        self.user = f.make_user(email="labs-csrf@test.com", password="StrongPass@123456")
        self.user.terms_accepted_version = TERMS_VERSION
        self.user.save(update_fields=["terms_accepted_version"])
        f.make_enrollment(user=self.user, course=course)
        self.exam = f.make_ctf_exam(eligible_courses=[course], slug="csrf-exam")
        f.make_ctf_question(exam=self.exam, answers=["right"])
        login = APIClient()
        response = login.post(
            reverse("auth-login"), {"email": self.user.email, "password": "StrongPass@123456"}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.browser = APIClient(enforce_csrf_checks=True)
        self.browser.cookies = login.cookies
        self.start_url = reverse("ctf-exam-start", args=[self.exam.slug])

    def csrf_token(self):
        response = self.browser.get(reverse("auth-csrf"), HTTP_ORIGIN=LABS)
        self.assertEqual(response.status_code, 200)
        return response.json()["csrf_token"]

    def test_post_without_csrf_token_is_refused(self):
        response = self.browser.post(self.start_url, {}, format="json", HTTP_ORIGIN=LABS, secure=True)
        self.assertEqual(response.status_code, 403)
        self.assertIn("CSRF", response.content.decode())
        self.assertFalse(CtfParticipation.objects.exists())

    def test_post_with_token_from_labs_origin_is_accepted(self):
        token = self.csrf_token()
        response = self.browser.post(
            self.start_url, {}, format="json", HTTP_ORIGIN=LABS, HTTP_X_CSRFTOKEN=token, secure=True
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response["Access-Control-Allow-Origin"], LABS)
        self.assertTrue(CtfParticipation.objects.filter(user=self.user).exists())

    def test_untrusted_origin_is_refused_even_with_a_token(self):
        token = self.csrf_token()
        response = self.browser.post(
            self.start_url, {}, format="json", HTTP_ORIGIN=EVIL, HTTP_X_CSRFTOKEN=token, secure=True
        )
        self.assertEqual(response.status_code, 403)
        self.assertFalse(CtfParticipation.objects.exists())
