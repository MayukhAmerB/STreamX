from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.urls import reverse
from rest_framework.test import APITestCase


User = get_user_model()


class MobileAuthTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.password = "StrongPass@123"
        self.user = User.objects.create_user(
            email="mobile-student@test.com",
            password=self.password,
            full_name="Mobile Student",
            role=User.ROLE_STUDENT,
        )

    def login(self):
        return self.client.post(
            reverse("auth-mobile-login"),
            {"email": self.user.email, "password": self.password},
            format="json",
        )

    def test_mobile_login_returns_bearer_tokens_without_auth_cookies(self):
        response = self.login()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["success"])
        self.assertEqual(response.data["data"]["user"]["email"], self.user.email)
        self.assertTrue(response.data["data"]["tokens"]["access"])
        self.assertTrue(response.data["data"]["tokens"]["refresh"])
        self.assertNotIn("access_token", response.cookies)
        self.assertNotIn("refresh_token", response.cookies)

    def test_mobile_access_token_authenticates_existing_current_user_endpoint(self):
        login_response = self.login()
        access = login_response.data["data"]["tokens"]["access"]

        response = self.client.get(
            reverse("auth-user"),
            HTTP_AUTHORIZATION=f"Bearer {access}",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["data"]["email"], self.user.email)

    def test_mobile_refresh_returns_a_complete_rotated_session(self):
        login_response = self.login()
        refresh = login_response.data["data"]["tokens"]["refresh"]

        response = self.client.post(
            reverse("auth-mobile-refresh"),
            {"refresh": refresh},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["data"]["user"]["id"], self.user.id)
        self.assertTrue(response.data["data"]["tokens"]["access"])
        self.assertTrue(response.data["data"]["tokens"]["refresh"])

    def test_mobile_logout_blacklists_refresh_token(self):
        login_response = self.login()
        refresh = login_response.data["data"]["tokens"]["refresh"]

        logout_response = self.client.post(
            reverse("auth-mobile-logout"),
            {"refresh": refresh},
            format="json",
        )
        refresh_response = self.client.post(
            reverse("auth-mobile-refresh"),
            {"refresh": refresh},
            format="json",
        )

        self.assertEqual(logout_response.status_code, 200)
        self.assertEqual(refresh_response.status_code, 401)

    def test_mobile_login_rejects_credentials_in_query_string(self):
        response = self.client.post(
            f'{reverse("auth-mobile-login")}?email={self.user.email}',
            {"password": self.password},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("must not be sent", response.data["errors"]["detail"])
