"""Monthly OSINT CTF (apps/ctf season_*): scheduling, ranking, ties, reward
granting idempotency, cosmetic expiry, streaks, XP delivery, the public API
(handles only) and the admin preview/finalise flow."""

from __future__ import annotations

from datetime import date, datetime, timedelta

from django.core.cache import cache
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.ctf import season_scheduler
from apps.ctf import season_services as services
from apps.ctf.season_identity import certificate_name, public_name
from apps.profiles.handles import derived_handle
from apps.ctf.season_models import (
    IST,
    CtfSeason,
    CtfSeasonAttempt,
    CtfSeasonAudit,
    CtfSeasonEntry,
    CtfSeasonReward,
    add_months,
)
from tests import factories as f

ON = {"teaching": True, "engagement": True, "monthly_ctf": True}
OFF = {"teaching": True, "engagement": True, "monthly_ctf": False}
ANSWER = "Lantern Quay"


def make_season(*, month=date(2026, 11, 1), opens_at=None, closes_at=None, status=CtfSeason.STATUS_OPEN, **overrides):
    now = timezone.now()
    season = CtfSeason.objects.create(
        slug=overrides.pop("slug", f"{month:%Y-%m}"),
        month=month,
        title=overrides.pop("title", "The Lantern Ledger"),
        brief=overrides.pop("brief", "A harbour photo, a ferry timetable and one missing name."),
        question=overrides.pop("question", "Which quay was the photo taken from?"),
        opens_at=opens_at or now - timedelta(hours=1),
        closes_at=closes_at or now + timedelta(hours=6),
        status=status,
        **overrides,
    )
    services.set_answers(season, [ANSWER, "lantern quay pier"])
    season.refresh_from_db()
    return season


@override_settings(FEATURE_DEFAULT_OVERRIDES=ON)
class _Base(TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()


class AnswerStorageTests(_Base):
    def test_answers_are_peppered_digests_never_plaintext(self):
        season = make_season()
        self.assertEqual(len(season.answer_hashes), 2)
        blob = str(season.answer_hashes) + str(season.answer_rules)
        self.assertNotIn("Lantern", blob)
        self.assertNotIn("lantern", blob)
        self.assertTrue(season.answer_key_id)
        correct, _ = services.check_answer(season, "  LANTERN   quay ")
        self.assertTrue(correct)
        self.assertFalse(services.check_answer(season, "Harbour Gate")[0])

    def test_digest_is_bound_to_the_season(self):
        first = make_season()
        second = make_season(month=date(2026, 12, 1), opens_at=timezone.now() + timedelta(days=30),
                             closes_at=timezone.now() + timedelta(days=31), status=CtfSeason.STATUS_DRAFT)
        self.assertTrue(set(first.answer_hashes).isdisjoint(second.answer_hashes))


class SchedulingTests(_Base):
    def test_schedule_requires_answers_and_a_future_window(self):
        now = timezone.now()
        season = CtfSeason.objects.create(
            slug="2026-12", month=date(2026, 12, 1), title="T", brief="B", question="Q",
            opens_at=now + timedelta(days=1), closes_at=now + timedelta(days=2),
        )
        with self.assertRaises(services.ValidationFailed):
            services.schedule(season)
        services.set_answers(season, ["x"])
        services.schedule(season)
        season.refresh_from_db()
        self.assertEqual(season.status, CtfSeason.STATUS_SCHEDULED)
        self.assertTrue(CtfSeasonAudit.objects.filter(season=season, action="schedule").exists())

    def test_overlapping_windows_are_refused(self):
        now = timezone.now()
        make_season(status=CtfSeason.STATUS_SCHEDULED, opens_at=now + timedelta(days=1), closes_at=now + timedelta(days=5))
        other = make_season(month=date(2026, 12, 1), status=CtfSeason.STATUS_DRAFT,
                            opens_at=now + timedelta(days=4), closes_at=now + timedelta(days=9))
        with self.assertRaises(services.ValidationFailed):
            services.schedule(other)

    def test_scheduler_opens_closes_and_finalises_in_order(self):
        now = timezone.now()
        season = make_season(status=CtfSeason.STATUS_SCHEDULED, opens_at=now + timedelta(minutes=5),
                             closes_at=now + timedelta(hours=2))
        draft = make_season(month=date(2026, 10, 1), status=CtfSeason.STATUS_DRAFT,
                            opens_at=now - timedelta(days=1), closes_at=now + timedelta(days=1))
        self.assertEqual(season_scheduler.run(now)["opened"], 0)
        stats = season_scheduler.run(now + timedelta(minutes=6))
        self.assertEqual(stats["opened"], 1)
        season.refresh_from_db()
        draft.refresh_from_db()
        self.assertEqual(season.status, CtfSeason.STATUS_OPEN)
        self.assertEqual(draft.status, CtfSeason.STATUS_DRAFT, "a draft never opens by itself")
        student = f.make_user()
        services.submit_answer(season, student, ANSWER, now=now + timedelta(minutes=30))
        stats = season_scheduler.run(now + timedelta(hours=3))
        self.assertEqual(stats["closed"], 1)
        self.assertEqual(stats["finalised"], 1)
        season.refresh_from_db()
        self.assertEqual(season.status, CtfSeason.STATUS_FINALISED)
        self.assertIsNone(season.finalised_by)
        self.assertTrue(CtfSeasonReward.objects.filter(season=season, user=student, kind="golden_aura").exists())
        # A second run is a no-op.
        stats = season_scheduler.run(now + timedelta(hours=4))
        self.assertEqual((stats["opened"], stats["closed"], stats["finalised"]), (0, 0, 0))

    def test_manual_finalise_waits_when_auto_finalise_is_off(self):
        now = timezone.now()
        season = make_season(auto_finalise=False, closes_at=now + timedelta(minutes=1))
        season_scheduler.run(now + timedelta(minutes=2))
        season.refresh_from_db()
        self.assertEqual(season.status, CtfSeason.STATUS_CLOSED)
        admin = f.make_admin()
        result = services.finalise(season, actor=admin)
        self.assertTrue(result["finalised"])
        season.refresh_from_db()
        self.assertEqual(season.finalised_by, admin)
        self.assertTrue(CtfSeasonAudit.objects.filter(season=season, action="finalise", actor=admin).exists())

    def test_cannot_finalise_an_open_season(self):
        season = make_season()
        with self.assertRaises(services.Conflict):
            services.finalise(season)

    def test_periodic_hook_publishes_only_when_due_and_switched_on(self):
        now = timezone.now()
        self.assertIsNone(season_scheduler.schedule_tick(now))
        make_season(status=CtfSeason.STATUS_SCHEDULED, opens_at=now - timedelta(minutes=1))
        event = season_scheduler.schedule_tick(now)
        self.assertIsNotNone(event)
        self.assertEqual(event.event_type, season_scheduler.EVENT_TICK)
        with override_settings(FEATURE_DEFAULT_OVERRIDES=OFF):
            self.assertIsNone(season_scheduler.schedule_tick(now))
            self.assertEqual(season_scheduler.run(now), {"skipped": 1})

    def test_tick_handler_runs_through_the_outbox(self):
        now = timezone.now()
        make_season(status=CtfSeason.STATUS_SCHEDULED, opens_at=now - timedelta(minutes=1))
        season_scheduler.schedule_tick(now)
        drain_outbox(batch_size=10)
        self.assertEqual(CtfSeason.objects.get().status, CtfSeason.STATUS_OPEN)


class RankingTests(_Base):
    def setUp(self):
        super().setUp()
        self.opens = timezone.now() - timedelta(hours=10)
        self.season = make_season(opens_at=self.opens, closes_at=self.opens + timedelta(days=2),
                                  wrong_attempt_penalty_seconds=600)

    def play(self, user, minutes, wrong=0):
        for index in range(wrong):
            services.submit_answer(self.season, user, f"wrong {index}", now=self.opens + timedelta(minutes=minutes - 1))
        return services.submit_answer(self.season, user, ANSWER, now=self.opens + timedelta(minutes=minutes))

    def test_score_is_solve_time_plus_penalty_per_wrong_answer(self):
        user = f.make_user()
        result = self.play(user, 30, wrong=2)
        self.assertTrue(result["correct"])
        self.assertEqual(result["solve_seconds"], 1800)
        self.assertEqual(result["score_seconds"], 1800 + 2 * 600)
        self.assertEqual(result["attempts"], 3)
        self.assertEqual(result["wrong_attempts"], 2)

    def test_wrong_answers_can_lose_to_a_slower_clean_solve(self):
        fast_but_sloppy = f.make_user()
        slow_but_clean = f.make_user()
        self.play(fast_but_sloppy, 10, wrong=3)   # 600 + 1800 = 2400
        self.play(slow_but_clean, 30)             # 1800
        board = services.leaderboard(self.season, None)
        self.assertEqual([row["score_seconds"] for row in board["rows"]], [1800, 2400])

    def test_ties_go_to_the_earliest_solve(self):
        early = f.make_user()
        late = f.make_user()
        # early: 20 min + 1 wrong = 1200 + 600 = 1800 ; late: 30 min clean = 1800
        self.play(early, 20, wrong=1)
        self.play(late, 30)
        board = services.leaderboard(self.season, late)
        self.assertEqual([row["score_seconds"] for row in board["rows"]], [1800, 1800])
        self.assertEqual(board["rows"][0]["rank"], 1)
        self.assertFalse(board["rows"][0]["is_me"])
        self.assertTrue(board["rows"][1]["is_me"])
        entries = {entry.user_id: entry for entry in CtfSeasonEntry.objects.all()}
        self.assertEqual(services.rank_of(entries[early.pk]), 1)
        self.assertEqual(services.rank_of(entries[late.pk]), 2)

    def test_exact_ties_fall_back_to_entry_order_and_never_share_a_rank(self):
        users = [f.make_user() for _ in range(3)]
        for user in users:
            self.play(user, 15)
        board = services.leaderboard(self.season, None)
        self.assertEqual([row["rank"] for row in board["rows"]], [1, 2, 3])
        ranks = sorted(services.rank_of(entry) for entry in CtfSeasonEntry.objects.all())
        self.assertEqual(ranks, [1, 2, 3])

    def test_disqualified_entries_leave_the_board(self):
        cheat, honest = f.make_user(), f.make_user()
        self.play(cheat, 5)
        self.play(honest, 50)
        services.disqualify(CtfSeasonEntry.objects.get(user=cheat), actor=f.make_admin(), reason="Shared the flag")
        board = services.leaderboard(self.season, honest)
        self.assertEqual(len(board["rows"]), 1)
        self.assertEqual(board["rows"][0]["rank"], 1)
        self.assertTrue(board["rows"][0]["is_me"])
        with self.assertRaises(services.PermissionDenied):
            services.submit_answer(self.season, cheat, ANSWER, now=self.opens + timedelta(minutes=60))

    def test_viewer_outside_the_top_gets_their_own_row(self):
        users = [f.make_user() for _ in range(4)]
        for minutes, user in enumerate(users, start=1):
            self.play(user, minutes * 10)
        board = services.leaderboard(self.season, users[-1], limit=2)
        self.assertEqual(len(board["rows"]), 2)
        self.assertEqual(board["me"]["rank"], 4)
        self.assertEqual(board["solvers"], 4)

    def test_already_solved_and_attempt_cap(self):
        solver = f.make_user()
        self.play(solver, 5)
        again = services.submit_answer(self.season, solver, "anything", now=self.opens + timedelta(minutes=6))
        self.assertTrue(again["already_solved"])
        self.assertEqual(CtfSeasonAttempt.objects.filter(user=solver).count(), 1)
        CtfSeason.objects.filter(pk=self.season.pk).update(max_attempts=2)
        self.season.refresh_from_db()
        capped = f.make_user()
        for index in range(2):
            services.submit_answer(self.season, capped, f"no {index}", now=self.opens + timedelta(minutes=7))
        with self.assertRaises(services.Conflict):
            services.submit_answer(self.season, capped, ANSWER, now=self.opens + timedelta(minutes=8))

    def test_closed_window_refuses_answers(self):
        user = f.make_user()
        with self.assertRaises(services.Conflict):
            services.submit_answer(self.season, user, ANSWER, now=self.opens + timedelta(days=3))

    def test_staff_answers_are_checked_but_never_recorded(self):
        admin = f.make_admin()
        result = services.submit_answer(self.season, admin, ANSWER)
        self.assertTrue(result["correct"])
        self.assertTrue(result["practice"])
        self.assertFalse(CtfSeasonEntry.objects.filter(user=admin).exists())


class RewardTests(_Base):
    def setUp(self):
        super().setUp()
        self.opens = timezone.now() - timedelta(days=2)
        self.closes = timezone.now() - timedelta(hours=1)
        self.season = make_season(opens_at=self.opens, closes_at=self.closes + timedelta(days=1), solve_xp=100)
        self.users = [f.make_user() for _ in range(12)]
        # users[0] solves first but with 5 wrong answers (score 60 + 3000 = 3060) -> First Blood, not #1.
        for index in range(5):
            services.submit_answer(self.season, self.users[0], f"x{index}", now=self.opens + timedelta(seconds=30))
        services.submit_answer(self.season, self.users[0], ANSWER, now=self.opens + timedelta(minutes=1))
        for index, user in enumerate(self.users[1:], start=1):
            services.submit_answer(self.season, user, ANSWER, now=self.opens + timedelta(minutes=2 + index))
        CtfSeason.objects.filter(pk=self.season.pk).update(closes_at=self.closes)
        self.season.refresh_from_db()
        self.finalised_at = timezone.now()

    def kinds(self, user):
        return set(CtfSeasonReward.objects.filter(season=self.season, user=user).values_list("kind", flat=True))

    def test_reward_matrix(self):
        services.finalise(self.season, now=self.finalised_at)
        champion = self.users[1]
        self.assertEqual(
            self.kinds(champion),
            {"golden_aura", "season_champion", "podium_frame", "podium_trophy", "finalist", "hall_of_fame",
             "certificate", "monthly_operative", "xp"},
        )
        trophy = CtfSeasonReward.objects.get(season=self.season, user=champion, kind="season_champion")
        self.assertEqual(trophy.title, "Season Champion · November 2026")
        self.assertIsNone(trophy.ends_at)
        tiers = dict(
            CtfSeasonReward.objects.filter(season=self.season, kind="podium_trophy").values_list("user_id", "tier")
        )
        self.assertEqual(tiers, {self.users[1].pk: "gold", self.users[2].pk: "silver", self.users[3].pk: "bronze"})
        self.assertEqual(
            self.kinds(self.users[4]),
            {"finalist", "hall_of_fame", "certificate", "monthly_operative", "xp"},
        )
        # users[0] ranks last (score 3060) but solved first.
        self.assertIn("first_blood", self.kinds(self.users[0]))
        self.assertEqual(self.kinds(self.users[0]) - {"first_blood"}, {"monthly_operative", "xp"})
        self.assertEqual(CtfSeasonReward.objects.filter(kind="first_blood").count(), 1)
        self.assertEqual(CtfSeasonReward.objects.filter(kind="certificate").exclude(verify_slug=None).count(), 10)
        ranks = list(CtfSeasonEntry.objects.filter(season=self.season).order_by("final_rank").values_list("final_rank", flat=True))
        self.assertEqual(ranks, list(range(1, 13)))

    def test_finalising_twice_grants_nothing_new(self):
        first = services.finalise(self.season, now=self.finalised_at)
        count = CtfSeasonReward.objects.count()
        second = services.finalise(self.season, now=self.finalised_at + timedelta(minutes=5))
        self.assertTrue(first["finalised"])
        self.assertTrue(second["already"])
        self.assertEqual(second["granted"], 0)
        self.assertEqual(CtfSeasonReward.objects.count(), count)
        self.assertEqual(season_scheduler.run()["finalised"], 0)
        self.assertEqual(CtfSeasonReward.objects.count(), count)
        self.assertEqual(OutboxEvent.objects.filter(event_type=services.EVENT_DELIVER_XP).count(), 1)

    def test_cosmetics_expire_after_the_following_month_and_trophies_stay(self):
        services.finalise(self.season, now=self.finalised_at)
        champion = self.users[1]
        aura = CtfSeasonReward.objects.get(season=self.season, user=champion, kind="golden_aura")
        self.assertEqual(aura.ends_at, datetime(2027, 1, 1, tzinfo=IST))
        during = services.active_cosmetics([champion.pk, self.users[0].pk], now=self.finalised_at + timedelta(minutes=1))
        self.assertTrue(during[champion.pk]["aura"])
        self.assertTrue(during[champion.pk]["frame"])
        self.assertEqual(during[champion.pk]["frame_tier"], "gold")
        self.assertEqual(during[self.users[0].pk]["title"], "First Blood")
        cache.clear()
        after = services.active_cosmetics([champion.pk], now=datetime(2027, 1, 1, 0, 1, tzinfo=IST))
        self.assertFalse(after[champion.pk]["aura"])
        self.assertFalse(after[champion.pk]["frame"])
        trophy = CtfSeasonReward.objects.get(season=self.season, user=champion, kind="season_champion")
        self.assertTrue(trophy.is_active(datetime(2030, 1, 1, tzinfo=IST)))

    def test_revoked_cosmetic_disappears_immediately(self):
        services.finalise(self.season, now=self.finalised_at)
        champion = self.users[1]
        self.assertTrue(services.active_cosmetics([champion.pk])[champion.pk]["aura"])
        aura = CtfSeasonReward.objects.get(season=self.season, user=champion, kind="golden_aura")
        with self.captureOnCommitCallbacks(execute=True):
            services.revoke_reward(aura, actor=f.make_admin(), reason="Rule breach")
        self.assertFalse(services.active_cosmetics([champion.pk])[champion.pk]["aura"])
        self.assertTrue(CtfSeasonAudit.objects.filter(action="revoke").exists())

    def test_cosmetics_are_hidden_while_switched_off(self):
        services.finalise(self.season, now=self.finalised_at)
        with override_settings(FEATURE_DEFAULT_OVERRIDES=OFF):
            self.assertFalse(services.active_cosmetics([self.users[1].pk])[self.users[1].pk]["aura"])

    def test_xp_is_delivered_once_to_the_engagement_ledger(self):
        from apps.engagement.models import XpEvent

        services.finalise(self.season, now=self.finalised_at)
        drain_outbox(batch_size=20)
        self.assertEqual(XpEvent.objects.filter(idempotency_key__startswith="ctf-season:").count(), 12)
        self.assertEqual(CtfSeasonReward.objects.filter(kind="xp", delivered_at__isnull=True).count(), 0)
        CtfSeasonReward.objects.filter(kind="xp").update(delivered_at=None)
        services.deliver_xp()
        self.assertEqual(XpEvent.objects.filter(idempotency_key__startswith="ctf-season:").count(), 12)
        event = XpEvent.objects.get(idempotency_key=f"ctf-season:{self.season.pk}:{self.users[1].pk}")
        self.assertEqual(event.points, 100)

    def test_xp_waits_while_engagement_is_off(self):
        services.finalise(self.season, now=self.finalised_at)
        with override_settings(FEATURE_DEFAULT_OVERRIDES={**ON, "engagement": False}):
            self.assertEqual(services.deliver_xp(), 0)
        self.assertEqual(CtfSeasonReward.objects.filter(kind="xp", delivered_at__isnull=True).count(), 12)
        self.assertEqual(services.deliver_xp(), 12)


class StreakTests(_Base):
    def test_monthly_operative_counts_consecutive_months(self):
        student = f.make_user()
        start = date(2026, 8, 1)
        for offset in range(4):
            month = add_months(start, offset)
            if offset == 1:
                continue  # skipped September
            opens = timezone.now() - timedelta(days=10 - offset)
            season = make_season(month=month, opens_at=opens, closes_at=opens + timedelta(days=1), status=CtfSeason.STATUS_OPEN)
            services.submit_answer(season, student, ANSWER, now=opens + timedelta(minutes=1))
            services.finalise(season, now=opens + timedelta(days=2))
        streaks = dict(
            CtfSeasonReward.objects.filter(user=student, kind="monthly_operative")
            .values_list("season__month", "metadata")
        )
        self.assertEqual(streaks[date(2026, 8, 1)]["streak"], 1)
        self.assertEqual(streaks[date(2026, 10, 1)]["streak"], 1)
        self.assertEqual(streaks[date(2026, 11, 1)]["streak"], 2)


class IdentityTests(TestCase):
    def test_handles_are_stable_and_never_expose_the_name_or_email(self):
        user = f.make_user(full_name="Ayesha Rahman", email="ayesha@example.test")
        handle = public_name(user, real_names=False)
        self.assertEqual(handle, derived_handle(user.pk))
        self.assertEqual(handle, public_name(user, real_names=False))
        self.assertNotIn("Ayesha", handle)
        self.assertNotIn("ayesha", handle.lower())
        # Owner rule (handle only): boards ignore any real-names request;
        # only certificates print the real name.
        self.assertEqual(public_name(user, real_names=True), handle)
        self.assertEqual(certificate_name(user), "Ayesha Rahman")


@override_settings(FEATURE_DEFAULT_OVERRIDES=ON)
class ApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.season = make_season()
        self.student = f.make_user(full_name="Zara Qureshi")

    def url(self, name, *args):
        return reverse(name, args=args)

    def test_switched_off_answers_feature_disabled(self):
        with override_settings(FEATURE_DEFAULT_OVERRIDES=OFF):
            response = self.client.get(self.url("ctf-season-current"))
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["errors"]["code"] if isinstance(response.json().get("errors"), dict) else response.json().get("code", "feature_disabled"), "feature_disabled")
            self.client.force_authenticate(self.student)
            response = self.client.post(self.url("ctf-season-submit", self.season.slug), {"answer": ANSWER}, format="json")
            self.assertEqual(response.status_code, 403)

    def test_current_season_teaser_for_visitors_and_case_file_for_students(self):
        anonymous = self.client.get(self.url("ctf-season-current")).json()["data"]
        self.assertEqual(anonymous["season"]["phase"], "open")
        self.assertIsNone(anonymous["season"]["brief"])
        self.assertFalse(anonymous["season"]["content_visible"])
        self.assertEqual(len(anonymous["rewards"]), 5)
        self.client.force_authenticate(self.student)
        data = self.client.get(self.url("ctf-season-current")).json()["data"]["season"]
        self.assertTrue(data["content_visible"])
        self.assertIn("harbour", data["brief"])
        self.assertTrue(data["can_play"])
        self.assertNotIn("answer_hashes", data)

    def test_submit_and_leaderboard_show_handles_only(self):
        response = self.client.post(self.url("ctf-season-submit", self.season.slug), {"answer": ANSWER}, format="json")
        self.assertIn(response.status_code, (401, 403))
        self.client.force_authenticate(self.student)
        wrong = self.client.post(self.url("ctf-season-submit", self.season.slug), {"answer": "nope"}, format="json")
        self.assertEqual(wrong.status_code, 200)
        self.assertFalse(wrong.json()["data"]["correct"])
        right = self.client.post(self.url("ctf-season-submit", self.season.slug), {"answer": ANSWER}, format="json")
        body = right.json()["data"]
        self.assertTrue(body["correct"])
        self.assertEqual(body["rank"], 1)
        self.assertEqual(body["wrong_attempts"], 1)
        self.client.force_authenticate(None)
        board = self.client.get(self.url("ctf-season-leaderboard", self.season.slug)).json()["data"]
        self.assertEqual(board["rows"][0]["name"], derived_handle(self.student.pk))
        text = str(board)
        self.assertNotIn("Zara", text)
        self.assertNotIn(self.student.email, text)
        self.assertNotIn("user_id", text)

    def test_empty_answer_is_a_validation_error(self):
        self.client.force_authenticate(self.student)
        response = self.client.post(self.url("ctf-season-submit", self.season.slug), {"answer": "  "}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_drafts_are_not_public(self):
        draft = make_season(month=date(2027, 1, 1), status=CtfSeason.STATUS_DRAFT,
                            opens_at=timezone.now() + timedelta(days=40), closes_at=timezone.now() + timedelta(days=41))
        self.assertEqual(self.client.get(self.url("ctf-season-detail", draft.slug)).status_code, 404)

    def test_me_cosmetics_hall_of_fame_and_certificate(self):
        self.client.force_authenticate(self.student)
        self.client.post(self.url("ctf-season-submit", self.season.slug), {"answer": ANSWER}, format="json")
        CtfSeason.objects.filter(pk=self.season.pk).update(closes_at=timezone.now() - timedelta(seconds=1))
        self.season.refresh_from_db()
        with self.captureOnCommitCallbacks(execute=True):
            services.finalise(self.season)
        me = self.client.get(self.url("ctf-season-me")).json()["data"]
        self.assertTrue(me["cosmetics"]["aura"])
        self.assertEqual(me["seasons_solved"], 1)
        self.assertEqual(me["streak_months"], 1 if self.season.month >= add_months(date.today().replace(day=1), -1) else 0)
        self.assertEqual({item["kind"] for item in me["trophies"]}, {"season_champion", "podium_trophy"})
        slug = me["certificates"][0]["certificate_slug"]
        cosmetics = self.client.get(self.url("ctf-season-cosmetics") + f"?user_ids={self.student.pk},999999").json()["data"]
        self.assertTrue(cosmetics["users"][str(self.student.pk)]["aura"])
        self.assertFalse(cosmetics["users"]["999999"]["aura"])
        self.client.force_authenticate(None)
        hof = self.client.get(self.url("ctf-season-hall-of-fame")).json()["data"]["seasons"]
        self.assertEqual(hof[0]["finalists"][0]["name"], derived_handle(self.student.pk))
        certificate = self.client.get(self.url("ctf-season-certificate", slug)).json()["data"]
        self.assertTrue(certificate["valid"])
        self.assertEqual(certificate["rank"], 1)
        with override_settings(FEATURE_DEFAULT_OVERRIDES=OFF):
            self.assertEqual(self.client.get(self.url("ctf-season-certificate", slug)).status_code, 200)
        self.assertEqual(self.client.get(self.url("ctf-season-certificate", "nope")).status_code, 404)

    def test_cosmetics_endpoint_validates_ids(self):
        self.client.force_authenticate(self.student)
        self.assertEqual(self.client.get(self.url("ctf-season-cosmetics") + "?user_ids=1,abc").status_code, 400)
        many = ",".join(str(index) for index in range(1, 102))
        self.assertEqual(self.client.get(self.url("ctf-season-cosmetics") + f"?user_ids={many}").status_code, 400)

    def test_leaderboard_query_count_is_bounded(self):
        for _ in range(15):
            user = f.make_user()
            services.submit_answer(self.season, user, ANSWER)
        cache.clear()
        url = self.url("ctf-season-leaderboard", self.season.slug)
        # Cold: season, top rows (+user), first blood, cosmetics, participants.
        with self.assertNumQueries(5):
            self.client.get(url + "?limit=25")
        # Warm: the shared part comes from the cache.
        with self.assertNumQueries(1):
            self.client.get(url + "?limit=25")

    def test_current_query_count_is_bounded(self):
        self.client.force_authenticate(self.student)
        self.client.get(self.url("ctf-season-current"))
        with self.assertNumQueries(2):
            self.client.get(self.url("ctf-season-current"))


@override_settings(FEATURE_DEFAULT_OVERRIDES=ON)
class AdminTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = f.make_admin()
        self.client.force_login(self.admin)

    def test_admin_creates_a_season_with_hashed_answers(self):
        now = timezone.localtime(timezone.now())
        opens = now + timedelta(days=3)
        closes = now + timedelta(days=10)
        response = self.client.post(
            reverse("admin:ctf_ctfseason_add"),
            {
                "slug": "2027-02", "month": "2027-02-01", "title": "Paper Trail", "tagline": "", "difficulty": "medium",
                "skills": '["GEOINT"]', "brief": "Case", "question": "Where?", "flag_format": "", "materials_url": "",
                "accepted_answers": "Old Port\nold port pier", "answer_rules": "[]",
                "opens_at_0": opens.strftime("%Y-%m-%d"), "opens_at_1": opens.strftime("%H:%M:%S"),
                "closes_at_0": closes.strftime("%Y-%m-%d"), "closes_at_1": closes.strftime("%H:%M:%S"),
                "auto_finalise": "on", "wrong_attempt_penalty_seconds": "600", "max_attempts": "50", "solve_xp": "100",
            },
        )
        self.assertEqual(response.status_code, 302, getattr(response, "context_data", {}) and response.context_data.get("errors"))
        season = CtfSeason.objects.get(slug="2027-02")
        self.assertEqual(len(season.answer_hashes), 2)
        self.assertNotIn("Old Port", str(season.answer_hashes))
        self.assertTrue(CtfSeasonAudit.objects.filter(season=season, action="create").exists())

    def test_reserved_slug_is_refused(self):
        response = self.client.post(reverse("admin:ctf_ctfseason_add"), {"slug": "current", "month": "2027-03-01"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(CtfSeason.objects.filter(slug="current").exists())

    def test_preview_then_finalise(self):
        opens = timezone.now() - timedelta(days=1)
        season = make_season(opens_at=opens, closes_at=opens + timedelta(days=2))
        student = f.make_user()
        services.submit_answer(season, student, ANSWER, now=opens + timedelta(minutes=3))
        url = reverse("admin:ctf_ctfseason_preview", args=[season.pk])
        page = self.client.get(url)
        self.assertEqual(page.status_code, 200)
        self.assertContains(page, "Golden Aura · November 2026")
        self.assertContains(page, derived_handle(student.pk))
        # Not closed yet: finalising is refused.
        self.client.post(url, {"action": "finalise"})
        self.assertFalse(CtfSeasonReward.objects.exists())
        CtfSeason.objects.filter(pk=season.pk).update(closes_at=timezone.now() - timedelta(seconds=1))
        response = self.client.post(url, {"action": "finalise"})
        self.assertEqual(response.status_code, 302)
        season.refresh_from_db()
        self.assertEqual(season.status, CtfSeason.STATUS_FINALISED)
        self.assertEqual(season.finalised_by, self.admin)
        self.assertTrue(CtfSeasonReward.objects.filter(user=student, kind="season_champion").exists())
        self.assertContains(self.client.get(url), "Rewards granted")

    def test_changelists_render(self):
        for name in ("ctfseason", "ctfseasonentry", "ctfseasonreward", "ctfseasonattempt", "ctfseasonaudit"):
            self.assertEqual(self.client.get(reverse(f"admin:ctf_{name}_changelist")).status_code, 200, name)
