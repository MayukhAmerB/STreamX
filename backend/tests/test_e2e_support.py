"""The end-to-end support package stays out of production and works as promised.

``apps.e2e_support`` is only installed by ``config.settings.e2e`` (E2E=1); these
tests exercise its pieces directly under the normal test settings.
"""

import os
import subprocess
import sys
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest import mock

from django.conf.urls.static import static
from django.core.management.base import CommandError
from django.http import Http404
from django.test import RequestFactory, SimpleTestCase, override_settings
from django.urls import Resolver404, resolve

from apps.e2e_support import clock, fakes

BACKEND_DIR = Path(__file__).resolve().parents[1]


class E2EClockTests(SimpleTestCase):
    def tearDown(self):
        clock.reset()

    def test_freeze_and_advance(self):
        frozen = clock.freeze("2026-11-15T23:59:00+05:30")
        self.assertEqual(clock.now(), frozen)
        self.assertEqual(clock.advance(61) - frozen, timedelta(seconds=61))
        self.assertEqual(clock.describe()["mode"], "frozen")

    def test_travel_keeps_flowing_and_reset_returns_to_real_time(self):
        target = clock.travel("2030-01-01T00:00:00+00:00")
        self.assertGreaterEqual(target.year, 2030)
        self.assertEqual(clock.describe()["mode"], "travel")
        real = clock.reset()
        self.assertLess(real.year, 2030)
        self.assertEqual(clock.describe()["mode"], "real")

    def test_naive_instants_are_refused(self):
        with self.assertRaises(ValueError):
            clock.freeze("2026-11-15T23:59:00")


class FakeFfmpegTests(SimpleTestCase):
    def test_concat_joins_the_listed_parts_and_ffprobe_reports_a_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            parts = [root / "part-0001.ts", root / "part-0002.ts"]
            parts[0].write_bytes(b"first-")
            parts[1].write_bytes(b"second")
            listing = root / "concat.txt"
            listing.write_text("".join(f"file '{part.as_posix()}'\n" for part in parts), encoding="utf-8")
            output = root / "out.mp4"
            result = fakes.fake_ffmpeg_run(["nice", "-n", "10", "ffmpeg", "-f", "concat", "-safe", "0", "-i", str(listing), str(output)])
            self.assertEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), b"first-second")
            probe = fakes.fake_ffmpeg_run(["ffprobe", "-v", "error", str(output)])
            self.assertEqual(probe.stdout.strip(), f"{fakes.FAKE_DURATION_SECONDS}.0")

    def test_empty_input_fails_like_ffmpeg(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "empty.ts"
            source.write_bytes(b"")
            result = fakes.fake_ffmpeg_run(["ffmpeg", "-i", str(source), str(Path(tmp) / "o.mp4")])
            self.assertEqual(result.returncode, 1)

    def test_patch_only_touches_the_recording_ffmpeg_module(self):
        import subprocess as real_subprocess

        from apps.realtime.recording import ffmpeg as recording_ffmpeg

        with fakes.patched_recording_ffmpeg():
            self.assertIs(recording_ffmpeg.subprocess.run, fakes.fake_ffmpeg_run)
            self.assertIsNot(real_subprocess.run, fakes.fake_ffmpeg_run)
        self.assertIs(recording_ffmpeg.subprocess, real_subprocess)

    def test_fake_capture_behaves_like_a_terminated_ffmpeg(self):
        with tempfile.TemporaryDirectory() as tmp:
            part = Path(tmp) / "part-0001.ts"
            process = fakes.FakeCapture(["ffmpeg", "-i", "not-a-url", "-c", "copy", str(part)])
            self.assertIsNone(process.poll())
            self.assertGreater(part.stat().st_size, 0)
            process.terminate()
            self.assertEqual(process.wait(timeout=1), 255)


class E2EIsolationTests(SimpleTestCase):
    def test_production_urlconf_has_no_control_api(self):
        with self.assertRaises(Resolver404):
            resolve("/api/__e2e__/reset/")

    def test_control_views_answer_404_outside_the_e2e_settings(self):
        from apps.e2e_support import views

        request = RequestFactory().post("/api/__e2e__/reset/", HTTP_X_E2E_TOKEN="anything")
        with self.assertRaises(Http404):
            views.reset_view(request)

    @override_settings(E2E_ENABLED=True, E2E_CONTROL_TOKEN="secret")
    def test_control_views_need_e2e_env_and_the_token(self):
        from apps.e2e_support import views

        factory = RequestFactory()
        with mock.patch.dict(os.environ, {"E2E": "1"}):
            with self.assertRaises(Http404):
                views.clock_view(factory.get("/api/__e2e__/clock/", HTTP_X_E2E_TOKEN="wrong"))
            response = views.clock_view(factory.get("/api/__e2e__/clock/", HTTP_X_E2E_TOKEN="secret"))
            self.assertEqual(response.status_code, 200)
        with mock.patch.dict(os.environ, {"E2E": ""}):
            with self.assertRaises(Http404):
                views.clock_view(factory.get("/api/__e2e__/clock/", HTTP_X_E2E_TOKEN="secret"))

    @override_settings(DEBUG=False, APP_ENV="production")
    def test_seed_command_refuses_without_debug_or_e2e(self):
        from apps.e2e_support.management.commands.seed_e2e import Command

        with mock.patch.dict(os.environ, {"E2E": ""}):
            with self.assertRaises(CommandError):
                Command().handle(no_flush=True, manifest="")

    @override_settings(DEBUG=True, APP_ENV="production")
    def test_seed_command_never_runs_with_app_env_production(self):
        from apps.e2e_support.management.commands.seed_e2e import Command

        with self.assertRaises(CommandError):
            Command().handle(no_flush=True, manifest="")

    def test_e2e_settings_refuse_to_load_without_e2e_1(self):
        env = {key: value for key, value in os.environ.items() if key not in {"E2E", "DJANGO_SETTINGS_MODULE"}}
        result = subprocess.run(
            [sys.executable, "-c", "import config.settings.e2e"],
            cwd=str(BACKEND_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires E2E=1", result.stderr)

    @override_settings(DEBUG=True)
    def test_e2e_urlconf_drops_only_the_debug_media_route(self):
        from config import urls as production_urls
        from config.e2e_urls import _is_debug_media_route

        media_routes = static("/media/", document_root="/tmp")
        self.assertTrue(media_routes)
        self.assertTrue(all(_is_debug_media_route(route) for route in media_routes))
        self.assertFalse(any(_is_debug_media_route(route) for route in production_urls.urlpatterns if "api/" in str(route.pattern)))
