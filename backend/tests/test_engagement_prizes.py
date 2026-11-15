"""Weekly/monthly prize rules (owner, Nov 2026) and ``engagement_void_prizes``.

Rules: one prize per student per period (best placement); only published, real
batch courses compete; 150+ learning XP in the period (purchase XP excluded);
batches with fewer than 30 active students pay only the top 3. The command
re-checks a closed period under these rules and voids what no longer qualifies
with reversing ledger rows (never deleting history), revoking Podium Week."""

from __future__ import annotations

import io
from datetime import timedelta
from unittest import mock

from django.core.management import call_command
from django.test import TestCase, override_settings

from apps.engagement import prize_void, rules, services, standings
from apps.engagement.models import Achievement, BadgeAward, EngagementAuditLog, EngagementSummary, XpEvent
from tests import factories as f
from tests.engagement_support import item, reset_engagement_state

OLD_RULES = dict(  # the close as it ran on 16 Nov 2026
    ENGAGEMENT_PRIZE_ONE_PER_STUDENT=False, ENGAGEMENT_PRIZE_MIN_LEARNING_XP="0", ENGAGEMENT_PRIZE_SMALL_BATCH_SIZE="0"
)


class PrizeCase(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()
        self.week = rules.current_week_start() - timedelta(days=7)
        start, _end = standings.week_window(self.week)
        self.in_week = start + timedelta(days=2)
        self.n = 0

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def batch(self, students=0, **course):
        course_row = f.make_course(**course)
        users = [f.make_user() for _ in range(students)]
        for user in users:
            f.make_enrollment(user=user, course=course_row)
        return course_row, users

    def enrol(self, user, course):
        f.make_enrollment(user=user, course=course)

    def give(self, user, points, kind=rules.KIND_MANUAL, at=None):
        self.n += 1
        services.award(user.pk, item(kind, points, f"t{self.n}", occurred_at=at or self.in_week))

    def weekly(self):
        return {
            (int(source.split(":")[0]), user_id): points
            for user_id, source, points in XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_WEEKLY, points__gt=0).values_list(
                "user_id", "source_id", "points"
            )
        }

    def old_close(self, week=None):
        """The pre-rule close: every course competes, no minimum, no small-batch cap, prizes in every batch."""
        with mock.patch.object(standings, "batch_eligibility", return_value=(True, "")), override_settings(**OLD_RULES):
            return standings.close_week(week or self.week)

    def period(self):
        year, number, _ = self.week.isocalendar()
        return f"{year}-W{number:02d}"


class PrizeRuleTests(PrizeCase):
    @override_settings(ENGAGEMENT_PRIZE_SMALL_BATCH_SIZE="0")
    def test_one_prize_per_student_in_the_batch_where_they_placed_best(self):
        first, first_users = self.batch(3)
        second, second_users = self.batch(3)
        star = first_users[0]
        self.enrol(star, second)
        for index, user in enumerate(first_users[1:] + second_users):
            self.give(user, 200 + index)
        self.give(star, 900)  # #1 in both batches
        standings.close_week(self.week)
        paid = self.weekly()
        self.assertEqual(paid[(first.pk, star.pk)], 200)
        self.assertNotIn((second.pk, star.pk), paid, "one prize per student per period")
        # The second batch ranks without them: its own best student is #1.
        best_second = max(second_users, key=lambda user: EngagementSummary.objects.get(user=user).total_xp)
        self.assertEqual(paid[(second.pk, best_second.pk)], 200)
        self.assertEqual(sum(1 for (_batch, user_id) in paid if user_id == star.pk), 1)

    @override_settings(ENGAGEMENT_PRIZE_SMALL_BATCH_SIZE="0")
    def test_best_placement_wins_even_in_the_later_batch(self):
        big, big_users = self.batch(3)
        small, small_users = self.batch(1)
        student = f.make_user()
        self.enrol(student, big)
        self.enrol(student, small)
        for index, user in enumerate(big_users):
            self.give(user, 1000 + index)  # three ahead of the student in `big`
        self.give(small_users[0], 160)
        self.give(student, 500)  # #4 in big, #1 in small
        standings.close_week(self.week)
        paid = self.weekly()
        self.assertEqual(paid[(small.pk, student.pk)], 200)
        self.assertNotIn((big.pk, student.pk), paid)

    def test_one_prize_rule_is_configurable(self):
        first, first_users = self.batch(1)
        second, _ = self.batch(0)
        self.enrol(first_users[0], second)
        self.give(first_users[0], 300)
        with override_settings(ENGAGEMENT_PRIZE_ONE_PER_STUDENT=False):
            standings.close_week(self.week)
        self.assertEqual(set(self.weekly()), {(first.pk, first_users[0].pk), (second.pk, first_users[0].pk)})

    def test_unpublished_test_and_excluded_courses_never_compete(self):
        cases = [
            ({"is_published": False}, {}),
            ({"title": "E2E CERT TEST (hidden, do not publish)"}, {}),
            ({"title": "Sandbox batch"}, {}),
            ({}, "excluded"),
        ]
        for course_fields, mode in cases:
            with self.subTest(course=course_fields or mode):
                reset_engagement_state()
                course, users = self.batch(2, **course_fields)
                for user in users:
                    self.give(user, 400)
                overrides = {"ENGAGEMENT_PRIZE_EXCLUDED_COURSE_IDS": f"{course.pk}, 99999"} if mode else {}
                with override_settings(**overrides):
                    competes, reason = standings.batch_eligibility(course)
                    self.assertFalse(competes)
                    self.assertTrue(reason)
                    self.assertNotIn(course.pk, standings.batch_ids())
                    standings.close_week(self.week)
                self.assertFalse(any(batch == course.pk for batch, _user in self.weekly()))

    def test_real_batch_titles_still_compete(self):
        for title in ("OSINT PROFESSIONAL TRAINING PROGRAM (BATCH III)", "Penetration Testing", "Contest prep"):
            with self.subTest(title=title):
                self.assertTrue(standings.batch_eligibility(f.make_course(title=title))[0])

    def test_minimum_learning_xp_excludes_purchase_xp(self):
        course, (buyer, learner, short) = self.batch(3)
        self.give(buyer, 149)
        self.give(buyer, 900, kind=rules.KIND_SUBSCRIPTION_CHARGE)  # ranks #1 on XP with purchases counted
        self.give(learner, 150)
        self.give(short, 149)
        standings.close_week(self.week)
        paid = self.weekly()
        self.assertEqual(paid, {(course.pk, learner.pk): 200})
        plan = standings.plan_week(self.week)
        self.assertEqual(plan.explain(course.pk, buyer.pk), "149 learning XP in the period (minimum 150)")

    @override_settings(ENGAGEMENT_PRIZE_MIN_LEARNING_XP="10")
    def test_minimum_is_configurable(self):
        course, (user,) = self.batch(1)
        self.give(user, 20)
        standings.close_week(self.week)
        self.assertEqual(self.weekly(), {(course.pk, user.pk): 200})

    def test_small_batches_pay_only_the_top_three(self):
        course, users = self.batch(12)
        for index, user in enumerate(users):
            self.give(user, 200 + index)
        stats = standings.close_week(self.week)
        paid = self.weekly()
        self.assertEqual(sorted(paid.values(), reverse=True), [200, 120, 120])
        self.assertEqual(stats["awards"], 3)
        self.assertEqual(BadgeAward.objects.filter(badge_key="podium_week").count(), 3)
        fourth = sorted(users, key=lambda user: -EngagementSummary.objects.get(user=user).total_xp)[3]
        self.assertIn("small batch (12 active students)", standings.plan_week(self.week).explain(course.pk, fourth.pk))

    def test_batches_of_thirty_pay_the_top_ten(self):
        _course, users = self.batch(30)
        for index, user in enumerate(users):
            self.give(user, 200 + index)
        standings.close_week(self.week)
        self.assertEqual(len(self.weekly()), 10)

    def test_monthly_close_shares_the_rules(self):
        month = (rules.ist_day().replace(day=1) - timedelta(days=1)).replace(day=1)
        start, _end = standings.month_window(month)
        course, users = self.batch(6)
        test_course, test_users = self.batch(1, title="E2E test course")
        for index, user in enumerate(users + test_users):
            self.give(user, 200 + index, at=start + timedelta(days=2))
        self.give(users[0], 10, at=start - timedelta(days=40))
        standings.close_month(month)
        winners = list(XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_MONTHLY).values_list("user_id", "source_id"))
        self.assertEqual(len(winners), 3)  # small batch: top 3
        self.assertTrue(all(source.startswith(f"{course.pk}:") for _user, source in winners))


class VoidPrizesTests(PrizeCase):
    def setUp(self):
        super().setUp()
        # Mirrors the 16 Nov close: one student #1 in two batches with 40 XP, a test-course winner,
        # a small real batch where ranks 4+ were paid.
        self.batch_a, self.a_users = self.batch(5, title="OSINT (BATCH II)")
        self.batch_b, self.b_users = self.batch(1, title="OSINT (BATCH IV)")
        self.test_course, (self.tester,) = self.batch(1, title="E2E CERT TEST (hidden, do not publish)")
        self.double = f.make_user()
        self.enrol(self.double, self.batch_a)
        self.enrol(self.double, self.batch_b)
        for index, user in enumerate(self.a_users):
            self.give(user, 300 + 10 * index)  # a_users[-1] is the best real learner
        self.give(self.b_users[0], 20)
        self.give(self.double, 40)
        self.give(self.tester, 500)
        self.old_close()
        self.before = self.weekly()

    def run_command(self, *args):
        out = io.StringIO()
        call_command("engagement_void_prizes", "--period", self.period(), *args, stdout=out)
        return out.getvalue()

    def test_dry_run_lists_every_prize_and_writes_nothing(self):
        rows_before = XpEvent.objects.count()
        output = self.run_command()
        self.assertIn("DRY RUN", output)
        self.assertEqual(XpEvent.objects.count(), rows_before)
        self.assertFalse(BadgeAward.objects.filter(revoked_at__isnull=False).exists())
        for header in ("user id", "handle", "batch", "XP", "status", "reason"):
            self.assertIn(header, output)
        report = prize_void.void_prizes(self.period())
        self.assertEqual(len(report.rows), len(self.before))
        by_user = {(row.batch_id, row.user_id): row for row in report.rows}
        self.assertEqual(by_user[(self.test_course.pk, self.tester.pk)].reason, "test or hidden course")
        self.assertIn("minimum 150", by_user[(self.batch_b.pk, self.double.pk)].reason)
        self.assertEqual(by_user[(self.batch_a.pk, self.a_users[-1].pk)].status, prize_void.STATUS_KEPT)

    def test_apply_reverses_with_ledger_rows_revokes_podium_and_is_idempotent(self):
        tester_total = EngagementSummary.objects.get(user=self.tester).total_xp
        output = self.run_command("--apply")
        self.assertIn("APPLIED", output)
        reversal = XpEvent.objects.get(user=self.tester, kind=rules.KIND_LEADERBOARD_WEEKLY, points__lt=0)
        original = XpEvent.objects.get(user=self.tester, kind=rules.KIND_LEADERBOARD_WEEKLY, points__gt=0)
        self.assertEqual(reversal.points, -original.points)
        self.assertEqual(reversal.idempotency_key, f"revoke:{original.pk}")
        self.assertEqual(reversal.occurred_at, original.occurred_at)  # stays in the closed week
        self.assertEqual(EngagementSummary.objects.get(user=self.tester).total_xp, tester_total - original.points)
        self.assertTrue(
            EngagementAuditLog.objects.filter(target_user=self.tester, reason=prize_void.VOID_REASON,
                                              action=EngagementAuditLog.ACTION_REVOKE_XP).exists()
        )
        # Podium Week: revoked for the voided podium winners (badge + achievement), kept for real winners.
        for user in (self.tester, self.double, self.b_users[0]):
            award = BadgeAward.objects.get(user=user, badge_key="podium_week")
            self.assertIsNotNone(award.revoked_at, user)
            self.assertIsNotNone(Achievement.objects.get(user=user, kind="badge", key="podium_week").revoked_at)
        self.assertIsNone(BadgeAward.objects.get(user=self.a_users[-1], badge_key="podium_week").revoked_at)
        # Small real batch (6 active): only its top 3 keep their prize.
        kept = {row.user_id for row in prize_void.void_prizes(self.period()).rows if row.status == prize_void.STATUS_KEPT}
        self.assertEqual(kept, {user.pk for user in self.a_users[-3:]})
        # History is never deleted: every original prize row still exists.
        self.assertEqual(XpEvent.objects.filter(kind=rules.KIND_LEADERBOARD_WEEKLY, points__gt=0).count(), len(self.before))
        # Second run: nothing changes.
        rows, badges = XpEvent.objects.count(), BadgeAward.objects.filter(revoked_at__isnull=False).count()
        audits = EngagementAuditLog.objects.count()
        second = self.run_command("--apply")
        self.assertEqual(XpEvent.objects.count(), rows)
        self.assertEqual(BadgeAward.objects.filter(revoked_at__isnull=False).count(), badges)
        self.assertEqual(EngagementAuditLog.objects.count(), audits)
        self.assertIn("voided earlier", second)
        self.assertIn(" 0 to voided", second)

    def test_voided_prize_reads_as_such_in_history_and_never_counts_on_boards(self):
        from apps.engagement import history

        self.run_command("--apply")
        items = history._xp_page(self.tester.pk, 1, 50)["items"]
        self.assertIn("Prize voided: rule change", [row["description"] for row in items])
        # The reversal is standing XP: never ranked, so a re-check ranks the same.
        plan = standings.plan_week(self.week)
        self.assertEqual(plan.learning.get(self.tester.pk), 500)

    def test_a_staff_revoke_after_the_void_is_a_no_op(self):
        self.run_command("--apply")
        original = XpEvent.objects.get(user=self.tester, kind=rules.KIND_LEADERBOARD_WEEKLY, points__gt=0)
        total = EngagementSummary.objects.get(user=self.tester).total_xp
        services.staff_revoke_xp(actor=f.make_admin(), event_id=original.pk, reason="double check")
        self.assertEqual(EngagementSummary.objects.get(user=self.tester).total_xp, total)

    def test_period_formats(self):
        self.assertEqual(prize_void.parse_period("2026-W46")[:2], ("week", self.week.__class__(2026, 11, 9)))
        self.assertEqual(prize_void.parse_period("2026-11-12")[2], "2026-W46")
        self.assertEqual(prize_void.parse_period("2026-10")[0], "month")
        with self.assertRaises(ValueError):
            prize_void.parse_period("last week")
