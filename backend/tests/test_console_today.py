"""``GET /api/console/today/`` (UI overhaul plan §3.4/§3.5, Appendix A.2). OWNER: WS-C.

Priority matrix for the Learn "Next up" card, the enrolment-scoped
countdown, the Teach counts with their permission scoping, and the query
budget (≤ 12 SQL queries per request).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.console_api import today
from apps.core import features
from apps.courses.models import LectureProgress, LiveClass, LiveClassEnrollment
from apps.ctf.models import CtfParticipation
from apps.realtime.models import RealtimeSession
from apps.realtime.recording.models import ClassRecording
from apps.reports.models import ReportPolicy, ReportSubmission, ReportTask
from tests import factories as f

URL = "/api/console/today/"
QUERY_BUDGET = 12
IST = ZoneInfo("Asia/Kolkata")


class _TodayCase(APITestCase):
    def setUp(self):
        features._reset_stub_state_for_tests()
        self.instructor = f.make_instructor(full_name="Iqbal Instructor")
        self.course = f.make_course(instructor=self.instructor, title="OSINT Foundations")
        section = f.make_section(course=self.course)
        self.lectures = [f.make_lecture(section=section, title=f"Lesson {n}", is_published=True) for n in (1, 2)]
        self.student = f.make_user(full_name="Sana Student")
        f.make_enrollment(user=self.student, course=self.course)
        self.outsider = f.make_user(full_name="Omar Outsider")

    def tearDown(self):
        features._reset_stub_state_for_tests()

    def today(self, user, workspace="learn", status=200):
        self.client.force_authenticate(user)
        response = self.client.get(URL, {"workspace": workspace})
        self.assertEqual(response.status_code, status, response.content)
        return response.json().get("data") if status == 200 else response.json()

    # --- fixtures --------------------------------------------------------
    def live_session(self, *, course=None, **overrides):
        fields = {
            "status": RealtimeSession.STATUS_LIVE,
            "stream_status": RealtimeSession.STREAM_LIVE,
            "started_at": timezone.now() - timedelta(minutes=5),
            "linked_course": course if course is not None else self.course,
            "title": "OSINT Live: Fri batch",
        }
        fields.update(overrides)
        return f.make_realtime_session(host=self.instructor, **fields)

    def report_task(self, *, due_in, **overrides):
        fields = {
            "course": self.course,
            "title": "Target: Acme Corp",
            "due_at": timezone.now() + due_in,
            "status": ReportTask.STATUS_PUBLISHED,
            "max_marks": Decimal("10.00"),
            "created_by": self.instructor,
        }
        fields.update(overrides)
        return ReportTask.objects.create(**fields)


class LearnPriorityTests(_TodayCase):
    def test_no_course_user_is_offered_the_catalogue_and_no_countdown(self):
        data = self.today(self.outsider)
        self.assertEqual(data["next_up"]["kind"], "browse")
        self.assertEqual(data["next_up"]["action"], {"label": "Browse courses", "href": "/courses"})
        self.assertIsNone(data["next_up"]["starts_at"])
        self.assertEqual(data["also"], [])
        self.assertEqual(data["courses"], [])
        self.assertIsNone(data["teach"])

    def test_enrolled_student_resumes_their_course(self):
        LectureProgress.objects.create(user=self.student, lecture=self.lectures[0], completed=True)
        data = self.today(self.student)
        next_up = data["next_up"]
        self.assertEqual(next_up["kind"], "resume")
        self.assertEqual(next_up["title"], "OSINT Foundations")
        self.assertEqual(next_up["action"], {"label": "Resume", "href": f"/learn/{self.course.pk}"})
        self.assertEqual(next_up["progress"], 0.5)
        self.assertEqual(data["courses"][0]["id"], self.course.pk)
        self.assertEqual(data["courses"][0]["progress"], 0.5)
        self.assertTrue(data["courses"][0]["image"])  # category artwork when no thumbnail

    def test_untouched_course_says_start(self):
        data = self.today(self.student)
        self.assertEqual(data["next_up"]["action"]["label"], "Start")
        self.assertEqual(data["next_up"]["progress"], 0.0)

    def test_report_due_within_72_hours_beats_resume(self):
        task = self.report_task(due_in=timedelta(hours=40))
        data = self.today(self.student)
        self.assertEqual(data["next_up"]["kind"], "report_due")
        self.assertEqual(data["next_up"]["action"], {"label": "Submit report", "href": f"/reports/tasks/{task.pk}"})
        self.assertEqual([row["kind"] for row in data["also"]], ["resume"])

    def test_report_due_later_this_week_comes_after_resume(self):
        self.report_task(due_in=timedelta(days=5))
        data = self.today(self.student)
        self.assertEqual(data["next_up"]["kind"], "resume")
        self.assertEqual([row["kind"] for row in data["also"]], ["report_due"])

    def test_a_handed_in_report_is_not_due(self):
        task = self.report_task(due_in=timedelta(hours=10))
        ReportSubmission.objects.create(
            task=task, student=self.student, status=ReportSubmission.STATUS_SUBMITTED, submitted_at=timezone.now()
        )
        self.assertEqual(self.today(self.student)["next_up"]["kind"], "resume")

    def test_open_exam_beats_report_and_finished_exam_does_not(self):
        self.report_task(due_in=timedelta(hours=10))
        exam = f.make_ctf_exam(eligible_courses=[self.course], title="E2E OSINT examination")
        data = self.today(self.student)
        self.assertEqual(data["next_up"]["kind"], "exam_open")
        self.assertEqual(data["next_up"]["title"], "E2E OSINT examination")
        self.assertTrue(data["next_up"]["action"]["href"].endswith("#exam"))
        CtfParticipation.objects.create(exam=exam, user=self.student, status=CtfParticipation.STATUS_SUBMITTED)
        self.assertEqual(self.today(self.student)["next_up"]["kind"], "report_due")

    def test_live_now_beats_everything(self):
        self.report_task(due_in=timedelta(hours=10))
        f.make_ctf_exam(eligible_courses=[self.course])
        session = self.live_session()
        data = self.today(self.student)
        self.assertEqual(data["next_up"]["kind"], "live_now")
        self.assertEqual(data["next_up"]["action"], {"label": "Join live", "href": f"/join-live?session={session.pk}"})
        self.assertEqual([row["kind"] for row in data["also"]], ["exam_open", "report_due", "resume"])

    def test_live_class_of_another_course_is_not_offered(self):
        other = f.make_course(title="Private batch")
        self.live_session(course=other)
        self.assertEqual(self.today(self.student)["next_up"]["kind"], "resume")
        self.assertEqual(self.today(self.outsider)["next_up"]["kind"], "browse")

    def test_broadcast_without_a_feed_and_abandoned_sessions_are_not_joinable(self):
        self.live_session(stream_status=RealtimeSession.STREAM_IDLE)
        self.live_session(started_at=timezone.now() - timedelta(hours=30))
        self.assertEqual(self.today(self.student)["next_up"]["kind"], "resume")

    def test_also_never_has_more_than_three_rows(self):
        self.live_session()
        f.make_ctf_exam(eligible_courses=[self.course])
        self.report_task(due_in=timedelta(hours=10))
        self.report_task(due_in=timedelta(hours=20), title="Target: Globex")
        data = self.today(self.student)
        self.assertEqual(len(data["also"]), 3)
        self.assertTrue(all(set(row) == {"kind", "label", "due_at", "href"} for row in data["also"]))


class NextClassScopeTests(_TodayCase):
    def setUp(self):
        super().setUp()
        self.live_class = LiveClass.objects.create(title="OSINT Live batch", description="Weekly classes.")

    def test_countdown_only_with_an_approved_live_class_enrolment(self):
        LiveClassEnrollment.objects.create(
            user=self.outsider, live_class=self.live_class, status=LiveClassEnrollment.STATUS_PENDING
        )
        self.assertEqual(self.today(self.outsider)["next_up"]["kind"], "browse")
        LiveClassEnrollment.objects.filter(user=self.outsider).update(status=LiveClassEnrollment.STATUS_APPROVED)
        next_up = self.today(self.outsider)["next_up"]
        self.assertEqual(next_up["kind"], "next_class")
        self.assertIsNotNone(next_up["starts_at"])

    def test_course_enrolment_gives_the_countdown_of_its_live_class(self):
        self.live_class.linked_course = self.course
        self.live_class.save()
        data = self.today(self.student)
        self.assertEqual(data["next_up"]["kind"], "resume")
        self.assertIn("next_class", [row["kind"] for row in data["also"]])

    def test_enrolled_student_without_live_class_access_gets_no_countdown(self):
        data = self.today(self.student)
        self.assertNotIn("next_class", [data["next_up"]["kind"], *[row["kind"] for row in data["also"]]])


class SelfServiceWeekTests(_TodayCase):
    def test_this_weeks_report_is_due_until_one_is_submitted(self):
        ReportPolicy.objects.create(course=self.course, self_service=True)
        saturday = datetime(2026, 11, 14, 12, 0, tzinfo=IST)  # due Sunday 23:59 IST: 36 h away
        data = today.build_learn(self.student, now=saturday)
        self.assertEqual(data["next_up"]["kind"], "report_due")
        self.assertEqual(data["next_up"]["action"]["href"], "/reports")
        self.assertEqual(data["next_up"]["title"], "Week of 9–15 Nov")

        policy = ReportPolicy.objects.get(course=self.course)
        from apps.reports.weekly import ensure_week_task
        from apps.reports.weeks import week_for

        task = ensure_week_task(self.course, policy, week_for(policy, saturday), now=saturday)
        ReportSubmission.objects.create(
            task=task, student=self.student, status=ReportSubmission.STATUS_SUBMITTED, submitted_at=saturday
        )
        self.assertEqual(today.build_learn(self.student, now=saturday)["next_up"]["kind"], "resume")


class TeachWorkspaceTests(_TodayCase):
    def setUp(self):
        super().setUp()
        self.other_instructor = f.make_instructor()
        self.other_course = f.make_course(instructor=self.other_instructor)
        self.admin = f.make_admin()

    def submit(self, task, student, minutes_ago):
        return ReportSubmission.objects.create(
            task=task,
            student=student,
            status=ReportSubmission.STATUS_SUBMITTED,
            submitted_at=timezone.now() - timedelta(minutes=minutes_ago),
        )

    def test_counts_are_scoped_to_the_instructors_courses(self):
        mine = self.report_task(due_in=timedelta(days=1))
        theirs = self.report_task(due_in=timedelta(days=1), course=self.other_course, created_by=self.other_instructor)
        self.submit(mine, self.student, 60 * 50)
        self.submit(mine, f.make_user(), 30)
        self.submit(theirs, f.make_user(), 10)
        session = f.make_realtime_session(host=self.instructor, linked_course=self.course)
        f.make_realtime_session(host=self.other_instructor)
        ClassRecording.objects.create(
            session=session, source=ClassRecording.SOURCE_SERVER, state=ClassRecording.STATE_PROCESSING
        )
        ClassRecording.objects.create(
            session=session, source=ClassRecording.SOURCE_SERVER, state=ClassRecording.STATE_FINALIZING,
            hold_unpublished=True,
        )
        exam = f.make_ctf_exam(eligible_courses=[self.course])
        f.make_ctf_exam(eligible_courses=[self.other_course])
        CtfParticipation.objects.create(exam=exam, user=self.student, status=CtfParticipation.STATUS_SUBMITTED)

        data = self.today(self.instructor, "teach")
        self.assertEqual(data["workspace"], "teach")
        self.assertIsNone(data["next_up"])
        teach = data["teach"]
        self.assertEqual(teach["to_grade"]["count"], 2)
        self.assertEqual(teach["to_grade"]["href"], "/console/teach/grading")
        self.assertIsNotNone(teach["to_grade"]["oldest_at"])
        self.assertEqual(teach["host_next"]["session_id"], session.pk)
        self.assertEqual(teach["host_next"]["href"], f"/console/teach/classes/{session.pk}/studio")
        self.assertEqual(teach["recordings"], {"processing": 2, "to_publish": 1, "href": "/console/teach/recordings"})
        self.assertEqual(teach["exams_open"]["count"], 1)
        self.assertEqual(teach["exams_open"]["submitted"], 1)
        self.assertEqual(teach["exams_open"]["eligible"], 1)
        self.assertEqual(teach["exams_open"]["href"], f"/console/teach/exams/{exam.slug}")

    def test_nothing_waiting_keeps_the_shape(self):
        teach = self.today(self.instructor, "teach")["teach"]
        self.assertEqual(teach["to_grade"], {"count": 0, "oldest_at": None, "href": "/console/teach/grading"})
        self.assertEqual(teach["host_next"], {"session_id": None, "starts_at": None, "href": "/console/teach/classes"})
        self.assertEqual(teach["exams_open"]["count"], 0)

    def test_staff_see_everything_under_the_admin_workspace(self):
        theirs = self.report_task(due_in=timedelta(days=1), course=self.other_course, created_by=self.other_instructor)
        self.submit(theirs, self.student, 5)
        teach = self.today(self.admin, "teach")["teach"]
        self.assertEqual(teach["to_grade"]["count"], 1)
        self.assertEqual(teach["to_grade"]["href"], "/console/admin/grading")
        self.assertEqual(teach["recordings"]["href"], "/console/admin/recordings")

    def test_students_cannot_open_teach(self):
        body = self.today(self.student, "teach", status=403)
        self.assertEqual(body["code"], "not_a_teacher")

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_teaching_switched_off_refuses_instructors_but_not_staff(self):
        body = self.today(self.instructor, "teach", status=403)
        self.assertEqual(body["code"], "feature_disabled")
        self.assertEqual(self.today(self.admin, "teach")["workspace"], "teach")
        # Learn is never gated.
        self.assertEqual(self.today(self.instructor)["workspace"], "learn")


class QueryBudgetTests(_TodayCase):
    def assert_budget(self, user, workspace):
        self.client.force_authenticate(user)
        self.client.get(URL, {"workspace": workspace})  # warm auth/session caches
        with CaptureQueriesContext(connection) as ctx:
            response = self.client.get(URL, {"workspace": workspace})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertLessEqual(len(ctx.captured_queries), QUERY_BUDGET, [q["sql"][:160] for q in ctx.captured_queries])

    def test_learn_with_everything_present(self):
        ReportPolicy.objects.create(course=self.course, self_service=True)
        LiveClass.objects.create(title="Live", description="d", linked_course=self.course)
        for extra in range(3):
            course = f.make_course(title=f"Extra {extra}")
            f.make_enrollment(user=self.student, course=course)
            f.make_lecture(section=f.make_section(course=course), is_published=True)
        LectureProgress.objects.create(user=self.student, lecture=self.lectures[0])
        self.live_session()
        f.make_ctf_exam(eligible_courses=[self.course])
        self.report_task(due_in=timedelta(hours=30))
        self.assert_budget(self.student, "learn")

    def test_learn_for_a_new_account(self):
        self.assert_budget(self.outsider, "learn")

    def test_teach(self):
        task = self.report_task(due_in=timedelta(days=1))
        ReportSubmission.objects.create(task=task, student=self.student, status=ReportSubmission.STATUS_SUBMITTED)
        f.make_realtime_session(host=self.instructor, linked_course=self.course)
        f.make_ctf_exam(eligible_courses=[self.course])
        self.assert_budget(self.instructor, "teach")
