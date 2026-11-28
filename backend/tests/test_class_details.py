"""Class details: the topic, description and module a recorded class is published with.

A calendar class is created as "OSINT Batch IV · Friday 27 Nov" with no module
and no description, so its recording used to land as
"OSINT Batch IV · Friday 27 Nov - 27 Nov 2026" in "Class recordings" with a
generic description. The host now gives the class its details (before, during
or after the class) and the recorded lecture carries them.
"""

from datetime import timedelta
from unittest.mock import MagicMock

from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.courses.models import Lecture, Section
from apps.realtime.models import ClassRecording, RealtimeSession
from apps.realtime.recording import modules, publisher, services
from apps.realtime.recording.recorder import StreamRecorder
from tests.test_class_recordings import RecordingFixtureMixin

R = ClassRecording


class ClassDetailsTests(RecordingFixtureMixin, APITestCase):
    def setUp(self):
        self.build_fixture()
        # A calendar class: no module chosen, no description.
        self.session = self.make_session(title="OSINT Batch IV · Friday 27 Nov", target_module=None, description="")
        self.url = reverse("realtime-session-class-details", kwargs={"pk": self.session.pk})

    def publish(self, session=None, started_at=None):
        # As the finalizer does: a fresh recording (and session) from the DB.
        created = R.objects.create(
            session_id=(session or self.session).pk,
            source=R.SOURCE_SERVER,
            state=R.STATE_FINALIZING,
            started_at=started_at or timezone.now(),
        )
        recording = R.objects.select_related("session").get(pk=created.pk)
        module = publisher.resolve_module(recording)
        lecture = publisher.create_lecture(recording, module, storage_name=f"lecture_videos/rec-{recording.pk}.mp4")
        R.objects.filter(pk=recording.pk).update(state=R.STATE_PUBLISHED)
        return lecture

    def save_details(self, **payload):
        self.client.force_authenticate(user=self.instructor)
        return self.client.post(self.url, payload, format="json")

    def test_details_given_before_the_class_name_its_recording(self):
        response = self.save_details(topic="Google dorking: advanced operators", description="filetype:, site:, inurl:",
                                     module_id=self.module2.pk)
        self.assertEqual(response.status_code, 200, response.content)

        lecture = self.publish()

        self.assertEqual(lecture.title, "Google dorking: advanced operators")
        self.assertEqual(lecture.description, "filetype:, site:, inurl:")
        self.assertEqual(lecture.section_id, self.module2.pk)

    def test_without_details_the_old_default_still_applies(self):
        lecture = self.publish()

        self.assertTrue(lecture.title.startswith("OSINT Batch IV · Friday 27 Nov - "))
        self.assertEqual(lecture.section.title, modules.ensure_auto_module(self.course.pk)[0].title)

    def test_details_given_after_the_class_rename_and_move_the_published_lecture(self):
        lecture = self.publish()
        recording = R.objects.get(lecture=lecture)
        self.assertTrue(recording.needs_review)

        response = self.save_details(topic="Dark web basics", description="Tor, onion services.",
                                     new_module_title="OSINT ADVANCED - DARK WEB")

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["lectures_updated"], 1)
        lecture.refresh_from_db()
        recording.refresh_from_db()
        new_module = Section.objects.get(course=self.course, title="OSINT ADVANCED - DARK WEB")
        self.assertEqual((lecture.title, lecture.description, lecture.section_id),
                         ("Dark web basics", "Tor, onion services.", new_module.pk))
        self.assertFalse(recording.needs_review)
        self.session.refresh_from_db()
        self.assertEqual(self.session.target_module_id, new_module.pk)
        self.assertEqual(self.session.title, "OSINT Batch IV · Friday 27 Nov", "calendar name is kept")

    def test_new_module_name_reuses_an_existing_module_with_that_name(self):
        self.save_details(topic="x", new_module_title="dorking")
        self.assertEqual(Section.objects.filter(course=self.course, title__iexact="dorking").count(), 1)
        self.session.refresh_from_db()
        self.assertEqual(self.session.target_module_id, self.module2.pk)

    def test_a_second_take_is_part_two(self):
        start = timezone.now() - timedelta(hours=1)
        first = self.publish(started_at=start)
        second = self.publish(started_at=start + timedelta(minutes=30))

        self.save_details(topic="Python basics")

        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual((first.title, second.title), ("Python basics", "Python basics (part 2)"))

    def test_module_of_another_course_is_refused(self):
        response = self.save_details(topic="x", module_id=self.foreign_module.pk)
        self.assertEqual(response.status_code, 400)

    def test_students_cannot_edit_class_details(self):
        self.client.force_authenticate(user=self.student)
        response = self.client.post(self.url, {"topic": "hijack"}, format="json")
        self.assertEqual(response.status_code, 403)
        self.session.refresh_from_db()
        self.assertEqual(self.session.lecture_title, "")

    def test_script_payloads_are_refused(self):
        response = self.save_details(topic="<script>alert(1)</script>")
        self.assertEqual(response.status_code, 400)

    def test_topic_is_in_the_session_payload(self):
        self.save_details(topic="Recon tools")
        self.client.force_authenticate(user=self.instructor)
        data = self.client.get(reverse("realtime-session-detail", kwargs={"pk": self.session.pk})).json()["data"]
        self.assertEqual(data["lecture_title"], "Recon tools")


class UpcomingClassIsNeverRecordedTests(RecordingFixtureMixin, TestCase):
    """Fri 27 Nov: Saturday's scheduled class read "stream live" while OBS was on
    and took over the recording of the Batch III class on air."""

    def setUp(self):
        self.build_fixture()
        self.recorder = StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": True})
        self.addCleanup(self.recorder.shutdown)

    def test_scheduled_class_with_live_stream_status_is_not_recorded(self):
        RealtimeSession.objects.filter(pk=self.session.pk).update(stream_status=RealtimeSession.STREAM_LIVE)
        on_air = R.objects.create(session=self.session, source=R.SOURCE_SERVER, state=R.STATE_RECORDING,
                                  started_at=timezone.now())
        upcoming = self.make_session(title="Saturday class", status=RealtimeSession.STATUS_SCHEDULED, started_at=None)
        # Updated last, so before the fix the recorder picked it.
        RealtimeSession.objects.filter(pk=upcoming.pk).update(
            stream_status=RealtimeSession.STREAM_LIVE, updated_at=timezone.now() + timedelta(seconds=5)
        )
        RealtimeSession.objects.filter(pk=self.session.pk).update(stream_status=RealtimeSession.STREAM_STOPPED)

        self.recorder.ensure_live_broadcasts_recorded()

        self.assertFalse(R.objects.filter(session=upcoming).exists())
        on_air.refresh_from_db()
        self.assertEqual(on_air.state, R.STATE_RECORDING)
