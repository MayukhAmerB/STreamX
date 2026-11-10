from datetime import timedelta

from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework.test import APITestCase
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.users.models import SessionSlot, User
from apps.users.session_policy import (
    SESSION_SLOT_CLAIM,
    SESSION_VERSION_CLAIM,
    legacy_session_slot,
    max_concurrent_sessions,
)
from tests.test_api import mark_terms_accepted


PASSWORD = "StrongPass@123"


def claims_of(raw_token):
    return RefreshToken(raw_token, verify=False).payload


def age_past_grace(raw_token):
    OutstandingToken.objects.filter(jti=claims_of(raw_token)["jti"]).update(
        created_at=timezone.now() - timedelta(minutes=30)
    )
    return raw_token


@override_settings(MAX_CONCURRENT_SESSIONS_PER_STUDENT=2)
class StudentSessionCapTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = self.make_user("cap-student@test.com")

    def make_user(self, email, **extra):
        extra.setdefault("role", User.ROLE_STUDENT)
        user = User.objects.create_user(email=email, full_name="Session Cap", password=PASSWORD, **extra)
        mark_terms_accepted(user)
        return user

    def sign_in(self, user=None):
        client = self.client_class()
        response = client.post(
            reverse("auth-login"),
            {"email": (user or self.user).email, "password": PASSWORD},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        return client

    def slot_of(self, client):
        return claims_of(client.cookies["refresh_token"].value)[SESSION_SLOT_CLAIM]

    def is_signed_in(self, client):
        return client.get(reverse("auth-user")).status_code == 200

    def refresh(self, client):
        age_past_grace(client.cookies["refresh_token"].value)
        return client.post(reverse("auth-refresh"), {}, format="json")

    def make_least_recently_used(self, client):
        SessionSlot.objects.filter(slot_id=self.slot_of(client)).update(
            last_seen_at=timezone.now() - timedelta(hours=1)
        )

    def test_two_student_devices_stay_signed_in_together(self):
        phone = self.sign_in()
        laptop = self.sign_in()

        self.assertTrue(self.is_signed_in(phone))
        self.assertTrue(self.is_signed_in(laptop))
        self.assertEqual(self.refresh(phone).status_code, 200)
        self.assertEqual(self.refresh(laptop).status_code, 200)
        self.assertTrue(self.is_signed_in(phone))
        self.assertTrue(self.is_signed_in(laptop))
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 2)

    def test_third_sign_in_evicts_only_the_least_recently_used_device(self):
        phone = self.sign_in()
        laptop = self.sign_in()
        evicted_refresh = laptop.cookies["refresh_token"].value
        self.make_least_recently_used(laptop)

        tablet = self.sign_in()

        self.assertFalse(self.is_signed_in(laptop))
        laptop.cookies["refresh_token"] = evicted_refresh
        rejected = laptop.post(reverse("auth-refresh"), {}, format="json")
        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(rejected.data["errors"]["code"], "session_replaced")
        self.assertEqual(rejected.data["message"], "Session expired.")
        self.assertEqual(rejected.cookies["refresh_token"]["max-age"], 0)

        for client in (phone, tablet):
            self.assertTrue(self.is_signed_in(client))
            self.assertEqual(self.refresh(client).status_code, 200)
            self.assertTrue(self.is_signed_in(client))
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 2)

    def test_refresh_keeps_the_device_slot_and_marks_it_recently_used(self):
        phone = self.sign_in()
        slot_id = self.slot_of(phone)
        self.make_least_recently_used(phone)
        laptop = self.sign_in()

        self.assertEqual(self.refresh(phone).status_code, 200)
        self.assertEqual(self.slot_of(phone), slot_id)
        self.sign_in()

        self.assertTrue(self.is_signed_in(phone))
        self.assertFalse(self.is_signed_in(laptop))

    def test_requests_mark_the_device_used_at_most_once_per_interval(self):
        phone = self.sign_in()
        slot = SessionSlot.objects.get(slot_id=self.slot_of(phone))
        stale = timezone.now() - timedelta(minutes=5)
        SessionSlot.objects.filter(pk=slot.pk).update(last_seen_at=stale)

        with self.captureOnCommitCallbacks(execute=True):
            self.assertTrue(self.is_signed_in(phone))
        slot.refresh_from_db()
        self.assertGreater(slot.last_seen_at, stale)

        recent = timezone.now() - timedelta(seconds=10)
        SessionSlot.objects.filter(pk=slot.pk).update(last_seen_at=recent)
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            self.assertTrue(self.is_signed_in(phone))
        self.assertEqual(callbacks, [])
        slot.refresh_from_db()
        self.assertEqual(slot.last_seen_at, recent)

    def test_logout_frees_the_device_slot(self):
        phone = self.sign_in()
        laptop = self.sign_in()

        self.assertEqual(phone.post(reverse("auth-logout"), format="json").status_code, 200)
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 1)
        tablet = self.sign_in()

        self.assertTrue(self.is_signed_in(laptop))
        self.assertTrue(self.is_signed_in(tablet))

    def test_logout_with_a_rotated_cookie_frees_the_live_slot(self):
        phone = self.sign_in()
        stale_refresh = age_past_grace(phone.cookies["refresh_token"].value)
        self.assertEqual(phone.post(reverse("auth-refresh"), {}, format="json").status_code, 200)

        stale_client = self.client_class()
        stale_client.cookies["refresh_token"] = stale_refresh
        stale_client.post(reverse("auth-logout"), format="json")

        self.assertFalse(SessionSlot.objects.filter(user=self.user).exists())
        self.assertFalse(self.is_signed_in(phone))

    def test_mobile_sign_ins_share_the_cap_and_mobile_logout_frees_a_slot(self):
        web = self.sign_in()
        login = self.client.post(
            reverse("auth-mobile-login"),
            {"email": self.user.email, "password": PASSWORD},
            format="json",
        )
        mobile_tokens = login.data["data"]["tokens"]
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 2)

        self.client.post(reverse("auth-mobile-logout"), {"refresh": mobile_tokens["refresh"]}, format="json")

        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 1)
        self.assertTrue(self.is_signed_in(web))
        mobile_user = self.client_class()
        mobile_user.credentials(HTTP_AUTHORIZATION=f"Bearer {mobile_tokens['access']}")
        self.assertEqual(mobile_user.get(reverse("auth-user")).status_code, 401)

    def test_a_burst_of_sign_ins_never_exceeds_the_cap(self):
        clients = [self.sign_in() for _ in range(6)]

        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 2)
        self.assertEqual([self.is_signed_in(client) for client in clients], [False] * 4 + [True] * 2)

    @override_settings(MAX_CONCURRENT_SESSIONS_PER_STUDENT=1)
    def test_a_cap_of_one_restores_single_device_sign_in(self):
        phone = self.sign_in()
        laptop = self.sign_in()

        self.assertFalse(self.is_signed_in(phone))
        self.assertTrue(self.is_signed_in(laptop))

    @override_settings(MAX_CONCURRENT_SESSIONS_PER_STUDENT=0)
    def test_the_cap_is_clamped_to_at_least_one(self):
        self.assertEqual(max_concurrent_sessions(), 1)
        self.assertTrue(self.is_signed_in(self.sign_in()))

    @override_settings(ACCOUNT_SELF_SERVICE_CREDENTIALS_ENABLED=True)
    def test_password_change_signs_other_devices_out(self):
        phone = self.sign_in()
        laptop = self.sign_in()

        response = laptop.post(
            reverse("auth-change-password"),
            {"current_password": PASSWORD, "new_password": "NewStrongPass@123"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.is_signed_in(phone))
        self.assertTrue(self.is_signed_in(laptop))
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 1)

    @override_settings(ACCOUNT_SELF_SERVICE_CREDENTIALS_ENABLED=True)
    def test_password_reset_signs_every_device_out_and_frees_the_slots(self):
        phone = self.sign_in()
        laptop = self.sign_in()
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 2)

        response = self.client_class().post(
            reverse("auth-password-reset-confirm"),
            {
                "uid": urlsafe_base64_encode(force_bytes(self.user.pk)),
                "token": default_token_generator.make_token(self.user),
                "new_password": "ResetStrongPass@123",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 0)
        self.assertFalse(self.is_signed_in(phone))
        self.assertFalse(self.is_signed_in(laptop))
        self.user.refresh_from_db()
        self.assertEqual(self.user.active_session_version, 1)
        # The freed slots let the owner sign in on two devices again right away.
        new_client = self.client_class()
        for _ in range(2):
            signed_in = new_client.post(
                reverse("auth-login"), {"email": self.user.email, "password": "ResetStrongPass@123"}, format="json"
            )
            self.assertEqual(signed_in.status_code, 200)
            self.assertEqual(new_client.get(reverse("auth-user")).status_code, 200)
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 2)

    def test_instructors_staff_and_allow_listed_accounts_are_never_evicted(self):
        instructor = self.make_user("instructor-multi@test.com", role=User.ROLE_INSTRUCTOR)
        staff_student = self.make_user("staff-multi@test.com", is_staff=True)
        superuser = self.make_user("super-multi@test.com", is_superuser=True)
        listed = self.make_user("listed-multi@test.com")

        with override_settings(AUTH_CONCURRENT_SESSION_EMAILS=["Listed-Multi@test.com"]):
            for account in (instructor, staff_student, superuser, listed):
                clients = [self.sign_in(account) for _ in range(6)]
                for client in clients:
                    self.assertTrue(self.is_signed_in(client), account.email)
                    self.assertEqual(self.refresh(client).status_code, 200, account.email)
                    self.assertTrue(self.is_signed_in(client), account.email)
                self.assertFalse(SessionSlot.objects.filter(user=account).exists())
                self.assertNotIn(SESSION_SLOT_CLAIM, claims_of(clients[0].cookies["refresh_token"].value))


@override_settings(MAX_CONCURRENT_SESSIONS_PER_STUDENT=2)
class LegacySessionTokenTests(APITestCase):
    """Tokens minted before session slots existed (session_version only)."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            email="legacy-student@test.com",
            full_name="Legacy Student",
            password=PASSWORD,
            role=User.ROLE_STUDENT,
            active_session_version=4,
        )
        mark_terms_accepted(self.user)

    def legacy_refresh(self, version=4):
        token = RefreshToken.for_user(self.user)
        token[SESSION_VERSION_CLAIM] = version
        return token

    def client_with(self, refresh):
        client = self.client_class()
        client.cookies["refresh_token"] = str(refresh)
        client.cookies["access_token"] = str(refresh.access_token)
        return client

    def sign_in(self):
        client = self.client_class()
        response = client.post(
            reverse("auth-login"),
            {"email": self.user.email, "password": PASSWORD},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        return client

    def test_deploy_does_not_sign_out_the_current_legacy_device(self):
        legacy = self.client_with(self.legacy_refresh())
        laptop = self.sign_in()

        self.assertEqual(legacy.get(reverse("auth-user")).status_code, 200)
        self.assertEqual(laptop.get(reverse("auth-user")).status_code, 200)

    def test_refresh_moves_a_legacy_session_into_a_slot(self):
        refresh = self.legacy_refresh()
        legacy = self.client_with(refresh)

        response = legacy.post(reverse("auth-refresh"), {}, format="json")

        self.assertEqual(response.status_code, 200)
        claims = claims_of(response.cookies["refresh_token"].value)
        self.assertEqual(claims[SESSION_SLOT_CLAIM], legacy_session_slot(refresh["jti"]))
        self.assertEqual(claims[SESSION_VERSION_CLAIM], 4)
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 1)
        self.assertEqual(legacy.get(reverse("auth-user")).status_code, 200)

    def test_concurrent_refreshes_of_a_legacy_token_claim_one_slot(self):
        raw = str(self.legacy_refresh())

        responses = []
        for _ in range(3):
            client = self.client_class()
            client.cookies["refresh_token"] = raw
            responses.append(client.post(reverse("auth-refresh"), {}, format="json"))

        self.assertEqual([response.status_code for response in responses], [200, 200, 200])
        self.assertEqual(len({claims_of(r.cookies["refresh_token"].value)["jti"] for r in responses}), 1)
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 1)

    def test_migrated_legacy_session_counts_toward_the_cap(self):
        legacy = self.client_with(self.legacy_refresh())
        self.assertEqual(legacy.post(reverse("auth-refresh"), {}, format="json").status_code, 200)
        SessionSlot.objects.filter(user=self.user).update(last_seen_at=timezone.now() - timedelta(hours=1))

        self.sign_in()
        self.sign_in()

        self.assertEqual(legacy.get(reverse("auth-user")).status_code, 401)
        self.assertEqual(SessionSlot.objects.filter(user=self.user).count(), 2)

    def test_an_evicted_legacy_token_cannot_reclaim_its_slot(self):
        raw = str(self.legacy_refresh())
        first = self.client_class()
        first.cookies["refresh_token"] = raw
        self.assertEqual(first.post(reverse("auth-refresh"), {}, format="json").status_code, 200)
        SessionSlot.objects.filter(user=self.user).update(last_seen_at=timezone.now() - timedelta(hours=1))
        self.sign_in()
        self.sign_in()

        replay = self.client_class()
        replay.cookies["refresh_token"] = raw
        response = replay.post(reverse("auth-refresh"), {}, format="json")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.data["errors"]["code"], "session_replaced")
        self.assertFalse(SessionSlot.objects.filter(slot_id=legacy_session_slot(claims_of(raw)["jti"])).exists())

    def test_superseded_legacy_tokens_stay_rejected(self):
        stale = self.client_with(self.legacy_refresh(version=3))

        self.assertEqual(stale.get(reverse("auth-user")).status_code, 401)
        response = stale.post(reverse("auth-refresh"), {}, format="json")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.data["errors"]["code"], "session_replaced")
        self.assertFalse(SessionSlot.objects.filter(user=self.user).exists())
