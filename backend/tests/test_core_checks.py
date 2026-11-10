import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

from apps.core import checks
from django.core.checks import ERROR, INFO, WARNING
from django.core.management import call_command
from django.test import SimpleTestCase, override_settings

BACKEND_DIR = Path(__file__).resolve().parents[1]
REDIS_CACHE = {"default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": "redis://127.0.0.1:6379/0"}}
PRODUCTION_LIKE = {
    "APP_ENV": "production",
    "DEBUG": False,
    "SECRET_KEY": "k8Jq2vN9xLm4Tz7Rw1Yb6Pc3Hs5Gd0Fa8Ue2Io9Kl4Mn7Bv1Cx6Zq3Wr5Ty8",
    "ALLOWED_HOSTS": ["api.example.com"],
    "CACHES": REDIS_CACHE,
    "DIRECT_COURSE_PAYMENTS_ENABLED": True,
    "RAZORPAY_KEY_ID": "rzp_live_abc",
    "RAZORPAY_KEY_SECRET": "live-secret-value",
    "RAZORPAY_WEBHOOK_SECRET": "webhook-secret-value",
    "TRUST_X_FORWARDED_FOR": True,
    "TRUSTED_PROXY_COUNT": 1,
    "METRICS_AUTH_TOKEN": "metrics-token",
    "EMAIL_BACKEND": "django.core.mail.backends.smtp.EmailBackend",
}


def ids(messages, level=None):
    return sorted(message.id for message in messages if level is None or message.level == level)


class NormalChecksTests(SimpleTestCase):
    def test_current_settings_pass_all_checks(self):
        call_command("check", verbosity=0)

    @override_settings(
        STREAM_RECORDER_ENABLED=True,
        STREAM_RECORDER_SOURCE_URL="owncast:8080/hls",
        STREAM_RECORDER_WORK_DIR="relative/dir",
        STREAM_RECORDER_MAX_DURATION_SECONDS=0,
        STREAM_RECORDER_FINALIZE_SPACE_FACTOR=0.5,
    )
    def test_stream_recorder_sanity(self):
        self.assertEqual(
            ids(checks.check_stream_recorder_settings()),
            ["core.E010", "core.E011", "core.E012", "core.E013"],
        )

    @override_settings(STREAM_RECORDER_ENABLED=False, STREAM_RECORDER_SOURCE_URL="garbage")
    def test_stream_recorder_ignored_when_disabled(self):
        self.assertEqual(checks.check_stream_recorder_settings(), [])

    def test_prometheus_url(self):
        for value, expected in (("", []), ("http://prometheus:9090", []), ("prometheus:9090", ["core.E014"])):
            with self.subTest(value=value), override_settings(PROMETHEUS_URL=value):
                self.assertEqual(ids(checks.check_prometheus_url()), expected)

    def test_trusted_proxy_count(self):
        for value, expected in ((1, []), (3, ["core.I015"]), (9, ["core.E015"]), ("x", ["core.E015"])):
            with self.subTest(value=value), override_settings(TRUSTED_PROXY_COUNT=value):
                self.assertEqual(ids(checks.check_proxy_trust_settings()), expected)

    @override_settings(IDEMPOTENCY_KEY_TTL_SECONDS=10, IDEMPOTENCY_LEASE_SECONDS=60, OUTBOX_DEFAULT_MAX_ATTEMPTS=0,
                       CIRCUIT_BREAKERS={"owncast": {"thresold": 3}})
    def test_core_settings(self):
        self.assertEqual(ids(checks.check_core_settings()), ["core.E016", "core.E017", "core.E018"])


class DeployChecksTests(SimpleTestCase):
    def test_not_production_is_silent(self):
        with override_settings(APP_ENV="development", DEBUG=True, ALLOWED_HOSTS=["*"]):
            self.assertEqual(checks.check_production_posture(), [])

    def test_production_like_settings_have_no_blocking_messages(self):
        with override_settings(**PRODUCTION_LIKE):
            messages = checks.check_production_posture()
        self.assertEqual([m for m in messages if m.level >= WARNING], [])

    def test_each_blocking_misconfiguration(self):
        cases = {
            "core.E001": {"SECRET_KEY": "change-me"},
            "core.E002": {"DEBUG": True},
            "core.E003": {"ALLOWED_HOSTS": ["*"]},
            "core.E004": {"CACHES": {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}},
            "core.E005": {"RAZORPAY_WEBHOOK_SECRET": ""},
            "core.E006": {"TRUST_X_FORWARDED_FOR": False},
        }
        for check_id, overrides in cases.items():
            with self.subTest(check_id), override_settings(**{**PRODUCTION_LIKE, **overrides}):
                self.assertEqual(ids(checks.check_production_posture(), ERROR), [check_id])

    def test_media_root_not_writable_is_an_error(self):
        with override_settings(**PRODUCTION_LIKE), mock.patch("apps.core.checks.os.access", return_value=False):
            self.assertIn("core.E007", ids(checks.check_production_posture(), ERROR))

    def test_advisories_are_info_only(self):
        overrides = {
            **PRODUCTION_LIKE,
            "RAZORPAY_KEY_ID": "rzp_test_abc",
            "METRICS_AUTH_TOKEN": "",
            "EMAIL_BACKEND": "django.core.mail.backends.console.EmailBackend",
            "MEDIA_ROOT": str(BACKEND_DIR / "does-not-exist-media"),
        }
        with override_settings(**overrides):
            messages = checks.check_production_posture()
        self.assertEqual(ids(messages, INFO), ["core.I001", "core.I002", "core.I003", "core.I004"])
        self.assertEqual(ids(messages, ERROR), [])


class DeployCommandTests(SimpleTestCase):
    """Mirror entrypoint.sh: prod settings + check --deploy --fail-level WARNING."""

    def test_check_deploy_passes_with_production_settings_module(self):
        env = {key: value for key, value in os.environ.items() if key in {"PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME"}}
        env.update(
            {
                "APP_ENV": "production",
                "DJANGO_SETTINGS_MODULE": "config.settings.prod",
                "DEBUG": "0",
                "DJANGO_SECRET_KEY": PRODUCTION_LIKE["SECRET_KEY"],
                "ALLOWED_HOSTS": "api.example.com",
                "DATABASE_URL": "postgres://app:pw@127.0.0.1:5432/app",
                "REDIS_URL": "redis://127.0.0.1:6379/0",
                "CORS_ALLOWED_ORIGINS": "https://example.com",
                "CSRF_TRUSTED_ORIGINS": "https://example.com",
                "FRONTEND_PUBLIC_ORIGIN": "https://example.com",
                "MEDIA_PUBLIC_BASE_URL": "https://media.example.com",
                "DIRECT_COURSE_PAYMENTS_ENABLED": "1",
                "RAZORPAY_KEY_ID": "rzp_live_abc",
                "RAZORPAY_KEY_SECRET": "live-secret-value",
                "RAZORPAY_WEBHOOK_SECRET": "webhook-secret-value",
                "LIVEKIT_API_KEY": "livekit-key",
                "LIVEKIT_API_SECRET": "livekit-secret-value",
                "TRUST_X_FORWARDED_FOR": "1",
                "TRUSTED_PROXY_COUNT": "1",
                "STREAM_RECORDER_ENABLED": "1",
            }
        )
        result = subprocess.run(
            [sys.executable, "manage.py", "check", "--deploy", "--fail-level", "WARNING"],
            cwd=BACKEND_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
