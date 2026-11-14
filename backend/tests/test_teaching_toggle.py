"""The Teachers section switch is enforced by the server (UI overhaul plan §5.3, WS-F).

Every instructor grant path answers 403 ``feature_disabled`` (or hides the
object, where the module hides ids) for a non-staff instructor while
``teaching`` is off, and behaves as before while it is on. Staff and students
are unaffected. A class already on air keeps its instructor controls.
"""

from __future__ import annotations

from django.test import override_settings
from rest_framework.test import APITestCase

from apps.core import features
from apps.courses.access import lecture_access_context
from apps.realtime.models import RealtimeSession
from apps.recording_uploads import tokens
from apps.users import teaching
from tests import factories as f

OFF = override_settings(FEATURE_DEFAULT_OVERRIDES={})
OFF_REASON = "Teaching tools are switched off for now. An admin can turn them on."


class _Case(APITestCase):
    def setUp(self):
        features.invalidate_cache()
        self.instructor = f.make_instructor(full_name="Imran Instructor")
        self.student = f.make_user()
        self.admin = f.make_admin()
        self.course = f.make_course(instructor=self.instructor)
        self.draft = f.make_course(instructor=self.instructor, is_published=False)
        self.section = f.make_section(course=self.course)
        self.lecture = f.make_lecture(section=self.section, is_published=False)

    def tearDown(self):
        features.invalidate_cache()

    def call(self, user, method, url, data=None, **extra):
        self.client.force_authenticate(user)
        return getattr(self.client, method)(url, data, format="json", **extra)

    def assertFeatureDisabled(self, response):
        self.assertEqual(response.status_code, 403, response.content)
        body = response.json()
        self.assertEqual(body["code"], "feature_disabled")
        self.assertEqual(body["detail"], OFF_REASON)
        self.assertEqual(body["errors"]["feature"], "teaching")

    def instructor_endpoints(self):
        """(label, method, url, data) for every instructor grant path reachable over HTTP."""
        session = f.make_realtime_session(host=self.instructor, linked_course=self.course)
        return [
            ("course create", "post", "/api/courses/", {"title": "New", "description": "d", "price": "10.00"}),
            ("course edit", "patch", f"/api/courses/{self.course.pk}/", {"title": "Renamed"}),
            ("course delete", "delete", f"/api/courses/{self.course.pk}/", None),
            ("section create", "post", "/api/sections/", {"course": self.course.pk, "title": "S", "order": 9}),
            ("section edit", "put", f"/api/sections/{self.section.pk}/", {"title": "S2", "order": 1}),
            ("lecture create", "post", "/api/lectures/", {"section": self.section.pk, "title": "L", "order": 9}),
            ("instructor courses", "get", "/api/instructor/courses/", None),
            ("report grading", "get", "/api/reports/manage/courses/", None),
            ("report queue", "get", "/api/reports/manage/submissions/", None),
            ("console exams", "get", "/api/ctf-admin/exams/", None),
            ("recording uploads", "get", "/api/recording-uploads/", None),
            ("recording upload targets", "get", "/api/recording-uploads/targets/", None),
            ("session create", "post", "/api/realtime/sessions/", {"title": "Class", "session_type": "broadcasting"}),
            ("session end (scheduled)", "post", f"/api/realtime/sessions/{session.pk}/end/", {}),
        ]


@OFF
class TeachingOffTests(_Case):
    def test_production_default_is_off(self):
        self.assertFalse(features.is_enabled("teaching"))
        self.assertTrue(teaching.acts_as_instructor(self.instructor))
        self.assertFalse(teaching.teaching_allowed(self.instructor))

    def test_every_instructor_path_answers_feature_disabled(self):
        for label, method, url, data in self.instructor_endpoints():
            with self.subTest(label):
                self.assertFeatureDisabled(self.call(self.instructor, method, url, data))
        self.course.refresh_from_db()
        self.assertNotEqual(self.course.title, "Renamed")

    def test_unpublished_course_is_hidden_like_for_a_student(self):
        response = self.call(self.instructor, "get", f"/api/courses/{self.draft.pk}/")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.call(self.instructor, "get", f"/api/courses/{self.draft.pk}/thumbnail/").status_code, 404)

    def test_unpublished_lecture_is_not_previewable(self):
        context = lecture_access_context(self.lecture, self.instructor)
        self.assertFalse(context["is_instructor_owner"])
        self.assertFalse(context["can_access"])

    def test_personal_upload_token_is_refused_with_the_reason(self):
        _token, raw = tokens.create_token(self.instructor, "OBS uploader")
        self.client.force_authenticate(None)
        response = self.client.get("/api/recording-uploads/", HTTP_X_UPLOAD_TOKEN=raw)
        self.assertFeatureDisabled(response)

    def test_ctf_and_reports_scopes_are_empty(self):
        from apps.ctf import access as ctf_access
        from apps.reports import access as reports_access

        self.assertEqual(ctf_access.taught_course_ids(self.instructor), [])
        self.assertFalse(reports_access.can_grade_course(self.instructor, self.course))
        self.assertFalse(reports_access.gradable_courses(self.instructor).exists())

    def test_staff_keep_every_tool(self):
        for url in ("/api/reports/manage/courses/", "/api/ctf-admin/exams/", "/api/recording-uploads/"):
            with self.subTest(url):
                self.assertEqual(self.call(self.admin, "get", url).status_code, 200)
        self.assertEqual(self.call(self.admin, "get", f"/api/courses/{self.draft.pk}/").status_code, 403)
        session = f.make_realtime_session(host=self.instructor, linked_course=self.course)
        self.assertTrue(session.is_moderator_allowed(self.admin))

    def test_staff_instructor_accounts_are_not_covered(self):
        staff_instructor = f.make_instructor(is_staff=True)
        self.assertFalse(teaching.acts_as_instructor(staff_instructor))
        self.assertTrue(teaching.teaching_allowed(staff_instructor))
        self.assertEqual(self.call(staff_instructor, "get", "/api/instructor/courses/").status_code, 200)

    def test_students_are_unaffected(self):
        self.assertEqual(self.call(self.student, "get", "/api/courses/").status_code, 200)
        response = self.call(self.student, "post", "/api/courses/", {"title": "x"})
        self.assertEqual(response.status_code, 403)
        self.assertNotEqual(response.json()["code"], "feature_disabled")
        self.assertEqual(self.call(self.student, "get", "/api/reports/manage/courses/").json()["code"], "not_a_grader")

    def test_a_class_on_air_keeps_its_instructor_controls(self):
        live = f.make_realtime_session(
            host=self.instructor, linked_course=self.course, status=RealtimeSession.STATUS_LIVE
        )
        scheduled = f.make_realtime_session(host=self.instructor, linked_course=self.course)
        self.assertTrue(live.is_moderator_allowed(self.instructor))
        self.assertTrue(live.is_instructor_owner(self.instructor))
        self.assertFalse(scheduled.is_moderator_allowed(self.instructor))
        self.assertFalse(scheduled.is_instructor_owner(self.instructor))
        # Once it has ended the in-flight exception is over.
        live.status = RealtimeSession.STATUS_ENDED
        self.assertFalse(live.is_moderator_allowed(self.instructor))

    def test_a_switch_flip_takes_effect_on_the_next_request(self):
        url = "/api/instructor/courses/"
        self.assertFeatureDisabled(self.call(self.instructor, "get", url))
        features.set_feature("teaching", True, by=self.admin, note="term starts")
        self.assertEqual(self.call(self.instructor, "get", url).status_code, 200)
        features.set_feature("teaching", False, by=self.admin)
        self.assertFeatureDisabled(self.call(self.instructor, "get", url))

    def test_custom_reason_reaches_the_api(self):
        features.set_feature("teaching", True, by=self.admin)
        features.set_feature("teaching", False, by=self.admin, reason="Teaching opens on 1 December.")
        response = self.call(self.instructor, "get", "/api/instructor/courses/")
        self.assertEqual(response.json()["detail"], "Teaching opens on 1 December.")


class TeachingOnTests(_Case):
    """Under tests the default is on: instructors behave exactly as before."""

    def test_instructor_paths_work(self):
        self.assertTrue(features.is_enabled("teaching"))
        self.assertEqual(self.call(self.instructor, "get", "/api/instructor/courses/").status_code, 200)
        self.assertEqual(self.call(self.instructor, "get", "/api/reports/manage/courses/").status_code, 200)
        self.assertEqual(self.call(self.instructor, "get", "/api/ctf-admin/exams/").status_code, 200)
        self.assertEqual(self.call(self.instructor, "get", "/api/recording-uploads/").status_code, 200)
        self.assertEqual(self.call(self.instructor, "get", f"/api/courses/{self.draft.pk}/").status_code, 200)
        response = self.call(self.instructor, "patch", f"/api/courses/{self.course.pk}/", {"title": "Renamed"})
        self.assertEqual(response.status_code, 200, response.content)

    def test_none_of_the_paths_say_feature_disabled(self):
        for label, method, url, data in self.instructor_endpoints():
            with self.subTest(label):
                response = self.call(self.instructor, method, url, data)
                code = response.json().get("code") if response.content and response["Content-Type"].startswith("application/json") else None
                self.assertNotEqual(code, "feature_disabled")

    def test_owner_controls_and_previews(self):
        scheduled = f.make_realtime_session(host=self.instructor, linked_course=self.course)
        self.assertTrue(scheduled.is_moderator_allowed(self.instructor))
        self.assertTrue(lecture_access_context(self.lecture, self.instructor)["can_access"])
        _token, raw = tokens.create_token(self.instructor, "OBS uploader")
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get("/api/recording-uploads/", HTTP_X_UPLOAD_TOKEN=raw).status_code, 200)
