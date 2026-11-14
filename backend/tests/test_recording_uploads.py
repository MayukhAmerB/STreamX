"""Resumable class recording uploads (apps.recording_uploads).

Chunked upload API (create/resume, out-of-order + idempotent chunks, per-chunk
checksums, complete, abort), the worker (assembly, whole-file checksum, probe,
remux, replace-vs-create, waiting for the auto-recording, leases), personal
upload tokens (scope, revocation, expiry), quotas and limits, path traversal,
CSRF, the firewall exemption, admin switch-back and the periodic cleanup.
"""

import hashlib
import os
import shutil
import tempfile
import uuid
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from django.conf import settings
from django.core.cache import cache
from django.core.files.storage import default_storage
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.core.outbox import OutboxEvent
from apps.courses.engagement.models import LectureComment
from apps.courses.models import Course, Lecture, LectureProgress, LiveClass, Section
from apps.notifications.models import Notification
from apps.realtime.models import ClassRecording, RealtimeSession
from apps.recording_uploads import services, storage, tokens
from apps.recording_uploads.media import MediaError, ProbeResult, parse_ffprobe_json
from apps.recording_uploads.models import RecordingUpload, RecordingUploadToken
from apps.users.models import User

R = ClassRecording
U = RecordingUpload
CHUNK = 1024
MKV_HEAD = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01" + b"matroska"
MP4_HEAD = b"\x00\x00\x00\x18ftypmp42"


def payload(size, head=MKV_HEAD):
    body = bytearray(head)
    seed = 7
    while len(body) < size:
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        body.append(seed & 0xFF)
    return bytes(body[:size])


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FakeRunner:
    """Injectable media runner (RECORDING_UPLOAD_MEDIA_RUNNER): no binary runs."""

    calls = []
    has_video = True
    remux_error = None

    def probe(self, path):
        FakeRunner.calls.append(("probe", Path(path).name))
        return ProbeResult(has_video=FakeRunner.has_video, duration_seconds=3600, format_name="matroska")

    def remux_to_mp4(self, source, output):
        FakeRunner.calls.append(("remux", Path(source).name))
        if FakeRunner.remux_error:
            raise MediaError(FakeRunner.remux_error)
        shutil.copyfile(source, output)
        return output


class UploadFixture:
    def build(self):
        cache.clear()
        FakeRunner.calls = []
        FakeRunner.has_video = True
        FakeRunner.remux_error = None
        self.media_root = tempfile.mkdtemp()
        self.staging_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media_root, True)
        self.addCleanup(shutil.rmtree, self.staging_root, True)
        overrides = override_settings(
            MEDIA_ROOT=self.media_root,
            RECORDING_UPLOAD_STAGING_ROOT=self.staging_root,
            RECORDING_UPLOAD_CHUNK_BYTES=CHUNK,
            RECORDING_UPLOAD_MAX_BYTES=64 * CHUNK,
            RECORDING_UPLOAD_MIN_FREE_BYTES=0,
            RECORDING_UPLOAD_MEDIA_RUNNER="tests.test_recording_uploads.FakeRunner",
            STREAM_RECORDER_MIN_FREE_BYTES=0,
            RECORDING_INSTANT_PUBLISH=True,
        )
        overrides.enable()
        self.addCleanup(overrides.disable)
        self.admin = User.objects.create_superuser(email="up-admin@test.com", password="StrongPass@123")
        self.instructor = User.objects.create_user(
            email="up-instructor@test.com", password="StrongPass@123", full_name="Instructor", role="instructor"
        )
        self.other_instructor = User.objects.create_user(
            email="up-other@test.com", password="StrongPass@123", full_name="Other", role="instructor"
        )
        self.student = User.objects.create_user(email="up-student@test.com", password="StrongPass@123")
        self.course = Course.objects.create(
            title="OSINT Batch", description="d", price=Decimal("1.00"), instructor=self.instructor, is_published=True
        )
        self.module = Section.objects.create(course=self.course, title="Recon", order=1)
        self.live_class = LiveClass.objects.create(
            title="Friday Live", description="Live", price=Decimal("0.00"), linked_course=self.course
        )
        self.session = self.make_session()
        self.client = APIClient()

    def make_session(self, **overrides):
        values = dict(
            title="Recon Class",
            host=self.instructor,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_ENDED,
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            linked_live_class=self.live_class,
            target_module=self.module,
            started_at=timezone.now() - timedelta(hours=2),
            ended_at=timezone.now() - timedelta(hours=1),
        )
        values.update(overrides)
        return RealtimeSession.objects.create(**values)

    def auto_recording(self, session=None, *, video_name="lecture_videos/osint/module_1/rec-auto.mp4"):
        session = session or self.session
        Path(self.media_root, video_name).parent.mkdir(parents=True, exist_ok=True)
        Path(self.media_root, video_name).write_bytes(MP4_HEAD + b"auto")
        lecture = Lecture(section=self.module, title="Recon Class - auto", order=5, is_published=True)
        lecture.video_file.name = video_name
        lecture._suppress_upload_notification = True
        lecture.save()
        return R.objects.create(
            session=session,
            module=self.module,
            lecture=lecture,
            source=R.SOURCE_SERVER,
            state=R.STATE_PUBLISHED,
            started_at=session.started_at,
        )

    # API helpers ---------------------------------------------------------
    def create(self, data, *, size=None, **extra):
        body = {"session_id": self.session.pk, "filename": "class.mkv", "size": size or len(data)}
        body.update(extra)
        return self.client.post(reverse("recording-uploads"), body, format="json")

    def put(self, upload_id, index, chunk, *, digest=True, **headers):
        if digest:
            headers.setdefault("HTTP_X_CHUNK_SHA256", sha(chunk))
        return self.client.put(
            reverse("recording-upload-chunk", args=[upload_id, index]),
            data=chunk,
            content_type="application/octet-stream",
            **headers,
        )

    def chunks(self, data):
        return [data[offset : offset + CHUNK] for offset in range(0, len(data), CHUNK)]

    def upload_all(self, data, order=None, **create_extra):
        response = self.create(data, **create_extra)
        self.assertIn(response.status_code, (200, 201), response.content)
        upload_id = response.data["data"]["id"]
        pieces = self.chunks(data)
        for index in order or range(len(pieces)):
            put = self.put(upload_id, index, pieces[index])
            self.assertEqual(put.status_code, 200, put.content)
        return upload_id

    def complete(self, upload_id):
        return self.client.post(reverse("recording-upload-complete", args=[upload_id]))

    def process(self, upload_id):
        with self.captureOnCommitCallbacks(execute=True):
            return services.process_upload(upload_id)


class ChunkedUploadApiTests(UploadFixture, TestCase):
    def setUp(self):
        self.build()
        self.client.force_authenticate(self.instructor)

    def test_create_resume_and_out_of_order_chunks(self):
        data = payload(3 * CHUNK + 100)
        created = self.create(data, sha256=sha(data))
        self.assertEqual(created.status_code, 201, created.content)
        info = created.data["data"]
        self.assertEqual((info["chunk_count"], info["chunk_bytes"], info["received_chunks"]), (4, CHUNK, []))
        pieces = self.chunks(data)
        for index in (3, 1):
            self.assertEqual(self.put(info["id"], index, pieces[index]).status_code, 200)
        # A refreshed tab / restarted uploader asks again for the same file: it resumes.
        resumed = self.create(data, sha256=sha(data))
        self.assertEqual(resumed.status_code, 200)
        self.assertEqual(resumed.data["data"]["id"], info["id"])
        self.assertEqual(resumed.data["data"]["received_chunks"], [1, 3])
        for index in (0, 2):
            ack = self.put(info["id"], index, pieces[index])
            self.assertEqual(ack.status_code, 200)
        self.assertTrue(ack.data["data"]["complete"])
        upload = U.objects.get(pk=info["id"])
        self.assertEqual((upload.received_count, upload.received_bytes), (4, len(data)))
        self.assertEqual(sorted(int(key) for key in upload.chunk_sha256), [0, 1, 2, 3])

    def test_different_checksum_or_name_starts_a_new_upload(self):
        data = payload(2 * CHUNK)
        first = self.create(data, sha256=sha(data)).data["data"]["id"]
        other = self.create(data, sha256=sha(b"other")).data["data"]["id"]
        renamed = self.create(data, filename="other.mkv").data["data"]["id"]
        self.assertEqual(len({first, other, renamed}), 3)

    def test_repeated_chunk_is_idempotent_and_conflicting_chunk_is_rejected(self):
        data = payload(2 * CHUNK)
        upload_id = self.create(data).data["data"]["id"]
        first = self.chunks(data)[0]
        self.assertFalse(self.put(upload_id, 0, first).data["data"]["duplicate"])
        again = self.put(upload_id, 0, first)
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.data["data"]["duplicate"])
        conflict = self.put(upload_id, 0, b"x" * CHUNK)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.data["errors"]["code"], "chunk_conflict")
        upload = U.objects.get(pk=upload_id)
        self.assertEqual((upload.received_count, upload.received_bytes), (1, CHUNK))
        self.assertEqual(storage.chunk_path(upload_id, 0).read_bytes(), first)
        self.assertEqual(list(storage.chunks_dir(upload_id).glob("*.part")), [])

    def test_chunk_checksum_mismatch_is_rejected_and_not_stored(self):
        data = payload(2 * CHUNK)
        upload_id = self.create(data).data["data"]["id"]
        response = self.put(upload_id, 0, self.chunks(data)[0], HTTP_X_CHUNK_SHA256=sha(b"different"))
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.data["errors"]["code"], "chunk_checksum_mismatch")
        self.assertEqual(U.objects.get(pk=upload_id).received_count, 0)
        self.assertFalse(storage.chunk_path(upload_id, 0).exists())
        self.assertEqual(list(storage.chunks_dir(upload_id).iterdir()), [])

    def test_chunk_size_and_range_are_enforced(self):
        data = payload(2 * CHUNK + 10)
        upload_id = self.create(data).data["data"]["id"]
        short = self.put(upload_id, 0, b"a" * (CHUNK - 1))
        self.assertEqual((short.status_code, short.data["errors"]["code"]), (400, "chunk_size_mismatch"))
        last_wrong = self.put(upload_id, 2, b"a" * CHUNK)
        self.assertEqual(last_wrong.data["errors"]["expected_bytes"], 10)
        out_of_range = self.put(upload_id, 3, b"a" * 10)
        self.assertEqual(out_of_range.status_code, 416)
        too_big = self.put(upload_id, 0, b"a" * (CHUNK + 1))
        self.assertEqual(too_big.status_code, 413)

    def test_complete_requires_every_chunk(self):
        data = payload(3 * CHUNK)
        upload_id = self.create(data).data["data"]["id"]
        self.put(upload_id, 1, self.chunks(data)[1])
        response = self.complete(upload_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["errors"]["missing_chunks"], [0, 2])
        self.assertEqual(U.objects.get(pk=upload_id).status, U.STATUS_UPLOADING)

    def test_concurrent_complete_queues_one_job(self):
        data = payload(2 * CHUNK)
        upload_id = self.upload_all(data)
        first = self.complete(upload_id)
        second = self.complete(upload_id)
        self.assertEqual((first.status_code, second.status_code), (202, 202))
        self.assertEqual(second.data["data"]["status"], U.STATUS_QUEUED)
        self.assertEqual(OutboxEvent.objects.filter(event_type=services.ASSEMBLE_EVENT).count(), 1)
        # No chunk is accepted once complete was requested.
        late = self.put(upload_id, 0, self.chunks(data)[0])
        self.assertEqual((late.status_code, late.data["errors"]["code"]), (409, "not_uploading"))

    def test_abort_removes_the_staged_chunks(self):
        data = payload(2 * CHUNK)
        upload_id = self.create(data).data["data"]["id"]
        self.put(upload_id, 0, self.chunks(data)[0])
        self.assertTrue(storage.upload_dir(upload_id).exists())
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(reverse("recording-upload-detail", args=[upload_id]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["data"]["status"], U.STATUS_ABORTED)
        self.assertFalse(storage.upload_dir(upload_id).exists())
        self.assertEqual(self.put(upload_id, 1, self.chunks(data)[1]).status_code, 409)

    def test_oversize_file_is_refused(self):
        response = self.create(b"", size=64 * CHUNK + 1)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.data["errors"]["code"], "file_too_large")
        self.assertFalse(U.objects.exists())

    def test_path_traversal_in_the_file_name_never_reaches_the_disk(self):
        for raw, expected in (
            ("../../etc/cron.d/evil.mkv", "evil.mkv"),
            ("..\\..\\Windows\\obs 2026-11-14.mkv", "obs 2026-11-14.mkv"),
            ("C:\\Users\\host\\Videos\\class.php.mp4", "class_php.mp4"),
        ):
            response = self.create(payload(CHUNK), filename=raw, size=CHUNK)
            self.assertEqual(response.status_code, 201, response.content)
            self.assertEqual(response.data["data"]["filename"], expected)
            directory = storage.upload_dir(response.data["data"]["id"])
            self.assertTrue(str(directory.resolve()).startswith(str(Path(self.staging_root).resolve())))
        for bad in ("payload.exe", "../../.mkv", "noextension", ""):
            response = self.create(payload(CHUNK), filename=bad or "x", size=CHUNK) if bad else self.create(
                payload(CHUNK), filename=" ", size=CHUNK
            )
            self.assertEqual(response.status_code, 400, bad)
        self.assertEqual(os.listdir(self.media_root), [])

    def test_upload_ids_that_are_not_uuids_are_not_routed(self):
        response = self.client.put(
            "/api/recording-uploads/..%2F..%2Fetc/chunks/0/", data=b"x", content_type="application/octet-stream"
        )
        self.assertEqual(response.status_code, 404)

    def test_quota_of_unfinished_uploads(self):
        with override_settings(RECORDING_UPLOAD_MAX_ACTIVE_PER_USER=2):
            for name in ("a.mkv", "b.mkv"):
                self.assertEqual(self.create(payload(CHUNK), filename=name, size=CHUNK).status_code, 201)
            refused = self.create(payload(CHUNK), filename="c.mkv", size=CHUNK)
        self.assertEqual((refused.status_code, refused.data["errors"]["code"]), (429, "too_many_uploads"))
        with override_settings(RECORDING_UPLOAD_MAX_ACTIVE_BYTES_PER_USER=3 * CHUNK):
            refused = self.create(payload(2 * CHUNK), filename="d.mkv", size=2 * CHUNK)
        self.assertEqual(refused.data["errors"]["code"], "upload_quota_exceeded")

    def test_not_enough_disk_space_is_507(self):
        with patch("apps.recording_uploads.storage.free_bytes", return_value=10):
            response = self.create(payload(CHUNK), size=CHUNK)
        self.assertEqual((response.status_code, response.data["errors"]["code"]), (507, "insufficient_storage"))

    def test_only_moderators_of_the_class_may_upload(self):
        self.client.force_authenticate(self.student)
        self.assertEqual(self.create(payload(CHUNK)).status_code, 403)
        self.client.force_authenticate(self.other_instructor)
        response = self.create(payload(CHUNK))
        self.assertEqual((response.status_code, response.data["errors"]["code"]), (403, "session_forbidden"))
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.create(payload(CHUNK)).status_code, 201)

    def test_another_users_upload_is_invisible(self):
        upload_id = self.create(payload(2 * CHUNK)).data["data"]["id"]
        self.client.force_authenticate(self.other_instructor)
        self.assertEqual(self.client.get(reverse("recording-upload-detail", args=[upload_id])).status_code, 404)
        self.assertEqual(self.put(upload_id, 0, payload(CHUNK)).status_code, 404)
        self.assertEqual(self.complete(upload_id).status_code, 404)

    def test_class_without_course_is_refused_up_front(self):
        self.session = self.make_session(linked_live_class=None, target_module=None)
        response = self.create(payload(CHUNK))
        self.assertEqual((response.status_code, response.data["errors"]["code"]), (400, "session_without_course"))

    def test_targets_list_says_replace_or_create(self):
        self.auto_recording()
        fresh = self.make_session(title="Dorking Class", started_at=timezone.now() - timedelta(minutes=30))
        response = self.client.get(reverse("recording-upload-targets"))
        self.assertEqual(response.status_code, 200)
        by_id = {item["session_id"]: item for item in response.data["data"]}
        self.assertEqual(by_id[self.session.pk]["action"], "replaced")
        self.assertEqual(by_id[fresh.pk]["action"], "created")
        self.assertEqual(by_id[fresh.pk]["module_title"], "Recon")
        latest = self.client.get(reverse("recording-upload-targets"), {"latest": "1"}).data["data"]
        self.assertEqual([item["session_id"] for item in latest], [fresh.pk])


class FirewallAndCsrfTests(UploadFixture, TestCase):
    def setUp(self):
        self.build()

    def test_chunk_body_is_not_inspected_but_its_query_string_is(self):
        self.client.force_authenticate(self.instructor)
        data = (b"<script>alert(1)</script> UNION SELECT password FROM users --" * 40)[:CHUNK]
        upload_id = self.create(payload(CHUNK), size=CHUNK).data["data"]["id"]
        with override_settings(SECURITY_MAX_INSPECTION_BODY_BYTES=10 * CHUNK):
            stored = self.put(upload_id, 0, data)
            self.assertEqual(stored.status_code, 200, stored.content)
            blocked = self.client.put(
                reverse("recording-upload-chunk", args=[upload_id, 0]) + "?x=<script>alert(1)</script>",
                data=data,
                content_type="application/octet-stream",
            )
        self.assertEqual(blocked.status_code, 400)
        self.assertEqual(blocked.json()["message"], "Request blocked by security policy.")

    def test_cookie_session_needs_the_csrf_token(self):
        from apps.users.terms import TERMS_VERSION

        User.objects.filter(pk=self.instructor.pk).update(terms_accepted_version=TERMS_VERSION)
        browser = APIClient(enforce_csrf_checks=True)
        csrf = browser.get(reverse("auth-csrf")).data["csrf_token"]
        login = browser.post(
            reverse("auth-login"),
            {"email": "up-instructor@test.com", "password": "StrongPass@123"},
            format="json",
            HTTP_X_CSRFTOKEN=csrf,
        )
        self.assertEqual(login.status_code, 200, login.content)
        body = {"session_id": self.session.pk, "filename": "class.mkv", "size": CHUNK}
        blocked = browser.post(reverse("recording-uploads"), body, format="json")
        self.assertEqual(blocked.status_code, 403)
        csrf = browser.cookies["csrftoken"].value
        allowed = browser.post(reverse("recording-uploads"), body, format="json", HTTP_X_CSRFTOKEN=csrf)
        self.assertEqual(allowed.status_code, 201, allowed.content)


class UploadTokenTests(UploadFixture, TestCase):
    def setUp(self):
        self.build()

    def new_token(self, user=None, **extra):
        self.client.force_authenticate(user or self.instructor)
        response = self.client.post(reverse("recording-upload-tokens"), {"name": "Laptop OBS", **extra}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        self.client.force_authenticate(None)
        return response.data["data"]

    def as_token(self, raw):
        self.client = APIClient()
        self.client.credentials(HTTP_X_UPLOAD_TOKEN=raw)

    def test_token_is_shown_once_and_stored_hashed(self):
        created = self.new_token()
        raw = created["token"]
        self.assertTrue(raw.startswith("asu_"))
        row = RecordingUploadToken.objects.get(pk=created["id"])
        self.assertEqual(row.token_hash, hashlib.sha256(raw.encode()).hexdigest())
        self.assertNotIn(raw, str(RecordingUploadToken.objects.values_list()))
        self.client.force_authenticate(self.instructor)
        listed = self.client.get(reverse("recording-upload-tokens")).data["data"]
        self.assertEqual([item["prefix"] for item in listed], [raw[:12]])
        self.assertNotIn("token", listed[0])

    def test_token_uploads_end_to_end_without_cookies_or_csrf(self):
        raw = self.new_token()["token"]
        self.client = APIClient(enforce_csrf_checks=True)
        self.client.credentials(HTTP_X_UPLOAD_TOKEN=raw)
        data = payload(2 * CHUNK + 5)
        # No session_id: attached to the host's latest class.
        created = self.client.post(
            reverse("recording-uploads"), {"filename": "2026-11-14 19-00-01.mkv", "size": len(data)}, format="json"
        )
        self.assertEqual(created.status_code, 201, created.content)
        self.assertEqual(created.data["data"]["session_id"], self.session.pk)
        self.assertTrue(created.data["data"]["via_token"])
        upload_id = created.data["data"]["id"]
        for index, chunk in enumerate(self.chunks(data)):
            self.assertEqual(self.put(upload_id, index, chunk).status_code, 200)
        self.assertEqual(self.complete(upload_id).status_code, 202)
        upload = self.process(upload_id)
        self.assertEqual((upload.status, upload.action), (U.STATUS_COMPLETED, U.ACTION_CREATED))
        self.assertIsNotNone(RecordingUploadToken.objects.get(owner=self.instructor).last_used_at)

    def test_token_cannot_manage_tokens_or_reach_other_apis(self):
        raw = self.new_token()["token"]
        self.as_token(raw)
        self.assertIn(self.client.get(reverse("recording-upload-tokens")).status_code, (401, 403))
        self.assertIn(
            self.client.post(reverse("recording-upload-tokens"), {"name": "more"}, format="json").status_code, (401, 403)
        )
        self.assertIn(self.client.get(reverse("auth-user")).status_code, (401, 403))
        self.assertEqual(RecordingUploadToken.objects.count(), 1)

    def test_revoked_or_expired_token_is_rejected(self):
        created = self.new_token()
        self.as_token(created["token"])
        self.assertEqual(self.client.get(reverse("recording-upload-targets")).status_code, 200)
        self.client.force_authenticate(self.instructor)
        revoked = self.client.delete(reverse("recording-upload-token-detail", args=[created["id"]]))
        self.assertEqual(revoked.status_code, 200)
        self.assertFalse(revoked.data["data"]["active"])
        self.as_token(created["token"])
        self.assertEqual(self.client.get(reverse("recording-upload-targets")).status_code, 401)

        expiring = self.new_token(expires_in_days=1)
        RecordingUploadToken.objects.filter(pk=expiring["id"]).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.as_token(expiring["token"])
        self.assertEqual(self.client.get(reverse("recording-upload-targets")).status_code, 401)
        self.as_token("asu_" + "x" * 43)
        self.assertEqual(self.client.get(reverse("recording-upload-targets")).status_code, 401)

    def test_token_of_a_demoted_user_stops_working(self):
        raw = self.new_token()["token"]
        User.objects.filter(pk=self.instructor.pk).update(role=User.ROLE_STUDENT)
        self.as_token(raw)
        self.assertEqual(self.client.get(reverse("recording-upload-targets")).status_code, 401)

    def test_students_cannot_create_tokens_and_cannot_revoke_others(self):
        self.client.force_authenticate(self.student)
        self.assertEqual(
            self.client.post(reverse("recording-upload-tokens"), {"name": "x"}, format="json").status_code, 403
        )
        created = self.new_token()
        self.client.force_authenticate(self.other_instructor)
        self.assertEqual(self.client.delete(reverse("recording-upload-token-detail", args=[created["id"]])).status_code, 404)
        self.assertIsNone(RecordingUploadToken.objects.get(pk=created["id"]).revoked_at)

    def test_token_cannot_touch_classes_its_owner_does_not_moderate(self):
        raw = self.new_token(user=self.other_instructor)["token"]
        self.as_token(raw)
        response = self.create(payload(CHUNK))
        self.assertEqual(response.status_code, 403)


class ProcessingTests(UploadFixture, TestCase):
    def setUp(self):
        self.build()
        self.client.force_authenticate(self.instructor)

    def finished(self, data, **extra):
        upload_id = self.upload_all(data, order=list(reversed(range(len(self.chunks(data))))), **extra)
        self.assertEqual(self.complete(upload_id).status_code, 202)
        return upload_id

    def test_replaces_the_auto_recording_and_keeps_the_lecture(self):
        auto = self.auto_recording()
        lecture = auto.lecture
        LectureProgress.objects.create(user=self.student, lecture=lecture, last_position_seconds=600)
        LectureComment.objects.create(lecture=lecture, user=self.student, body="Great class")
        notifications_before = Notification.objects.count()
        data = payload(3 * CHUNK + 1)
        upload_id = self.finished(data, sha256=sha(data))

        upload = self.process(upload_id)

        self.assertEqual((upload.status, upload.action), (U.STATUS_COMPLETED, U.ACTION_REPLACED), upload.error)
        lecture.refresh_from_db()
        self.assertEqual(upload.lecture_id, lecture.pk)
        self.assertEqual(lecture.video_file.name, upload.video_name)
        self.assertTrue(lecture.video_file.name.endswith(".mp4"))
        self.assertEqual(Path(self.media_root, lecture.video_file.name).read_bytes(), data)
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED)
        self.assertTrue(lecture.is_published)
        # Students' progress and comments stay with the same lecture; nobody is notified again.
        self.assertEqual(LectureProgress.objects.get(user=self.student).lecture_id, lecture.pk)
        self.assertEqual(LectureComment.objects.get().lecture_id, lecture.pk)
        self.assertEqual(Notification.objects.count(), notifications_before)
        # The replaced file is kept so an admin can switch back.
        self.assertEqual(upload.previous_video_name, "lecture_videos/osint/module_1/rec-auto.mp4")
        self.assertTrue(default_storage.exists(upload.previous_video_name))
        self.assertEqual(upload.replaced_recording_id, auto.pk)
        recording = upload.recording
        self.assertEqual((recording.source, recording.state), (R.SOURCE_OBS_UPLOAD, R.STATE_PROCESSING))
        self.assertEqual((recording.lecture_id, recording.duration_seconds), (lecture.pk, 3600))
        self.assertEqual(upload.computed_sha256, sha(data))
        self.assertFalse(storage.upload_dir(upload_id).exists())
        self.assertEqual([call[0] for call in FakeRunner.calls], ["probe", "remux"])

    def test_creates_and_publishes_the_lecture_when_there_is_no_recording(self):
        data = payload(2 * CHUNK)
        upload = self.process(self.finished(data))
        self.assertEqual((upload.status, upload.action), (U.STATUS_COMPLETED, U.ACTION_CREATED), upload.error)
        lecture = upload.lecture
        self.assertEqual(lecture.section_id, self.module.pk)
        self.assertTrue(lecture.is_published)
        self.assertEqual(lecture.title, f"Recon Class - {timezone.localtime(self.session.started_at):%d %b %Y}")
        self.assertEqual(upload.previous_video_name, "")
        self.assertFalse(upload.recording.needs_review)
        response = self.client.get(reverse("recording-upload-detail", args=[upload.pk]))
        result = response.data["data"]["result"]
        self.assertEqual(result["learn_url"], f"/learn/{self.course.pk}?lecture={lecture.pk}")
        self.assertFalse(result["can_switch_back"])

    def test_derived_module_is_flagged_for_review(self):
        self.session.target_module = None
        self.session.save(update_fields=["target_module"])
        upload = self.process(self.finished(payload(CHUNK)))
        self.assertEqual(upload.lecture.section.title, "Class recordings")
        self.assertTrue(upload.recording.needs_review)

    def test_second_upload_replaces_the_first_upload(self):
        first = self.process(self.finished(payload(CHUNK)))
        data = payload(CHUNK, head=MP4_HEAD)
        second = self.process(self.finished(data, filename="better.mp4"))
        self.assertEqual(second.action, U.ACTION_REPLACED)
        self.assertEqual(second.lecture_id, first.lecture_id)
        self.assertEqual(second.previous_video_name, first.video_name)
        self.assertEqual(Lecture.objects.filter(section=self.module).count(), 1)

    def test_waits_for_the_auto_recording_instead_of_making_a_second_lecture(self):
        capturing = R.objects.create(session=self.session, source=R.SOURCE_SERVER, state=R.STATE_FINALIZING)
        upload_id = self.finished(payload(CHUNK))
        upload = self.process(upload_id)
        self.assertEqual(upload.status, U.STATUS_QUEUED)
        self.assertIsNotNone(upload.waiting_since)
        self.assertEqual(
            OutboxEvent.objects.filter(event_type=services.ASSEMBLE_EVENT).count(), 2, "a delayed re-check is queued"
        )
        self.assertTrue(self.client.get(reverse("recording-upload-detail", args=[upload_id])).data["data"]["waiting_for_auto_recording"])
        # The auto-recording gets its lecture: the upload replaces it.
        auto = self.auto_recording()
        capturing.delete()
        upload = self.process(upload_id)
        self.assertEqual((upload.status, upload.action, upload.lecture_id), (U.STATUS_COMPLETED, U.ACTION_REPLACED, auto.lecture_id))

    def test_gives_up_waiting_after_the_limit(self):
        R.objects.create(session=self.session, source=R.SOURCE_SERVER, state=R.STATE_RECORDING)
        upload_id = self.finished(payload(CHUNK))
        U.objects.filter(pk=upload_id).update(waiting_since=timezone.now() - timedelta(hours=4))
        upload = self.process(upload_id)
        self.assertEqual((upload.status, upload.action), (U.STATUS_COMPLETED, U.ACTION_CREATED))

    def test_whole_file_checksum_mismatch_fails_and_cleans_up(self):
        data = payload(2 * CHUNK)
        upload_id = self.finished(data, sha256=sha(b"what the laptop had"))
        upload = self.process(upload_id)
        self.assertEqual(upload.status, U.STATUS_FAILED)
        self.assertIn("SHA-256 mismatch", upload.error)
        self.assertFalse(storage.upload_dir(upload_id).exists())
        self.assertFalse(Lecture.objects.filter(section=self.module).exists())
        self.assertFalse(R.objects.filter(source=R.SOURCE_OBS_UPLOAD).exists())

    def test_tampered_chunk_on_disk_fails_assembly(self):
        data = payload(2 * CHUNK)
        upload_id = self.finished(data)
        storage.chunk_path(upload_id, 1).write_bytes(b"z" * CHUNK)
        upload = self.process(upload_id)
        self.assertEqual(upload.status, U.STATUS_FAILED)
        self.assertIn("Chunk 1 changed", upload.error)

    def test_file_that_is_not_the_declared_container_fails(self):
        upload = self.process(self.finished(payload(CHUNK, head=b"MZ\x90\x00not-a-video")))
        self.assertEqual(upload.status, U.STATUS_FAILED)
        self.assertIn("MKV", upload.error)

    def test_file_without_video_fails(self):
        FakeRunner.has_video = False
        upload = self.process(self.finished(payload(CHUNK)))
        self.assertEqual((upload.status, upload.error), (U.STATUS_FAILED, "The file has no video track."))

    def test_remux_failure_fails_without_touching_the_lecture(self):
        auto = self.auto_recording()
        FakeRunner.remux_error = "Invalid data found when processing input"
        upload = self.process(self.finished(payload(CHUNK)))
        self.assertEqual(upload.status, U.STATUS_FAILED)
        auto.lecture.refresh_from_db()
        self.assertEqual(auto.lecture.video_file.name, "lecture_videos/osint/module_1/rec-auto.mp4")
        leftovers = [name for _root, _dirs, files in os.walk(self.media_root) for name in files if "upload-" in name]
        self.assertEqual(leftovers, [])
        self.assertFalse(R.objects.filter(source=R.SOURCE_OBS_UPLOAD).exists())

    def test_worker_is_idempotent_and_respects_the_lease(self):
        upload_id = self.finished(payload(CHUNK))
        U.objects.filter(pk=upload_id).update(
            status=U.STATUS_ASSEMBLING, lease_until=timezone.now() + timedelta(minutes=5)
        )
        with self.assertRaises(services.UploadBusy):
            services.process_upload(upload_id)
        # The other worker died: its lease runs out and the next delivery takes over.
        U.objects.filter(pk=upload_id).update(lease_until=timezone.now() - timedelta(seconds=1))
        upload = self.process(upload_id)
        self.assertEqual(upload.status, U.STATUS_COMPLETED)
        again = self.process(upload_id)
        self.assertEqual(again.status, U.STATUS_COMPLETED)
        self.assertEqual(Lecture.objects.filter(section=self.module).count(), 1)
        self.assertEqual(R.objects.filter(source=R.SOURCE_OBS_UPLOAD).count(), 1)

    def test_unexpected_error_releases_the_lease_for_a_retry(self):
        upload_id = self.finished(payload(CHUNK))
        with patch("apps.recording_uploads.services._publish", side_effect=RuntimeError("database went away")):
            with self.assertRaises(RuntimeError):
                services.process_upload(upload_id)
        upload = U.objects.get(pk=upload_id)
        self.assertEqual((upload.status, upload.lease_until), (U.STATUS_ASSEMBLING, None))
        self.assertEqual(self.process(upload_id).status, U.STATUS_COMPLETED)

    def test_outbox_handler_runs_the_worker(self):
        from apps.core.outbox import drain_outbox

        upload_id = self.finished(payload(CHUNK))
        with self.captureOnCommitCallbacks(execute=True):
            drain_outbox(batch_size=10)
        self.assertEqual(U.objects.get(pk=upload_id).status, U.STATUS_COMPLETED)


class SwitchBackAndCleanupTests(UploadFixture, TestCase):
    def setUp(self):
        self.build()
        self.client.force_authenticate(self.instructor)
        self.auto = self.auto_recording()
        upload_id = self.upload_all(payload(CHUNK))
        self.complete(upload_id)
        self.upload = self.process(upload_id)

    def switch(self, restore=False):
        return self.client.post(
            reverse("recording-upload-switch-video", args=[self.upload.pk]), {"restore_upload": restore}, format="json"
        )

    def test_admin_switches_back_and_forth(self):
        self.assertEqual(self.switch().status_code, 403)  # instructors cannot
        self.client.force_authenticate(self.admin)
        back = self.switch()
        self.assertEqual(back.status_code, 200, back.content)
        lecture = Lecture.objects.get(pk=self.auto.lecture_id)
        self.assertEqual(lecture.video_file.name, "lecture_videos/osint/module_1/rec-auto.mp4")
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED)
        self.assertTrue(back.data["data"]["result"]["reverted"])
        self.assertEqual(self.switch().status_code, 409)
        forth = self.switch(restore=True)
        self.assertEqual(forth.status_code, 200)
        lecture.refresh_from_db()
        self.assertTrue(lecture.video_file.name.startswith("lecture_videos/"))
        self.assertIn("/upload-", lecture.video_file.name)

    def test_switch_refuses_when_the_lecture_changed_meanwhile(self):
        Lecture.objects.filter(pk=self.auto.lecture_id).update(video_file="lecture_videos/manual.mp4")
        self.client.force_authenticate(self.admin)
        response = self.switch()
        self.assertEqual((response.status_code, response.data["errors"]["code"]), (409, "lecture_changed"))

    def test_cleanup_deletes_the_replaced_video_after_retention_only(self):
        previous = self.upload.previous_video_name
        services.cleanup()
        self.assertTrue(default_storage.exists(previous))
        later = timezone.now() + timedelta(days=15)
        stats = services.cleanup(now=later)
        self.assertEqual(stats["previous_deleted"], 1)
        self.assertFalse(default_storage.exists(previous))
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.switch().status_code, 410)

    def test_cleanup_never_deletes_a_file_a_lecture_uses(self):
        self.client.force_authenticate(self.admin)
        self.switch()  # the auto-recording is the lecture's video again; the upload is now "previous"
        self.upload.refresh_from_db()
        Lecture.objects.filter(pk=self.auto.lecture_id).update(video_file=self.upload.previous_video_name)
        services.cleanup(now=timezone.now() + timedelta(days=15))
        self.assertTrue(default_storage.exists(self.upload.previous_video_name))

    def test_cleanup_expires_stale_uploads_and_removes_orphans(self):
        stale_id = self.create(payload(2 * CHUNK), filename="stale.mkv").data["data"]["id"]
        self.put(stale_id, 0, self.chunks(payload(2 * CHUNK))[0])
        U.objects.filter(pk=stale_id).update(expires_at=timezone.now() - timedelta(minutes=1))
        live_id = self.create(payload(2 * CHUNK), filename="live.mkv").data["data"]["id"]
        old_part = storage.chunks_dir(live_id) / "000001.abc.part"
        old_part.write_bytes(b"x")
        os.utime(old_part, (0, 0))
        orphan = Path(self.staging_root) / str(uuid.uuid4())
        orphan.mkdir()
        os.utime(orphan, (0, 0))
        stranger = Path(self.staging_root) / "not-a-uuid"
        stranger.mkdir()
        stats = services.cleanup()
        self.assertEqual(U.objects.get(pk=stale_id).status, U.STATUS_EXPIRED)
        self.assertFalse(storage.upload_dir(stale_id).exists())
        self.assertFalse(orphan.exists())
        self.assertTrue(stranger.exists(), "only upload directories are ever removed")
        self.assertFalse(old_part.exists())
        self.assertTrue(storage.upload_dir(live_id).exists())
        self.assertGreaterEqual(stats["expired"], 1)
        expired_put = self.put(stale_id, 1, self.chunks(payload(2 * CHUNK))[1])
        self.assertEqual(expired_put.status_code, 409)

    def test_periodic_hook_publishes_one_cleanup_event_per_interval(self):
        from apps.recording_uploads.outbox_handlers import schedule_cleanup

        schedule_cleanup()
        schedule_cleanup()
        self.assertEqual(OutboxEvent.objects.filter(event_type=services.CLEANUP_EVENT).count(), 1)


class MediaRunnerTests(TestCase):
    def test_ffprobe_json_is_parsed(self):
        result = parse_ffprobe_json(
            '{"streams":[{"codec_type":"audio"},{"codec_type":"video"}],"format":{"duration":"3599.6","format_name":"matroska,webm"}}'
        )
        self.assertEqual(result, ProbeResult(True, 3600, "matroska,webm"))
        self.assertFalse(parse_ffprobe_json('{"streams":[{"codec_type":"audio"}],"format":{}}').has_video)
        with self.assertRaises(MediaError):
            parse_ffprobe_json("not json")

    def test_ffmpeg_runner_builds_a_stream_copy_faststart_remux(self):
        from apps.realtime.recording import ffmpeg
        from apps.recording_uploads.media import FFmpegMediaRunner

        command = ffmpeg.build_remux_command("in.mkv", "out.mp4")
        self.assertIn("copy", command)
        self.assertIn("+faststart", command)
        probe = FFmpegMediaRunner().probe_command("in.mkv")
        self.assertEqual(probe[-3:], ["-of", "json", "in.mkv"])

    def test_staging_root_inside_media_root_is_a_system_check_error(self):
        from apps.recording_uploads.checks import check_recording_upload_settings

        with override_settings(RECORDING_UPLOAD_STAGING_ROOT=str(Path(settings.MEDIA_ROOT) / "staging")):
            ids = [problem.id for problem in check_recording_upload_settings(None)]
        self.assertIn("recording_uploads.E001", ids)


class TokenHelperTests(TestCase):
    def test_lookup_rejects_wrong_prefix_and_overlong_values(self):
        self.assertIsNone(tokens.lookup("Bearer something"))
        self.assertIsNone(tokens.lookup("asu_" + "a" * 200))
