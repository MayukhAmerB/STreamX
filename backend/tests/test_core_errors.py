"""The API error contract: every raised error leaves as the envelope."""

import logging

from apps.core import errors as core_errors
from django.core.cache import cache
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from django.test import override_settings
from django.urls import path
from rest_framework import exceptions as drf_exceptions
from rest_framework import serializers
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.test import APITestCase
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView


class _OncePerMinute(SimpleRateThrottle):
    rate = "1/minute"

    def get_cache_key(self, request, view):
        return "test-core-errors-throttle"


class _FieldSerializer(serializers.Serializer):
    email = serializers.EmailField()
    age = serializers.IntegerField(min_value=1)


class _CodeFieldSerializer(serializers.Serializer):
    code = serializers.CharField(min_length=6)


class _Base(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []


class ProtectedView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"ok": True})


class NotFoundView(_Base):
    def get(self, request):
        raise Http404("No such thing")


class GetOnlyView(_Base):
    def get(self, request):
        return Response({"ok": True})


class JsonOnlyView(_Base):
    parser_classes = [JSONParser]

    def post(self, request):
        return Response({"echo": request.data})


class ThrottledView(_Base):
    throttle_classes = [_OncePerMinute]

    def get(self, request):
        return Response({"ok": True})


class ThrottledNoWaitView(_Base):
    def get(self, request):
        raise drf_exceptions.Throttled()


class ValidateView(_Base):
    def post(self, request):
        _FieldSerializer(data=request.data).is_valid(raise_exception=True)
        return Response({"ok": True})


class CodeFieldView(_Base):
    def post(self, request):
        _CodeFieldSerializer(data=request.data).is_valid(raise_exception=True)
        return Response({"ok": True})


class ListValidationView(_Base):
    def post(self, request):
        raise drf_exceptions.ValidationError("Seats are sold out.")


class BoomView(_Base):
    def get(self, request):
        raise RuntimeError("SELECT secret_column FROM payments_payment WHERE 1=1")


class DomainConflictView(_Base):
    def post(self, request):
        raise core_errors.Conflict("Order already captured.", code="order_already_captured", details={"order_id": 5})


class DomainRateLimitedView(_Base):
    def post(self, request):
        raise core_errors.RateLimited(retry_after=12)


class DomainUpstreamView(_Base):
    def get(self, request):
        raise core_errors.UpstreamUnavailable(upstream="owncast", retry_after=3)


class DomainValidationView(_Base):
    def post(self, request):
        raise core_errors.ValidationFailed(details={"title": ["Too long."]})


class TermsView(_Base):
    def get(self, request):
        raise drf_exceptions.PermissionDenied(
            {"detail": "You must accept the current Terms.", "code": "terms_acceptance_required", "terms_version": "v7"}
        )


class CsrfView(_Base):
    def post(self, request):
        raise drf_exceptions.PermissionDenied("CSRF Failed: CSRF token missing.")


class DjangoValidationView(_Base):
    def post(self, request):
        raise DjangoValidationError({"title": ["Script tags are not allowed."]})


urlpatterns = [
    path("protected", ProtectedView.as_view()),
    path("missing", NotFoundView.as_view()),
    path("get-only", GetOnlyView.as_view()),
    path("json-only", JsonOnlyView.as_view()),
    path("throttled", ThrottledView.as_view()),
    path("throttled-no-wait", ThrottledNoWaitView.as_view()),
    path("validate", ValidateView.as_view()),
    path("code-field", CodeFieldView.as_view()),
    path("list-validation", ListValidationView.as_view()),
    path("boom", BoomView.as_view()),
    path("conflict", DomainConflictView.as_view()),
    path("rate-limited", DomainRateLimitedView.as_view()),
    path("upstream", DomainUpstreamView.as_view()),
    path("domain-validation", DomainValidationView.as_view()),
    path("terms", TermsView.as_view()),
    path("csrf", CsrfView.as_view()),
    path("django-validation", DjangoValidationView.as_view()),
]


@override_settings(ROOT_URLCONF="tests.test_core_errors")
class ErrorEnvelopeTests(APITestCase):
    def setUp(self):
        cache.clear()

    def assertEnvelope(self, response, *, status_code, code):
        self.assertEqual(response.status_code, status_code, response.content)
        body = response.json()
        self.assertIs(body["success"], False)
        self.assertIsNone(body["data"])
        self.assertTrue(body["message"])
        self.assertEqual(body["code"], code)
        self.assertIsInstance(body["errors"], dict)
        if not isinstance(body["errors"].get("code"), list):
            self.assertEqual(body["errors"]["code"], code)
            # apiMessage() shows the first errors value; code must never be first.
            self.assertNotEqual(next(iter(body["errors"])), "code")
        self.assertIn("detail", body)
        return body

    def test_401_not_authenticated(self):
        body = self.assertEnvelope(self.client.get("/protected"), status_code=401, code="not_authenticated")
        self.assertEqual(body["errors"]["detail"], "Authentication credentials were not provided.")
        self.assertEqual(body["detail"], body["message"])

    def test_404(self):
        body = self.assertEnvelope(self.client.get("/missing"), status_code=404, code="not_found")
        self.assertEqual(list(body["errors"].keys()), ["detail", "code"])

    def test_405_keeps_allow_header(self):
        response = self.client.post("/get-only", {})
        self.assertEnvelope(response, status_code=405, code="method_not_allowed")
        self.assertIn("GET", response["Allow"])

    def test_415(self):
        response = self.client.post("/json-only", data="plain", content_type="text/plain")
        self.assertEnvelope(response, status_code=415, code="unsupported_media_type")

    def test_parse_error(self):
        response = self.client.post("/json-only", data="{not json", content_type="application/json")
        self.assertEnvelope(response, status_code=400, code="parse_error")

    def test_429_has_retry_after(self):
        self.assertEqual(self.client.get("/throttled").status_code, 200)
        response = self.client.get("/throttled")
        body = self.assertEnvelope(response, status_code=429, code="rate_limited")
        self.assertTrue(response.has_header("Retry-After"))
        self.assertGreater(int(response["Retry-After"]), 0)
        self.assertEqual(body["errors"]["retry_after"], int(response["Retry-After"]))

    def test_429_without_wait_still_has_retry_after(self):
        response = self.client.get("/throttled-no-wait")
        self.assertEnvelope(response, status_code=429, code="rate_limited")
        self.assertTrue(response.has_header("Retry-After"))

    def test_validation_error_field_shape_and_legacy_top_level_fields(self):
        response = self.client.post("/validate", {"email": "nope", "age": 0}, format="json")
        body = self.assertEnvelope(response, status_code=400, code="validation_failed")
        self.assertEqual(list(body["errors"].keys())[:2], ["email", "age"])
        self.assertTrue(body["message"].startswith("Email: "))
        # DRF's raw shape stays readable at the top level.
        self.assertEqual(body["email"], body["errors"]["email"])

    def test_field_named_code_wins_inside_errors(self):
        body = self.client.post("/code-field", {"code": "1"}, format="json").json()
        self.assertIsInstance(body["errors"]["code"], list)
        self.assertEqual(body["code"], "validation_failed")

    def test_list_validation_error(self):
        body = self.assertEnvelope(self.client.post("/list-validation", {}), status_code=400, code="validation_failed")
        self.assertEqual(body["message"], "Seats are sold out.")
        self.assertEqual(body["errors"]["non_field_errors"], ["Seats are sold out."])

    def test_unhandled_500_is_enveloped_without_leaking_and_logged_with_request_id(self):
        self.client.raise_request_exception = False
        with self.assertLogs("apps.core.errors", level=logging.ERROR) as logs:
            response = self.client.get("/boom", HTTP_X_REQUEST_ID="req-abcdef123456")
        body = self.assertEnvelope(response, status_code=500, code="internal_error")
        self.assertNotIn("SELECT", response.content.decode())
        self.assertNotIn("Traceback", response.content.decode())
        self.assertEqual(body["errors"]["request_id"], "req-abcdef123456")
        self.assertEqual(response["X-Request-ID"], "req-abcdef123456")
        self.assertIn("req-abcdef123456", logs.output[0])

    def test_unhandled_500_still_reaches_test_client_and_error_reporters(self):
        # got_request_exception is sent, so Sentry captures it and the test
        # client re-raises it like Django's own 500 handling does.
        with self.assertRaises(RuntimeError):
            self.client.get("/boom")

    def test_domain_conflict_details(self):
        body = self.assertEnvelope(self.client.post("/conflict"), status_code=409, code="order_already_captured")
        self.assertEqual(body["errors"]["order_id"], 5)
        self.assertEqual(body["message"], "Order already captured.")

    def test_domain_rate_limited_retry_after(self):
        response = self.client.post("/rate-limited")
        body = self.assertEnvelope(response, status_code=429, code="rate_limited")
        self.assertEqual(response["Retry-After"], "12")
        self.assertEqual(body["errors"]["retry_after"], 12)

    def test_domain_upstream_unavailable_is_logged_503(self):
        with self.assertLogs("apps.core.errors", level=logging.WARNING):
            response = self.client.get("/upstream")
        body = self.assertEnvelope(response, status_code=503, code="upstream_unavailable")
        self.assertEqual(body["errors"]["upstream"], "owncast")
        self.assertEqual(response["Retry-After"], "3")
        self.assertIn("request_id", body["errors"])

    def test_domain_validation_failed_puts_fields_first(self):
        body = self.assertEnvelope(self.client.post("/domain-validation"), status_code=400, code="validation_failed")
        self.assertEqual(next(iter(body["errors"])), "title")

    def test_dict_detail_keeps_custom_code_and_legacy_keys(self):
        body = self.assertEnvelope(self.client.get("/terms"), status_code=403, code="terms_acceptance_required")
        self.assertEqual(body["terms_version"], "v7")
        self.assertEqual(body["errors"]["terms_version"], "v7")
        self.assertEqual(body["detail"], "You must accept the current Terms.")

    def test_csrf_failure_code_and_detail_kept_for_client_retry(self):
        body = self.assertEnvelope(self.client.post("/csrf"), status_code=403, code="csrf_failed")
        self.assertIn("CSRF", body["detail"])
        self.assertIn("CSRF", body["errors"]["detail"])

    def test_django_validation_error_is_a_400_not_a_500(self):
        body = self.assertEnvelope(self.client.post("/django-validation"), status_code=400, code="validation_failed")
        self.assertEqual(body["errors"]["title"], ["Script tags are not allowed."])


class RealEndpointErrorEnvelopeTests(APITestCase):
    def test_unauthenticated_api_call_returns_envelope(self):
        response = self.client.get("/api/notifications/")
        self.assertEqual(response.status_code, 401)
        body = response.json()
        self.assertIs(body["success"], False)
        self.assertEqual(body["code"], "not_authenticated")
        self.assertEqual(body["detail"], body["errors"]["detail"])
