from collections import namedtuple
from unittest import mock

from apps.core import health
from apps.core.circuit import BreakerConfig, CircuitBreaker
from django.core.cache import cache
from django.db import OperationalError
from django.test import TestCase, override_settings
from django.urls import reverse

DiskUsage = namedtuple("DiskUsage", "total used free")
GiB = 1024**3


class ReadinessTests(TestCase):
    def setUp(self):
        health.reset_readiness_cache()
        cache.clear()

    def tearDown(self):
        health.reset_readiness_cache()

    def test_liveness_does_no_io(self):
        with self.assertNumQueries(0):
            response = self.client.get(reverse("health-live"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(self.client.get("/healthz").status_code, 200)

    def test_readiness_reports_all_hard_checks(self):
        response = self.client.get(reverse("health-ready"))
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        for key in ("database", "cache", "storage", "migrations", "media_disk"):
            self.assertIn(key, body["checks"])
        self.assertEqual(body["checks"]["migrations"], "ok")
        self.assertIsNone(body["failures"])
        self.assertIn("owncast", body["upstreams"])
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(self.client.get("/readyz").status_code, 200)

    def test_readiness_is_memoised_briefly(self):
        self.client.get(reverse("health-ready"))
        with self.assertNumQueries(0):
            body = self.client.get(reverse("health-ready")).json()
        self.assertTrue(body["cached"])

    @override_settings(HEALTH_READINESS_CACHE_SECONDS=0)
    def test_database_failure_is_503_without_leaking_details(self):
        with mock.patch.object(health, "check_database", side_effect=OperationalError("could not connect to 10.0.0.5")):
            response = self.client.get(reverse("health-ready"))
        self.assertEqual(response.status_code, 503)
        body = response.json()
        self.assertEqual(body["status"], "degraded")
        self.assertEqual(body["failures"]["database"], "OperationalError")
        self.assertNotIn("10.0.0.5", response.content.decode())
        self.assertEqual(body["checks"]["migrations"], "skipped")

    @override_settings(HEALTH_READINESS_CACHE_SECONDS=0)
    def test_unapplied_migrations_fail_readiness(self):
        with mock.patch(
            "django.db.migrations.executor.MigrationExecutor.migration_plan",
            return_value=[(mock.Mock(app_label="core"), False)],
        ):
            response = self.client.get(reverse("health-ready"))
        self.assertEqual(response.status_code, 503)
        self.assertIn("migrations", response.json()["failures"])

    @override_settings(HEALTH_READINESS_CACHE_SECONDS=0, HEALTH_MEDIA_MIN_FREE_BYTES=GiB, HEALTH_MEDIA_WARN_FREE_BYTES=5 * GiB)
    def test_media_disk_thresholds(self):
        with mock.patch("apps.core.health.shutil.disk_usage", return_value=DiskUsage(100 * GiB, 97 * GiB, 3 * GiB)):
            warn = self.client.get(reverse("health-ready"))
        self.assertEqual(warn.status_code, 200)
        self.assertIn("media_disk", warn.json()["warnings"])
        with mock.patch("apps.core.health.shutil.disk_usage", return_value=DiskUsage(100 * GiB, 99.5 * GiB, GiB // 2)):
            fail = self.client.get(reverse("health-ready"))
        self.assertEqual(fail.status_code, 503)
        self.assertIn("media_disk", fail.json()["failures"])

    @override_settings(HEALTH_READINESS_CACHE_SECONDS=0)
    def test_open_upstream_circuit_is_reported_but_not_fatal(self):
        breaker = CircuitBreaker("owncast", BreakerConfig(failure_threshold=1, open_seconds=60))
        breaker.allow().failure()
        response = self.client.get(reverse("health-ready"))
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["upstreams"]["owncast"]["state"], "open")
        self.assertIn("owncast", body["warnings"]["upstreams"])
        breaker.reset()
