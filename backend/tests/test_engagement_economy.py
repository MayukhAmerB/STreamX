"""XP economy v2 and the level system (owner rules A and B).

* purchases: XP per successful charge scaled by price (subscriptions and
  one-time purchases, capped), idempotent on the charge, reversed pro rata on
  refund, tracked as ``purchase_xp`` and never a study day;
* live classes: present 150, partial 30, first live class ever +100 once;
* standings: weekly close per batch (#1 200, #2-3 120, #4-10 60 + Podium
  Week), monthly all-time top 10 (100), idempotent, hidden students excluded,
  nothing before release day;
* leaderboards with or without purchase XP (setting), both totals exposed;
* the level chart, the level-up notification and the celebration ack.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.core.models import OutboxEvent
from apps.engagement import leaderboard, outbox_handlers, rules, services, signals, standings
from apps.engagement.models import ActivityDay, BadgeAward, EngagementSettings, EngagementSummary, XpEvent
from apps.notifications.models import NotificationRecipient
from apps.payments.models import Payment
from tests import factories as f
from tests.engagement_support import drain, item, reset_engagement_state


class EconomyCase(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def summary(self, user):
        return EngagementSummary.objects.get(user=user)


# --- rules ------------------------------------------------------------------------------------------------
class RuleTests(EconomyCase):
    def test_purchase_formula_scales_with_price_and_rounds_half_up(self):
        self.assertEqual(rules.purchase_xp(Decimal("500.00"), subscription=True), 250)
        self.assertEqual(rules.purchase_xp(Decimal("1649.00"), subscription=True), 825)
        self.assertEqual(rules.purchase_xp(Decimal("0"), subscription=True), 0)
        # One-time purchases are capped (default 1,000 XP per payment).
        self.assertEqual(rules.purchase_xp(Decimal("9999.00"), subscription=False), 1000)
        self.assertEqual(rules.purchase_xp(Decimal("999.00"), subscription=False), 500)

    @override_settings(ENGAGEMENT_PURCHASE_XP_PER_RUPEE="1", ENGAGEMENT_ONE_TIME_PURCHASE_XP_CAP="300",
                       ENGAGEMENT_LIVE_PRESENT_XP="175", ENGAGEMENT_WEEKLY_FIRST_XP="250")
    def test_values_are_tunable_from_settings(self):
        self.assertEqual(rules.purchase_xp(500, subscription=True), 500)
        self.assertEqual(rules.purchase_xp(500, subscription=False), 300)
        self.assertEqual(rules.live_present_xp(), 175)
        self.assertEqual(rules.weekly_standing_xp(1), 250)

    def test_live_and_standing_amounts(self):
        self.assertEqual((rules.live_present_xp(), rules.live_partial_xp(), rules.first_live_bonus_xp()), (150, 30, 100))
        self.assertEqual([rules.weekly_standing_xp(rank) for rank in range(1, 12)],
                         [200, 120, 120, 60, 60, 60, 60, 60, 60, 60, 0])
        self.assertEqual((rules.monthly_standing_xp(10), rules.monthly_standing_xp(11)), (100, 0))
        # Kept: watch and lecture XP.
        self.assertEqual((rules.lecture_xp(), rules.watch_blocks(300), rules.watch_blocks(10 * 3600)), (20, 1, 60))

    def test_level_curve_documented_pace(self):
        # A regular active week (~800 XP) moves up one rank every 2-4 weeks (rules.py docstring).
        gaps = [b.min_xp - a.min_xp for a, b in zip(rules.LEVELS, rules.LEVELS[1:])]
        self.assertEqual(len(rules.LEVELS), 8)
        for gap in gaps:
            self.assertGreaterEqual(gap / 800, 1.5)
            self.assertLessEqual(gap / 800, 4.5)
        self.assertEqual(rules.LEVELS[-1].title, "Elite Operator")


# --- purchases -----------------------------------------------------------------------------------------
class PurchaseTests(EconomyCase):
    def setUp(self):
        super().setUp()
        self.student = f.make_user()

    def charge(self, amount="500.00", **extra):
        fields = {"plan": Payment.PLAN_PLATFORM_SUBSCRIPTION, "razorpay_payment_id": f"pay_{amount}_{extra.get('n', 1)}",
                  "status": Payment.STATUS_PAID, "paid_at": timezone.now(), "amount": Decimal(amount)}
        extra.pop("n", None)
        fields.update(extra)
        return f.make_payment(user=self.student, course=None, **fields)

    def test_subscription_charge_awards_scaled_xp_once(self):
        payment = self.charge("1649.00")
        drain()
        event = XpEvent.objects.get(user=self.student, kind=rules.KIND_SUBSCRIPTION_CHARGE)
        self.assertEqual(event.points, 825)
        self.assertEqual(event.idempotency_key, f"purchase:{payment.razorpay_payment_id}")
        summary = self.summary(self.student)
        self.assertEqual((summary.total_xp, summary.purchase_xp), (825, 825))
        # Replays (webhook retries, re-saves, a duplicate outbox delivery) never pay twice.
        payment.save()
        outbox_handlers.handle_payment_paid(SimpleNamespace(payload={"payment_id": payment.pk}))
        drain()
        self.assertEqual(XpEvent.objects.filter(user=self.student).count(), 1)

    def test_paying_is_not_studying(self):
        self.charge()
        drain()
        self.assertFalse(ActivityDay.objects.filter(user=self.student, is_study_day=True).exists())
        self.assertEqual(self.summary(self.student).current_streak, 0)

    def test_each_monthly_cycle_earns_again(self):
        self.charge("500.00", n=1)
        self.charge("500.00", n=2)
        drain()
        self.assertEqual(self.summary(self.student).purchase_xp, 500)

    def test_one_time_course_purchase_is_capped(self):
        course = f.make_course()
        f.make_payment(user=self.student, course=course, amount=Decimal("4999.00"), status=Payment.STATUS_PAID,
                       razorpay_payment_id="pay_course_1", paid_at=timezone.now())
        drain()
        event = XpEvent.objects.get(user=self.student, kind=rules.KIND_COURSE_PURCHASE)
        self.assertEqual(event.points, rules.ONE_TIME_PURCHASE_XP_CAP)

    def test_refunds_reverse_pro_rata_and_never_twice(self):
        payment = self.charge("1000.00")
        drain()
        self.assertEqual(self.summary(self.student).total_xp, 500)
        payment.amount_refunded = Decimal("400.00")
        payment.save()
        drain()
        self.assertEqual(self.summary(self.student).total_xp, 300)
        payment.amount_refunded = Decimal("1000.00")
        payment.status = Payment.STATUS_REFUNDED
        payment.refunded_at = timezone.now()
        payment.save()
        drain()
        outbox_handlers.handle_payment_refunded(SimpleNamespace(payload={"payment_id": payment.pk}))
        summary = self.summary(self.student)
        self.assertEqual((summary.total_xp, summary.purchase_xp), (0, 0))
        self.assertEqual(XpEvent.objects.filter(user=self.student, kind=rules.KIND_PURCHASE_REFUND).count(), 2)

    def test_a_refund_alone_never_creates_negative_xp(self):
        payment = self.charge("500.00", status=Payment.STATUS_REFUNDED, amount_refunded=Decimal("500.00"))
        drain()
        outbox_handlers.handle_payment_refunded(SimpleNamespace(payload={"payment_id": payment.pk}))
        self.assertFalse(XpEvent.objects.filter(user=self.student).exists())

    def test_guest_payment_and_other_currencies_earn_nothing(self):
        f.make_payment(user=None, course=None, plan=Payment.PLAN_PLATFORM_ONE_TIME, status=Payment.STATUS_PAID,
                       amount=Decimal("500.00"), razorpay_payment_id="pay_guest")
        self.charge("500.00", currency="USD")
        drain()
        self.assertFalse(XpEvent.objects.exists())

    def test_payment_never_breaks_when_engagement_raises(self):
        with mock.patch("apps.engagement.signals.publish", side_effect=RuntimeError("engagement exploded")):
            payment = self.charge("500.00")
        self.assertEqual(Payment.objects.get(pk=payment.pk).status, Payment.STATUS_PAID)

    def test_switch_off_records_nothing(self):
        with override_settings(FEATURE_DEFAULT_OVERRIDES={"engagement": False}):
            reset_engagement_state()
            self.charge("500.00")
        self.assertFalse(OutboxEvent.objects.filter(event_type=signals.EVENT_PAYMENT_PAID).exists())


# --- live classes ----------------------------------------------------------------------------------------
class LiveEconomyTests(EconomyCase):
    def session(self, minutes_ago=120):
        end = timezone.now() - timedelta(minutes=minutes_ago - 60)
        return f.make_realtime_session(status="ended", started_at=end - timedelta(hours=1), ended_at=end)

    def record(self, session, user, seconds):
        from apps.attendance.models import AttendanceRecord

        return AttendanceRecord.objects.create(
            session=session, session_ref_id=session.pk, user=user, seconds_present=seconds,
            first_joined_at=session.started_at,
        )

    def test_present_partial_and_first_live_bonus_once(self):
        present, partial = f.make_user(), f.make_user()
        first = self.session(minutes_ago=300)
        self.record(first, present, 45 * 60)
        self.record(first, partial, 10 * 60)
        outbox_handlers.handle_live_ended(SimpleNamespace(payload={"session_id": first.pk}))
        self.assertEqual(self.summary(present).total_xp, 150 + 100)
        self.assertEqual(self.summary(partial).total_xp, 30 + 100)
        second = self.session(minutes_ago=120)
        self.record(second, present, 50 * 60)
        outbox_handlers.handle_live_ended(SimpleNamespace(payload={"session_id": second.pk}))
        outbox_handlers.handle_live_ended(SimpleNamespace(payload={"session_id": second.pk}))
        live_kinds = (rules.KIND_LIVE_ATTENDED, rules.KIND_FIRST_LIVE_BONUS)
        live_xp = sum(XpEvent.objects.filter(user=present, kind__in=live_kinds).values_list("points", flat=True))
        self.assertEqual(live_xp, 150 + 100 + 150)  # (a streak bonus may join if the classes span two IST days)
        self.assertEqual(XpEvent.objects.filter(user=present, kind=rules.KIND_FIRST_LIVE_BONUS).count(), 1)


# --- standings --------------------------------------------------------------------------------------------
class StandingsTests(EconomyCase):
    def setUp(self):
        super().setUp()
        self.batch = f.make_course()
        self.week = rules.current_week_start() - timedelta(days=7)
        start, _end = standings.week_window(self.week)
        self.in_week = start + timedelta(days=2)
        self.students = []
        for n in range(12):
            user = f.make_user()
            f.make_enrollment(user=user, course=self.batch)
            self.students.append(user)

    def give(self, user, points, key, at=None):
        services.award(user.pk, item(rules.KIND_MANUAL, points, key, occurred_at=at or self.in_week))

    def test_weekly_close_awards_ranks_badges_and_is_idempotent(self):
        for index, user in enumerate(self.students):
            self.give(user, 100 + index, f"w{index}")  # students[-1] is #1
        hidden = self.students[-2]  # would be #2
        EngagementSettings.objects.create(user=hidden, leaderboard_display=EngagementSettings.DISPLAY_HIDDEN)
        stats = standings.close_week(self.week)
        standings.close_week(self.week)  # re-run: nothing new
        points = dict(
            XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_WEEKLY).values_list("user_id", "points")
        )
        ranked = [user for user in reversed(self.students) if user != hidden]
        self.assertEqual(points[ranked[0].pk], 200)
        self.assertEqual((points[ranked[1].pk], points[ranked[2].pk]), (120, 120))
        self.assertEqual({points[user.pk] for user in ranked[3:10]}, {60})
        self.assertNotIn(ranked[10].pk, points)
        self.assertNotIn(hidden.pk, points, "hidden students opted out of the competition")
        self.assertEqual(stats["awards"], 10)
        self.assertEqual(XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_WEEKLY).count(), 10)
        podium = set(BadgeAward.objects.filter(badge_key="podium_week").values_list("user_id", flat=True))
        self.assertEqual(podium, {user.pk for user in ranked[:3]})
        # Standing XP belongs to the closed week and never makes a study day.
        event = XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_WEEKLY).first()
        self.assertEqual(rules.week_start(rules.ist_day(event.occurred_at)), self.week)
        day = ActivityDay.objects.get(user_id=event.user_id, day=rules.ist_day(event.occurred_at))
        self.assertFalse(day.is_study_day)

    def test_weekly_close_ignores_standing_xp_and_purchases_when_configured(self):
        self.give(self.students[0], 100, "learn0")
        services.award(self.students[1].pk, item(rules.KIND_SUBSCRIPTION_CHARGE, 500, "buy1", occurred_at=self.in_week))
        with override_settings(ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP=False):
            standings.close_week(self.week)
        winners = list(XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_WEEKLY).values_list("user_id", "points"))
        self.assertEqual(winners, [(self.students[0].pk, 200)])

    def test_nothing_from_before_release_day(self):
        self.give(self.students[0], 100, "before")
        release = standings.week_window(self.week)[1] + timedelta(hours=1)
        with override_settings(ENGAGEMENT_RELEASE_AT=release.isoformat()):
            self.assertEqual(standings.run_due(), {"weeks": 0, "months": 0})
        self.assertFalse(XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_WEEKLY).exists())

    def test_monthly_close_top_ten_all_time(self):
        month = (rules.ist_day().replace(day=1) - timedelta(days=1)).replace(day=1)
        start, end = standings.month_window(month)
        for index, user in enumerate(self.students):
            self.give(user, 10 + index, f"m{index}", at=start + timedelta(days=3))
        standings.close_month(month)
        standings.close_month(month)
        winners = set(XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_MONTHLY).values_list("user_id", flat=True))
        self.assertEqual(winners, {user.pk for user in self.students[2:]})
        self.assertEqual(set(XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_MONTHLY).values_list("points", flat=True)), {100})

    def test_run_due_respects_the_switches(self):
        with override_settings(ENGAGEMENT_STANDING_AWARDS=False):
            self.assertEqual(standings.run_due(), {"weeks": 0, "months": 0})


# --- leaderboards with or without purchase XP ------------------------------------------------------------
class PurchaseLeaderboardTests(EconomyCase):
    def setUp(self):
        super().setUp()
        self.batch = f.make_course()
        self.learner, self.buyer = f.make_user(), f.make_user()
        for user in (self.learner, self.buyer):
            f.make_enrollment(user=user, course=self.batch)
        services.award(self.learner.pk, item(rules.KIND_MANUAL, 300, "learn"))
        services.award(self.buyer.pk, item(rules.KIND_MANUAL, 100, "learn-b"))
        services.award(self.buyer.pk, item(rules.KIND_SUBSCRIPTION_CHARGE, 500, "buy"))

    def board(self, user):
        client = APIClient()
        client.force_authenticate(user)
        response = client.get("/api/engagement/leaderboard/", {"period": "all"})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def test_default_counts_purchase_xp_and_exposes_both_totals(self):
        data = self.board(self.learner)
        self.assertTrue(data["counts_purchase_xp"])
        self.assertEqual([entry["xp"] for entry in data["entries"]], [600, 300])
        top = data["entries"][0]
        self.assertEqual((top["xp_with_purchases"], top["xp_without_purchases"]), (600, 100))
        self.assertEqual(data["me"]["xp_without_purchases"], 300)

    def test_learning_only_ranking_when_switched(self):
        with override_settings(ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP=False):
            leaderboard.bump_generation([self.batch.pk])
            data = self.board(self.learner)
            self.assertFalse(data["counts_purchase_xp"])
            self.assertEqual([entry["xp"] for entry in data["entries"]], [300, 100])
            self.assertTrue(data["entries"][0]["is_me"])
            self.assertEqual(data["me"]["rank"], 1)

    def test_me_exposes_both_totals(self):
        client = APIClient()
        client.force_authenticate(self.buyer)
        data = client.get("/api/engagement/me/").json()["data"]
        self.assertEqual((data["xp"], data["purchase_xp"], data["xp_without_purchases"]), (600, 500, 100))


# --- levels -------------------------------------------------------------------------------------------------
class LevelSystemTests(EconomyCase):
    def setUp(self):
        super().setUp()
        self.student = f.make_user()
        self.client = APIClient()
        self.client.force_authenticate(self.student)

    def test_level_chart_lists_ranks_unlocks_earning_and_position(self):
        services.award(self.student.pk, item(rules.KIND_MANUAL, 2000, "seed"))
        response = self.client.get("/api/engagement/levels/")
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual([level["key"] for level in data["levels"]], [level.key for level in rules.LEVELS])
        self.assertTrue(all(level["unlocks"] for level in data["levels"]))
        current = [level for level in data["levels"] if level["current"]]
        self.assertEqual([level["key"] for level in current], ["operative"])
        self.assertEqual(data["me"]["xp"], 2000)
        self.assertEqual(data["me"]["xp_to_next_level"], 1500)
        kinds = {row["key"] for row in data["earn"]}
        self.assertTrue({rules.KIND_LIVE_ATTENDED, rules.KIND_SUBSCRIPTION_CHARGE, rules.KIND_LEADERBOARD_WEEKLY} <= kinds)

    def test_level_chart_needs_sign_in(self):
        self.assertIn(APIClient().get("/api/engagement/levels/").status_code, (401, 403))

    def test_level_up_notifies_and_celebrates_once(self):
        with self.captureOnCommitCallbacks(execute=True):
            services.award(self.student.pk, item(rules.KIND_MANUAL, 1600, "up"))
        self.assertTrue(
            NotificationRecipient.objects.filter(user=self.student, notification__kind="level_up").exists()
        )
        me = self.client.get("/api/engagement/me/").json()["data"]
        self.assertTrue(me["level_up"]["pending"])
        self.assertEqual(me["level_up"]["from_level"]["key"], "recruit")
        response = self.client.post("/api/engagement/me/level-seen/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(response.json()["data"]["level_up"]["pending"])
        cache_bust = services.award(self.student.pk, item(rules.KIND_MANUAL, 1, "bump"))
        self.assertTrue(cache_bust.events)
        self.assertFalse(self.client.get("/api/engagement/me/").json()["data"]["level_up"]["pending"])

    def test_history_before_release_neither_notifies_nor_celebrates(self):
        release = timezone.now()
        with override_settings(ENGAGEMENT_RELEASE_AT=release.isoformat()):
            with self.captureOnCommitCallbacks(execute=True):
                services.award(self.student.pk, item(rules.KIND_MANUAL, 1600, "old", occurred_at=release - timedelta(days=30)))
            self.assertFalse(NotificationRecipient.objects.filter(user=self.student).exists())
            self.assertEqual(self.summary(self.student).level_seen, 2)
            self.assertFalse(services.summary_snapshot(self.summary(self.student))["level_up"]["pending"])

    def test_notification_failure_never_breaks_the_award(self):
        with mock.patch("apps.notifications.services.create_notification", side_effect=RuntimeError("down")):
            with self.captureOnCommitCallbacks(execute=True):
                result = services.award(self.student.pk, item(rules.KIND_MANUAL, 1600, "safe"))
        self.assertTrue(result.leveled_up)
        self.assertEqual(self.summary(self.student).total_xp, 1600)
