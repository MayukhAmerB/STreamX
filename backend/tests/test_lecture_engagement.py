import json
import re
import shutil
import tempfile
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework.throttling import SimpleRateThrottle

from apps.courses.engagement.models import LectureComment, LectureLike, LectureView
from apps.courses.engagement.text import clean_comment_body
from apps.courses.engagement.views_tracking import record_lecture_view
from apps.courses.models import Course, Enrollment, Lecture, Section

User = get_user_model()


def _all_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _all_keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_keys(item)


class EngagementFixtureMixin:
    def build_fixture(self):
        cache.clear()
        self.media_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media_root, True)
        media_override = override_settings(MEDIA_ROOT=self.media_root, COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True)
        media_override.enable()
        self.addCleanup(media_override.disable)

        self.instructor = User.objects.create_user(
            email="eng-instructor@test.com", password="StrongPass@123", full_name="Ins Tructor", role="instructor"
        )
        self.student = User.objects.create_user(
            email="eng-student@test.com", password="StrongPass@123", full_name="Enrolled Student"
        )
        self.other_student = User.objects.create_user(
            email="eng-other@test.com", password="StrongPass@123", full_name="Other Student"
        )
        self.outsider = User.objects.create_user(
            email="eng-outsider@test.com", password="StrongPass@123", full_name="Not Enrolled"
        )
        self.admin = User.objects.create_superuser(email="eng-admin@test.com", password="StrongPass@123")
        self.course = Course.objects.create(
            title="Engagement Course",
            description="desc",
            price=Decimal("10.00"),
            instructor=self.instructor,
            is_published=True,
        )
        self.section = Section.objects.create(course=self.course, title="Module 1", order=1)
        self.lecture = Lecture.objects.create(
            section=self.section,
            title="Lecture with video",
            video_file=SimpleUploadedFile("lesson.mp4", b"fake video payload", content_type="video/mp4"),
            order=1,
        )
        for user in (self.student, self.other_student):
            Enrollment.objects.create(user=user, course=self.course, payment_status=Enrollment.STATUS_PAID)


class LectureLikeTests(EngagementFixtureMixin, APITestCase):
    def setUp(self):
        self.build_fixture()
        self.url = reverse("lecture-like", kwargs={"pk": self.lecture.id})

    def test_anonymous_cannot_like(self):
        response = self.client.post(self.url)
        self.assertIn(response.status_code, (401, 403))
        self.assertFalse(LectureLike.objects.exists())

    def test_user_without_course_access_cannot_like(self):
        self.client.force_authenticate(self.outsider)
        self.assertEqual(self.client.post(self.url).status_code, 403)
        self.assertEqual(self.client.get(reverse("lecture-engagement", kwargs={"pk": self.lecture.id})).status_code, 403)

    def test_toggle_counts_and_one_like_per_user(self):
        self.client.force_authenticate(self.student)
        first = self.client.post(self.url)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.data["data"], {"lecture_id": self.lecture.id, "like_count": 1, "liked": True, "comment_count": 0})
        self.assertEqual(self.client.post(self.url).data["data"]["liked"], False)
        self.assertEqual(LectureLike.objects.count(), 0)

        self.client.put(self.url)
        again = self.client.put(self.url)
        self.assertEqual(again.data["data"]["like_count"], 1)
        self.client.force_authenticate(self.other_student)
        self.assertEqual(self.client.put(self.url).data["data"]["like_count"], 2)
        self.assertEqual(self.client.delete(self.url).data["data"]["like_count"], 1)
        self.assertEqual(self.client.delete(self.url).data["data"]["like_count"], 1)

    def test_like_is_throttled(self):
        self.client.force_authenticate(self.student)
        with patch.dict(SimpleRateThrottle.THROTTLE_RATES, {"lecture_like": "2/minute"}):
            self.assertEqual(self.client.put(self.url).status_code, 200)
            self.assertEqual(self.client.put(self.url).status_code, 200)
            self.assertEqual(self.client.put(self.url).status_code, 429)


class LectureCommentTests(EngagementFixtureMixin, APITestCase):
    def setUp(self):
        self.build_fixture()
        self.url = reverse("lecture-comments", kwargs={"pk": self.lecture.id})

    def _post(self, user, body):
        self.client.force_authenticate(user)
        return self.client.post(self.url, {"body": body}, format="json")

    def test_anonymous_and_outsiders_are_rejected(self):
        self.assertIn(self.client.get(self.url).status_code, (401, 403))
        self.assertIn(self.client.post(self.url, {"body": "hi"}, format="json").status_code, (401, 403))
        self.assertEqual(self._post(self.outsider, "hi").status_code, 403)
        self.assertFalse(LectureComment.objects.exists())

    def test_html_is_stripped_and_payload_has_no_emails(self):
        response = self._post(self.student, "<b>Great</b> <i>class</i>!")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["data"]["body"], "Great class!")
        self.assertEqual(response.data["data"]["author"], {"id": self.student.id, "display_name": "Enrolled Student", "is_instructor": False})
        self.client.force_authenticate(self.other_student)
        listing = self.client.get(self.url)
        self.assertEqual(listing.status_code, 200)
        raw = json.dumps(listing.data)
        self.assertNotIn("@test.com", raw)
        self.assertNotIn("email", raw)
        self.assertFalse(listing.data["data"]["results"][0]["is_mine"])

    def test_active_content_and_length_are_rejected(self):
        self.assertEqual(self._post(self.student, "click javascript:alert(1)").status_code, 400)
        self.assertEqual(self._post(self.student, "<p></p>").status_code, 400)
        self.assertEqual(self._post(self.student, "x" * 2001).status_code, 400)
        self.assertFalse(LectureComment.objects.exists())

    def test_clean_comment_body_strips_tags_and_controls(self):
        self.assertEqual(clean_comment_body("  <a href='x'>link</a>\x00 text\n\n\n\nend "), "link text\n\nend")

    def test_list_is_newest_first_paginated_and_hides_moderated(self):
        for index in range(5):
            self._post(self.student, f"comment {index}")
        hidden = LectureComment.objects.get(body="comment 4")
        hidden.is_hidden = True
        hidden.save()
        self.client.force_authenticate(self.other_student)
        page = self.client.get(self.url, {"page": 1, "page_size": 2}).data["data"]
        self.assertEqual([row["body"] for row in page["results"]], ["comment 3", "comment 2"])
        self.assertEqual(page["pagination"]["total"], 4)
        self.assertTrue(page["pagination"]["has_next"])
        page2 = self.client.get(self.url, {"page": 2, "page_size": 2}).data["data"]
        self.assertEqual([row["body"] for row in page2["results"]], ["comment 1", "comment 0"])

    def test_edit_and_delete_own_only(self):
        comment_id = self._post(self.student, "original").data["data"]["id"]
        detail = reverse("lecture-comment-detail", kwargs={"comment_id": comment_id})

        self.client.force_authenticate(self.other_student)
        self.assertEqual(self.client.patch(detail, {"body": "hijack"}, format="json").status_code, 403)
        self.assertEqual(self.client.delete(detail).status_code, 403)

        self.client.force_authenticate(self.student)
        edited = self.client.patch(detail, {"body": "<em>edited</em>"}, format="json")
        self.assertEqual(edited.status_code, 200)
        self.assertEqual(edited.data["data"]["body"], "edited")
        self.assertTrue(edited.data["data"]["is_edited"])
        self.assertEqual(self.client.delete(detail).status_code, 200)
        self.assertFalse(LectureComment.objects.exists())

    def test_course_instructor_can_delete_any_comment(self):
        comment_id = self._post(self.student, "spam").data["data"]["id"]
        self.client.force_authenticate(self.instructor)
        response = self.client.delete(reverse("lecture-comment-detail", kwargs={"comment_id": comment_id}))
        self.assertEqual(response.status_code, 200)

    def test_comment_writes_are_throttled(self):
        with patch.dict(SimpleRateThrottle.THROTTLE_RATES, {"lecture_comment_write": "2/minute"}):
            self.assertEqual(self._post(self.student, "one").status_code, 201)
            self.assertEqual(self._post(self.student, "two").status_code, 201)
            self.assertEqual(self._post(self.student, "three").status_code, 429)
            # Reads use their own budget.
            self.assertEqual(self.client.get(self.url).status_code, 200)

    def test_unpublished_lecture_is_hidden_from_students(self):
        self.lecture.is_published = False
        self.lecture.save()
        self.assertEqual(self._post(self.student, "early").status_code, 403)
        self.client.force_authenticate(self.student)
        self.assertEqual(self.client.get(reverse("lecture-video", kwargs={"pk": self.lecture.id})).status_code, 404)
        course = self.client.get(reverse("course-detail", kwargs={"pk": self.course.id})).data["data"]
        lecture_ids = [lec["id"] for sec in course["sections"] for lec in sec["lectures"]]
        self.assertNotIn(self.lecture.id, lecture_ids)
        self.client.force_authenticate(self.instructor)
        self.assertEqual(self.client.get(reverse("lecture-video", kwargs={"pk": self.lecture.id})).status_code, 200)


class LectureViewCountTests(EngagementFixtureMixin, APITestCase):
    def setUp(self):
        self.build_fixture()
        self.video_url = reverse("lecture-video", kwargs={"pk": self.lecture.id})

    def test_views_are_deduplicated_per_user_per_day(self):
        self.client.force_authenticate(self.student)
        for _ in range(3):
            self.assertEqual(self.client.get(self.video_url).status_code, 200)
        self.client.force_authenticate(self.other_student)
        self.client.get(self.video_url)
        self.assertEqual(LectureView.objects.filter(lecture=self.lecture).count(), 2)

        tomorrow = timezone.now() + timedelta(days=1)
        with patch("apps.courses.engagement.views_tracking.timezone.now", return_value=tomorrow):
            self.client.get(self.video_url)
        self.assertEqual(LectureView.objects.filter(lecture=self.lecture).count(), 3)

    def test_denied_playback_is_not_counted(self):
        self.client.force_authenticate(self.outsider)
        self.assertEqual(self.client.get(self.video_url).status_code, 403)
        self.assertFalse(LectureView.objects.exists())

    def test_anonymous_preview_views_store_only_a_hash(self):
        self.lecture.is_preview = True
        self.lecture.save()
        request = RequestFactory().get("/", REMOTE_ADDR="81.2.69.160")
        request.user = type("Anon", (), {"is_authenticated": False})()
        self.assertTrue(record_lecture_view(lecture=self.lecture, request=request))
        self.assertFalse(record_lecture_view(lecture=self.lecture, request=request))
        view = LectureView.objects.get()
        self.assertTrue(view.viewer_key.startswith("a:"))
        self.assertNotIn("81.2.69.160", view.viewer_key)

    def test_view_count_never_appears_in_student_payloads(self):
        self.client.force_authenticate(self.student)
        self.client.get(self.video_url)
        payloads = [
            self.client.get(self.video_url).data,
            self.client.get(reverse("course-detail", kwargs={"pk": self.course.id})).data,
            self.client.get(reverse("lecture-engagement", kwargs={"pk": self.lecture.id})).data,
            self.client.get(reverse("lecture-comments", kwargs={"pk": self.lecture.id})).data,
            self.client.get(reverse("my-courses")).data,
        ]
        view_key = re.compile(r"(^|_)views?(_|$)")
        for payload in payloads:
            self.assertNotIn("view_count", json.dumps(payload, default=str))
            for key in _all_keys(payload):
                self.assertIsNone(view_key.search(str(key).lower()), key)


class EngagementAdminTests(EngagementFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.client.force_login(self.admin)

    def test_lecture_admin_shows_sortable_view_count(self):
        LectureView.objects.create(lecture=self.lecture, viewer_key="u:1", view_date=timezone.localdate())
        LectureView.objects.create(lecture=self.lecture, viewer_key="u:2", view_date=timezone.localdate())
        changelist = self.client.get(reverse("admin:courses_lecture_changelist"), {"o": "-9"})
        self.assertEqual(changelist.status_code, 200)
        self.assertContains(changelist, "column-view_count")
        self.assertEqual(changelist.context["cl"].result_list[0]._view_count, 2)
        detail = self.client.get(reverse("admin:courses_lecture_change", args=[self.lecture.id]))
        self.assertEqual(detail.status_code, 200)
        self.assertContains(detail, "Views")

    def test_hide_unhide_and_delete_moderation_actions(self):
        comments = [
            LectureComment.objects.create(lecture=self.lecture, user=self.student, body=f"c{i}") for i in range(3)
        ]
        url = reverse("admin:courses_lecturecomment_changelist")
        self.assertEqual(self.client.get(url, {"lecture__id__exact": self.lecture.id}).status_code, 200)
        self.client.post(url, {"action": "hide_selected_comments", "_selected_action": [comments[0].id, comments[1].id]})
        self.assertEqual(LectureComment.objects.filter(is_hidden=True).count(), 2)
        self.client.post(url, {"action": "unhide_selected_comments", "_selected_action": [comments[1].id]})
        self.assertEqual(LectureComment.objects.filter(is_hidden=True).count(), 1)
        self.client.post(
            url,
            {"action": "delete_selected", "_selected_action": [comments[2].id], "post": "yes"},
        )
        self.assertFalse(LectureComment.objects.filter(pk=comments[2].id).exists())
