"""Scan for recordings already on the server, and publishing them to a module."""

import io
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.courses.models import Lecture
from apps.realtime.models import RealtimeSessionRecording
from apps.realtime.recording import importer, publisher, services, state
from apps.realtime.recording.recorder import StreamRecorder
from tests.test_class_recordings import MP4_BYTES, R, RecordingFixtureMixin, fake_ffmpeg_run

FFMPEG_RUN = "apps.realtime.recording.ffmpeg.subprocess.run"
OLD = time.time() - 7200


def write(path, data=b"video-bytes" * 10, *, mtime=OLD):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    os.utime(path, (mtime, mtime))
    return path


def recorder():
    return StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": False})


class ScanTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.media = Path(self.media_root)
        self.recordings = Path(self.work_root)  # LiveKit output root == recorder work root in the fixture

    def scan(self, **kwargs):
        kwargs.setdefault("min_age_seconds", 600)
        return importer.scan_existing_recordings(**kwargs)

    def test_lists_unlinked_videos_and_skips_everything_else(self):
        orphan = write(self.media / "lecture_videos" / "osint-batch" / f"module_{self.module.pk}" / "old-class.mp4")
        linked = write(self.media / "lecture_videos" / "osint-batch" / "linked.mp4")
        lecture = Lecture.objects.create(section=self.module, title="Linked", order=10)
        Lecture.objects.filter(pk=lecture.pk).update(video_file="lecture_videos/osint-batch/linked.mp4")
        write(self.media / "lecture_videos" / "upload.mp4.part")
        write(self.media / "lecture_videos" / ".hidden.mp4")
        write(self.media / "lecture_videos" / "empty.mp4", b"")
        write(self.media / "lecture_videos" / "notes.txt")
        write(self.media / "lecture_videos" / "fresh.mp4", mtime=time.time())
        write(self.media / "streams" / "x" / "seg.ts")  # HLS output is never scanned
        report = self.scan()

        rows = list(R.objects.filter(source=R.SOURCE_IMPORTED))
        self.assertEqual([row.source_path for row in rows], [str(orphan.resolve())])
        row = rows[0]
        self.assertEqual(row.state, R.STATE_IMPORTED)
        self.assertEqual(row.source_size_bytes, orphan.stat().st_size)
        self.assertEqual(row.file_size_bytes, orphan.stat().st_size)
        self.assertEqual(row.module_id, self.module.pk, "module_<id> in the path is suggested")
        self.assertIsNone(row.lecture_id)
        self.assertEqual(report.linked, 1)
        self.assertEqual(report.skipped["temporary/partial"], 2)
        self.assertEqual(report.skipped["empty"], 1)
        self.assertEqual(report.skipped["recently modified"], 1)
        self.assertTrue(linked.exists() and orphan.exists(), "the scan never touches files")
        self.assertIn("1 new", report.summary())

    def test_is_idempotent_and_refreshes_size_and_mtime(self):
        path = write(self.recordings / "egress" / "room.mp4")
        self.assertEqual(len(self.scan().created), 1)
        again = self.scan()
        self.assertEqual(again.created, [])
        self.assertEqual(again.unchanged, 1)
        write(path, b"x" * 500, mtime=OLD + 60)
        third = self.scan()
        self.assertEqual(len(third.updated), 1)
        row = R.objects.get(source=R.SOURCE_IMPORTED)
        self.assertEqual(row.source_size_bytes, 500)
        self.assertEqual(R.objects.filter(source=R.SOURCE_IMPORTED).count(), 1)

    def test_dry_run_writes_nothing(self):
        write(self.recordings / "egress" / "room.mp4")
        report = self.scan(dry_run=True)
        self.assertEqual(len(report.created), 1)
        self.assertFalse(R.objects.filter(source=R.SOURCE_IMPORTED).exists())

    def test_livekit_recording_metadata_is_attached(self):
        path = write(self.recordings / "rooms" / "recon-class.mp4")
        egress = RealtimeSessionRecording.objects.create(
            session=self.session, status=RealtimeSessionRecording.STATUS_COMPLETED,
            output_file_path="/recordings/rooms/recon-class.mp4", started_at=timezone.now(),
        )
        self.scan()
        row = R.objects.get(source=R.SOURCE_IMPORTED)
        self.assertEqual(row.source_path, str(path.resolve()))
        self.assertEqual(row.session_id, self.session.pk)
        self.assertEqual(row.livekit_recording_id, egress.pk)

    def test_already_published_egress_recordings_are_linked(self):
        path = write(self.recordings / "rooms" / "done.mp4")
        R.objects.create(session=self.session, source=R.SOURCE_LIVEKIT_EGRESS, state=R.STATE_PUBLISHED,
                         source_path=str(path))
        report = self.scan()
        self.assertEqual(report.created, [])
        self.assertEqual(report.linked, 1)

    def test_orphaned_capture_folder_becomes_one_recording(self):
        orphan = self.recordings / "class-recording-999"
        write(orphan / "part-0001.ts", b"a" * 10)
        write(orphan / "part-0002.ts", b"b" * 20)
        write(orphan / "part-0001.log", b"log")
        owned = R.objects.create(session=self.session, source=R.SOURCE_SERVER, state=R.STATE_FAILED)
        write(self.recordings / f"class-recording-{owned.pk}" / "part-0001.ts")
        self.scan()
        row = R.objects.get(source=R.SOURCE_IMPORTED)
        self.assertEqual(row.work_dir, str(orphan.resolve()))
        self.assertEqual(row.source_path, "")
        self.assertEqual(row.part_count, 2)
        self.assertEqual(row.source_size_bytes, 30)

    def test_symlinks_are_never_followed(self):
        outside = write(Path(self.media_root).parent / f"outside-{os.getpid()}.mp4")
        self.addCleanup(outside.unlink, missing_ok=True)
        try:
            os.symlink(outside, self.media / "lecture_videos" / "link.mp4")
            os.symlink(outside.parent, self.media / "lecture_videos" / "linkdir", target_is_directory=True)
        except (OSError, NotImplementedError):
            (self.media / "lecture_videos").mkdir(parents=True, exist_ok=True)
            self.skipTest("symlinks are not available on this machine")
        report = self.scan()
        self.assertEqual(report.created, [])
        self.assertFalse(importer.is_within_import_roots(outside))

    def test_probe_fills_in_durations_when_ffprobe_exists(self):
        write(self.recordings / "egress" / "room.mp4")
        with patch("apps.realtime.recording.importer.shutil.which", return_value="/usr/bin/ffprobe"), patch(
            FFMPEG_RUN, side_effect=fake_ffmpeg_run
        ):
            report = self.scan()
        self.assertTrue(report.probe_available)
        self.assertEqual(R.objects.get(source=R.SOURCE_IMPORTED).duration_seconds, 3600)

    def test_limit_stops_and_says_so(self):
        for index in range(3):
            write(self.recordings / "egress" / f"room-{index}.mp4")
        report = self.scan(limit=2)
        self.assertEqual(len(report.created), 2)
        self.assertTrue(report.truncated)
        self.assertEqual(len(self.scan().created), 1)

    def test_management_command(self):
        write(self.recordings / "egress" / "room.mp4")
        out = io.StringIO()
        call_command("scan_existing_recordings", "--dry-run", stdout=out)
        self.assertIn("would list", out.getvalue())
        self.assertFalse(R.objects.filter(source=R.SOURCE_IMPORTED).exists())
        call_command("scan_existing_recordings", "--no-probe", stdout=out)
        self.assertEqual(R.objects.filter(source=R.SOURCE_IMPORTED).count(), 1)


class PublishImportTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.media = Path(self.media_root)
        self.recordings = Path(self.work_root)

    def imported(self, path=None, **extra):
        values = dict(source=R.SOURCE_IMPORTED, state=R.STATE_IMPORTED, source_path=str(path or ""),
                      started_at=timezone.now())
        values.update(extra)
        return R.objects.create(**values)

    def publish(self, row, module=None):
        services.publish_to_module(row, module or self.module)
        with patch(FFMPEG_RUN, side_effect=fake_ffmpeg_run) as run:
            recorder().finalize_recording(row.pk)
        row.refresh_from_db()
        return row, run

    def test_mp4_is_linked_or_copied_into_the_module_and_the_original_kept(self):
        original = write(self.recordings / "rooms" / "old.mp4", MP4_BYTES)
        row = self.imported(original)
        row, _run = self.publish(row)
        self.assertEqual(row.state, R.STATE_PROCESSING)
        lecture = row.lecture
        self.assertEqual(lecture.section_id, self.module.pk)
        self.assertFalse(lecture.is_published)
        self.assertEqual(lecture.description, "Reconnaissance module notes.")
        self.assertTrue(lecture.title.startswith("Class recording - "))
        placed = self.media / lecture.video_file.name
        self.assertTrue(lecture.video_file.name.startswith(f"lecture_videos/osint-batch/module_{self.module.pk}/"))
        self.assertEqual(placed.read_bytes(), MP4_BYTES)
        self.assertTrue(original.exists(), "imports never move or delete the original")
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED, "the transcoder picks it up")

    def test_title_comes_from_the_session_when_known(self):
        original = write(self.recordings / "rooms" / "old.mp4", MP4_BYTES)
        row, _run = self.publish(self.imported(original, session=self.session))
        self.assertTrue(row.lecture.title.startswith("Recon Class - "))

    def test_mkv_is_remuxed_and_falls_back_to_a_copy(self):
        original = write(self.recordings / "obs" / "2026-01-15 10-00-00.mkv")
        row, run = self.publish(self.imported(original))
        self.assertTrue(row.lecture.video_file.name.endswith(".mp4"))
        remux = run.call_args_list[0].args[0]
        self.assertEqual(remux[remux.index("-i") + 1], row.source_path)

        other = write(self.recordings / "obs" / "broken.mkv")
        row = self.imported(other)
        services.publish_to_module(row, self.module)

        def failing(cmd, *args, **kwargs):
            if "ffprobe" in str(cmd[0]):
                return fake_ffmpeg_run(cmd)
            import subprocess

            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Invalid data")

        with patch(FFMPEG_RUN, side_effect=failing):
            recorder().finalize_recording(row.pk)
        row.refresh_from_db()
        self.assertEqual(row.state, R.STATE_PROCESSING)
        self.assertTrue(row.lecture.video_file.name.endswith(".mkv"), "original container kept for the transcoder")
        self.assertTrue(other.exists())

    def test_orphaned_parts_are_concatenated_and_left_in_place(self):
        folder = self.recordings / "class-recording-555"
        write(folder / "part-0001.ts", b"a")
        write(folder / "part-0002.ts", b"b")
        row, run = self.publish(self.imported(work_dir=str(folder)))
        self.assertEqual(row.state, R.STATE_PROCESSING)
        concat = run.call_args_list[0].args[0]
        self.assertIn("concat", concat)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["part-0001.ts", "part-0002.ts"])

    def test_refusals(self):
        outside = write(Path(self.media_root).parent / f"elsewhere-{os.getpid()}.mp4")
        self.addCleanup(outside.unlink, missing_ok=True)
        row, _run = self.publish(self.imported(outside))
        self.assertEqual(row.state, R.STATE_FAILED)
        self.assertIn("outside the recording folders", row.error)

        missing = self.imported(self.recordings / "gone.mp4")
        missing, _run = self.publish(missing)
        self.assertEqual(missing.state, R.STATE_FAILED)
        self.assertIn("no longer on the server", missing.error)

        with self.assertRaises(ValidationError):
            services.publish_to_module(R.objects.get(pk=self.imported(outside).pk), None)
        server = R.objects.create(session=self.session, source=R.SOURCE_SERVER, state=R.STATE_FAILED)
        self.assertFalse(services.can_publish_to_module(server))

    def test_disk_space_check_applies(self):
        original = write(self.recordings / "rooms" / "big.mp4", MP4_BYTES)
        row = self.imported(original)
        with override_settings(STREAM_RECORDER_MIN_FREE_BYTES=10**15):
            row, _run = self.publish(row)
        self.assertEqual(row.state, R.STATE_FAILED)
        self.assertIn("Not enough free disk space", row.error)
        self.assertTrue(services.can_retry(row))
        row, _run = self.publish(row)  # publish to module again from FAILED
        self.assertEqual(row.state, R.STATE_PROCESSING)
        self.assertEqual(row.attempts, 1)

    def test_imported_state_machine(self):
        row = self.imported(write(self.recordings / "a.mp4"))
        self.assertFalse(state.transition(row, R.STATE_PROCESSING, reason="t"))
        self.assertFalse(services.can_retry(row))
        R.objects.filter(pk=row.pk).update(state=R.STATE_FAILED)
        row.refresh_from_db()
        self.assertFalse(services.can_retry(row), "no module: use publish to module")

    def test_place_file_links_when_possible_and_copies_otherwise(self):
        source = write(self.media / "realtime_recordings" / "x.webm")
        target = self.media / "lecture_videos" / "c" / "x.webm"
        self.assertIn(publisher.place_file(source, target), {"linked", "copied"})
        self.assertEqual(target.read_bytes(), source.read_bytes())
        with patch("apps.realtime.recording.publisher.os.link", side_effect=OSError(18, "EXDEV")):
            self.assertEqual(publisher.place_file(source, target), "copied")
        self.assertEqual(target.read_bytes(), source.read_bytes())
        self.assertFalse(target.with_name(target.name + ".partial").exists())
        self.assertTrue(source.exists())


class SweepRespectsImportsTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()

    def test_sweep_keeps_folders_and_uploads_owned_by_imports(self):
        folder = Path(self.work_root) / "class-recording-4242"
        write(folder / "part-0001.ts", mtime=time.time() - 3 * 86400)
        os.utime(folder, (time.time() - 3 * 86400,) * 2)
        staged = write(Path(self.media_root) / "class-recording-uploads" / "obs-class-1-x.mkv",
                       mtime=time.time() - 3 * 86400)
        R.objects.create(source=R.SOURCE_IMPORTED, state=R.STATE_IMPORTED, work_dir=str(folder))
        R.objects.create(source=R.SOURCE_IMPORTED, state=R.STATE_IMPORTED, source_path=str(staged))
        swept = recorder().sweep_stale_files()
        self.assertEqual(swept["orphan_dirs"], 0)
        self.assertEqual(swept["orphan_uploads"], 0)
        self.assertTrue(folder.exists())
        self.assertTrue(staged.exists())
