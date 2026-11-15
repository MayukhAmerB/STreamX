"""Engagement API: /me, leaderboards (DB and Redis paths), settings, staff
actions, public verification, presence, the feature switch, backfill and
read-path query budgets."""

from __future__ import annotations

import io
import json
from datetime import timedelta
from decimal import Decimal

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from apps.core import features
from apps.courses.models import LectureProgress
from apps.engagement import buffer, flush, leaderboard, rules, services
from apps.engagement.models import (
    Achievement,
    BadgeAward,
    EngagementAuditLog,
    EngagementSettings,
    EngagementSummary,
    LiveAttendance,
    XpEvent,
)
from apps.profiles.handles import public_handle
from tests import factories as f
from tests.engagement_support import FakeRedis, drain, item, reset_engagement_state

ME = "/api/engagement/me/"
BOARD = "/api/engagement/leaderboard/"
SETTINGS = "/api/engagement/settings/"


class ApiCase(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()
        self.client = APIClient()

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def as_user(self, user):
        self.client.force_authenticate(user)
        return self.client

    def give(self, user, points, key, **kwargs):
        # The leaderboard write and cache invalidation run on commit.
        with self.captureOnCommitCallbacks(execute=True):
            return services.award(user.pk, item(rules.KIND_MANUAL, points, key, **kwargs))

    def set_display(self, user, mode):
        with self.captureOnCommitCallbacks(execute=True):
            return services.update_settings(user, leaderboard_display=mode)


# --- /me ----------------------------------------------------------------------------------------------
class MeTests(ApiCase):
    def setUp(self):
        super().setUp()
        self.student = f.make_user(full_name="Asha Kumar")
        self.course = f.make_course(title="OSINT Batch 7", batch="B7")
        f.make_enrollment(user=self.student, course=self.course)
        section = f.make_section(course=self.course)
        self.lectures = [f.make_lecture(section=section, video_key="v.mp4", stream_duration_seconds=600) for _ in range(4)]

    def test_shape(self):
        LectureProgress.objects.create(user=self.student, lecture=self.lectures[0], completed=True, max_position_seconds=600,
                                       duration_seconds=600, last_position_seconds=600)
        LectureProgress.objects.create(user=self.student, lecture=self.lectures[1], last_position_seconds=120,
                                       max_position_seconds=120, duration_seconds=600)
        self.give(self.student, 1600, "seed")
        response = self.as_user(self.student).get(ME)
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual(data["xp"], 1600)
        self.assertEqual(data["level"]["key"], "operative")
        self.assertEqual(data["next_level"]["key"], "operator")
        self.assertEqual(data["xp_to_next_level"], 1900)
        self.assertEqual(data["streak"]["current"], 1)
        self.assertEqual(data["progress"][0]["percent"], 25)
        self.assertEqual(data["continue"]["lecture_id"], self.lectures[1].pk)
        self.assertEqual(data["continue"]["position_seconds"], 120)
        self.assertEqual(data["next_milestone"]["remaining_xp"], 1900)
        self.assertEqual(set(data["time"]), {"this_week_seconds", "total_seconds", "week_start"})
        self.assertIn("recent_achievements", data)
        # The new curve: 1,600 XP is Operative and also earns "Thousand Club".
        self.assertIn("level", {row["kind"] for row in data["recent_achievements"]})
        self.assertTrue(response["Cache-Control"].startswith("private"))

    def test_warm_read_is_one_query_and_etag_304(self):
        self.give(self.student, 40, "seed")
        client = self.as_user(self.student)
        first = client.get(ME)  # fills the extras cache
        with self.assertNumQueries(1):
            second = client.get(ME)
        self.assertEqual(second.status_code, 200)
        etag = second["ETag"]
        with self.assertNumQueries(1):
            not_modified = client.get(ME, HTTP_IF_NONE_MATCH=etag)
        self.assertEqual(not_modified.status_code, 304)
        self.assertEqual(first["ETag"], etag)
        self.give(self.student, 5, "more")
        self.assertEqual(client.get(ME, HTTP_IF_NONE_MATCH=etag).status_code, 200)

    def test_cold_read_stays_bounded(self):
        self.give(self.student, 40, "seed")
        with self.assertNumQueries(7):
            self.as_user(self.student).get(ME)

    def test_new_user_without_summary(self):
        response = self.as_user(f.make_user()).get(ME)
        self.assertEqual(response.json()["data"]["xp"], 0)
        self.assertEqual(response.json()["data"]["level"]["key"], "recruit")

    def test_requires_authentication(self):
        self.assertEqual(APIClient().get(ME).status_code, 401)


# --- leaderboards ---------------------------------------------------------------------------------------
class LeaderboardTests(ApiCase):
    def setUp(self):
        super().setUp()
        self.batch = f.make_course(title="Batch A")
        self.other = f.make_course(title="Batch B")
        now = timezone.now()
        self.ann = f.make_user(full_name="Ann Lee")
        self.bob = f.make_user(full_name="Bob Stone")
        self.cy = f.make_user(full_name="Cy Hidden")
        self.dee = f.make_user(full_name="Dee Outsider")
        for user in (self.ann, self.bob, self.cy):
            f.make_enrollment(user=user, course=self.batch)
        f.make_enrollment(user=self.dee, course=self.other)
        # Ann and Bob tie on 100 XP; Bob got there first.
        self.give(self.bob, 100, "bob", occurred_at=now - timedelta(hours=2))
        self.give(self.ann, 100, "ann", occurred_at=now - timedelta(hours=1))
        self.give(self.cy, 500, "cy")
        self.give(self.dee, 900, "dee")
        self.set_display(self.cy, EngagementSettings.DISPLAY_HIDDEN)

    def board(self, user, **params):
        response = self.as_user(user).get(BOARD, params)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def test_scope_ties_privacy_and_handles(self):
        data = self.board(self.ann, period="all")
        self.assertEqual(data["batch"]["id"], self.batch.pk)
        names = [(entry["rank"], entry["display_name"], entry["xp"]) for entry in data["entries"]]
        # Owner privacy rule: handles only; hidden Cy and outsider Dee absent.
        self.assertEqual(names, [(1, public_handle(self.bob), 100), (2, public_handle(self.ann), 100)])
        self.assertEqual(data["entries"][0]["handle"], public_handle(self.bob))
        self.assertNotIn("Bob", json.dumps(data))
        self.assertNotIn("user_id", data["entries"][0])
        self.assertEqual(data["me"]["rank"], 2)
        self.assertTrue(data["entries"][1]["is_me"])

    def test_hidden_user_still_sees_own_rank(self):
        data = self.board(self.cy, period="all")
        self.assertEqual(
            data["me"],
            {"rank": 1, "xp": 500, "xp_with_purchases": 500, "xp_without_purchases": 500, "visible": False,
             "display_name": None, "handle": public_handle(self.cy), "leaderboard_display": "hidden"},
        )
        self.assertEqual(len(data["entries"]), 2)

    def test_retired_name_setting_still_shows_the_handle(self):
        # A row stored before the privacy rule (the migration maps these; be safe anyway).
        EngagementSettings.objects.update_or_create(user=self.bob, defaults={"leaderboard_display": "name"})
        leaderboard.bump_generation([self.batch.pk])
        data = self.board(self.ann, period="all")
        self.assertEqual(data["entries"][0]["display_name"], public_handle(self.bob))
        self.assertNotIn("Bob Stone", json.dumps(data))

    def test_weekly_period_counts_this_week_only(self):
        self.give(self.ann, 30, "old", occurred_at=timezone.now() - timedelta(days=40))
        data = self.board(self.ann, period="week")
        self.assertEqual([entry["xp"] for entry in data["entries"]], [100, 100])
        self.assertEqual(data["week_start"], rules.current_week_start().isoformat())

    def test_cannot_read_another_batch(self):
        response = self.as_user(self.ann).get(BOARD, {"batch": self.other.pk})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["code"], "engagement_batch_not_found")

    def test_invalid_period(self):
        self.assertEqual(self.as_user(self.ann).get(BOARD, {"period": "year"}).status_code, 400)

    def test_cached_and_invalidated_on_xp(self):
        first = self.board(self.ann, period="all")
        self.give(self.ann, 1, "tiebreak")
        second = self.board(self.ann, period="all")
        self.assertEqual(second["entries"][0]["display_name"], public_handle(self.ann))
        self.assertNotEqual(first["entries"][0]["display_name"], second["entries"][0]["display_name"])

    def test_staff_board_any_batch_shows_hidden_flagged(self):
        staff = f.make_admin()
        response = self.as_user(staff).get("/api/engagement/staff/leaderboard/", {"batch": self.batch.pk, "period": "all"})
        self.assertEqual(response.status_code, 200)
        entries = response.json()["data"]["entries"]
        self.assertEqual([(entry["full_name"], entry["hidden"]) for entry in entries][0], ("Cy Hidden", True))
        self.assertEqual(self.as_user(self.ann).get("/api/engagement/staff/leaderboard/", {"batch": self.batch.pk}).status_code, 403)

    def test_instructor_reads_own_batch_without_names(self):
        teacher = self.batch.instructor
        response = self.as_user(teacher).get("/api/engagement/staff/leaderboard/", {"batch": self.batch.pk, "period": "all"})
        self.assertEqual(response.status_code, 200, response.content)
        entries = response.json()["data"]["entries"]
        self.assertEqual([entry["full_name"] for entry in entries], [public_handle(self.bob), public_handle(self.ann)])
        self.assertIsNone(entries[0]["email"])
        self.assertEqual(
            self.as_user(teacher).get("/api/engagement/staff/leaderboard/", {"batch": self.other.pk}).status_code, 403
        )

    def test_read_query_budget(self):
        client = self.as_user(self.ann)
        client.get(BOARD, {"period": "all"})
        with self.assertNumQueries(5):  # batches, summary, settings, my rank, batch titles (board cached)
            client.get(BOARD, {"period": "all"})


class RedisLeaderboardTests(ApiCase):
    def setUp(self):
        super().setUp()
        self.redis = FakeRedis()
        buffer._client_override = self.redis
        self.batch = f.make_course()
        self.users = [f.make_user(full_name=f"Student {n}") for n in range(3)]
        for user in self.users:
            f.make_enrollment(user=user, course=self.batch)

    def test_awards_zadd_and_reads_use_the_sorted_set(self):
        now = timezone.now()
        self.give(self.users[0], 50, "a", occurred_at=now - timedelta(minutes=5))
        self.give(self.users[1], 50, "b", occurred_at=now - timedelta(minutes=9))
        self.give(self.users[2], 10, "c")
        key = leaderboard.zkey(self.batch.pk, leaderboard.PERIOD_ALL)
        self.assertEqual(len(self.redis.data[key]), 3)
        # Never built -> one rebuild under the lock, then served from Redis.
        rows, total, source = leaderboard.top(self.batch.pk, leaderboard.PERIOD_ALL, 10)
        self.assertEqual(source, "redis")
        self.assertEqual([user_id for user_id, _xp in rows], [self.users[1].pk, self.users[0].pk, self.users[2].pk])
        self.assertEqual(total, 3)
        self.assertIn("exists", self.redis.commands)
        summary = EngagementSummary.objects.get(user=self.users[0])
        self.assertEqual(leaderboard.rank_of(self.batch.pk, leaderboard.PERIOD_ALL, self.users[0].pk, summary, visible=True), 2)

    def test_weekly_keys_expire_after_three_weeks(self):
        self.give(self.users[0], 5, "w")
        key = leaderboard.zkey(self.batch.pk, leaderboard.PERIOD_WEEK)
        self.assertEqual(self.redis.ttl[key], 21 * 24 * 3600)

    def test_opt_out_removes_from_set_but_keeps_rank(self):
        self.give(self.users[0], 50, "a")
        self.give(self.users[1], 10, "b")
        leaderboard.rebuild(self.batch.pk, leaderboard.PERIOD_ALL)
        self.set_display(self.users[0], EngagementSettings.DISPLAY_HIDDEN)
        key = leaderboard.zkey(self.batch.pk, leaderboard.PERIOD_ALL)
        self.assertNotIn(str(self.users[0].pk), self.redis.data[key])
        summary = EngagementSummary.objects.get(user=self.users[0])
        self.assertEqual(leaderboard.rank_of(self.batch.pk, leaderboard.PERIOD_ALL, self.users[0].pk, summary, visible=False), 1)
        response = self.as_user(self.users[1]).get(BOARD, {"period": "all"})
        self.assertEqual([entry["xp"] for entry in response.json()["data"]["entries"]], [10])

    def test_rebuild_command(self):
        self.give(self.users[0], 50, "a")
        self.redis.data.clear()
        call_command("engagement_rebuild_leaderboards", "--batch", str(self.batch.pk), stdout=io.StringIO())
        self.assertEqual(len(self.redis.data[leaderboard.zkey(self.batch.pk, leaderboard.PERIOD_ALL)]), 1)

    def test_watch_buffer_uses_hincrby_and_flush_renames(self):
        buffer.incr("watch", f"{self.users[0].pk}:1:{rules.ist_day().isoformat()}", 600)
        self.assertIn("hincrby", self.redis.commands)
        stats = flush.flush_watch()
        self.assertEqual(stats["seconds"], 600)
        self.assertIn("rename", self.redis.commands)
        self.assertEqual(flush.flush_watch()["batches"], 0)
        drain()
        self.assertEqual(XpEvent.objects.get(user=self.users[0], kind=rules.KIND_WATCH_TIME).points, 2)


def test_score_encoding_orders_ties_by_earliest_reach():
    now = timezone.now()
    assert leaderboard.encode(100, now - timedelta(hours=1)) > leaderboard.encode(100, now)
    assert leaderboard.encode(101, now) > leaderboard.encode(100, now - timedelta(days=300))
    assert leaderboard.decode_xp(leaderboard.encode(12345, now)) == 12345


class ScoreEncodingTests(TestCase):
    def test_encoding(self):
        test_score_encoding_orders_ties_by_earliest_reach()


# --- settings ----------------------------------------------------------------------------------------------
class SettingsTests(ApiCase):
    def test_default_patch_and_validation(self):
        user = f.make_user()
        client = self.as_user(user)
        data = client.get(SETTINGS).json()["data"]
        self.assertEqual((data["leaderboard_display"], data["show_on_leaderboards"]), ("handle", True))
        response = client.patch(SETTINGS, {"show_on_leaderboards": False}, format="json")
        self.assertEqual(response.json()["data"]["leaderboard_display"], "hidden")
        response = client.patch(SETTINGS, {"leaderboard_display": "name"}, format="json")
        self.assertEqual(response.json()["data"]["leaderboard_display"], "handle")  # retired value -> handle
        response = client.patch(SETTINGS, {"leaderboard_display": "hidden"}, format="json")
        self.assertEqual(response.json()["data"]["leaderboard_display"], "hidden")
        response = client.patch(SETTINGS, {"leaderboard_display": "handle"}, format="json")
        self.assertEqual(response.json()["data"]["leaderboard_display"], "handle")
        self.assertEqual(client.patch(SETTINGS, {"leaderboard_display": "loud"}, format="json").status_code, 400)
        self.assertEqual(client.patch(SETTINGS, {}, format="json").status_code, 400)


# --- the switch ----------------------------------------------------------------------------------------------
class SwitchTests(ApiCase):
    def test_off_disables_apis_and_hooks_and_keeps_data(self):
        from apps.core.models import OutboxEvent

        student = f.make_user()
        self.give(student, 30, "kept")
        features.set_feature("engagement", False, by=f.make_admin())
        for url in (ME, BOARD, SETTINGS, "/api/engagement/badges/", "/api/engagement/achievements/"):
            response = self.as_user(student).get(url)
            self.assertEqual(response.status_code, 403, url)
            self.assertEqual(response.json()["code"], "feature_disabled")
        lecture = f.make_lecture(video_key="v.mp4", stream_duration_seconds=100)
        LectureProgress.objects.create(user=student, lecture=lecture, completed=True, max_position_seconds=100, duration_seconds=100)
        self.assertFalse(OutboxEvent.objects.filter(event_type__startswith="engagement.").exists())
        self.assertEqual(EngagementSummary.objects.get(user=student).total_xp, 30)
        features.set_feature("engagement", True, by=f.make_admin())
        self.assertEqual(self.as_user(student).get(ME).json()["data"]["xp"], 30)


# --- staff actions -------------------------------------------------------------------------------------------
class StaffTests(ApiCase):
    def test_award_revoke_and_badges_are_audited(self):
        staff, student = f.make_admin(), f.make_user()
        client = self.as_user(staff)
        response = client.post("/api/engagement/staff/xp/", {"user_id": student.pk, "points": 75, "reason": "Helped peers"}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        event_id = response.json()["data"]["id"]
        revoke = client.post(f"/api/engagement/staff/xp/{event_id}/revoke/", {"reason": "Duplicate"}, format="json")
        self.assertEqual(revoke.json()["data"]["points"], -75)
        client.post(f"/api/engagement/staff/xp/{event_id}/revoke/", {"reason": "Duplicate"}, format="json")
        self.assertEqual(EngagementSummary.objects.get(user=student).total_xp, 0)
        self.assertEqual(XpEvent.objects.filter(user=student).count(), 2)
        badge = client.post("/api/engagement/staff/badges/", {"user_id": student.pk, "badge_key": "exam_ace", "action": "award", "reason": "Offline exam"}, format="json")
        self.assertEqual(badge.status_code, 200, badge.content)
        self.assertTrue(Achievement.objects.filter(user=student, kind="badge", key="exam_ace", revoked_at__isnull=True).exists())
        client.post("/api/engagement/staff/badges/", {"user_id": student.pk, "badge_key": "exam_ace", "action": "revoke", "reason": "Mistake"}, format="json")
        self.assertIsNotNone(BadgeAward.objects.get(user=student, badge_key="exam_ace").revoked_at)
        self.assertEqual(EngagementSummary.objects.get(user=student).badges_count, 0)
        actions = list(EngagementAuditLog.objects.order_by("created_at", "id").values_list("action", flat=True))
        self.assertEqual(actions, ["award_xp", "revoke_xp", "award_badge", "revoke_badge"])
        self.assertTrue(all(EngagementAuditLog.objects.values_list("actor_email", flat=True)))

    def test_students_and_bad_input_are_refused(self):
        student = f.make_user()
        client = self.as_user(student)
        self.assertEqual(client.post("/api/engagement/staff/xp/", {"user_id": student.pk, "points": 5, "reason": "me"}, format="json").status_code, 403)
        staff_client = self.as_user(f.make_admin())
        self.assertEqual(staff_client.post("/api/engagement/staff/xp/", {"user_id": student.pk, "points": 0, "reason": "zero"}, format="json").status_code, 400)
        self.assertEqual(staff_client.post("/api/engagement/staff/xp/", {"user_id": student.pk, "points": 5, "reason": ""}, format="json").status_code, 400)
        self.assertEqual(staff_client.post("/api/engagement/staff/badges/", {"user_id": student.pk, "badge_key": "nope", "action": "award", "reason": "why"}, format="json").status_code, 400)


# --- achievements & verification -------------------------------------------------------------------------------
class VerificationTests(ApiCase):
    def setUp(self):
        super().setUp()
        self.student = f.make_user(full_name="Asha Kumar")
        self.give(self.student, 1510, "lvl")
        self.achievement = Achievement.objects.get(user=self.student, key="operative")

    def test_public_verification(self):
        response = APIClient().get(f"/api/engagement/achievements/{self.achievement.slug}/")
        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        # Owner privacy rule: the achievement page shows the handle; the real name
        # is printed only on the certificate (verify_url).
        from apps.profiles.handles import public_handle

        handle = public_handle(self.student)
        self.assertEqual((data["valid"], data["recipient_name"], data["title"]), (True, handle, "Reached Operative"))
        self.assertNotIn("Asha", response.content.decode())
        # The share link is the certificate page (apps.engagement.certificates).
        self.assertTrue(data["verify_url"].endswith(f"/certificates/{data['reference']}"))
        self.assertEqual(APIClient().get("/api/engagement/achievements/not-a-real-slug/").status_code, 404)
        Achievement.objects.filter(pk=self.achievement.pk).update(revoked_at=timezone.now())
        self.assertFalse(APIClient().get(f"/api/engagement/achievements/{self.achievement.slug}/").json()["data"]["valid"])

    def test_slugs_are_unguessable(self):
        slugs = {Achievement.objects.create(user=self.student, kind="badge", key=f"k{n}", title="t").slug for n in range(20)}
        self.assertEqual(len(slugs), 20)
        self.assertTrue(all(len(slug) >= 21 for slug in slugs))

    def test_share_card_png_and_certificate_pdf(self):
        # Certificates are private: only the holder (and staff) may fetch the files.
        self.assertEqual(APIClient().get(f"/api/engagement/achievements/{self.achievement.slug}/card.png").status_code, 404)
        holder = self.as_user(self.achievement.user)
        card = holder.get(f"/api/engagement/achievements/{self.achievement.slug}/card.png")
        self.assertEqual(card.status_code, 200)
        self.assertEqual(card["Content-Type"], "image/png")
        self.assertEqual(Image.open(io.BytesIO(card.content)).size, (1200, 630))
        pdf = holder.get(f"/api/engagement/achievements/{self.achievement.slug}/certificate.pdf")
        self.assertEqual(pdf["Content-Type"], "application/pdf")
        self.assertTrue(pdf.content.startswith(b"%PDF"))

    def test_my_achievements_and_badge_catalogue(self):
        client = self.as_user(self.student)
        mine = client.get("/api/engagement/achievements/").json()["data"]["achievements"]
        self.assertIn(self.achievement.slug, [row["slug"] for row in mine])
        badges = client.get("/api/engagement/badges/").json()["data"]["badges"]
        self.assertGreaterEqual(len(badges), 25)
        self.assertEqual({"key", "title", "description", "tier", "earned", "earned_at"}, set(badges[0]))


# --- live presence ------------------------------------------------------------------------------------------------
class PresenceTests(ApiCase):
    def test_presence_pings_accumulate_and_flush(self):
        student = f.make_user()
        session = f.make_realtime_session(status="live", started_at=timezone.now() - timedelta(minutes=5))
        client = self.as_user(student)
        url = f"/api/engagement/live/{session.pk}/presence/"
        first = client.post(url)
        self.assertEqual(first.json()["data"], {"counted": True, "credited_seconds": 60})
        second = client.post(url)
        self.assertLessEqual(second.json()["data"]["credited_seconds"], 1)
        flush.flush_live()
        self.assertGreaterEqual(LiveAttendance.objects.get(session_id=session.pk, user=student).seconds, 60)
        self.assertEqual(client.post("/api/engagement/live/999999/presence/").status_code, 404)

    def test_not_live_is_not_counted(self):
        session = f.make_realtime_session(status="scheduled")
        response = self.as_user(f.make_user()).post(f"/api/engagement/live/{session.pk}/presence/")
        self.assertEqual(response.json()["data"]["counted"], False)


# --- backfill ----------------------------------------------------------------------------------------------------
class BackfillTests(ApiCase):
    def setUp(self):
        super().setUp()
        from apps.reports.models import ReportGrade, ReportSubmission, ReportTask

        admin = f.make_admin()
        features.set_feature("engagement", False, by=admin)  # history created before the app existed
        self.student = f.make_user()
        course = f.make_course()
        f.make_enrollment(user=self.student, course=course)
        lecture = f.make_lecture(section=f.make_section(course=course), video_key="v.mp4", stream_duration_seconds=900)
        LectureProgress.objects.create(user=self.student, lecture=lecture, completed=True, max_position_seconds=900,
                                       last_position_seconds=900, duration_seconds=900)
        now = timezone.now()
        task = ReportTask.objects.create(course=course, title="T", due_at=now + timedelta(days=1), status="published",
                                         max_marks=Decimal("10"))
        submission = ReportSubmission.objects.create(task=task, student=self.student, status="graded", first_submitted_at=now,
                                                     submitted_at=now)
        ReportGrade.objects.create(submission=submission, final_marks=Decimal("6"), graded_at=now)
        features.set_feature("engagement", True, by=admin)
        features._pending.dirty = False
        features.invalidate_cache()

    def test_dry_run_writes_nothing_then_apply_is_idempotent(self):
        out = io.StringIO()
        call_command("engagement_backfill", "--sleep", "0", stdout=out)
        self.assertIn("DRY RUN", out.getvalue())
        self.assertIn("lecture_completed: 1 event(s), 20 XP", out.getvalue())
        self.assertFalse(XpEvent.objects.exists())
        call_command("engagement_backfill", "--apply", "--sleep", "0", "--chunk-size", "1", stdout=io.StringIO())
        kinds = dict(XpEvent.objects.filter(user=self.student).values_list("kind", "points"))
        self.assertEqual(
            kinds,
            {"lecture_completed": 20, "report_submitted": 40, "report_graded": 30, "watch_time": 3},
        )
        total = EngagementSummary.objects.get(user=self.student).total_xp
        self.assertEqual(total, 93)
        call_command("engagement_backfill", "--apply", "--sleep", "0", stdout=io.StringIO())
        self.assertEqual(EngagementSummary.objects.get(user=self.student).total_xp, total)
        out = io.StringIO()
        call_command("engagement_backfill", "--sleep", "0", stdout=out)
        self.assertIn("users with new XP: 0", out.getvalue())

    def test_resume_starts_after_checkpoint(self):
        call_command("engagement_backfill", "--apply", "--sleep", "0", "--chunk-size", "1", "--max-chunks", "1", stdout=io.StringIO())
        out = io.StringIO()
        call_command("engagement_backfill", "--sleep", "0", "--resume", stdout=out)
        self.assertNotIn("users after id 0", out.getvalue())

    def test_apply_refuses_while_switched_off(self):
        from django.core.management.base import CommandError

        features.set_feature("engagement", False, by=f.make_admin())
        with self.assertRaises(CommandError):
            call_command("engagement_backfill", "--apply", stdout=io.StringIO())


# --- scale ---------------------------------------------------------------------------------------------------------
class ReadPathScaleTests(ApiCase):
    """300 students x 50 ledger rows: reads never touch the ledger."""

    def test_query_counts_do_not_grow_with_the_ledger(self):
        from apps.courses.models import Enrollment

        from django.contrib.auth import get_user_model

        batch = f.make_course()
        user_model = get_user_model()
        user_model.objects.bulk_create(
            [user_model(email=f"scale{n}@factory.test", full_name=f"Scale {n}", password="!") for n in range(300)]
        )
        users = list(user_model.objects.filter(email__startswith="scale").order_by("pk"))
        Enrollment.objects.bulk_create([Enrollment(user=user, course=batch, payment_status="paid") for user in users])
        now = timezone.now()
        XpEvent.objects.bulk_create(
            [
                XpEvent(user=user, kind="manual", source_type="day", points=5, occurred_at=now, idempotency_key=f"s:{user.pk}:{n}")
                for user in users
                for n in range(50)
            ]
        )
        EngagementSummary.objects.bulk_create(
            [EngagementSummary(user=user, total_xp=250 + index, week_start=rules.current_week_start(), weekly_xp=index,
                               xp_reached_at=now, weekly_reached_at=now) for index, user in enumerate(users)]
        )
        client = self.as_user(users[10])
        client.get(ME)
        with self.assertNumQueries(1):
            self.assertEqual(client.get(ME).status_code, 200)
        client.get(BOARD, {"period": "all"})
        with self.assertNumQueries(5):
            data = client.get(BOARD, {"period": "all"}).json()["data"]
        self.assertEqual(data["participants"], 300)
        self.assertEqual(data["entries"][0]["xp"], 549)
        self.assertEqual(data["me"]["rank"], 290)
