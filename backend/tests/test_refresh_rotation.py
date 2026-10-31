from datetime import timedelta
from unittest.mock import patch

from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.users.models import User
from apps.users.refresh_rotation import _issue_refresh_token, successor_jti
from config.throttling import RefreshIpCeilingThrottle
from tests.test_api import mark_terms_accepted


def jti_of(raw_token):
    return RefreshToken(raw_token, verify=False)["jti"]


def age_past_grace(raw_token):
    # Tokens minted within the grace window are re-issued instead of rotated;
    # age them so a test exercises a real rotation.
    OutstandingToken.objects.filter(jti=jti_of(raw_token)).update(created_at=timezone.now() - timedelta(minutes=30))
    return raw_token


class RefreshRotationRaceTests(APITestCase):
    password = "StrongPass@123"

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            email="rotation@test.com",
            full_name="Rotation Student",
            password=self.password,
            role=User.ROLE_STUDENT,
        )
        mark_terms_accepted(self.user)

    def login(self, client=None):
        client = client or self.client
        response = client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": self.password},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        return age_past_grace(client.cookies["refresh_token"].value)

    def refresh_with(self, raw_token):
        client = self.client_class()
        client.cookies["refresh_token"] = raw_token
        return client, client.post(reverse("auth-refresh"), {}, format="json")

    def test_concurrent_refreshes_of_one_cookie_converge_on_one_successor(self):
        issued = self.login()

        winner_client, winner = self.refresh_with(issued)
        loser_client, loser = self.refresh_with(issued)

        self.assertEqual(winner.status_code, 200)
        self.assertEqual(loser.status_code, 200)
        winner_refresh = winner.cookies["refresh_token"].value
        loser_refresh = loser.cookies["refresh_token"].value
        self.assertEqual(jti_of(winner_refresh), jti_of(loser_refresh))
        self.assertEqual(jti_of(winner_refresh), successor_jti(jti_of(issued)))
        self.assertEqual(winner_client.get(reverse("auth-user")).status_code, 200)
        self.assertEqual(loser_client.get(reverse("auth-user")).status_code, 200)

    def test_successor_issuance_is_idempotent(self):
        jti = successor_jti("seed")
        first = _issue_refresh_token(self.user, jti)
        second = _issue_refresh_token(self.user, jti)

        self.assertEqual(first["jti"], second["jti"])
        self.assertEqual(OutstandingToken.objects.filter(jti=jti).count(), 1)

    def test_tabs_mixing_fresh_and_stale_cookies_converge_without_forking(self):
        issued = self.login()
        _, tab_a = self.refresh_with(issued)
        fresh = tab_a.cookies["refresh_token"].value

        _, tab_b = self.refresh_with(fresh)
        _, tab_c = self.refresh_with(issued)

        self.assertEqual([tab_b.status_code, tab_c.status_code], [200, 200])
        jtis = {jti_of(r.cookies["refresh_token"].value) for r in (tab_a, tab_b, tab_c)}
        self.assertEqual(jtis, {jti_of(fresh)})
        self.assertFalse(OutstandingToken.objects.filter(jti=successor_jti(jti_of(fresh))).exists())

    def test_logout_with_a_stale_cookie_revokes_the_live_successor(self):
        issued = self.login()
        _, rotated = self.refresh_with(issued)
        live = rotated.cookies["refresh_token"].value

        stale_client = self.client_class()
        stale_client.cookies["refresh_token"] = issued
        self.assertEqual(stale_client.post(reverse("auth-logout"), format="json").status_code, 200)
        _, after_logout = self.refresh_with(live)

        self.assertEqual(after_logout.status_code, 401)

    def test_mobile_logout_with_a_stale_token_revokes_the_live_successor(self):
        login = self.client.post(
            reverse("auth-mobile-login"),
            {"email": self.user.email, "password": self.password},
            format="json",
        )
        issued = age_past_grace(login.data["data"]["tokens"]["refresh"])
        rotated = self.client.post(reverse("auth-mobile-refresh"), {"refresh": issued}, format="json")
        live = rotated.data["data"]["tokens"]["refresh"]

        self.client.post(reverse("auth-mobile-logout"), {"refresh": issued}, format="json")
        after_logout = self.client.post(reverse("auth-mobile-refresh"), {"refresh": live}, format="json")

        self.assertEqual(after_logout.status_code, 401)

    def test_reused_token_is_rejected_after_logout_without_clearing_cookies(self):
        issued = self.login()
        rotated_client, rotated = self.refresh_with(issued)
        self.assertEqual(rotated.status_code, 200)
        self.assertEqual(rotated_client.post(reverse("auth-logout"), format="json").status_code, 200)

        _, replay = self.refresh_with(issued)

        self.assertEqual(replay.status_code, 401)
        self.assertEqual(replay.data["errors"]["code"], "refresh_token_revoked")
        self.assertNotIn("refresh_token", replay.cookies)

    def test_reused_token_is_rejected_after_the_grace_window(self):
        issued = self.login()
        _, rotated = self.refresh_with(issued)
        self.assertEqual(rotated.status_code, 200)
        OutstandingToken.objects.filter(jti=successor_jti(jti_of(issued))).update(
            created_at=timezone.now() - timedelta(minutes=5)
        )

        _, replay = self.refresh_with(issued)

        self.assertEqual(replay.status_code, 401)
        self.assertNotIn("refresh_token", replay.cookies)

    def test_refresh_within_the_grace_window_reissues_instead_of_rotating(self):
        client = self.client_class()
        client.post(reverse("auth-login"), {"email": self.user.email, "password": self.password}, format="json")
        fresh = client.cookies["refresh_token"].value

        _, response = self.refresh_with(fresh)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(jti_of(response.cookies["refresh_token"].value), jti_of(fresh))

    @override_settings(AUTH_REFRESH_REUSE_GRACE_SECONDS=0)
    def test_disabling_the_grace_window_restores_strict_single_use(self):
        issued = self.login()
        self.refresh_with(issued)

        _, replay = self.refresh_with(issued)

        self.assertEqual(replay.status_code, 401)

    def test_session_replaced_on_another_device_still_ends_the_session(self):
        first_refresh = self.login(self.client_class())
        self.login(self.client_class())

        _, stale = self.refresh_with(first_refresh)

        self.assertEqual(stale.status_code, 401)
        self.assertEqual(stale.data["errors"]["code"], "session_replaced")
        self.assertEqual(stale.cookies["refresh_token"]["max-age"], 0)

    def test_mobile_concurrent_refreshes_converge_on_one_successor(self):
        login = self.client.post(
            reverse("auth-mobile-login"),
            {"email": self.user.email, "password": self.password},
            format="json",
        )
        issued = age_past_grace(login.data["data"]["tokens"]["refresh"])

        responses = [
            self.client_class().post(reverse("auth-mobile-refresh"), {"refresh": issued}, format="json")
            for _ in range(3)
        ]

        self.assertEqual([response.status_code for response in responses], [200, 200, 200])
        self.assertEqual(len({jti_of(r.data["data"]["tokens"]["refresh"]) for r in responses}), 1)


class SharedAddressThrottleTests(APITestCase):
    password = "StrongPass@123"

    def setUp(self):
        cache.clear()

    def make_user(self, index):
        user = User.objects.create_user(
            email=f"classroom{index}@test.com",
            full_name="Classroom Student",
            password=self.password,
            role=User.ROLE_STUDENT,
        )
        mark_terms_accepted(user)
        return user

    def test_refresh_is_budgeted_per_token_not_per_shared_ip(self):
        codes = []
        for index in range(60):
            client = self.client_class()
            client.cookies["refresh_token"] = str(RefreshToken.for_user(self.make_user(index)))
            codes.append(client.post(reverse("auth-refresh"), {}, format="json", REMOTE_ADDR="10.1.1.1").status_code)

        self.assertEqual(set(codes), {200})

    def test_refresh_replays_of_one_token_are_still_throttled(self):
        raw = str(RefreshToken.for_user(self.make_user(0)))
        codes = []
        for _ in range(35):
            client = self.client_class()
            client.cookies["refresh_token"] = raw
            codes.append(client.post(reverse("auth-refresh"), {}, format="json").status_code)

        self.assertIn(429, codes)

    def test_anonymous_bootstrap_refreshes_are_not_throttled(self):
        codes = {
            self.client_class().post(reverse("auth-refresh"), {}, format="json", REMOTE_ADDR="10.3.3.3").status_code
            for _ in range(60)
        }

        self.assertEqual(codes, {401})

    def test_forged_tokens_hit_the_per_ip_ceiling(self):
        rates = {**RefreshIpCeilingThrottle.THROTTLE_RATES, "refresh_ip": "3/minute"}
        with patch.object(RefreshIpCeilingThrottle, "THROTTLE_RATES", rates):
            codes = []
            for index in range(5):
                client = self.client_class()
                client.cookies["refresh_token"] = f"forged-{index}"
                codes.append(client.post(reverse("auth-refresh"), {}, format="json", REMOTE_ADDR="10.4.4.4").status_code)

        self.assertEqual(codes, [401, 401, 401, 429, 429])

    def test_classroom_behind_one_ip_can_log_in_together(self):
        codes = []
        for index in range(15):
            user = self.make_user(index)
            codes.append(
                self.client_class()
                .post(
                    reverse("auth-login"),
                    {"email": user.email, "password": self.password},
                    format="json",
                    REMOTE_ADDR="10.2.2.2",
                )
                .status_code
            )

        self.assertEqual(set(codes), {200})
