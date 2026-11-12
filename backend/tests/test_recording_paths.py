"""Regression: recorded-class file paths must fit the lecture's file column.

Production's verify_recording_pipeline failed with "value too long for type
character varying(100)" because Lecture.video_file used Django's default
max_length of 100 and recorded-class paths include the course slug.
"""

from types import SimpleNamespace

from django.test import TestCase
from django.utils import timezone

from apps.courses.models import Lecture
from apps.realtime.models import RealtimeSessionRecording
from apps.realtime.recording.publisher import storage_name_for
from tests.factories import make_course, make_section


class RecordedClassPathLengthTests(TestCase):
    def setUp(self):
        self.course = make_course(title="A" * 40)
        self.course.slug = "zz-verify-recording-pipeline-" + "very-long-course-name-" * 8
        self.course.save(update_fields=["slug"])
        self.module = make_section(course=self.course)

    def _recording(self, pk=987654):
        now = timezone.now()
        return SimpleNamespace(pk=pk, started_at=now, created_at=now)

    def test_storage_name_caps_the_course_slug(self):
        name = storage_name_for(self._recording(), self.module)
        slug_part = name.split("/")[1]
        self.assertLessEqual(len(slug_part), 48)
        self.assertFalse(slug_part.endswith("-"))
        self.assertTrue(name.endswith(".mp4"))
        self.assertLessEqual(len(name), 120)

    def test_storage_name_fits_lecture_file_column(self):
        name = storage_name_for(self._recording(), self.module)
        max_length = Lecture._meta.get_field("video_file").max_length
        self.assertGreaterEqual(max_length, 500)
        self.assertLessEqual(len(name), max_length)

    def test_lecture_saves_a_long_video_path(self):
        long_name = "lecture_videos/" + "x" * 300 + "/rec-1-20261112-153000.mp4"
        lecture = Lecture(section=self.module, title="Recorded class", order=1, is_published=False)
        lecture.video_file.name = long_name
        lecture.save()
        lecture.refresh_from_db()
        self.assertEqual(lecture.video_file.name, long_name)

    def test_realtime_recording_file_column_is_wide(self):
        field = RealtimeSessionRecording._meta.get_field("video_file")
        self.assertGreaterEqual(field.max_length, 500)
