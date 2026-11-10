"""The real-ffmpeg pipeline check. The end-to-end test runs only where ffmpeg and
ffprobe are installed (the backend image) and is skipped elsewhere."""

import shutil
import unittest
from io import StringIO
from unittest.mock import patch

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from apps.courses.models import Course
from apps.realtime.recording.verification import MARKER, Report, run_verification

HAS_FFMPEG = bool(
    shutil.which(getattr(settings, "FFMPEG_BINARY", "") or "ffmpeg")
    and shutil.which(getattr(settings, "FFPROBE_BINARY", "") or "ffprobe")
)


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe are not installed here")
class RealFfmpegPipelineTests(TestCase):
    def test_pipeline_end_to_end(self):
        lines = []
        report = run_verification(write=lines.append)
        failures = [line for line in lines if line.startswith("[FAIL]")]
        self.assertTrue(report.passed, "\n".join(failures) or "\n".join(lines))
        names = [name for status, name, _detail in report.lines if status == "PASS"]
        for expected in (
            "(a) live: every live segment captured",
            "(b) offline tail: ffmpeg ended the part by itself",
            "(b) offline clip was never downloaded",
            "(c) reconnect: new connection captured",
            "two parts (one per OBS connection)",
            "final MP4: H.264 video + AAC audio",
            "final MP4: duration matches",
            "final MP4: faststart (moov before mdat)",
            "lecture created unpublished in the right module",
            "lecture has the module description",
            "OBS MKV upload remuxed and swapped in",
            "Host Studio egress file -> lecture",
            "publish to module -> lecture",
            "database left unchanged (transaction rolled back)",
        ):
            self.assertIn(expected, names)


class VerifyCommandTests(TestCase):
    @override_settings(FFMPEG_BINARY="definitely-not-installed-ffmpeg", FFPROBE_BINARY="definitely-not-ffprobe")
    def test_without_ffmpeg_it_fails_cleanly(self):
        report = run_verification()
        self.assertFalse(report.passed)
        self.assertEqual(report.lines[0][0], "FAIL")
        out = StringIO()
        with self.assertRaises(CommandError) as caught:
            call_command("verify_recording_pipeline", stdout=out)
        self.assertIn("RESULT: FAIL", str(caught.exception))
        self.assertIn("[FAIL] ffmpeg and ffprobe installed", out.getvalue())

    def test_pass_output(self):
        report = Report()
        report.ok("everything")
        out = StringIO()
        with patch("apps.realtime.management.commands.verify_recording_pipeline.run_verification",
                   return_value=report):
            call_command("verify_recording_pipeline", stdout=out)
        self.assertIn("RESULT: PASS (1 checks passed)", out.getvalue())

    def test_refuses_when_marker_rows_exist(self):
        Course.objects.create(title=f"{MARKER} leftover", description="d", price=0)
        with patch("apps.realtime.recording.verification._preflight", return_value=True), patch(
            "apps.realtime.recording.verification._environment"
        ):
            report = run_verification()
        self.assertFalse(report.passed)
        self.assertIn("refusing to run", report.lines[-1][2])
