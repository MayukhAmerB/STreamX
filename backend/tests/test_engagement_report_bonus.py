"""Report-mark XP tiers (owner, Nov 2026): a graded report pays a tiered bonus on
its score out of 10 (10 = 300, 9 = 200, 8 = 130, 7 = 80, 6 = 40, below 0) on
top of the submission XP (30, or 40 on time). A regrade settles the difference
with ledger correction rows: idempotent per report, never paid twice."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from apps.engagement import history, outbox_handlers, rules, services
from apps.engagement.admin import report_bonus_summary
from apps.engagement.models import BadgeAward, EngagementSummary, XpEvent
from tests import factories as f
from tests.engagement_support import drain, reset_engagement_state


class TierTableTests(SimpleTestCase):
    def test_default_tiers(self):
        self.assertEqual(rules.report_mark_bonus_table(), {10: 300, 9: 200, 8: 130, 7: 80, 6: 40})
        expected = {10: 300, 9: 200, 8: 130, 7: 80, 6: 40, 5: 0, 0: 0}
        for score, points in expected.items():
            with self.subTest(score=score):
                self.assertEqual(rules.report_mark_bonus(score), points)

    def test_score_is_normalised_to_ten_and_rounded_down(self):
        cases = [
            (("10", "10"), 10), (("9.99", "10"), 9), (("9", "10"), 9), (("18", "20"), 9), (("17.9", "20"), 8),
            (("6", "10"), 6), (("5.99", "10"), 5), (("0", "10"), 0), (("12", "10"), 10), (("5", "0"), 0),
        ]
        for (final, maximum), score in cases:
            with self.subTest(final=final, maximum=maximum):
                self.assertEqual(rules.report_score10(Decimal(final), Decimal(maximum)), score)

    @override_settings(ENGAGEMENT_REPORT_MARK_BONUS='{"10": 500, "8": 100}')
    def test_tiers_are_configurable_from_settings(self):
        self.assertEqual(rules.report_mark_bonus(10), 500)
        self.assertEqual(rules.report_mark_bonus(9), 100)
        self.assertEqual(rules.report_mark_bonus(7), 0)
        self.assertIn("10/10 = 500 XP", report_bonus_summary())

    def test_invalid_settings_fall_back_to_the_default_table(self):
        for raw in ("not json", '{"11": 5}', '{"9": -1}', "[1, 2]", '{"x": 1}'):
            with self.subTest(raw=raw), override_settings(ENGAGEMENT_REPORT_MARK_BONUS=raw):
                self.assertEqual(rules.report_mark_bonus(10), 300)

    def test_earn_table_lists_every_tier(self):
        rows = [row for row in rules.earn_table() if row["key"] == rules.KIND_REPORT_GRADED]
        self.assertEqual([row["xp"] for row in rows], [300, 200, 130, 80, 40])
        self.assertTrue(rows[0]["label"].startswith("Report bonus: 10/10"))

    def test_admin_listing(self):
        text = report_bonus_summary()
        self.assertIn("on top of 30 XP, 40 on time", text)
        self.assertIn("10/10 = 300 XP · 9/10 = 200 XP · 8/10 = 130 XP · 7/10 = 80 XP · 6/10 = 40 XP", text)


class ReportBonusFlowTests(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()
        from apps.reports.models import ReportTask

        self.student = f.make_user()
        self.course = f.make_course()
        self.now = timezone.now()
        self.ReportTask = ReportTask
        self.task = self.make_task()
        self.clock = 0

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def make_task(self, *, due_in=timedelta(days=1), max_marks="10.00", title="Target"):
        return self.ReportTask.objects.create(
            course=self.course, title=title, due_at=self.now + due_in, max_marks=Decimal(max_marks),
            status=self.ReportTask.STATUS_PUBLISHED,
        )

    def submit(self, task=None, *, key="t", at=None):
        from apps.reports.models import ReportSubmission

        at = at or self.now
        return ReportSubmission.objects.create(
            task=task or self.task, student=self.student, target_key=key, status="submitted",
            first_submitted_at=at, submitted_at=at,
        )

    def grade(self, submission, marks):
        """Grade, or regrade (a new grading time each call, like the grading form)."""
        from apps.reports.models import ReportGrade

        self.clock += 1
        graded_at = timezone.now() + timedelta(seconds=self.clock * 5)
        ReportGrade.objects.update_or_create(
            submission=submission,
            defaults={"raw_marks": Decimal(marks), "final_marks": Decimal(marks), "graded_at": graded_at},
        )
        submission.status = "graded"
        submission.save(update_fields=["status", "updated_at"])
        drain()

    def bonus_rows(self):
        return list(
            XpEvent.objects.filter(user=self.student, kind=rules.KIND_REPORT_GRADED).order_by("id").values_list("points", flat=True)
        )

    def total(self):
        return EngagementSummary.objects.get(user=self.student).total_xp

    def descriptions(self):
        return [row["description"] for row in history._xp_page(self.student.pk, 1, 100)["items"] if row["source"] == rules.KIND_REPORT_GRADED]

    # --- each tier ----------------------------------------------------------------------------------
    def test_each_tier_pays_its_bonus_on_top_of_the_submission_xp(self):
        expected = {"10": 300, "9.5": 200, "9": 200, "8": 130, "7": 80, "6": 40, "5.5": 0, "0": 0}
        for index, (marks, bonus) in enumerate(expected.items()):
            with self.subTest(marks=marks):
                task = self.make_task(title=f"Week {index}")
                before = self.total() if EngagementSummary.objects.filter(user=self.student).exists() else 0
                submission = self.submit(task, key=f"k{index}")
                self.grade(submission, marks)
                after = self.total()
                paid = XpEvent.objects.filter(
                    user=self.student, kind=rules.KIND_REPORT_GRADED, idempotency_key__startswith=f"report-graded:{submission.pk}"
                )
                self.assertEqual(sum(paid.values_list("points", flat=True)), bonus)
                if bonus == 0:
                    self.assertFalse(paid.exists(), "below the lowest tier: nothing recorded")
                bonus_and_base = after - before
                # 40 on time + the bonus (+ at most one 5 XP streak bonus on a new study day).
                self.assertIn(bonus_and_base - 40 - bonus, (0, rules.STREAK_DAILY_BONUS_XP))

    def test_history_says_report_bonus_with_the_score(self):
        self.grade(self.submit(), "10")
        self.assertEqual(self.descriptions(), ["Report bonus: 10/10"])
        row = next(row for row in history._xp_page(self.student.pk, 1, 100)["items"] if row["source"] == rules.KIND_REPORT_GRADED)
        self.assertEqual((row["source_label"], row["amount"]), ("Report bonus", 300))

    def test_score_is_normalised_from_any_maximum(self):
        task = self.make_task(max_marks="20.00")
        self.grade(self.submit(task), "18")  # 9/10
        self.assertEqual(self.bonus_rows(), [200])
        self.assertEqual(self.descriptions(), ["Report bonus: 9/10"])

    # --- regrades ---------------------------------------------------------------------------------------
    def test_regrade_up_pays_only_the_difference(self):
        submission = self.submit()
        self.grade(submission, "7")
        self.assertEqual(self.bonus_rows(), [80])
        self.grade(submission, "10")
        self.assertEqual(self.bonus_rows(), [80, 220])
        self.assertEqual(sum(self.bonus_rows()), 300)
        self.assertEqual(set(self.descriptions()), {"Report bonus: 7/10", "Report bonus: 10/10 (regraded)"})
        self.assertTrue(BadgeAward.objects.filter(user=self.student, badge_key="perfect_score").exists())

    def test_regrade_down_takes_back_the_difference(self):
        submission = self.submit()
        self.grade(submission, "10")
        total_before = self.total()
        self.grade(submission, "6")
        self.assertEqual(self.bonus_rows(), [300, -260])
        self.assertEqual(self.total(), total_before - 260)
        self.grade(submission, "4")  # below every tier: the bonus goes to 0, never negative
        self.assertEqual(sum(self.bonus_rows()), 0)
        self.assertEqual(self.bonus_rows(), [300, -260, -40])

    def test_regrade_down_then_up_again_settles_each_time(self):
        submission = self.submit()
        for marks, net in (("10", 300), ("7", 80), ("10", 300), ("8", 130)):
            self.grade(submission, marks)
            self.assertEqual(sum(self.bonus_rows()), net, marks)
        self.assertEqual(len(self.bonus_rows()), 4)

    def test_first_grade_below_the_tiers_then_a_regrade_up(self):
        submission = self.submit()
        self.grade(submission, "5")
        self.assertEqual(self.bonus_rows(), [])
        self.grade(submission, "9")
        self.assertEqual(self.bonus_rows(), [200])
        self.assertEqual(self.descriptions(), ["Report bonus: 9/10"])

    # --- idempotency ------------------------------------------------------------------------------------
    def test_replays_never_pay_twice(self):
        submission = self.submit()
        self.grade(submission, "9")
        total = self.total()
        event = SimpleNamespace(payload={"submission_id": submission.pk})
        for _ in range(3):
            outbox_handlers.handle_report_graded(event)
            outbox_handlers.handle_report_submitted(event)
        submission.refresh_from_db()
        services.settle_report_bonus(submission)
        services.settle_report_bonus(submission)
        self.task.marks_released_at = timezone.now()
        self.task.save()
        drain()  # marks released: settles to the same 200
        self.assertEqual(self.bonus_rows(), [200])
        self.assertEqual(self.total(), total)

    def test_held_marks_pay_on_release_once(self):
        from apps.reports import services as report_services

        self.task.marks_visibility = self.ReportTask.MARKS_ON_RELEASE
        self.task.save()
        submission = self.submit()
        self.grade(submission, "8")
        self.assertEqual(self.bonus_rows(), [])
        report_services.release_marks(task=self.task, actor=f.make_admin())
        drain()
        report_services.release_marks(task=self.task, actor=f.make_admin())
        drain()
        self.assertEqual(self.bonus_rows(), [130])

    # --- late submissions ------------------------------------------------------------------------------
    def test_late_submission_keeps_the_base_30_and_earns_the_bonus_on_its_final_marks(self):
        late_task = self.make_task(due_in=-timedelta(days=2), title="Late")
        submission = self.submit(late_task, key="late", at=self.now - timedelta(days=1))
        self.grade(submission, "8")  # final marks after any late penalty
        submitted = XpEvent.objects.get(user=self.student, kind=rules.KIND_REPORT_SUBMITTED)
        self.assertEqual(submitted.points, 30)
        self.assertEqual(self.bonus_rows(), [130])

    # --- badges --------------------------------------------------------------------------------------------
    def test_sharp_analyst_counts_current_scores_after_regrades(self):
        submissions = []
        for index in range(5):
            submission = self.submit(self.make_task(title=f"W{index}"), key=f"s{index}")
            submissions.append(submission)
            self.grade(submission, "9")
            if index == 0:
                self.grade(submission, "6")  # regraded down: no longer a 90 % report
        self.assertFalse(BadgeAward.objects.filter(user=self.student, badge_key="sharp_analyst").exists())
        self.grade(submissions[0], "10")  # back up: five reports at 9/10 or more
        self.assertTrue(BadgeAward.objects.filter(user=self.student, badge_key="sharp_analyst").exists())
