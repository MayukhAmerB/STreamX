import io
import json
from datetime import timedelta
from decimal import Decimal
from unittest import mock
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.courses.models import Course, Enrollment
from apps.insights import metrics
from apps.insights.infrastructure import build_hourly_window, container_label
from apps.insights.prometheus import (
    REASON_BAD_RESPONSE,
    REASON_HTTP_ERROR,
    REASON_NOT_CONFIGURED,
    REASON_TIMEOUT,
    REASON_UNREACHABLE,
    PrometheusClient,
    PrometheusError,
)
from apps.payments.models import Payment


User = get_user_model()

PROMETHEUS_TEST_URL = "http://prometheus-test.invalid:9090"
SECTION_ORDER = ["business", "learning", "outreach", "infrastructure", "streaming"]
SECTION_KEYS = {"id", "title", "description", "available", "unavailable_reason", "note", "kpis", "charts"}
KPI_KEYS = {
    "id", "label", "value", "unit", "delta_pct", "delta_good_direction", "period_label",
    "trend", "status", "status_label", "hint",
}
KPI_UNITS = {"count", "inr", "percent", "ms", "per_second", "cores"}
STATUSES = {"good", "warning", "critical", None}
TIMESERIES_KEYS = {"id", "title", "subtitle", "type", "mark", "unit", "bucket", "buckets", "series", "empty_message"}
LIST_CHART_KEYS = {"id", "title", "subtitle", "type", "unit", "items", "empty_message"}


def _json_response(payload):
    return io.BytesIO(json.dumps(payload).encode())


def _vector(*samples):
    return {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [{"metric": labels, "value": [1700000000.0, str(value)]} for labels, value in samples],
        },
    }


class FakePrometheus:
    """Routes urlopen calls to canned answers keyed by a substring of the query."""

    def __init__(self, instant, ranged):
        self.instant = instant
        self.ranged = ranged
        self.urls = []

    def _match(self, table, expr):
        for needle, answer in table:
            if needle in expr:
                return answer
        return []

    def __call__(self, request, timeout=None):
        url = request.full_url
        self.urls.append(url)
        parts = urlsplit(url)
        params = {key: values[0] for key, values in parse_qs(parts.query).items()}
        expr = params["query"]
        if parts.path.endswith("/query_range"):
            start, end, step = float(params["start"]), float(params["end"]), int(params["step"])
            stamps = list(range(int(start), int(end) + 1, step))
            result = [
                {"metric": labels, "values": [[stamp, str(value)] for stamp in stamps]}
                for labels, value in self._match(self.ranged, expr)
            ]
            return _json_response({"status": "success", "data": {"resultType": "matrix", "result": result}})
        return _json_response(_vector(*self._match(self.instant, expr)))


class DashboardTestMixin:
    def setUp(self):
        cache.clear()
        self.superuser = User.objects.create_superuser(
            email="insights-admin@example.com",
            password="StrongAdmin@123",
            full_name="Insights Admin",
        )
        self.staff = User.objects.create_user(
            email="insights-staff@example.com",
            password="StrongStaff@123",
            full_name="Insights Staff",
            is_staff=True,
        )

    def tearDown(self):
        cache.clear()

    def get_data(self, range_key=None):
        params = {"range": range_key} if range_key is not None else {}
        return self.client.get(reverse("insights-dashboard-data"), params)


@override_settings(PROMETHEUS_URL="")
class DashboardAccessTests(DashboardTestMixin, TestCase):
    def test_anonymous_is_redirected_to_admin_login(self):
        for name in ("insights-dashboard", "insights-dashboard-data"):
            response = self.client.get(reverse(name))
            self.assertEqual(response.status_code, 302)
            self.assertIn(reverse("admin:login"), response["Location"])

    def test_staff_without_superuser_is_forbidden(self):
        self.client.force_login(self.staff)
        self.assertEqual(self.client.get(reverse("insights-dashboard")).status_code, 403)
        self.assertEqual(self.get_data().status_code, 403)

    def test_superuser_can_open_page_and_data(self):
        self.client.force_login(self.superuser)
        page = self.client.get(reverse("insights-dashboard"))
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.context["title"], "Dashboard")
        self.assertEqual(page.context["data_url"], reverse("insights-dashboard-data"))
        self.assertEqual(page.context["default_range"], "7d")
        self.assertEqual(
            page.context["ranges"],
            [("24h", "Last 24 hours"), ("7d", "Last 7 days"), ("30d", "Last 30 days")],
        )
        self.assertContains(page, reverse("insights-dashboard-data"))

        data = self.get_data()
        self.assertEqual(data.status_code, 200)
        self.assertEqual(data["Content-Type"], "application/json")
        self.assertEqual(data["Cache-Control"], "no-store, private")

    def test_urls_live_under_admin(self):
        self.assertEqual(reverse("insights-dashboard"), "/admin/dashboard/")
        self.assertEqual(reverse("insights-dashboard-data"), "/admin/dashboard/data/")

    def test_data_rejects_unsafe_methods(self):
        self.client.force_login(self.superuser)
        response = self.client.post(reverse("insights-dashboard-data"))
        self.assertIn(response.status_code, {403, 405})


@override_settings(PROMETHEUS_URL="")
class DashboardRangeAndShapeTests(DashboardTestMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.superuser)

    def test_default_range_is_seven_days(self):
        payload = self.get_data().json()
        self.assertEqual(payload["range"], "7d")
        self.assertEqual(payload["range_label"], "Last 7 days")

    def test_invalid_ranges_are_rejected(self):
        for value in ("1y", "", "7D", "24h;drop"):
            response = self.get_data(value)
            self.assertEqual(response.status_code, 400, value)
            self.assertIn("error", response.json())
            self.assertEqual(response["Cache-Control"], "no-store, private")

    def test_bucket_counts_per_range(self):
        expected = {"24h": ("hour", 24), "7d": ("day", 7), "30d": ("day", 30)}
        for range_key, (bucket, count) in expected.items():
            payload = self.get_data(range_key).json()
            self.assertEqual(payload["range"], range_key)
            business = payload["sections"][0]
            revenue_chart = next(chart for chart in business["charts"] if chart["id"] == "revenue")
            self.assertEqual(revenue_chart["bucket"], bucket)
            self.assertEqual(len(revenue_chart["buckets"]), count)
            self.assertEqual(len(business["kpis"][0]["trend"]), count)

    def test_payload_matches_contract(self):
        payload = self.get_data("24h").json()
        self.assertEqual(set(payload), {"range", "range_label", "generated_at", "sections"})
        self.assertIsNotNone(timezone.datetime.fromisoformat(payload["generated_at"]))
        self.assertEqual([section["id"] for section in payload["sections"]], SECTION_ORDER)

        for section in payload["sections"]:
            self.assertEqual(set(section), SECTION_KEYS)
            if section["id"] in {"infrastructure", "streaming"}:
                self.assertFalse(section["available"])
                self.assertEqual(section["unavailable_reason"], REASON_NOT_CONFIGURED)
                continue
            self.assertTrue(section["available"])
            self.assertEqual(section["unavailable_reason"], "")
            self.assertTrue(section["kpis"])
            for kpi in section["kpis"]:
                self.assert_kpi_shape(kpi)
            for chart in section["charts"]:
                self.assert_chart_shape(chart)

    def assert_kpi_shape(self, kpi):
        self.assertEqual(set(kpi), KPI_KEYS)
        self.assertIn(kpi["unit"], KPI_UNITS)
        self.assertNotIn(":", kpi["label"])
        self.assertEqual(kpi["label"][0], kpi["label"][0].upper())
        self.assertIn(kpi["delta_good_direction"], {"up", "down", None})
        self.assertIn(kpi["status"], STATUSES)
        self.assertTrue(kpi["value"] is None or isinstance(kpi["value"], (int, float)))

    def assert_chart_shape(self, chart):
        if chart["type"] == "timeseries":
            self.assertEqual(set(chart), TIMESERIES_KEYS)
            self.assertIn(chart["mark"], {"line", "area", "column"})
            self.assertIn(chart["bucket"], {"hour", "day"})
            self.assertTrue(1 <= len(chart["series"]) <= 3)
            for series in chart["series"]:
                self.assertEqual(set(series), {"key", "label", "values"})
                self.assertEqual(len(series["values"]), len(chart["buckets"]))
        else:
            self.assertIn(chart["type"], {"ranked", "segmented"})
            self.assertEqual(set(chart), LIST_CHART_KEYS)
            self.assertLessEqual(len(chart["items"]), 8)
            for item in chart["items"]:
                self.assertIn("label", item)
                self.assertIn("value", item)
                if chart["type"] == "segmented":
                    self.assertEqual(chart["unit"], "count")
                    self.assertIn(item["status"], {"good", "warning", "critical", "neutral", None})

    def test_response_is_cached_per_range(self):
        first = self.get_data("7d").json()
        with mock.patch("apps.insights.dashboard.build_dashboard") as build:
            second = self.get_data("7d").json()
        build.assert_not_called()
        self.assertEqual(first["generated_at"], second["generated_at"])
        self.assertNotEqual(self.get_data("24h").json()["range"], first["range"])


@override_settings(PROMETHEUS_URL="")
class DashboardAggregationTests(DashboardTestMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.superuser)
        self.now = timezone.now()
        self.window = metrics.build_window("7d", self.now)
        self.previous_moment = self.window.start - timedelta(days=2)
        self.recent = self.now - timedelta(minutes=30)

        self.instructor = User.objects.create_user(
            email="insights-instructor@example.com",
            password="StrongInstructor@123",
            full_name="Insights Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        self.course = Course.objects.create(
            title="Insights OSINT",
            description="Dashboard aggregation course.",
            price=Decimal("1000.00"),
            instructor=self.instructor,
            is_published=True,
        )
        self.student_a = self._student("a@example.com")
        self.student_b = self._student("b@example.com")
        old_student = self._student("old@example.com")
        User.objects.filter(pk=old_student.pk).update(created_at=self.previous_moment)

        self._payment(Decimal("1000.00"), Payment.STATUS_PAID, Payment.PLAN_FULL, paid_at=self.recent)
        self._payment(Decimal("500.00"), Payment.STATUS_PAID, Payment.PLAN_MONTHLY, paid_at=self.recent)
        self._payment(Decimal("300.00"), Payment.STATUS_FAILED, Payment.PLAN_FULL)
        self._payment(Decimal("200.00"), Payment.STATUS_CREATED, Payment.PLAN_FULL)
        self._payment(
            Decimal("750.00"), Payment.STATUS_PAID, Payment.PLAN_FULL,
            paid_at=self.previous_moment, created_at=self.previous_moment,
        )

        Enrollment.objects.create(
            user=self.student_a, course=self.course,
            payment_status=Enrollment.STATUS_PAID, access_type=Enrollment.ACCESS_LIFETIME,
        )
        Enrollment.objects.create(
            user=self.student_b, course=self.course,
            payment_status=Enrollment.STATUS_PAID, access_type=Enrollment.ACCESS_INSTALLMENT,
            access_expires_at=self.now - timedelta(days=1),
        )
        Enrollment.objects.create(
            user=old_student, course=self.course, payment_status=Enrollment.STATUS_PENDING,
        )

    def _student(self, email):
        return User.objects.create_user(email=email, password="StrongStudent@123", full_name=email)

    def _payment(self, amount, status, plan, paid_at=None, created_at=None):
        payment = Payment.objects.create(
            user=self.student_a, course=self.course, amount=amount,
            status=status, plan=plan, paid_at=paid_at,
        )
        if created_at:
            Payment.objects.filter(pk=payment.pk).update(created_at=created_at)
        return payment

    def _section(self, payload, section_id):
        return next(section for section in payload["sections"] if section["id"] == section_id)

    def _by_id(self, items):
        return {item["id"]: item for item in items}

    def test_business_figures(self):
        business = self._section(self.get_data("7d").json(), "business")
        kpis = self._by_id(business["kpis"])

        self.assertEqual(kpis["revenue"]["value"], 1500.0)
        self.assertEqual(kpis["revenue"]["unit"], "inr")
        self.assertEqual(kpis["revenue"]["delta_pct"], 100.0)
        self.assertEqual(kpis["revenue"]["delta_good_direction"], "up")
        self.assertEqual(kpis["revenue"]["period_label"], "vs previous 7 days")
        self.assertEqual(sum(kpis["revenue"]["trend"]), 1500.0)

        self.assertEqual(kpis["paid_payments"]["value"], 2)
        self.assertEqual(kpis["paid_payments"]["delta_pct"], 100.0)
        self.assertEqual(kpis["new_students"]["value"], 2)  # staff, admin and instructor excluded
        self.assertEqual(kpis["new_students"]["delta_pct"], 100.0)
        self.assertEqual(kpis["new_enrollments"]["value"], 2)  # paid only
        self.assertIsNone(kpis["new_enrollments"]["delta_pct"])  # nothing in the previous period

        charts = self._by_id(business["charts"])
        self.assertEqual(
            charts["revenue_by_plan"]["items"],
            [{"label": "Full / lifetime", "value": 1000.0}, {"label": "Monthly installment", "value": 500.0}],
        )
        self.assertEqual(
            charts["payment_outcomes"]["items"],
            [
                {"label": "Paid", "value": 2, "status": "good"},
                {"label": "Pending", "value": 1, "status": "warning"},
                {"label": "Failed", "value": 1, "status": "critical"},
            ],
        )
        # Only the lifetime enrollment is active; the installment one expired.
        self.assertEqual(charts["top_courses"]["items"], [{"label": "Insights OSINT", "value": 1}])
        self.assertEqual(sum(charts["revenue"]["series"][0]["values"]), 1500.0)

    def test_learning_active_enrollments_use_access_rules(self):
        learning = self._section(self.get_data("7d").json(), "learning")
        kpis = self._by_id(learning["kpis"])
        self.assertEqual(kpis["active_enrollments"]["value"], 1)
        self.assertIsNone(kpis["active_enrollments"]["delta_pct"])

    def test_hourly_buckets_place_rows_in_the_right_hour(self):
        payload = self.get_data("24h").json()
        revenue = self._by_id(self._section(payload, "business")["kpis"])["revenue"]
        window = metrics.build_window("24h", timezone.now())
        expected_index = next(
            index for index, bucket in enumerate(window.buckets)
            if bucket <= self.recent < bucket + timedelta(hours=1)
        )
        self.assertEqual(revenue["trend"][expected_index], 1500.0)
        self.assertEqual(revenue["value"], 1500.0)


class DeltaAndFoldingTests(SimpleTestCase):
    def test_delta_pct(self):
        self.assertEqual(metrics.delta_pct(150, 100), 50.0)
        self.assertEqual(metrics.delta_pct(50, 100), -50.0)
        self.assertEqual(metrics.delta_pct(1, 3), -66.7)
        self.assertEqual(metrics.delta_pct(0, 0), 0.0)
        self.assertIsNone(metrics.delta_pct(5, 0))
        self.assertIsNone(metrics.delta_pct(None, 5))
        self.assertIsNone(metrics.delta_pct(5, None))

    def test_previous_period_has_equal_length(self):
        now = timezone.now()
        for range_key in metrics.RANGES:
            window = metrics.build_window(range_key, now)
            self.assertEqual(window.end - window.start, window.prev_end - window.prev_start)
            self.assertEqual(window.prev_end, window.start)
            self.assertLessEqual(window.buckets[0], now)
            self.assertLessEqual(window.buckets[-1], now)

    def test_fold_ranked_keeps_top_seven_and_other(self):
        pairs = [(f"item{index}", index) for index in range(1, 11)]
        items = metrics.fold_ranked(pairs, digits=0)
        self.assertEqual(len(items), 8)
        self.assertEqual(items[0], {"label": "item10", "value": 10})
        self.assertEqual(items[-1], {"label": "Other", "value": 1 + 2 + 3})
        self.assertEqual(sum(item["value"] for item in items), 55)

    def test_container_label(self):
        self.assertEqual(container_label("streamx-backend-1"), "backend")
        self.assertEqual(container_label("streamx-backend-2-1"), "backend-2")
        self.assertEqual(container_label("streamx-owncast-1"), "owncast")

    def test_hourly_window_is_capped_and_complete(self):
        now = timezone.now()
        window = build_hourly_window(24, now)
        self.assertEqual(len(window.buckets), 24)
        self.assertLessEqual(window.eval_timestamps[-1], now.timestamp())
        self.assertEqual(len(build_hourly_window(10_000, now).buckets), 30 * 24)


class PrometheusClientTests(SimpleTestCase):
    def setUp(self):
        self.client = PrometheusClient(base_url=PROMETHEUS_TEST_URL, timeout=2)

    def test_instant_vector_parsing(self):
        payload = _vector(({"name": "streamx-backend-1"}, "0.25"), ({"name": "streamx-redis-1"}, "NaN"))
        with mock.patch("apps.insights.prometheus.urlopen", return_value=_json_response(payload)) as urlopen:
            samples = self.client.query("up")
        request = urlopen.call_args.args[0]
        self.assertTrue(request.full_url.startswith(f"{PROMETHEUS_TEST_URL}/api/v1/query?"))
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 2.0)
        self.assertEqual(samples[0].labels, {"name": "streamx-backend-1"})
        self.assertEqual(samples[0].value, 0.25)
        self.assertIsNone(samples[1].value)  # NaN becomes null, never invalid JSON

    def test_scalar_parsing(self):
        payload = {"status": "success", "data": {"resultType": "scalar", "result": [1700000000, "42"]}}
        with mock.patch("apps.insights.prometheus.urlopen", return_value=_json_response(payload)):
            samples = self.client.query("vector(42)")
        self.assertEqual(samples[0].value, 42.0)

    def test_range_parsing(self):
        payload = {
            "status": "success",
            "data": {
                "resultType": "matrix",
                "result": [{"metric": {"result": "success"}, "values": [[3600, "1"], [7200, "+Inf"]]}],
            },
        }
        with mock.patch("apps.insights.prometheus.urlopen", return_value=_json_response(payload)) as urlopen:
            series = self.client.query_range("x", 3600, 7200)
        params = parse_qs(urlsplit(urlopen.call_args.args[0].full_url).query)
        self.assertEqual(params["step"], ["3600"])
        self.assertEqual(series[0].labels, {"result": "success"})
        self.assertEqual(series[0].points, {3600: 1.0, 7200: None})

    def test_errors_become_short_reasons(self):
        cases = [
            (URLError("Name or service not known"), REASON_UNREACHABLE),
            (URLError(TimeoutError("timed out")), REASON_TIMEOUT),
            (TimeoutError("timed out"), REASON_TIMEOUT),
            (ConnectionResetError("reset"), REASON_UNREACHABLE),
            (HTTPError(PROMETHEUS_TEST_URL, 503, "Unavailable", {}, None), REASON_HTTP_ERROR),
        ]
        for side_effect, reason in cases:
            with mock.patch("apps.insights.prometheus.urlopen", side_effect=side_effect):
                with self.assertRaises(PrometheusError) as raised:
                    self.client.query("up")
            self.assertEqual(raised.exception.reason, reason)
            self.assertNotIn("prometheus-test", raised.exception.reason)

    def test_bad_payloads_become_short_reasons(self):
        bodies = [
            (b"<html>nope</html>", REASON_BAD_RESPONSE),
            (json.dumps({"status": "error", "error": "parse error"}).encode(), REASON_HTTP_ERROR),
            (json.dumps({"status": "success", "data": {"resultType": "matrix"}}).encode(), REASON_BAD_RESPONSE),
            (json.dumps(_vector(({}, "not-a-number"))).encode(), REASON_BAD_RESPONSE),
        ]
        for body, reason in bodies:
            with mock.patch("apps.insights.prometheus.urlopen", return_value=io.BytesIO(body)):
                with self.assertRaises(PrometheusError) as raised:
                    self.client.query("up")
            self.assertEqual(raised.exception.reason, reason)

    def test_unconfigured_client_never_calls_out(self):
        client = PrometheusClient(base_url="", timeout=2)
        with mock.patch("apps.insights.prometheus.urlopen") as urlopen:
            results, errors = client.run_many({"a": mock.sentinel.query})
        urlopen.assert_not_called()
        self.assertEqual(results, {})
        self.assertEqual(errors, {"a": REASON_NOT_CONFIGURED})
        self.assertFalse(PrometheusClient(base_url="file:///etc/passwd").configured)


@override_settings(PROMETHEUS_URL=PROMETHEUS_TEST_URL, PROMETHEUS_TIMEOUT_SECONDS=2)
class DashboardPrometheusTests(DashboardTestMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.superuser)

    def _section(self, payload, section_id):
        return next(section for section in payload["sections"] if section["id"] == section_id)

    def test_prometheus_failure_marks_only_its_sections_unavailable(self):
        with mock.patch("apps.insights.prometheus.urlopen", side_effect=URLError("connection refused")):
            response = self.get_data("24h")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual([section["id"] for section in payload["sections"]], SECTION_ORDER)
        for section in payload["sections"]:
            if section["id"] in {"infrastructure", "streaming"}:
                self.assertFalse(section["available"])
                self.assertEqual(section["unavailable_reason"], REASON_UNREACHABLE)
                self.assertEqual(section["kpis"], [])
                self.assertEqual(section["charts"], [])
            else:
                self.assertTrue(section["available"])
                self.assertTrue(section["kpis"])
        self.assertNotIn("prometheus-test", response.content.decode())
        self.assertNotIn("Traceback", response.content.decode())

    def test_prometheus_sections_are_shaped_from_results(self):
        fake = FakePrometheus(
            instant=[
                ('mode="idle"', [({}, "37.456")]),
                ("node_memory_MemAvailable_bytes", [({}, "61.2")]),
                ('status_code=~"5.."', [({}, "2.5")]),
                ("histogram_quantile", [({}, "2400.4")]),
                ("sum(rate(streamx_http_requests_total[1h]))", [({}, "12.345")]),
                ('sum(up{job="streamx_backend"})', [({}, "3")]),
                ('count(up{job="streamx_backend"})', [({}, "4")]),
                ("ratio_rate30d", [({}, "99.95")]),
                (
                    "sum by (name)",
                    [({"name": f"streamx-svc{index}-1"}, str(index / 10)) for index in range(1, 10)],
                ),
                ('name="streamx-owncast-1"', [({}, "1.234")]),
                ("streamx_realtime_join_total", [({"result": "success"}, "18"), ({"result": "failure"}, "2")]),
                ("offset 1h", [({}, "4")]),
                ('event="disconnected"', [({}, "6")]),
                ('up{job="livekit"}', [({}, "1")]),
            ],
            ranged=[
                ('mode="idle"', [({}, "40")]),
                ("node_memory_MemAvailable_bytes", [({}, "60")]),
                ('status_code=~"5.."', [({}, "0.5")]),
                ("histogram_quantile", [({}, "120")]),
                ("sum(rate(streamx_http_requests_total[1h]))", [({}, "10")]),
                ('name="streamx-owncast-1"', [({}, "0.5")]),
                ("streamx_realtime_join_total", [({"result": "success"}, "3"), ({"result": "failure"}, "1")]),
                ('event="disconnected"', []),
            ],
        )
        with mock.patch("apps.insights.prometheus.urlopen", side_effect=fake):
            payload = self.get_data("24h").json()

        infra = self._section(payload, "infrastructure")
        self.assertTrue(infra["available"], infra["unavailable_reason"])
        self.assertIn("last hour", infra["note"])
        kpis = {kpi["id"]: kpi for kpi in infra["kpis"]}
        self.assertEqual(kpis["host_cpu"]["value"], 37.46)
        self.assertEqual(kpis["host_cpu"]["trend"], [40.0] * 24)
        self.assertEqual(kpis["memory"]["value"], 61.2)
        self.assertEqual(kpis["api_requests"]["value"], 12.35)
        self.assertEqual(kpis["api_requests"]["unit"], "per_second")
        self.assertEqual((kpis["error_rate"]["value"], kpis["error_rate"]["status"]), (2.5, "warning"))
        self.assertEqual((kpis["latency_p95"]["value"], kpis["latency_p95"]["status"]), (2400, "critical"))
        self.assertEqual(kpis["healthy_backends"]["value"], 3)
        self.assertEqual(kpis["healthy_backends"]["hint"], "of 4")
        self.assertEqual(kpis["healthy_backends"]["status"], "critical")
        self.assertEqual(kpis["availability_30d"]["value"], 99.95)

        charts = {chart["id"]: chart for chart in infra["charts"]}
        cpu_memory = charts["cpu_memory"]
        self.assertEqual(cpu_memory["bucket"], "hour")
        self.assertEqual(len(cpu_memory["buckets"]), 24)
        self.assertEqual([series["key"] for series in cpu_memory["series"]], ["cpu", "memory"])
        containers = charts["container_cpu"]["items"]
        self.assertEqual(len(containers), 8)
        self.assertEqual(containers[0], {"label": "svc9", "value": 0.9})
        self.assertEqual(containers[-1]["label"], "Other")
        self.assertAlmostEqual(containers[-1]["value"], 0.1 + 0.2)  # svc2 and svc1 folded

        streaming = self._section(payload, "streaming")
        self.assertTrue(streaming["available"], streaming["unavailable_reason"])
        kpis = {kpi["id"]: kpi for kpi in streaming["kpis"]}
        self.assertEqual(kpis["owncast_cpu"]["value"], 1.234)
        self.assertEqual(kpis["join_success"]["value"], 90.0)
        self.assertEqual(kpis["join_success"]["trend"], [75.0] * 24)
        self.assertEqual(kpis["livekit_disconnects"]["value"], 6)
        self.assertEqual(kpis["livekit_disconnects"]["delta_pct"], 50.0)
        self.assertEqual(kpis["livekit_disconnects"]["delta_good_direction"], "down")
        self.assertEqual((kpis["livekit_health"]["status"], kpis["livekit_health"]["status_label"]), ("good", "Up"))

        charts = {chart["id"]: chart for chart in streaming["charts"]}
        joins = charts["realtime_joins"]["series"]
        self.assertEqual([(series["label"], series["values"][0]) for series in joins], [("Succeeded", 3), ("Failed", 1)])
        # No data points means null, never zero.
        self.assertEqual(charts["livekit_disconnects"]["series"][0]["values"], [None] * 24)

        for url in fake.urls:
            self.assertTrue(url.startswith(f"{PROMETHEUS_TEST_URL}/api/v1/"))
        self.assertNotIn("prometheus-test", json.dumps(payload))
