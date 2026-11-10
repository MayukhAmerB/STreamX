import uuid
from datetime import timedelta
from unittest import mock

from apps.core import idempotency
from apps.core.models import IdempotencyKey
from django.test import override_settings
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.test import APITestCase
from rest_framework.views import APIView

from tests import factories

CALLS = {"count": 0}


class _OrderSerializer(serializers.Serializer):
    amount = serializers.IntegerField(min_value=1)


class CreateOrderView(idempotency.IdempotencyMixin, APIView):
    permission_classes = [AllowAny]
    idempotency_scope = "tests.create_order"

    def post(self, request):
        CALLS["count"] += 1
        _OrderSerializer(data=request.data).is_valid(raise_exception=True)
        if request.data.get("explode"):
            raise RuntimeError("provider crashed")
        return Response({"order": CALLS["count"], "amount": request.data["amount"]}, status=201)


class RequiredKeyView(idempotency.IdempotencyMixin, APIView):
    permission_classes = [AllowAny]
    idempotency_scope = "tests.required"
    idempotency_required = True

    def post(self, request):
        CALLS["count"] += 1
        return Response({"ok": True})


class DecoratedView(APIView):
    permission_classes = [AllowAny]

    @idempotency.idempotent(scope="tests.decorated")
    def post(self, request):
        CALLS["count"] += 1
        return Response({"n": CALLS["count"]}, status=201)


urlpatterns = [
    path("orders", CreateOrderView.as_view()),
    path("required", RequiredKeyView.as_view()),
    path("decorated", DecoratedView.as_view()),
]


@override_settings(ROOT_URLCONF="tests.test_core_idempotency")
class IdempotencyTests(APITestCase):
    def setUp(self):
        CALLS["count"] = 0
        self.user = factories.make_user()
        self.client.force_authenticate(self.user)
        self.client.raise_request_exception = False

    def post(self, url="/orders", body=None, key="key-00000001", **extra):
        headers = {"HTTP_IDEMPOTENCY_KEY": key} if key else {}
        return self.client.post(url, body if body is not None else {"amount": 10}, format="json", **headers, **extra)

    def test_without_key_requests_are_not_deduplicated(self):
        self.post(key=None)
        self.post(key=None)
        self.assertEqual(CALLS["count"], 2)
        self.assertFalse(IdempotencyKey.objects.exists())

    def test_replay_returns_stored_response_without_running_again(self):
        first = self.post()
        second = self.post()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(second["Idempotent-Replayed"], "true")
        self.assertEqual(CALLS["count"], 1)
        record = IdempotencyKey.objects.get()
        self.assertEqual(record.status, IdempotencyKey.STATUS_COMPLETED)
        self.assertNotIn("key-00000001", record.key_hash)  # only digests are stored

    def test_same_key_different_body_is_422(self):
        self.post(body={"amount": 10})
        response = self.post(body={"amount": 11})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["code"], "idempotency_key_reused")
        self.assertEqual(CALLS["count"], 1)

    def test_concurrent_duplicate_gets_409_in_progress(self):
        claim = self._claim_in_progress()
        response = self.post()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "idempotency_in_progress")
        self.assertTrue(response.has_header("Retry-After"))
        self.assertEqual(CALLS["count"], 0)
        self.assertIsNotNone(claim)

    def test_expired_lease_is_taken_over_and_fences_the_old_owner(self):
        old_claim = self._claim_in_progress()
        IdempotencyKey.objects.update(locked_until=timezone.now() - timedelta(seconds=1))
        response = self.post()
        self.assertEqual(response.status_code, 201)
        self.assertEqual(CALLS["count"], 1)
        # The crashed original finishing late cannot overwrite the result.
        self.assertFalse(idempotency.complete(old_claim, Response({"stale": True}, status=201)))
        self.assertEqual(self.post().json(), response.json())

    def test_server_error_releases_key_so_retry_runs_again(self):
        failed = self.post(body={"amount": 10, "explode": True})
        self.assertEqual(failed.status_code, 500)
        self.assertFalse(IdempotencyKey.objects.exists())
        self.post(body={"amount": 10, "explode": True})
        self.assertEqual(CALLS["count"], 2)

    def test_validation_error_is_stored_and_replayed(self):
        first = self.post(body={"amount": 0})
        second = self.post(body={"amount": 0})
        self.assertEqual(first.status_code, 400)
        self.assertEqual(second.status_code, 400)
        self.assertEqual(second["Idempotent-Replayed"], "true")
        self.assertEqual(CALLS["count"], 1)

    def test_keys_are_scoped_per_user(self):
        self.post()
        self.client.force_authenticate(factories.make_user())
        self.post()
        self.assertEqual(CALLS["count"], 2)

    def test_expired_key_starts_over(self):
        self.post()
        IdempotencyKey.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.post(body={"amount": 99})
        self.assertEqual(CALLS["count"], 2)

    def test_required_and_invalid_keys(self):
        missing = self.post("/required", key=None)
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(missing.json()["code"], "idempotency_key_required")
        invalid = self.post("/required", key="bad key!")
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["code"], "idempotency_key_invalid")
        self.assertEqual(CALLS["count"], 0)

    def test_decorator(self):
        first = self.post("/decorated")
        second = self.post("/decorated")
        self.assertEqual(first.json(), second.json())
        self.assertEqual(CALLS["count"], 1)

    def test_insert_race_resolves_to_the_winner(self):
        """Two requests miss the SELECT; the loser's INSERT hits the unique
        constraint inside a savepoint and falls back to the winner's row."""
        self.post()  # the "winner" completed
        real_select_for_update = IdempotencyKey.objects.select_for_update
        calls = {"n": 0}

        def racing_select_for_update(*args, **kwargs):
            calls["n"] += 1
            queryset = real_select_for_update(*args, **kwargs)
            if calls["n"] == 1:
                return queryset.none()  # first lookup "misses"
            return queryset

        with mock.patch.object(IdempotencyKey.objects, "select_for_update", side_effect=racing_select_for_update):
            replay = self.post()
        self.assertEqual(replay.status_code, 201)
        self.assertEqual(replay["Idempotent-Replayed"], "true")
        self.assertEqual(CALLS["count"], 1)
        self.assertEqual(IdempotencyKey.objects.count(), 1)

    def test_prune_expired(self):
        self.post()
        self.assertEqual(idempotency.prune_expired(), 0)
        IdempotencyKey.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(idempotency.prune_expired(), 1)

    def _claim_in_progress(self):
        now = timezone.now()
        record = IdempotencyKey.objects.create(
            scope="tests.create_order",
            owner_hash=idempotency._digest(f"user:{self.user.pk}"),
            key_hash=idempotency._digest("key-00000001"),
            request_fingerprint=self._fingerprint({"amount": 10}),
            lease_token=uuid.uuid4(),
            locked_until=now + timedelta(seconds=60),
            expires_at=now + timedelta(days=1),
        )
        return idempotency.Claim(record.pk, record.lease_token, record.scope)

    def _fingerprint(self, body):
        from rest_framework.parsers import JSONParser
        from rest_framework.request import Request
        from rest_framework.test import APIRequestFactory

        django_request = APIRequestFactory().post("/orders", body, format="json")
        return idempotency.request_fingerprint(Request(django_request, parsers=[JSONParser()]))
