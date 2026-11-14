"""WS-G: one recordings list over ClassRecording + RealtimeSessionRecording +
RecordingUpload, its filters, paging, review panel detail and actions."""

from __future__ import annotations

from datetime import timedelta

from django.contrib.admin.models import LogEntry
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.courses.models import Lecture
from apps.realtime.models import RealtimeSessionRecording
from apps.realtime.recording.models import ClassRecording
from apps.recording_uploads.models import RecordingUpload
from tests.factories import make_admin, make_lecture, make_realtime_session, make_section, make_user

URL = "/api/admin/recordings/"


class AdminRecordingsTests(APITestCase):
    def setUp(self):
        self.admin = make_admin()
        self.client.force_authenticate(self.admin)
        now = timezone.now()
        self.session = make_realtime_session(title="Recon class")
        self.module = make_section()
        self.lecture = make_lecture(section=self.module, title="Recon class - 10 Nov", is_published=True)
        self.review = ClassRecording.objects.create(
            source=ClassRecording.SOURCE_SERVER,
            state=ClassRecording.STATE_PUBLISHED,
            session=self.session,
            module=self.module,
            lecture=self.lecture,
            needs_review=True,
            review_reason="Module chosen automatically.",
        )
        self.failed = ClassRecording.objects.create(source=ClassRecording.SOURCE_SERVER, state=ClassRecording.STATE_FAILED, error="ffmpeg")
        self.processing = ClassRecording.objects.create(source=ClassRecording.SOURCE_SERVER, state=ClassRecording.STATE_PROCESSING)
        # A raw egress recording already turned into a class recording is not listed twice.
        linked = RealtimeSessionRecording.objects.create(session=self.session, status=RealtimeSessionRecording.STATUS_COMPLETED)
        ClassRecording.objects.filter(pk=self.processing.pk).update(livekit_recording=linked)
        self.raw_failed = RealtimeSessionRecording.objects.create(session=self.session, status=RealtimeSessionRecording.STATUS_FAILED)
        upload = dict(owner=make_user(), extension="mkv", total_bytes=2048, chunk_bytes=1024, chunk_count=2, expires_at=now + timedelta(days=1))
        self.upload_failed = RecordingUpload.objects.create(filename="failed.mkv", status=RecordingUpload.STATUS_FAILED, **upload)
        self.upload_done = RecordingUpload.objects.create(filename="done.mkv", status=RecordingUpload.STATUS_COMPLETED, **upload)
        RecordingUpload.objects.create(filename="cancelled.mkv", status=RecordingUpload.STATUS_ABORTED, **upload)
        # Spread creation times so the merged order is deterministic.
        for offset, (model, pk) in enumerate(
            [
                (ClassRecording, self.review.pk),
                (ClassRecording, self.failed.pk),
                (ClassRecording, self.processing.pk),
                (RealtimeSessionRecording, self.raw_failed.pk),
                (RecordingUpload, self.upload_failed.pk),
                (RecordingUpload, self.upload_done.pk),
            ]
        ):
            model.objects.filter(pk=pk).update(created_at=now - timedelta(minutes=10 * offset))

    def ids(self, **params):
        response = self.client.get(URL, params)
        self.assertEqual(response.status_code, 200, response.content)
        return [row["id"] for row in response.json()["data"]["results"]]

    def test_one_list_over_three_models_newest_first(self):
        self.assertEqual(
            self.ids(),
            [
                f"cr_{self.review.pk}",
                f"cr_{self.failed.pk}",
                f"cr_{self.processing.pk}",
                f"sr_{self.raw_failed.pk}",
                f"up_{self.upload_failed.pk}",
                f"up_{self.upload_done.pk}",
            ],
        )

    def test_filters_and_counts(self):
        self.assertEqual(self.ids(filter="needs_review"), [f"cr_{self.review.pk}"])
        self.assertEqual(self.ids(filter="failed"), [f"cr_{self.failed.pk}", f"sr_{self.raw_failed.pk}", f"up_{self.upload_failed.pk}"])
        self.assertEqual(self.ids(filter="published"), [f"cr_{self.review.pk}", f"up_{self.upload_done.pk}"])
        self.assertEqual(self.ids(filter="processing"), [f"cr_{self.processing.pk}"])
        data = self.client.get(URL).json()["data"]
        self.assertEqual(data["counts"], {"needs_review": 1, "failed": 3, "processing": 1, "published": 2})
        self.assertEqual(data["count"], 6)

    def test_paging_across_sources(self):
        page1 = self.ids(page_size=4)
        page2 = self.ids(page_size=4, page=2)
        self.assertEqual(len(page1), 4)
        self.assertEqual(page2, [f"up_{self.upload_failed.pk}", f"up_{self.upload_done.pk}"])

    def test_item_shape_and_detail(self):
        row = self.client.get(URL, {"filter": "needs_review"}).json()["data"]["results"][0]
        self.assertEqual(row["status"], "published")
        self.assertTrue(row["needs_review"])
        self.assertEqual(row["title"], "Recon class - 10 Nov")
        self.assertEqual(row["actions"], {"publish": False, "unpublish": True, "mark_reviewed": True, "retry": False})
        self.assertTrue(row["links"]["back_office"].endswith(f"/realtime/classrecording/{self.review.pk}/change/"))
        detail = self.client.get(f"{URL}cr_{self.review.pk}/").json()["data"]
        self.assertEqual(detail["id"], f"cr_{self.review.pk}")
        self.assertEqual(detail["media_url"], "")  # no file on disk in tests
        upload = self.client.get(f"{URL}up_{self.upload_failed.pk}/").json()["data"]
        self.assertEqual(upload["status"], "failed")
        for missing in ("cr_999999", "up_not-a-uuid", "xx_1", "sr_abc"):
            with self.subTest(missing=missing):
                self.assertEqual(self.client.get(f"{URL}{missing}/").status_code, 404)

    def test_mark_reviewed_and_unpublish(self):
        url = f"{URL}cr_{self.review.pk}/actions/"
        response = self.client.post(url, {"action": "mark_reviewed"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["message"], "Marked as reviewed.")
        self.review.refresh_from_db()
        self.assertFalse(self.review.needs_review)
        self.assertEqual(self.client.get(URL, {"filter": "needs_review"}).json()["data"]["results"], [])
        response = self.client.post(url, {"action": "unpublish"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(Lecture.objects.get(pk=self.lecture.pk).is_published)
        self.assertTrue(response.json()["data"]["item"]["actions"]["publish"])
        self.assertEqual(LogEntry.objects.filter(object_id=str(self.review.pk)).count(), 2)

    def test_invalid_actions(self):
        self.assertEqual(self.client.post(f"{URL}cr_{self.processing.pk}/actions/", {"action": "retry"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(f"{URL}cr_{self.review.pk}/actions/", {"action": "delete"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(f"{URL}up_{self.upload_failed.pk}/actions/", {"action": "publish"}, format="json").status_code, 400)

    def test_staff_only(self):
        self.client.force_authenticate(make_user())
        self.assertEqual(self.client.get(URL).status_code, 403)
        self.assertEqual(self.client.post(f"{URL}cr_{self.review.pk}/actions/", {"action": "mark_reviewed"}, format="json").status_code, 403)
