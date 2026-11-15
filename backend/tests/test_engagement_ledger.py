"""Engagement: ledger, XP rules, levels, streaks, badges (apps.engagement)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone as dt_timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from apps.core.outbox import publish  # noqa: F401  (outbox registry loaded)
from apps.courses.models import LectureProgress
from apps.engagement import badges, buffer, flush, outbox_handlers, rules, services, signals, streaks
from apps.engagement.models import (
    Achievement,
    ActivityDay,
    AppendOnlyError,
    BadgeAward,
    EngagementSummary,
    LiveAttendance,
    XpEvent,
)
from tests import factories as f
from tests.engagement_support import drain, ist, item, reset_engagement_state


class EngagementTestCase(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def summary(self, user):
        return EngagementSummary.objects.get(user=user)


# --- levels -------------------------------------------------------------------------------
class LevelTests(SimpleTestCase):
    def test_thresholds(self):
        expected = [
            (0, "recruit"), (1499, "recruit"), (1500, "operative"), (3499, "operative"), (3500, "operator"),
            (5999, "operator"), (6000, "analyst"), (9000, "specialist"), (11999, "specialist"),
            (12000, "senior_analyst"), (15500, "lead_investigator"), (18999, "lead_investigator"),
            (19000, "elite_operator"), (999999, "elite_operator"),
        ]
        for xp, key in expected:
            with self.subTest(xp=xp):
                self.assertEqual(rules.level_for(xp).key, key)

    def test_titles_and_next_level(self):
        self.assertEqual(
            [(level.title, level.min_xp) for level in rules.LEVELS],
            [("Recruit", 0), ("Operative", 1500), ("Operator", 3500), ("Analyst", 6000), ("Specialist", 9000),
             ("Senior Analyst", 12000), ("Lead Investigator", 15500), ("Elite Operator", 19000)],
        )
        self.assertEqual(rules.next_level(0).key, "operative")
        self.assertEqual(rules.next_level(1500).key, "operator")
        self.assertIsNone(rules.next_level(19000))

    def test_rule_amounts(self):
        self.assertEqual(rules.lecture_xp(), 20)
        self.assertEqual(rules.report_submitted_xp(on_time=True), 40)
        self.assertEqual(rules.report_submitted_xp(on_time=False), 30)
        self.assertEqual(rules.report_graded_xp(80), 130)  # report-mark bonus tier 8/10
        self.assertEqual(rules.report_graded_xp(100), 300)
        self.assertEqual(rules.exam_xp(73.4), 73)
        self.assertEqual(rules.exam_xp(140), 100)
        self.assertEqual(rules.watch_blocks(299), 0)
        self.assertEqual(rules.watch_blocks(300), 1)
        self.assertEqual(rules.watch_blocks(10 * 3600), 60)


# --- streaks (pure) ------------------------------------------------------------------------------
class StreakMathTests(SimpleTestCase):
    def test_consecutive_days(self):
        state = streaks.compute([date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 4)])
        self.assertEqual((state.current, state.best), (3, 3))
        self.assertEqual(state.continuing_days, {date(2026, 11, 3), date(2026, 11, 4)})

    def test_single_missed_day_is_frozen_once_per_week(self):
        # Mon, (Tue missed -> freeze), Wed, (Thu missed: freeze already used this week) Fri
        state = streaks.compute([date(2026, 11, 2), date(2026, 11, 4), date(2026, 11, 6)])
        self.assertEqual(state.frozen_days, [date(2026, 11, 3)])
        self.assertEqual(state.current, 1)
        self.assertEqual(state.best, 2)

    def test_freeze_belongs_to_the_week_of_the_missed_day(self):
        # Sat 7th, (Sun 8th missed, week of 2 Nov) Mon 9th, (Tue 10th missed, week of 9 Nov) Wed 11th
        state = streaks.compute([date(2026, 11, 7), date(2026, 11, 9), date(2026, 11, 11)])
        self.assertEqual(state.frozen_days, [date(2026, 11, 8), date(2026, 11, 10)])
        self.assertEqual(state.current, 3)
        self.assertEqual(state.freeze_week, date(2026, 11, 9))

    def test_two_missed_days_break_the_streak(self):
        state = streaks.compute([date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 6)])
        self.assertEqual((state.current, state.best), (1, 2))

    def test_effective_today_and_yesterday(self):
        today = date(2026, 11, 12)  # Thursday
        alive = streaks.effective(current=4, best=4, last_day=today, freeze_week=None, today=today)
        self.assertTrue(alive.alive and alive.studied_today)
        pending = streaks.effective(current=4, best=4, last_day=today - timedelta(days=1), freeze_week=None, today=today)
        self.assertEqual((pending.current, pending.alive, pending.studied_today), (4, True, False))

    def test_effective_freeze_covers_yesterday_once(self):
        today = date(2026, 11, 12)
        covered = streaks.effective(current=4, best=4, last_day=date(2026, 11, 10), freeze_week=None, today=today)
        self.assertEqual((covered.current, covered.freeze_covering), (4, date(2026, 11, 11)))
        self.assertFalse(covered.freeze_available)
        used = streaks.effective(current=4, best=4, last_day=date(2026, 11, 10), freeze_week=date(2026, 11, 9), today=today)
        self.assertEqual((used.current, used.alive), (0, False))
        broken = streaks.effective(current=4, best=9, last_day=date(2026, 11, 9), freeze_week=None, today=today)
        self.assertEqual((broken.current, broken.best), (0, 9))

    def test_ist_midnight_boundary(self):
        before = datetime(2026, 11, 3, 18, 29, tzinfo=dt_timezone.utc)  # 23:59 IST on the 3rd
        after = datetime(2026, 11, 3, 18, 31, tzinfo=dt_timezone.utc)  # 00:01 IST on the 4th
        self.assertEqual(rules.ist_day(before), date(2026, 11, 3))
        self.assertEqual(rules.ist_day(after), date(2026, 11, 4))
        self.assertEqual(rules.week_start(date(2026, 11, 8)), date(2026, 11, 2))  # Sunday -> Monday
        self.assertEqual(rules.week_start(date(2026, 11, 9)), date(2026, 11, 9))


# --- ledger ----------------------------------------------------------------------------------------
class LedgerTests(EngagementTestCase):
    def test_award_is_idempotent(self):
        user = f.make_user()
        first = services.award(user.pk, item(rules.KIND_MANUAL, 20, "k1"))
        second = services.award(user.pk, item(rules.KIND_MANUAL, 20, "k1"))
        self.assertEqual(first.points, 20)
        self.assertEqual(second.points, 0)
        self.assertEqual(XpEvent.objects.filter(user=user).count(), 1)
        self.assertEqual(self.summary(user).total_xp, 20)
        both = services.award_many(user.pk, [item(rules.KIND_MANUAL, 5, "k2"), item(rules.KIND_MANUAL, 5, "k2")])
        self.assertEqual(both.points, 5)

    def test_ledger_is_append_only(self):
        user = f.make_user()
        services.award(user.pk, item(rules.KIND_MANUAL, 10, "append"))
        event = XpEvent.objects.get(user=user)
        event.points = 999
        with self.assertRaises(AppendOnlyError):
            event.save()
        with self.assertRaises(AppendOnlyError):
            event.delete()
        with self.assertRaises(AppendOnlyError):
            XpEvent.objects.filter(pk=event.pk).update(points=1)
        with self.assertRaises(AppendOnlyError):
            XpEvent.objects.filter(pk=event.pk).delete()

    def test_summary_updates_and_level_up_achievement(self):
        user = f.make_user(full_name="Asha Kumar")
        result = services.award(user.pk, item(rules.KIND_MANUAL, 4000, "big"))
        summary = self.summary(user)
        self.assertEqual((summary.total_xp, summary.level, summary.version), (4000, 3, 1))
        self.assertTrue(result.leveled_up)
        keys = set(Achievement.objects.filter(user=user, kind="level").values_list("key", flat=True))
        self.assertEqual(keys, {"operative", "operator"})
        achievement = Achievement.objects.get(user=user, key="operator")
        self.assertEqual(achievement.recipient_name, "Asha Kumar")
        self.assertGreaterEqual(len(achievement.slug), 20)

    def test_weekly_xp_counts_only_this_ist_week(self):
        user = f.make_user()
        now = timezone.now()
        services.award_many(
            user.pk,
            [item(rules.KIND_MANUAL, 10, "now", occurred_at=now), item(rules.KIND_MANUAL, 7, "old", occurred_at=now - timedelta(days=30))],
        )
        summary = self.summary(user)
        self.assertEqual((summary.total_xp, summary.weekly_xp), (17, 10))
        self.assertEqual(summary.week_start, rules.current_week_start())

    def test_switch_off_awards_nothing_and_keeps_data(self):
        from apps.core import features

        user = f.make_user()
        services.award(user.pk, item(rules.KIND_MANUAL, 10, "before"))
        admin = f.make_admin()
        features.set_feature("engagement", False, by=admin)
        self.assertTrue(services.award(user.pk, item(rules.KIND_MANUAL, 10, "after")).skipped)
        self.assertEqual(self.summary(user).total_xp, 10)
        self.assertTrue(XpEvent.objects.filter(idempotency_key="before").exists())


# --- streak integration -------------------------------------------------------------------------------
class StreakAwardTests(EngagementTestCase):
    def test_study_days_streak_bonus_and_freeze(self):
        user = f.make_user()
        for day in (2, 3, 5):  # Mon, Tue, (Wed missed -> freeze), Thu
            services.award(user.pk, item(rules.KIND_LECTURE_COMPLETED, 20, f"l{day}", occurred_at=ist(2026, 11, day)))
        summary = self.summary(user)
        self.assertEqual((summary.current_streak, summary.best_streak), (3, 3))
        self.assertEqual(summary.freeze_used_on, date(2026, 11, 4))
        bonuses = set(XpEvent.objects.filter(user=user, kind=rules.KIND_STREAK_BONUS).values_list("source_id", flat=True))
        self.assertEqual(bonuses, {"2026-11-03", "2026-11-05"})
        self.assertEqual(summary.total_xp, 3 * 20 + 2 * 5)
        self.assertEqual(ActivityDay.objects.filter(user=user, is_study_day=True).count(), 3)

    def test_events_either_side_of_ist_midnight_are_two_study_days(self):
        user = f.make_user()
        services.award(user.pk, item(rules.KIND_MANUAL, 5, "a", occurred_at=datetime(2026, 11, 3, 18, 29, tzinfo=dt_timezone.utc)))
        services.award(user.pk, item(rules.KIND_MANUAL, 5, "b", occurred_at=datetime(2026, 11, 3, 18, 31, tzinfo=dt_timezone.utc)))
        days = list(ActivityDay.objects.filter(user=user).order_by("day").values_list("day", flat=True))
        self.assertEqual(days, [date(2026, 11, 3), date(2026, 11, 4)])
        self.assertEqual(self.summary(user).current_streak, 2)

    def test_same_day_events_make_one_study_day(self):
        user = f.make_user()
        services.award(user.pk, item(rules.KIND_MANUAL, 5, "a", occurred_at=ist(2026, 11, 3, 0, 1)))
        services.award(user.pk, item(rules.KIND_MANUAL, 5, "b", occurred_at=ist(2026, 11, 3, 23, 59)))
        self.assertEqual(ActivityDay.objects.get(user=user).xp, 10)
        self.assertEqual(self.summary(user).current_streak, 1)
        self.assertFalse(XpEvent.objects.filter(user=user, kind=rules.KIND_STREAK_BONUS).exists())


# --- XP rules through the real source hooks -----------------------------------------------------------------
class LectureRuleTests(EngagementTestCase):
    def setUp(self):
        super().setUp()
        self.student = f.make_user()
        self.lecture = f.make_lecture(stream_duration_seconds=1000, video_key="videos/x.mp4")
        f.make_enrollment(user=self.student, course=self.lecture.section.course)

    def _save_progress(self, position, *, completed=None):
        progress, _ = LectureProgress.objects.get_or_create(user=self.student, lecture=self.lecture)
        progress.mark_progress(position_seconds=position, duration_seconds=1000, completed=completed)
        progress.save()
        return progress

    def test_completion_with_80_percent_awards_20_xp_once(self):
        self._save_progress(950)
        self._save_progress(990)
        drain()
        events = XpEvent.objects.filter(user=self.student, kind=rules.KIND_LECTURE_COMPLETED)
        self.assertEqual([event.points for event in events], [20])
        self.assertTrue(BadgeAward.objects.filter(user=self.student, badge_key="first_lecture").exists())

    def test_marked_complete_below_80_percent_earns_nothing_until_watched(self):
        self._save_progress(500, completed=True)
        drain()
        self.assertFalse(XpEvent.objects.filter(user=self.student, kind=rules.KIND_LECTURE_COMPLETED).exists())
        self.assertTrue(LectureProgress.objects.get(user=self.student).completed)

    def test_progress_api_returns_engagement_header(self):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(self.student)
        response = client.put(
            f"/api/lectures/{self.lecture.pk}/progress/",
            {"position_seconds": 990, "duration_seconds": 1000, "completed": True},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        import json

        header = json.loads(response["X-Engagement"])
        self.assertEqual(header["pending_xp"], 20)
        drain()
        self.assertEqual(self.summary(self.student).total_xp, 20)

    def test_completing_every_lecture_awards_course_finisher(self):
        self._save_progress(1000)
        drain()
        self.assertTrue(BadgeAward.objects.filter(user=self.student, badge_key="course_finisher").exists())
        course = Achievement.objects.get(user=self.student, kind="course")
        self.assertEqual(course.key, str(self.lecture.section.course_id))


class WatchTimeTests(EngagementTestCase):
    def test_watch_credit_is_capped_by_wall_clock(self):
        now = timezone.now()
        self.assertEqual(signals.watch_credit((0, now - timedelta(seconds=60)), 60, now), 60)
        self.assertEqual(signals.watch_credit((0, now - timedelta(seconds=20)), 3000, now), 30)  # seek ahead
        self.assertEqual(signals.watch_credit((0, now - timedelta(hours=2)), 3000, now), 300)  # per-update cap
        self.assertEqual(signals.watch_credit((500, now - timedelta(seconds=60)), 400, now), 0)  # rewind
        self.assertEqual(signals.watch_credit((0, None), 100, now), 0)  # first save

    def test_heartbeats_go_to_the_buffer_and_flush_awards_one_xp_per_5_minutes(self):
        student = f.make_user()
        lecture = f.make_lecture(stream_duration_seconds=3600, video_key="videos/y.mp4")
        progress = LectureProgress.objects.create(user=student, lecture=lecture, last_position_seconds=0)
        LectureProgress.objects.filter(pk=progress.pk).update(updated_at=timezone.now() - timedelta(minutes=10))
        progress = LectureProgress.objects.get(pk=progress.pk)  # post_init remembers position + time
        services.is_enabled()  # warm the switch memo
        with self.assertNumQueries(1):  # the progress UPDATE only: no engagement writes per heartbeat
            progress.last_position_seconds = 600
            progress.save(update_fields=["last_position_seconds", "updated_at"])
        pending = buffer.pending_snapshot("watch")
        self.assertEqual(list(pending.values()), [300])
        self.assertFalse(ActivityDay.objects.filter(user=student).exists())
        flush.flush_watch()
        self.assertEqual(ActivityDay.objects.get(user=student).watch_seconds, 300)
        drain()
        self.assertEqual(XpEvent.objects.get(user=student, kind=rules.KIND_WATCH_TIME).points, 1)
        summary = EngagementSummary.objects.get(user=student)
        self.assertEqual((summary.time_total_seconds, summary.time_week_seconds), (300, 300))

    def test_daily_cap_is_60_xp(self):
        student = f.make_user()
        today = rules.ist_day()
        services.apply_time(student.pk, {today: 4 * 3600}, kind="watch")
        services.award_watch_xp(student.pk, [today])
        services.apply_time(student.pk, {today: 4 * 3600}, kind="watch")
        services.award_watch_xp(student.pk, [today])
        services.award_watch_xp(student.pk, [today])
        self.assertEqual(sum(XpEvent.objects.filter(user=student, kind=rules.KIND_WATCH_TIME).values_list("points", flat=True)), 60)
        self.assertTrue(BadgeAward.objects.filter(user=student, badge_key="deep_focus").exists())


class LiveRuleTests(EngagementTestCase):
    def test_live_xp_follows_the_attendance_rule_of_40_live_minutes(self):
        # Owner rule (apps.attendance): present = at least 40 minutes of the live
        # class; half of a 60-minute class (30 min) is no longer enough.
        present, brief, half = f.make_user(), f.make_user(), f.make_user()
        end = timezone.now()
        session = f.make_realtime_session(status="ended", started_at=end - timedelta(hours=1), ended_at=end)
        LiveAttendance.objects.create(session_id=session.pk, user=present, seconds=40 * 60)
        LiveAttendance.objects.create(session_id=session.pk, user=brief, seconds=40 * 60 - 1)
        LiveAttendance.objects.create(session_id=session.pk, user=half, seconds=30 * 60)
        outbox_handlers.handle_live_ended(SimpleNamespace(payload={"session_id": session.pk}))
        self.assertEqual(XpEvent.objects.get(user=present, kind=rules.KIND_LIVE_ATTENDED).points, 150)
        # The first live class ever adds the one-time bonus (owner rules A).
        self.assertEqual(XpEvent.objects.get(user=present, kind=rules.KIND_FIRST_LIVE_BONUS).points, 100)
        self.assertFalse(XpEvent.objects.filter(user=brief).exists())
        self.assertFalse(XpEvent.objects.filter(user=half).exists())
        self.assertEqual(LiveAttendance.objects.get(user=present).on_air_seconds, 3600)
        outbox_handlers.handle_live_ended(SimpleNamespace(payload={"session_id": session.pk}))
        self.assertEqual(XpEvent.objects.filter(user=present).count(), 2)

    def test_live_xp_reads_attendance_records_and_the_short_session_rule(self):
        from apps.attendance.models import AttendanceRecord

        tracked_present, tracked_partial = f.make_user(), f.make_user()
        end = timezone.now()
        # A 30-minute class is a short session: present = 80 % of it (24 minutes).
        session = f.make_realtime_session(status="ended", started_at=end - timedelta(minutes=30), ended_at=end)
        for user, seconds in ((tracked_present, 24 * 60), (tracked_partial, 23 * 60)):
            AttendanceRecord.objects.create(
                session=session, session_ref_id=session.pk, user=user, seconds_present=seconds, first_joined_at=end
            )
            # The legacy engagement row says "enough" for both: attendance wins.
            LiveAttendance.objects.create(session_id=session.pk, user=user, seconds=30 * 60)
        outbox_handlers.handle_live_ended(SimpleNamespace(payload={"session_id": session.pk}))
        self.assertTrue(XpEvent.objects.filter(user=tracked_present, kind=rules.KIND_LIVE_ATTENDED).exists())
        self.assertFalse(XpEvent.objects.filter(user=tracked_partial, kind=rules.KIND_LIVE_ATTENDED).exists())
        # Joined but below the bar: the smaller "joined" XP (owner rules A).
        self.assertEqual(XpEvent.objects.get(user=tracked_partial, kind=rules.KIND_LIVE_PARTIAL).points, 30)

    def test_session_end_publishes_a_delayed_event(self):
        from apps.core.models import OutboxEvent

        session = f.make_realtime_session(status="live", started_at=timezone.now() - timedelta(minutes=30))
        session.status = "ended"
        session.ended_at = timezone.now()
        session.save()
        event = OutboxEvent.objects.get(event_type=signals.EVENT_LIVE_ENDED)
        self.assertGreater(event.available_at, timezone.now() + timedelta(seconds=60))


class ReportRuleTests(EngagementTestCase):
    def setUp(self):
        super().setUp()
        from apps.reports.models import ReportTask

        self.student = f.make_user()
        self.course = f.make_course()
        self.now = timezone.now()
        self.task = ReportTask.objects.create(
            course=self.course, title="Target", due_at=self.now + timedelta(days=1), max_marks=Decimal("10.00"),
            status=ReportTask.STATUS_PUBLISHED,
        )

    def _submit(self, task=None, *, at=None, student=None, key="t"):
        from apps.reports.models import ReportSubmission

        return ReportSubmission.objects.create(
            task=task or self.task, student=student or self.student, target_key=key, status="submitted",
            first_submitted_at=at or self.now, submitted_at=at or self.now,
        )

    def _grade(self, submission, marks):
        from apps.reports.models import ReportGrade

        ReportGrade.objects.create(submission=submission, raw_marks=marks, final_marks=marks, graded_at=timezone.now())
        submission.status = "graded"
        submission.save(update_fields=["status", "updated_at"])

    def test_on_time_submission_earns_40_and_late_30(self):
        from apps.reports.models import ReportTask

        self._submit()
        late_task = ReportTask.objects.create(course=self.course, title="Late", due_at=self.now - timedelta(days=1),
                                              status=ReportTask.STATUS_PUBLISHED)
        self._submit(late_task, key="late")
        drain()
        points = sorted(XpEvent.objects.filter(user=self.student, kind=rules.KIND_REPORT_SUBMITTED).values_list("points", flat=True))
        self.assertEqual(points, [30, 40])
        self.assertTrue(BadgeAward.objects.filter(user=self.student, badge_key="first_report").exists())

    def test_one_submission_xp_per_task(self):
        self._submit(key="a")
        self._submit(key="b")
        drain()
        self.assertEqual(XpEvent.objects.filter(user=self.student, kind=rules.KIND_REPORT_SUBMITTED).count(), 1)

    def test_graded_marks_pay_the_report_bonus_tier(self):
        submission = self._submit()
        self._grade(submission, Decimal("8.00"))
        drain()
        self.assertEqual(XpEvent.objects.get(user=self.student, kind=rules.KIND_REPORT_GRADED).points, 130)

    def test_held_marks_award_on_release(self):
        from apps.reports import services as report_services
        from apps.reports.models import ReportTask

        self.task.marks_visibility = ReportTask.MARKS_ON_RELEASE
        self.task.save()
        submission = self._submit()
        self._grade(submission, Decimal("10.00"))
        drain()
        self.assertFalse(XpEvent.objects.filter(user=self.student, kind=rules.KIND_REPORT_GRADED).exists())
        report_services.release_marks(task=self.task, actor=f.make_admin())
        drain()
        self.assertEqual(XpEvent.objects.get(user=self.student, kind=rules.KIND_REPORT_GRADED).points, 300)
        self.assertTrue(BadgeAward.objects.filter(user=self.student, badge_key="perfect_score").exists())


class ExamRuleTests(EngagementTestCase):
    def test_finalised_results_award_score_percent_and_exam_badges(self):
        from apps.ctf.models import CtfExamResult

        course = f.make_course()
        exam = f.make_ctf_exam(eligible_courses=[course])
        students = [f.make_user() for _ in range(4)]
        scores = [100, 90, 50, 10]
        for rank, (student, score) in enumerate(zip(students, scores, strict=True), 1):
            CtfExamResult.objects.create(exam=exam, user=student, batch_course=course, status="submitted", score=score,
                                         total_points=100, rank=rank)
        exam.status = "closed"
        exam.results_finalized_at = timezone.now()
        exam.save(update_fields=["status", "results_finalized_at", "updated_at"])
        drain()
        points = [XpEvent.objects.get(user=student, kind=rules.KIND_EXAM_FINISHED).points for student in students]
        self.assertEqual(points, [100, 90, 50, 10])
        owned = lambda student: set(BadgeAward.objects.filter(user=student).values_list("badge_key", flat=True))  # noqa: E731
        self.assertTrue({"first_exam", "exam_ace", "perfect_score", "batch_top_3"} <= owned(students[0]))
        self.assertIn("exam_ace", owned(students[1]))
        self.assertIn("batch_top_3", owned(students[2]))
        self.assertNotIn("batch_top_3", owned(students[3]))


# --- badges ------------------------------------------------------------------------------------------------
class BadgeTests(EngagementTestCase):
    def test_catalogue_is_declarative_and_complete(self):
        self.assertGreaterEqual(len(badges.CATALOGUE), 25)
        self.assertEqual(len({badge.key for badge in badges.CATALOGUE}), len(badges.CATALOGUE))
        job_granted = {"podium_week"}  # granted by the weekly close, never by an award
        for badge in badges.CATALOGUE:
            self.assertIn(badge.tier, badges.TIERS)
            self.assertTrue(badge.title and badge.description)
            self.assertTrue(badge.triggers or badge.key in job_granted, badge.key)

    def _award(self, user, kind, points, key, **kwargs):
        return services.award(user.pk, item(kind, points, key, **kwargs))

    def owned(self, user):
        return set(BadgeAward.objects.filter(user=user).values_list("badge_key", flat=True))

    def test_time_of_day_badges(self):
        owl, bird, noon = f.make_user(), f.make_user(), f.make_user()
        self._award(owl, rules.KIND_LECTURE_COMPLETED, 20, "o", occurred_at=ist(2026, 11, 3, 1, 30))
        self._award(bird, rules.KIND_LECTURE_COMPLETED, 20, "b", occurred_at=ist(2026, 11, 3, 6, 15))
        self._award(noon, rules.KIND_LECTURE_COMPLETED, 20, "n", occurred_at=ist(2026, 11, 3, 12, 0))
        self.assertIn("night_owl", self.owned(owl))
        self.assertIn("early_bird", self.owned(bird))
        self.assertFalse({"night_owl", "early_bird"} & self.owned(noon))

    def test_streak_badges(self):
        user = f.make_user()
        for day in range(1, 8):
            self._award(user, rules.KIND_MANUAL, 1, f"s{day}", occurred_at=ist(2026, 10, day))
        self.assertTrue({"streak_3", "streak_7"} <= self.owned(user))
        self.assertNotIn("streak_30", self.owned(user))

    def test_report_ranger_needs_ten_reports(self):
        user = f.make_user()
        for n in range(9):
            self._award(user, rules.KIND_REPORT_SUBMITTED, 30, f"r{n}")
        self.assertNotIn("report_ranger", self.owned(user))
        self._award(user, rules.KIND_REPORT_SUBMITTED, 30, "r9")
        self.assertIn("report_ranger", self.owned(user))

    def test_live_regular_needs_ten_classes(self):
        user = f.make_user()
        for n in range(10):
            self._award(user, rules.KIND_LIVE_ATTENDED, 40, f"live{n}")
        self.assertTrue({"first_live", "live_regular"} <= self.owned(user))
        self.assertNotIn("live_devotee", self.owned(user))

    def test_weekend_comeback_and_xp_badges(self):
        user = f.make_user()
        self._award(user, rules.KIND_MANUAL, 600, "sat", occurred_at=ist(2026, 10, 3))  # Saturday
        self._award(user, rules.KIND_MANUAL, 500, "sun", occurred_at=ist(2026, 10, 4))  # Sunday
        self.assertTrue({"weekend_warrior", "xp_1000"} <= self.owned(user))
        self._award(user, rules.KIND_MANUAL, 1, "back", occurred_at=ist(2026, 10, 14))
        self.assertIn("comeback", self.owned(user))

    def test_badges_are_awarded_once_with_achievements(self):
        user = f.make_user()
        self._award(user, rules.KIND_LECTURE_COMPLETED, 20, "x1")
        self._award(user, rules.KIND_LECTURE_COMPLETED, 20, "x2")
        self.assertEqual(BadgeAward.objects.filter(user=user, badge_key="first_lecture").count(), 1)
        self.assertEqual(Achievement.objects.filter(user=user, kind="badge", key="first_lecture").count(), 1)
        self.assertEqual(EngagementSummary.objects.get(user=user).badges_count, len(self.owned(user)))
        self.assertIsNotNone(BadgeAward.objects.get(user=user, badge_key="first_lecture").awarded_at)

    def test_a_broken_criterion_never_blocks_xp(self):
        user = f.make_user()
        broken = badges.Badge("first_lecture", "x", "x", "bronze", frozenset({rules.KIND_LECTURE_COMPLETED}),
                              lambda ctx: 1 / 0)
        with mock.patch.object(badges, "CATALOGUE", (broken,)):
            result = self._award(user, rules.KIND_LECTURE_COMPLETED, 20, "safe")
        self.assertEqual(result.points, 20)
