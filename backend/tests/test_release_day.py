"""Release-day owner decisions: live site figures, the first Monthly CTF season,
legacy rewards for existing students (active definition, idempotency, fairness),
the one-time journey screen, the release epoch and the live-attendance backfill."""

from __future__ import annotations

import io
import json
import os
import tempfile
from datetime import timedelta
from unittest import mock

from apps.engagement import badges, legacy, rules, services
from apps.engagement.badges import AwardedItem
from apps.engagement.models import (
    Achievement,
    ActivityDay,
    BadgeAward,
    Certificate,
    EngagementSummary,
    LegacyGrant,
    XpEvent,
)
from apps.site_media import stats as site_stats
from django.core.cache import cache
from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from tests import factories as f
from tests.engagement_support import reset_engagement_state

LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "release-day-tests"}}


# --- site figures -------------------------------------------------------------------------------
@override_settings(CACHES=LOCMEM)
class SiteStatsTests(TestCase):
    def setUp(self):
        cache.clear()

    def _students(self, n, course):
        for _ in range(n):
            f.make_enrollment(user=f.make_user(), course=course)

    def test_small_figures_are_hidden_and_real_ones_shown(self):
        course = f.make_course()
        self._students(3, course)
        payload = APIClient().get("/api/site/stats/").json()["data"]
        self.assertIsNone(payload["stats"]["students_enrolled"], "3 students is below the minimum: hidden")
        self._students(site_stats.MINIMUMS["students_enrolled"], course)
        site_stats.invalidate()
        payload = APIClient().get("/api/site/stats/").json()["data"]
        self.assertEqual(payload["stats"]["students_enrolled"], 3 + site_stats.MINIMUMS["students_enrolled"])
        self.assertTrue(payload["available"])

    def test_only_paid_students_count_and_staff_never(self):
        course = f.make_course()
        from apps.courses.models import Enrollment

        for _ in range(site_stats.MINIMUMS["students_enrolled"]):
            f.make_enrollment(user=f.make_user(), course=course, payment_status=Enrollment.STATUS_PENDING)
        f.make_enrollment(user=f.make_admin(), course=course)
        self.assertEqual(site_stats.students_enrolled(), 0)

    def test_rating_needs_ten_reviews_and_is_rounded_down(self):
        from apps.courses.experience_models import CourseReview

        course = f.make_course()
        ratings = [5, 5, 5, 5, 5, 5, 4, 4, 4]  # 9 reviews
        for value in ratings:
            CourseReview.objects.create(course=course, student=f.make_user(), rating=value, text="Good.")
        self.assertEqual(site_stats.course_rating(), (None, 9))
        CourseReview.objects.create(course=course, student=f.make_user(), rating=4, text="Good.")  # mean 4.6
        CourseReview.objects.create(course=course, student=f.make_user(), rating=5, text="Good.", status="hidden")
        self.assertEqual(site_stats.course_rating(), (4.6, 10))

    def test_live_classes_need_to_have_gone_on_air(self):
        now = timezone.now()
        host = f.make_instructor()
        for minutes in (5, 45):
            f.make_realtime_session(host=host, status="ended", started_at=now - timedelta(minutes=minutes), ended_at=now)
        f.make_realtime_session(host=host, status="ended", started_at=None, ended_at=now)
        self.assertEqual(site_stats.live_classes_delivered(), 1)

    def test_cached_for_everyone_and_fail_soft(self):
        first = APIClient().get("/api/site/stats/")
        self.assertEqual(first.status_code, 200)
        self.assertIn("max-age=300", first["Cache-Control"])
        with mock.patch.object(site_stats, "students_enrolled", side_effect=AssertionError("must be cached")):
            self.assertEqual(APIClient().get("/api/site/stats/").status_code, 200)
        site_stats.invalidate()
        with mock.patch.object(site_stats, "build_payload", side_effect=RuntimeError("db down")):
            body = APIClient().get("/api/site/stats/").json()["data"]
        self.assertFalse(body["available"])
        self.assertEqual(set(body["stats"]), set(site_stats.STAT_KEYS))

    def test_one_broken_source_blanks_only_itself(self):
        with mock.patch.dict(site_stats.COUNTERS, {"ctf_cases": mock.Mock(side_effect=RuntimeError("x"))}):
            payload, complete = site_stats.build_payload()
        self.assertFalse(complete)
        self.assertIsNone(payload["stats"]["ctf_cases"])

    def test_no_personal_data(self):
        user = f.make_user(full_name="Zebulon Quartermain")
        f.make_enrollment(user=user)
        text = APIClient().get("/api/site/stats/").content.decode()
        self.assertNotIn("Zebulon", text)
        self.assertNotIn(user.email, text)


# --- first Monthly CTF season ---------------------------------------------------------------------
CASE = {
    "month": "2026-12",
    "title": "The Harbour Photograph",
    "brief": "A ferry company posted a photo of a moored ship. Work out which numbered berth it is tied to, "
    "using only public sources.",
    "question": "Which berth is the ship moored at?",
    "accepted_answers": ["Harbour 17"],
}


@override_settings(FEATURE_DEFAULT_OVERRIDES={"monthly_ctf": True}, CTF_ANSWER_PEPPER="release-day-test-pepper-0123456789")
class FirstSeasonCommandTests(TestCase):
    def _file(self, **changes):
        now = timezone.now()
        data = {**CASE, "opens_at": (now + timedelta(days=1)).isoformat(), "closes_at": (now + timedelta(days=3)).isoformat()}
        data.update(changes)
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(data, handle)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def _run(self, *args):
        out = io.StringIO()
        call_command("ctf_first_season", *args, stdout=out)
        return out.getvalue()

    def test_status_says_what_to_do(self):
        out = self._run()
        self.assertIn("Seasons stored: 0", out)
        self.assertIn("Admin > Monthly CTF seasons", out)

    def test_refuses_placeholder_content(self):
        from apps.ctf.season_models import CtfSeason

        with self.assertRaisesMessage(CommandError, "placeholder"):
            self._run("--file", self._file(title="TODO title"), "--apply")
        with self.assertRaisesMessage(CommandError, "brief"):
            self._run("--file", self._file(brief="Short."), "--apply")
        self.assertFalse(CtfSeason.objects.exists())

    def test_dry_run_then_apply_creates_and_schedules_once(self):
        from apps.ctf.season_models import CtfSeason

        path = self._file()
        self.assertIn("Valid.", self._run("--file", path))
        self.assertFalse(CtfSeason.objects.exists(), "the dry run writes nothing")
        self.assertIn("Created and scheduled", self._run("--file", path, "--apply"))
        season = CtfSeason.objects.get()
        self.assertEqual(season.status, CtfSeason.STATUS_SCHEDULED)
        self.assertNotIn("Harbour 17", json.dumps(season.answer_hashes))
        with self.assertRaisesMessage(CommandError, "already exists"):
            self._run("--file", path, "--apply")


# --- legacy rewards ------------------------------------------------------------------------------
@override_settings(CACHES=LOCMEM)
class LegacyBase(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()
        self.now = timezone.now()
        self.release = self.now - timedelta(hours=1)
        self.batch2 = f.make_course(batch="Batch 2")
        self.unnumbered = f.make_course(batch="")

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def enrol(self, user, course, *, days_ago=90):
        from apps.courses.models import Enrollment

        row = f.make_enrollment(user=user, course=course)
        Enrollment.objects.filter(pk=row.pk).update(enrolled_at=self.release - timedelta(days=days_ago))
        return row

    def touch_lecture(self, user, course, *, days_before_release):
        from apps.courses.models import LectureProgress

        lecture = f.make_lecture(section=f.make_section(course=course), video_key="v.mp4", stream_duration_seconds=600)
        progress = LectureProgress.objects.create(user=user, lecture=lecture, last_position_seconds=60)
        LectureProgress.objects.filter(pk=progress.pk).update(updated_at=self.release - timedelta(days=days_before_release))

    def plan_for(self, user, **kwargs):
        return legacy.build_plans([user.pk], self.release, **kwargs)[user.pk]

    def run_command(self, *args):
        out = io.StringIO()
        call_command("engagement_legacy_rewards", "--release-at", self.release.isoformat(), "--sleep", "0", *args, stdout=out)
        return out.getvalue()


class ActiveDefinitionTests(LegacyBase):
    def test_enrolled_now_and_active_in_the_last_30_days_is_active(self):
        user = f.make_user()
        self.enrol(user, self.batch2)
        self.touch_lecture(user, self.batch2, days_before_release=5)
        plan = self.plan_for(user)
        self.assertTrue(plan.current_course)
        self.assertTrue(plan.active)
        self.assertEqual(plan.batches, {2})

    def test_activity_older_than_the_window_is_inactive(self):
        user = f.make_user()
        self.enrol(user, self.batch2)
        self.touch_lecture(user, self.batch2, days_before_release=45)
        self.assertFalse(self.plan_for(user).active)

    @override_settings(ENGAGEMENT_LEGACY_ACTIVE_DAYS=60)
    def test_window_is_a_setting(self):
        user = f.make_user()
        self.enrol(user, self.batch2)
        self.touch_lecture(user, self.batch2, days_before_release=45)
        self.assertTrue(self.plan_for(user).active)

    def test_activity_but_access_expired_is_inactive(self):
        from apps.courses.models import Enrollment

        user = f.make_user()
        row = self.enrol(user, self.batch2)
        Enrollment.objects.filter(pk=row.pk).update(
            access_type=Enrollment.ACCESS_INSTALLMENT, access_expires_at=self.release - timedelta(days=1)
        )
        self.touch_lecture(user, self.batch2, days_before_release=2)
        plan = self.plan_for(user)
        self.assertFalse(plan.current_course)
        self.assertFalse(plan.active)

    def test_recent_sign_in_counts_as_activity(self):
        from django.contrib.auth import get_user_model

        user = f.make_user()
        self.enrol(user, self.batch2)
        get_user_model().objects.filter(pk=user.pk).update(last_login=self.release - timedelta(days=3))
        self.assertTrue(self.plan_for(user).active)

    def test_who_is_a_legacy_student(self):
        early, late, staff, pending = f.make_user(), f.make_user(), f.make_admin(), f.make_user()
        self.enrol(early, self.batch2)
        f.make_enrollment(user=late, course=self.batch2)  # enrolled after release
        self.enrol(staff, self.batch2)
        from apps.courses.models import Enrollment

        f.make_enrollment(user=pending, course=self.batch2, payment_status=Enrollment.STATUS_PENDING)
        self.assertEqual(legacy.legacy_user_ids(self.release), [early.pk])

    def test_course_without_batch_number_earns_no_pioneer_badge(self):
        user = f.make_user()
        self.enrol(user, self.unnumbered)
        plan = self.plan_for(user)
        self.assertEqual(plan.batches, set())
        self.assertIn(self.unnumbered.title[:80], plan.unnumbered)
        self.assertEqual(legacy.batch_number("Batch 12"), 12)
        self.assertIsNone(legacy.batch_number("Spring cohort"))


class GrantTests(LegacyBase):
    def setUp(self):
        super().setUp()
        self.active = f.make_user(full_name="Active Founder")
        self.enrol(self.active, self.batch2)
        self.touch_lecture(self.active, self.batch2, days_before_release=3)
        self.inactive = f.make_user(full_name="Quiet Founder")
        self.enrol(self.inactive, self.batch2, days_ago=200)

    def test_dry_run_writes_nothing_but_reports(self):
        out = self.run_command()
        self.assertIn("legacy_students: 2", out)
        self.assertIn("active: 1", out)
        self.assertIn("founding_operative: 1", out)
        self.assertIn("Dry run", out)
        self.assertFalse(BadgeAward.objects.exists())
        self.assertFalse(LegacyGrant.objects.exists())
        self.assertNotIn("Active Founder", out, "the report never prints real names")

    def test_report_is_written_to_a_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "review.txt")
            self.run_command("--report", path)
            with open(path, encoding="utf-8") as handle:
                self.assertIn("XP distribution", handle.read())

    def test_inactive_get_badges_only(self):
        self.run_command("--apply")
        keys = set(BadgeAward.objects.filter(user=self.inactive).values_list("badge_key", flat=True))
        self.assertEqual(keys, {"founding_member", "batch_pioneer_2"})
        self.assertFalse(Achievement.objects.filter(user=self.inactive).exists())
        self.assertFalse(Certificate.objects.filter(user=self.inactive).exists())
        grant = LegacyGrant.objects.get(user=self.inactive)
        self.assertEqual(grant.cohort, LegacyGrant.COHORT_INACTIVE)
        self.assertIsNone(grant.glow_ends_at)

    def test_active_get_the_highest_rewards(self):
        self.run_command("--apply")
        keys = set(BadgeAward.objects.filter(user=self.active).values_list("badge_key", flat=True))
        self.assertEqual(keys, {"founding_member", "batch_pioneer_2", "founding_operative"})
        self.assertEqual(badges.get("founding_operative").tier, badges.TIER_PLATINUM)
        certificate = Certificate.objects.get(user=self.active)
        self.assertEqual(certificate.heading, "Certificate of Founding Membership")
        self.assertEqual(certificate.recipient_name, "Active Founder", "certificates carry the real name")
        self.assertEqual(certificate.issued_at, self.release)
        grant = LegacyGrant.objects.get(user=self.active)
        self.assertEqual(grant.cohort, LegacyGrant.COHORT_ACTIVE)
        self.assertEqual(grant.glow_ends_at - grant.glow_starts_at, timedelta(days=30))
        self.assertTrue(grant.glow_active())
        self.assertEqual(EngagementSummary.objects.get(user=self.active).badges_count, 3)

    def test_graduates_get_badge_and_special_certificate(self):
        try:
            from apps.certification.models import HallOfFameEntry
        except ImportError:  # pragma: no cover
            self.skipTest("certification app not installed")
        entry = HallOfFameEntry.objects.create(user=self.inactive, batch_label="Batch 2")
        HallOfFameEntry.objects.filter(pk=entry.pk).update(created_at=self.release - timedelta(days=30))
        self.run_command("--apply")
        self.assertTrue(BadgeAward.objects.filter(user=self.inactive, badge_key="founding_graduate").exists())
        certificate = Certificate.objects.get(user=self.inactive)
        self.assertEqual(certificate.heading, "Founding Graduate Certificate")

    def test_graduates_file_by_email(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "graduates.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(f"{self.inactive.email.upper()}\nnobody@example.test\n")
            out = self.run_command("--apply", "--graduates-file", path)
        self.assertIn("Graduate e-mails with no account: 1", out)
        self.assertTrue(LegacyGrant.objects.get(user=self.inactive).graduate)

    def test_idempotent(self):
        self.run_command("--apply")
        before = (BadgeAward.objects.count(), Achievement.objects.count(), Certificate.objects.count(), LegacyGrant.objects.count())
        out = self.run_command("--apply")
        after = (BadgeAward.objects.count(), Achievement.objects.count(), Certificate.objects.count(), LegacyGrant.objects.count())
        self.assertEqual(before, after)
        self.assertIn("granted_new_badges: 0", out)
        self.assertEqual(EngagementSummary.objects.get(user=self.active).badges_count, 3)

    def test_apply_before_release_is_refused(self):
        with self.assertRaisesMessage(CommandError, "future"):
            call_command(
                "engagement_legacy_rewards", "--release-at", (self.now + timedelta(days=2)).isoformat(), "--apply",
                stdout=io.StringIO(),
            )

    def test_streaks_restart_and_weekly_counts_only_post_release(self):
        today = rules.ist_day(self.now)
        old_days = [today - timedelta(days=offset) for offset in range(40, 30, -1)]  # a 10-day streak long ago
        for day in old_days:
            ActivityDay.objects.create(user=self.active, day=day, xp=10, is_study_day=True)
        EngagementSummary.objects.create(
            user=self.active, total_xp=500, weekly_xp=400, week_start=rules.current_week_start(self.now),
            current_streak=10, best_streak=4, last_study_day=old_days[-1],
        )
        XpEvent.objects.create(
            user=self.active, kind=rules.KIND_MANUAL, source_type="staff", points=500,
            occurred_at=self.release - timedelta(minutes=5), idempotency_key="old-xp",
        )
        self.run_command("--apply")
        summary = EngagementSummary.objects.get(user=self.active)
        self.assertEqual(summary.best_streak, 10, "the historical best streak is recorded")
        self.assertEqual(summary.current_streak, 0, "streaks start fresh on release day")
        self.assertIsNone(summary.freeze_week, "this week's free freeze is available")
        self.assertEqual(summary.weekly_xp, 0, "the weekly leaderboard starts at zero")
        self.assertEqual(summary.total_xp, 500, "all-time keeps the history")


class JourneyTests(LegacyBase):
    def test_shown_once_to_legacy_students_only(self):
        student = f.make_user()
        self.enrol(student, self.batch2)
        self.run_command("--apply")
        client = APIClient()
        client.force_authenticate(student)
        body = client.get("/api/engagement/journey/").json()["data"]
        self.assertTrue(body["show"])
        journey = body["journey"]
        self.assertEqual(journey["cohort"], "inactive")
        self.assertIn("founding_member", {badge["key"] for badge in journey["badges"]})
        self.assertIn("level", journey)
        self.assertEqual(client.post("/api/engagement/journey/dismiss/").status_code, 200)
        self.assertFalse(client.get("/api/engagement/journey/").json()["data"]["show"])

        newcomer = f.make_user()
        client.force_authenticate(newcomer)
        self.assertEqual(client.get("/api/engagement/journey/").json()["data"], {"show": False, "journey": None})


# --- release epoch, completion dates, live backfill ------------------------------------------------------
@override_settings(CACHES=LOCMEM)
class EpochTests(TestCase):
    def setUp(self):
        reset_engagement_state()
        self.user = f.make_user()
        self.now = timezone.now()

    def tearDown(self):
        reset_engagement_state()

    def _item(self, key, when):
        return AwardedItem(kind=rules.KIND_MANUAL, points=50, key=key, source_type="staff", occurred_at=when)

    def test_history_never_counts_on_the_weekly_board_or_the_streak(self):
        release = self.now - timedelta(minutes=30)
        with override_settings(ENGAGEMENT_RELEASE_AT=release.isoformat()):
            yesterday = self.now - timedelta(days=1)
            services.award_many(self.user.pk, [self._item("a", yesterday), self._item("b", self.now)], force=True)
        summary = EngagementSummary.objects.get(user=self.user)
        self.assertEqual(summary.total_xp, 100)
        if rules.week_start(rules.ist_day(yesterday)) == rules.current_week_start(self.now):
            self.assertEqual(summary.weekly_xp, 50)
        self.assertEqual(summary.current_streak, 1, "yesterday (before release) does not extend the streak")

    def test_without_epoch_nothing_changes(self):
        yesterday = self.now - timedelta(days=1)
        services.award_many(self.user.pk, [self._item("a", yesterday), self._item("b", self.now)], force=True)
        self.assertEqual(EngagementSummary.objects.get(user=self.user).current_streak, 2)


@override_settings(CACHES=LOCMEM)
class CompletionDateTests(TestCase):
    def setUp(self):
        reset_engagement_state()

    def tearDown(self):
        reset_engagement_state()

    def test_course_completion_is_dated_on_the_real_completion(self):
        user = f.make_user()
        course = f.make_course()
        section = f.make_section(course=course)
        lectures = [f.make_lecture(section=section, video_key="v.mp4") for _ in range(2)]
        done_at = timezone.now() - timedelta(days=100)
        items = [
            AwardedItem(kind=rules.KIND_LECTURE_COMPLETED, points=20, key=f"lec:{user.pk}:{lec.pk}", source_type="lecture",
                        source_id=str(lec.pk), occurred_at=done_at - timedelta(days=index))
            for index, lec in enumerate(lectures)
        ]
        services.award_many(user.pk, items, force=True)
        achievement = Achievement.objects.get(user=user, kind=Achievement.KIND_COURSE)
        self.assertEqual(achievement.earned_at, done_at)
        from apps.engagement.certificates import ensure_for_achievement

        self.assertEqual(ensure_for_achievement(achievement).issued_at, done_at)


@override_settings(CACHES=LOCMEM)
class LiveBackfillTests(TestCase):
    def setUp(self):
        reset_engagement_state()

    def tearDown(self):
        reset_engagement_state()

    def _record(self, user, session, **fields):
        from apps.attendance.models import AttendanceRecord

        defaults = {
            "session": session, "session_ref_id": session.pk, "user": user, "status": AttendanceRecord.STATUS_PRESENT,
            "source": AttendanceRecord.SOURCE_PRESENCE, "seconds_present": 2700, "on_air_seconds": 3600,
            "first_joined_at": session.started_at, "finalized_at": session.ended_at,
        }
        defaults.update(fields)
        return AttendanceRecord.objects.create(**defaults)

    def test_only_reliable_join_logs_earn_live_xp(self):
        from apps.attendance.models import AttendanceRecord

        now = timezone.now()
        host = f.make_instructor()
        sessions = [
            f.make_realtime_session(host=host, status="ended", started_at=now - timedelta(days=d, hours=1),
                                    ended_at=now - timedelta(days=d))
            for d in (10, 9, 8)
        ]
        logged, partial, overridden = f.make_user(), f.make_user(), f.make_user()
        self._record(logged, sessions[0])
        self._record(logged, sessions[1])
        self._record(partial, sessions[0], status=AttendanceRecord.STATUS_PARTIAL, seconds_present=600)
        self._record(overridden, sessions[2], source=AttendanceRecord.SOURCE_MANUAL, manual_override=True)
        call_command("engagement_backfill", "--apply", "--kinds", "live", "--sleep", "0", "--force", stdout=io.StringIO())
        kinds = list(XpEvent.objects.filter(user=logged).values_list("kind", flat=True))
        self.assertEqual(sorted(kinds).count(rules.KIND_LIVE_ATTENDED), 2)
        self.assertEqual(kinds.count(rules.KIND_FIRST_LIVE_BONUS), 1)
        self.assertTrue(XpEvent.objects.filter(user=partial, kind=rules.KIND_LIVE_PARTIAL).exists())
        self.assertFalse(XpEvent.objects.filter(user=overridden).exists(), "staff entries are not join logs")
        before = XpEvent.objects.count()
        call_command("engagement_backfill", "--apply", "--kinds", "live", "--sleep", "0", "--force", stdout=io.StringIO())
        self.assertEqual(XpEvent.objects.count(), before, "idempotent")


