"""Phase 3 self-service weekly reports: normaliser vectors, IST week boundaries,
target uniqueness (409 open-existing / near-duplicate / limit), async virus
scan (fail closed), submit + undo + idempotency, grader queue signals, the
scheduler's exactly-once notifications and the expand/contract migration."""

import random
import shutil
import tempfile
import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from apps.core import textnorm
from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.notifications.models import Notification, NotificationRecipient
from apps.reports import housekeeping, scheduler, services, weekly
from apps.reports.models import (
    PENDING_PREFIX,
    SCAN_CLEAN,
    SCAN_INFECTED,
    ReportFile,
    ReportNoticeLog,
    ReportPolicy,
    ReportQuarantineRecord,
    ReportSubmission,
    ReportTask,
)
from apps.reports.storage import private_report_storage
from apps.reports.weeks import penalty_percent, previous_week, selectable_weeks, week_for, week_starting
from django.contrib.auth.models import Group
from django.core.cache import cache
from django.db import IntegrityError, connection
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from tests import factories as f
from tests import report_files as rf

IST = ZoneInfo("Asia/Kolkata")
MARKER = b"STREAMX-TEST-VIRUS"


def ist(year, month, day, hour=0, minute=0, second=0, microsecond=0):
    return datetime(year, month, day, hour, minute, second, microsecond, tzinfo=IST)


class Policy:
    """A plain stand-in for ReportPolicy in the pure week tests."""

    def __init__(self, **overrides):
        self.due_weekday = overrides.get("due_weekday", 6)
        self.due_time = overrides.get("due_time", time(23, 59))
        self.grace_hours = overrides.get("grace_hours", 48)
        self.late_penalty_percent_per_day = overrides.get("late_penalty_percent_per_day", Decimal("10"))


# ---------------------------------------------------------------------------
# Normaliser vectors
# ---------------------------------------------------------------------------
class TargetKeyTests(SimpleTestCase):
    SAME_AS_ACME = [
        "Acme",
        "acme",
        "ACME",
        "  Acme  ",
        "Acme Pvt Ltd",
        "Acme Pvt. Ltd.",
        "ACME Private Limited",
        "Acme Ltd",
        "Acme Limited",
        "Acme, Inc.",
        "Acme Inc",
        "Acme Incorporated",
        "Acme LLC",
        "Acme L.L.C.",
        "Acme Corp.",
        "Acme Corporation",
        "Acme Co.",
        "Acme GmbH",
        "Acme PLC",
        "The Acme Company",
        "ＡＣＭＥ",  # full-width (NFKC)
        "Acme​",  # zero-width space
        "acme\tpvt\nltd",
    ]

    def test_variants_share_one_key(self):
        for value in self.SAME_AS_ACME:
            with self.subTest(value=value):
                self.assertEqual(textnorm.target_key(value), "acme")

    def test_distinct_targets_stay_distinct(self):
        vectors = {
            "Tata Consultancy Services": "tata consultancy services",
            "Café Coffee Day": "cafe coffee day",
            "The Company": "the company",
            "Limited Edition Labs": "limited edition labs",
            "Company Watch": "company watch",
            "@acme_hq": "@acme_hq",
            "J.P. Morgan": "jp morgan",
            "AC/DC": "ac dc",
            "Elon Musk": "elon musk",
            "123 Industries Pvt Ltd": "123 industries",
        }
        for value, expected in vectors.items():
            with self.subTest(value=value):
                self.assertEqual(textnorm.target_key(value), expected)

    def test_profile_platform_paths_keep_their_identity(self):
        # Review finding: different people on one platform must not collide as
        # exact duplicates (a hard 409 the student cannot override).
        keys = {
            "facebook.com/john": "facebook.com/john",
            "https://www.facebook.com/jane/": "facebook.com/jane",
            "m.facebook.com/profile.php?id=123#about": "facebook.com/profile.php?id=123",
            "linkedin.com/in/john-doe": "linkedin.com/in/john-doe",
            "https://github.com/torvalds": "github.com/torvalds",
            "facebook.com": "facebook.com",
        }
        for value, expected in keys.items():
            with self.subTest(value=value):
                self.assertEqual(textnorm.target_key(value), expected)
        self.assertNotEqual(textnorm.target_key("facebook.com/john"), textnorm.target_key("facebook.com/jane"))
        self.assertNotEqual(
            textnorm.target_key("facebook.com/profile.php?id=123"), textnorm.target_key("facebook.com/profile.php?id=456")
        )
        # A company site's pages are still the company (see test_textnorm_target_keys).
        self.assertEqual(textnorm.target_key("https://acme.com/about-us"), "acme.com")

    def test_empty_and_symbol_only(self):
        self.assertEqual(textnorm.target_key(""), "")
        self.assertEqual(textnorm.target_key("   "), "")
        self.assertEqual(textnorm.target_key("!!!"), "")

    def test_clean_display_keeps_case_but_drops_controls(self):
        self.assertEqual(textnorm.clean_display("  Acme‮  Pvt\x00 Ltd "), "Acme Pvt Ltd")
        self.assertEqual(len(textnorm.clean_display("x" * 500)), 200)

    def test_trigram_similarity_matches_pg_trgm(self):
        # Values computed with PostgreSQL 16 pg_trgm similarity().
        self.assertAlmostEqual(textnorm.trigram_similarity("word", "two words"), 0.363636, places=5)
        self.assertAlmostEqual(textnorm.trigram_similarity("acme", "acme"), 1.0)
        self.assertEqual(textnorm.trigram_similarity("", "acme"), 0.0)
        self.assertAlmostEqual(textnorm.trigram_similarity("acme corp", "acme crop"), 0.428571, places=5)

    def test_near_duplicates(self):
        rows = [(1, "globex systems"), (2, "globex system"), (3, "initech"), (4, "glo bex systems"), (5, "acme")]
        found = dict(textnorm.near_duplicates("globex systems", rows))
        self.assertIn(2, found)  # trigram >= 0.6 / one typo
        self.assertIn(4, found)  # same without spaces
        self.assertNotIn(1, found)  # identical keys are exact duplicates, not near ones
        self.assertNotIn(3, found)
        self.assertIn(7, dict(textnorm.near_duplicates("acme crop", [(7, "acme corp")])))  # transposition
        self.assertEqual(textnorm.near_duplicates("acme", [(8, "acmf")]), [])  # too short for typo rule

    def test_ctf_rules_are_unchanged(self):
        from apps.ctf import answers

        samples = ["  Héllo   World ", "https://www.Example.com/", "@handle", "«quoted»", "۱۲۳-45", "ＡＢＣ"]
        for rules in (None, list(textnorm.RULE_NAMES)[:6], ["nfkc", "strip_diacritics", "digits_only"]):
            for sample in samples:
                with self.subTest(rules=rules, sample=sample):
                    self.assertEqual(answers.normalize(sample, rules), textnorm.normalize(sample, rules))
        with self.assertRaises(ValueError):
            textnorm.validate_rules(["nope"])


# ---------------------------------------------------------------------------
# IST week boundaries (property + edge tests)
# ---------------------------------------------------------------------------
class WeekBoundaryTests(SimpleTestCase):
    def test_sunday_2359_is_on_time_and_monday_is_next_week(self):
        policy = Policy()
        sunday_end = ist(2026, 11, 15, 23, 59, 59, 999999)
        week = week_for(policy, sunday_end)
        self.assertEqual(week.week_start, date(2026, 11, 9))
        self.assertEqual(week.due_at, sunday_end)
        self.assertEqual(week.status_at(sunday_end), "open")
        self.assertEqual(week.minutes_late(sunday_end), 0)

        monday = ist(2026, 11, 16, 0, 0)
        nxt = week_for(policy, monday)
        self.assertEqual(nxt.week_start, date(2026, 11, 16))
        self.assertEqual(week.status_at(monday), "late")
        self.assertEqual(week.days_late(monday), 1)
        self.assertEqual(penalty_percent(policy, week.days_late(monday)), Decimal("10"))

    def test_grace_window_and_penalty_days(self):
        policy = Policy()
        week = week_for(policy, ist(2026, 11, 12, 12))
        cases = [
            (ist(2026, 11, 15, 23, 59, 30), "open", 0),
            (ist(2026, 11, 16, 0, 0, 1), "late", 1),
            (ist(2026, 11, 16, 23, 59, 59), "late", 1),
            (ist(2026, 11, 17, 0, 0, 1), "late", 2),
            (ist(2026, 11, 17, 23, 59, 59, 999999), "late", 2),
            (ist(2026, 11, 18, 0, 0, 0, 1), "closed", 3),
        ]
        for at, status, days in cases:
            with self.subTest(at=at):
                self.assertEqual(week.status_at(at), status)
                self.assertEqual(week.days_late(at), days)
        self.assertEqual(penalty_percent(policy, 2), Decimal("20"))
        self.assertEqual(penalty_percent(Policy(late_penalty_percent_per_day=Decimal("60")), 2), Decimal("100"))

    def test_selectable_weeks_offer_last_week_only_in_grace(self):
        policy = Policy()
        tuesday = ist(2026, 11, 17, 10)
        choices = selectable_weeks(policy, tuesday)
        self.assertEqual(choices["current"].week_start, date(2026, 11, 16))
        self.assertEqual(choices["previous"].week_start, date(2026, 11, 9))
        wednesday = ist(2026, 11, 18, 0, 0, 1)
        self.assertIsNone(selectable_weeks(policy, wednesday)["previous"])
        self.assertIsNone(selectable_weeks(Policy(grace_hours=0), ist(2026, 11, 16, 0, 1))["previous"])

    def test_utc_instants_are_bucketed_in_ist(self):
        # Sunday 18:29:59 UTC == Sunday 23:59:59 IST; 18:30 UTC == Monday 00:00 IST.
        policy = Policy()
        utc = ZoneInfo("UTC")
        self.assertEqual(week_for(policy, datetime(2026, 11, 15, 18, 29, 59, tzinfo=utc)).week_start, date(2026, 11, 9))
        self.assertEqual(week_for(policy, datetime(2026, 11, 15, 18, 30, 0, tzinfo=utc)).week_start, date(2026, 11, 16))

    def test_property_every_instant_falls_in_exactly_one_week(self):
        rng = random.Random(20261114)
        start = ist(2026, 1, 1)
        for policy in (Policy(), Policy(due_weekday=4, due_time=time(18, 0)), Policy(due_weekday=0, grace_hours=0)):
            for _ in range(400):
                at = start + timedelta(seconds=rng.randrange(0, 400 * 24 * 3600))
                week = week_for(policy, at)
                with self.subTest(policy=vars(policy), at=at):
                    self.assertLess(week.opens_at, at)
                    self.assertLessEqual(at, week.due_at)
                    self.assertEqual(week.due_at.astimezone(IST).weekday(), policy.due_weekday)
                    self.assertEqual((week.week_end - week.week_start).days, 6)
                    self.assertEqual(week_starting(policy, week.week_start), week)
                    self.assertEqual(previous_week(policy, week).due_at, week.due_at - timedelta(days=7))

    def test_week_numbers_count_from_course_start(self):
        policy = Policy()
        anchor = date(2026, 11, 4)  # a Wednesday: its week (Mon 2 Nov) is week 1
        self.assertEqual(week_for(policy, ist(2026, 11, 3), anchor=anchor).number, 1)
        self.assertEqual(week_for(policy, ist(2026, 11, 16, 9), anchor=anchor).number, 3)
        self.assertIsNone(week_for(policy, ist(2026, 10, 20), anchor=anchor).number)
        self.assertEqual(week_for(policy, ist(2026, 11, 16, 9), anchor=anchor).label(), "Week 3 · 16–22 Nov")
        self.assertEqual(week_for(policy, ist(2026, 11, 30, 9)).label(), "Week of 30 Nov – 6 Dec")


# ---------------------------------------------------------------------------
# API and services
# ---------------------------------------------------------------------------
class SelfServiceTestCase(APITestCase):
    def setUp(self):
        cache.clear()  # throttle buckets
        self.private_root = tempfile.mkdtemp(prefix="reports-ss-")
        self.quarantine_root = tempfile.mkdtemp(prefix="reports-ss-q-")
        self._override = override_settings(
            REPORTS_PRIVATE_ROOT=self.private_root,
            REPORTS_QUARANTINE_ROOT=self.quarantine_root,
            REPORTS_MIN_FREE_BYTES=0,
            REPORTS_ANTIVIRUS_SCANNER="fake",
        )
        self._override.enable()
        self.instructor = f.make_instructor()
        self.course = f.make_course(instructor=self.instructor, title="OSINT Pro")
        self.policy = ReportPolicy.objects.create(course=self.course, self_service=True)
        self.student = f.make_user(full_name="Asha Rao")
        self.other = f.make_user(full_name="Ravi Kumar")
        f.make_enrollment(user=self.student, course=self.course)
        f.make_enrollment(user=self.other, course=self.course)

    def tearDown(self):
        self._override.disable()
        shutil.rmtree(self.private_root, ignore_errors=True)
        shutil.rmtree(self.quarantine_root, ignore_errors=True)

    # helpers -----------------------------------------------------------
    def as_user(self, user):
        self.client.force_authenticate(user)

    def week(self):
        self.as_user(self.student)
        response = self.client.get(reverse("reports-me-week"))
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["data"]

    def create_target(self, name, user=None, **extra):
        self.as_user(user or self.student)
        return self.client.post(
            reverse("reports-me-targets"), {"course": self.course.pk, "target_name": name, **extra}, format="json"
        )

    def upload(self, target_id, file=None):
        return self.client.post(
            reverse("reports-me-target-files", args=[target_id]), {"file": file or rf.pdf()}, format="multipart"
        )

    def submit(self, target_id, key=None, **body):
        return self.client.post(
            reverse("reports-me-target-submit", args=[target_id]),
            body,
            format="json",
            HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()),
        )

    def deliver(self):
        OutboxEvent.objects.update(available_at=timezone.now() - timedelta(seconds=1))
        return drain_outbox(batch_size=100)

    def ready_target(self, name="Acme Pvt Ltd", user=None):
        response = self.create_target(name, user=user)
        self.assertEqual(response.status_code, 201, response.data)
        target_id = response.data["data"]["id"]
        upload = self.upload(target_id)
        self.assertEqual(upload.status_code, 202, upload.data)
        self.deliver()
        return target_id

    def submitted(self, name="Acme Pvt Ltd", user=None):
        target_id = self.ready_target(name, user=user)
        response = self.submit(target_id)
        self.assertEqual(response.status_code, 201, response.data)
        return ReportSubmission.objects.get(pk=target_id)


class MyWeekTests(SelfServiceTestCase):
    def test_week_payload_for_self_service_course(self):
        data = self.week()
        state = data["courses"][0]
        self.assertTrue(state["enabled"])
        self.assertEqual(state["reason"], "")
        current = state["weeks"][0]
        self.assertEqual(current["which"], "current")
        self.assertIsNone(current["slots_left"])  # no cap by default
        self.assertEqual(current["targets"], [])
        due = datetime.fromisoformat(current["due_at"].replace("Z", "+00:00")).astimezone(IST)
        self.assertEqual((due.weekday(), due.hour, due.minute), (6, 23, 59))
        self.assertEqual(state["rules"]["grace_hours"], 48)
        self.assertEqual(state["rules"]["marks_visibility"], "on_grade")

    def test_course_with_reports_off_gives_a_reason(self):
        self.policy.self_service = False
        self.policy.save()
        state = self.week()["courses"][0]
        self.assertFalse(state["enabled"])
        self.assertEqual(state["reason"], "Reports are not enabled for this course.")
        response = self.create_target("Acme")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "reports_disabled")

    def test_no_policy_is_disabled_and_strangers_get_404(self):
        other_course = f.make_course(title="Other")
        f.make_enrollment(user=self.student, course=other_course)
        titles = {state["course"]["title"]: state for state in self.week()["courses"]}
        self.assertFalse(titles["Other"]["enabled"])
        stranger = f.make_user()
        self.assertEqual(self.create_target("Acme", user=stranger).status_code, 404)

    def test_get_does_not_create_week_tasks(self):
        self.week()
        self.assertFalse(ReportTask.objects.filter(origin=ReportTask.ORIGIN_AUTO).exists())


class TargetCreationTests(SelfServiceTestCase):
    def test_zero_admin_action_acceptance_flow(self):
        target_id = self.ready_target("Acme Pvt Ltd")
        response = self.submit(target_id)
        self.assertEqual(response.status_code, 201, response.data)
        target = response.data["data"]["target"]
        self.assertEqual(target["status"], "submitted")
        self.assertFalse(target["is_late"])
        self.assertIsNotNone(target["undo_until"])
        task = ReportTask.objects.get(origin=ReportTask.ORIGIN_AUTO)
        self.assertEqual(task.status, ReportTask.STATUS_PUBLISHED)
        self.assertEqual(task.week_start.weekday(), 0)

        duplicate = self.create_target("acme")
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(duplicate.data["code"], "duplicate_target")
        self.assertEqual(duplicate.data["errors"]["existing"]["id"], target_id)

        other = self.create_target("Globex Systems")
        self.assertEqual(other.status_code, 201, other.data)
        targets = self.week()["courses"][0]["weeks"][0]["targets"]
        self.assertEqual([item["target_name"] for item in targets], ["Acme Pvt Ltd", "Globex Systems"])

    def test_other_students_can_report_the_same_target(self):
        self.submitted("Acme Pvt Ltd")
        self.assertEqual(self.create_target("ACME", user=self.other).status_code, 201)

    def test_near_duplicate_needs_confirmation_and_is_stored(self):
        self.assertEqual(self.create_target("Globex Systems").status_code, 201)
        response = self.create_target("Globex Sytsems")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "similar_target")
        self.assertEqual(response.data["errors"]["suggestions"][0]["target_name"], "Globex Systems")
        confirmed = self.create_target("Globex Sytsems", confirm_different=True)
        self.assertEqual(confirmed.status_code, 201)
        row = ReportSubmission.objects.get(pk=confirmed.data["data"]["id"])
        self.assertTrue(row.different_target_confirmed)
        self.assertEqual(row.similar_targets, ["Globex Systems"])

    def test_failed_similarity_sql_falls_back_without_aborting_the_transaction(self):
        # Review finding: on PostgreSQL a failing similarity() query (pg_trgm in
        # another schema, a statement timeout) aborts the whole transaction, so
        # create_target's INSERT raised instead of using the Python fallback.
        # Emulate PostgreSQL: the failing statement poisons the innermost atomic
        # block, exactly as an aborted transaction refuses further queries.
        from django.db import OperationalError, transaction

        failures = []

        def postgres_like(execute, sql, params, many, context):
            if "similarity(" in sql:
                failures.append(sql)
                transaction.set_rollback(True)
                raise OperationalError("canceling statement due to statement timeout")
            return execute(sql, params, many, context)

        self.assertEqual(self.create_target("Globex Systems").status_code, 201)
        with (
            mock.patch.object(weekly, "_pg_trgm_installed", return_value=True),
            connection.execute_wrapper(postgres_like),
        ):
            similar = self.create_target("Globex Sytsems")
            self.assertEqual(similar.status_code, 409, similar.data)
            self.assertEqual(similar.data["code"], "similar_target")
            self.assertEqual(similar.data["errors"]["suggestions"][0]["target_name"], "Globex Systems")
            unrelated = self.create_target("Initech")
            self.assertEqual(unrelated.status_code, 201, unrelated.data)
            confirmed = self.create_target("Globex Sytsems", confirm_different=True)
            self.assertEqual(confirmed.status_code, 201, confirmed.data)
        self.assertEqual(len(failures), 3)  # the database path really ran and failed each time
        self.assertEqual(
            sorted(ReportSubmission.objects.filter(student=self.student).values_list("target_name", flat=True)),
            ["Globex Systems", "Globex Sytsems", "Initech"],
        )

    def test_max_targets_per_week(self):
        self.policy.max_targets_per_week = 2
        self.policy.save()
        self.assertEqual(self.create_target("Acme").status_code, 201)
        self.assertEqual(self.create_target("Initech").status_code, 201)
        response = self.create_target("Umbrella")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "target_limit")
        self.assertEqual(self.week()["courses"][0]["weeks"][0]["slots_left"], 0)

    def test_invalid_names(self):
        for name in ("", " ", "x", "!!!"):
            with self.subTest(name=name):
                response = self.create_target(name)
                self.assertEqual(response.status_code, 400, response.data)

    def test_previous_week_only_during_grace(self):
        monday = ist(2026, 11, 16, 9)
        submission = weekly.create_target(
            course=self.course, student=self.student, target_name="Acme", week="previous", now=monday
        )
        self.assertEqual(submission.task.week_start, date(2026, 11, 9))
        thursday = ist(2026, 11, 19, 9)
        with self.assertRaises(Exception) as caught:
            weekly.create_target(
                course=self.course, student=self.student, target_name="Initech", week="previous", now=thursday
            )
        self.assertEqual(getattr(caught.exception, "code", ""), "week_closed")

    def test_week_task_race_recovers(self):
        now = timezone.now()
        week = week_for(self.policy, now)
        first = weekly.ensure_week_task(self.course, self.policy, week, now=now)
        # The second caller missed the row on its read and hit the constraint on insert.
        with mock.patch.object(weekly.ReportTask.objects, "filter") as patched:
            patched.return_value.first.return_value = None
            second = weekly.ensure_week_task(self.course, self.policy, week, now=now)
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(ReportTask.objects.filter(origin=ReportTask.ORIGIN_AUTO).count(), 1)

    def test_partial_constraint_allows_admin_tasks_same_week(self):
        week = week_for(self.policy, timezone.now())
        weekly.ensure_week_task(self.course, self.policy, week)
        ReportTask.objects.create(course=self.course, title="Extra", due_at=week.due_at, week_start=week.week_start)
        with self.assertRaises(IntegrityError):
            ReportTask.objects.create(
                course=self.course,
                title="Dup",
                due_at=week.due_at,
                week_start=week.week_start,
                origin=ReportTask.ORIGIN_AUTO,
            )

    def test_duplicate_insert_race_is_a_409(self):
        self.assertEqual(self.create_target("Acme").status_code, 201)
        task = ReportTask.objects.get(origin=ReportTask.ORIGIN_AUTO)
        real_filter = ReportSubmission.objects.filter

        def stale_filter(*args, **kwargs):
            # The concurrent request's row is invisible to this request's read.
            if kwargs.get("task") == task and kwargs.get("student") == self.student and len(kwargs) == 2:
                return real_filter(pk=-1)
            return real_filter(*args, **kwargs)

        with mock.patch.object(ReportSubmission.objects, "filter", side_effect=stale_filter):
            with self.assertRaises(Exception) as caught:
                weekly.create_target(course=self.course, student=self.student, target_name="ACME Ltd")
        self.assertEqual(getattr(caught.exception, "code", ""), "duplicate_target")


class AsyncScanTests(SelfServiceTestCase):
    def test_upload_is_pending_until_scanned_then_clean(self):
        target_id = self.create_target("Acme").data["data"]["id"]
        response = self.upload(target_id)
        self.assertEqual(response.status_code, 202, response.data)
        data = response.data["data"]
        self.assertTrue(data["scan_pending"])
        self.assertEqual(data["scan_status"], "unscanned")
        item = ReportFile.objects.get(pk=data["id"])
        self.assertTrue(item.file.name.startswith(PENDING_PREFIX))
        # Never downloadable, never submittable before the scan.
        self.assertEqual(self.client.get(reverse("reports-file-download", args=[item.pk])).status_code, 409)
        blocked = self.submit(target_id)
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.data["code"], "files_scanning")

        self.deliver()
        item.refresh_from_db()
        self.assertEqual(item.scan_status, SCAN_CLEAN)
        self.assertFalse(item.file.name.startswith(PENDING_PREFIX))
        self.assertTrue(private_report_storage().exists(item.file.name))
        self.assertEqual(self.client.get(reverse("reports-file-download", args=[item.pk])).status_code, 200)
        self.assertEqual(self.submit(target_id).status_code, 201)

    def test_infected_upload_is_blocked_and_bytes_removed(self):
        target_id = self.create_target("Acme").data["data"]["id"]
        upload = self.upload(target_id, rf.upload("bad.pdf", rf.PDF_BYTES + b"%" + MARKER + b"\n", "application/pdf"))
        self.assertEqual(upload.status_code, 202)
        pending_name = ReportFile.objects.get(pk=upload.data["data"]["id"]).file.name
        self.deliver()
        item = ReportFile.objects.get(pk=upload.data["data"]["id"])
        self.assertEqual(item.scan_status, SCAN_INFECTED)
        self.assertEqual(item.file.name, "")
        self.assertFalse(private_report_storage().exists(pending_name))
        self.assertTrue(ReportQuarantineRecord.objects.filter(sha256=item.sha256).exists())
        response = self.submit(target_id)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "validation_file_blocked")
        detail = self.client.get(reverse("reports-me-target-detail", args=[target_id])).data["data"]
        self.assertEqual(detail["draft_files"][0]["blocked_reason"], "StreamX.Test.Marker")

    def test_scanner_down_keeps_file_pending_and_retries(self):
        target_id = self.create_target("Acme").data["data"]["id"]
        file_id = self.upload(target_id).data["data"]["id"]
        with override_settings(REPORTS_ANTIVIRUS_SCANNER="off"):
            self.deliver()
        item = ReportFile.objects.get(pk=file_id)
        self.assertEqual(item.scan_status, "unscanned")
        self.assertTrue(item.scan_pending)
        self.assertEqual(self.submit(target_id).data["code"], "files_scanning")
        self.deliver()  # scanner back: the retried job succeeds
        item.refresh_from_db()
        self.assertEqual(item.scan_status, SCAN_CLEAN)

    def test_rescan_ignores_pending_uploads(self):
        from apps.reports.rescan import HOLDERS

        target_id = self.create_target("Acme").data["data"]["id"]
        file_id = self.upload(target_id).data["data"]["id"]
        self.assertFalse(HOLDERS[0].queryset().filter(pk=file_id).exists())

    def test_removing_a_file_while_scanning_discards_it(self):
        target_id = self.create_target("Acme").data["data"]["id"]
        file_id = self.upload(target_id).data["data"]["id"]
        response = self.client.delete(reverse("reports-me-target-file-delete", args=[target_id, file_id]))
        self.assertEqual(response.status_code, 200)
        self.deliver()
        self.assertFalse(ReportFile.objects.filter(pk=file_id).exists())

    def test_concurrent_scan_jobs_never_delete_a_clean_file(self):
        # Review finding: the original job (retrying) and a requeue job for the
        # same file must not race; the loser used to delete the clean row.
        from apps.core.concurrency import DistributedLock
        from apps.reports import scanning

        target_id = self.create_target("Acme").data["data"]["id"]
        file_id = self.upload(target_id).data["data"]["id"]
        held = DistributedLock(f"reports-scan:{file_id}", ttl=60)
        self.assertTrue(held.acquire(blocking=False))
        try:
            self.assertIsNone(scanning.scan_pending_file(file_id))  # another worker is scanning it
        finally:
            held.release()
        self.assertEqual(ReportFile.objects.get(pk=file_id).scan_status, "unscanned")
        self.assertEqual(scanning.scan_pending_file(file_id), SCAN_CLEAN)
        # A second (requeued) job after the first finished is a no-op.
        self.assertIsNone(scanning.scan_pending_file(file_id))
        item = ReportFile.objects.get(pk=file_id)
        self.assertEqual(item.scan_status, SCAN_CLEAN)
        self.assertTrue(private_report_storage().exists(item.file.name))


class SubmitTests(SelfServiceTestCase):
    def test_idempotent_submit_replays(self):
        target_id = self.ready_target()
        key = str(uuid.uuid4())
        first = self.submit(target_id, key=key)
        second = self.submit(target_id, key=key)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second.data["data"]["target"]["version_count"], 1)
        third = self.submit(target_id)  # new key, nothing changed
        self.assertEqual(third.status_code, 200)
        self.assertFalse(third.data["data"]["created"])
        self.assertEqual(ReportSubmission.objects.get(pk=target_id).versions.count(), 1)

    def test_files_of_another_target_cannot_be_borrowed(self):
        acme = self.ready_target("Acme")
        initech = self.create_target("Initech").data["data"]["id"]
        acme_file = ReportFile.objects.filter(draft_id=acme).first().pk
        response = self.submit(initech, file_ids=[acme_file])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "validation_files_missing")

    def test_undo_returns_to_draft_and_suppresses_receipt(self):
        target_id = self.ready_target()
        self.assertEqual(self.submit(target_id).status_code, 201)
        response = self.client.post(reverse("reports-me-target-undo", args=[target_id]))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["data"]["status"], "not_submitted")
        self.assertEqual(len(response.data["data"]["draft_files"]), 1)
        self.deliver()
        self.assertFalse(Notification.objects.filter(event_key__startswith=f"report-receipt:{target_id}").exists())
        # Submit again: a fresh version 1 and a receipt.
        self.assertEqual(self.submit(target_id).status_code, 201)
        self.deliver()
        self.assertTrue(Notification.objects.filter(event_key__startswith=f"report-receipt:{target_id}:").exists())

    def test_undo_window_expires(self):
        submission = self.submitted()
        ReportSubmission.objects.filter(pk=submission.pk).update(submitted_at=timezone.now() - timedelta(minutes=5))
        response = self.client.post(reverse("reports-me-target-undo", args=[submission.pk]))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "undo_expired")

    def test_late_submission_in_grace_window_is_penalised(self):
        monday = ist(2026, 11, 16, 9)
        submission = weekly.create_target(
            course=self.course, student=self.student, target_name="Acme", week="previous", now=monday
        )
        item = ReportFile.objects.create(
            task=submission.task,
            owner=self.student,
            draft=submission,
            file="reports/x.bin",
            original_name="r.pdf",
            extension="pdf",
            content_type="application/pdf",
            size=10,
            scan_status=SCAN_CLEAN,
        )
        result = weekly.submit_target(submission_id=submission.pk, student=self.student, now=monday)
        self.assertTrue(result.version.is_late)
        submission.refresh_from_db()
        self.assertEqual(submission.minutes_late, 9 * 60 + 1)
        services.save_grade(
            submission_id=submission.pk,
            grader=self.instructor,
            action="grade",
            expected_revision=submission.revision,
            marks="8",
        )
        submission.refresh_from_db()
        self.assertEqual(submission.grade.late_penalty, Decimal("1.00"))  # 1 started day x 10 % of 10
        self.assertEqual(submission.grade.final_marks, Decimal("7.00"))
        self.assertTrue(item.pk)

    def test_draft_marks_do_not_lock_before_deadline(self):
        submission = self.submitted()
        self.as_user(self.instructor)
        response = self.client.post(
            reverse("reports-manage-submission-grade", args=[submission.pk]),
            {"action": "draft", "expected_revision": submission.revision, "marks": "5"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.as_user(self.student)
        self.assertEqual(self.upload(submission.pk).status_code, 202)
        self.deliver()
        replaced = self.submit(submission.pk)
        self.assertEqual(replaced.status_code, 201, replaced.data)
        submission.refresh_from_db()
        self.assertEqual(submission.status, ReportSubmission.STATUS_SUBMITTED)  # back in the queue

    def test_return_sets_revision_deadline(self):
        submission = self.submitted()
        before = timezone.now()
        services.save_grade(
            submission_id=submission.pk,
            grader=self.instructor,
            action="return",
            expected_revision=submission.revision,
            feedback="Add sources",
        )
        submission.refresh_from_db()
        self.assertGreaterEqual(submission.revision_deadline, before + timedelta(hours=72) - timedelta(seconds=5))
        ReportSubmission.objects.filter(pk=submission.pk).update(
            revision_deadline=timezone.now() - timedelta(minutes=1)
        )
        allowed, reason = services.student_can_change(submission.task, ReportSubmission.objects.get(pk=submission.pk))
        self.assertFalse(allowed)
        self.assertIn("resubmit", reason)

    def test_marks_visible_on_grade_and_gradebook_sums_targets(self):
        acme = self.submitted("Acme")
        initech = self.submitted("Initech")
        for submission, marks in ((acme, "6"), (initech, "8")):
            submission.refresh_from_db()
            services.save_grade(
                submission_id=submission.pk,
                grader=self.instructor,
                action="grade",
                expected_revision=submission.revision,
                marks=marks,
            )
        detail = self.client.get(reverse("reports-me-target-detail", args=[acme.pk])).data["data"]
        self.assertTrue(detail["marks_visible"])
        self.assertEqual(Decimal(detail["grade"]["final_marks"]), Decimal("6.00"))
        book = services.course_gradebook(self.course)
        row = next(row for row in book["rows"] if row["student"].pk == self.student.pk)
        cell = row["cells"][0]
        self.assertEqual(cell["target_count"], 2)
        self.assertEqual(cell["final_marks"], Decimal("14.00"))
        self.assertEqual(cell["max_marks"], Decimal("20.00"))
        marks = self.client.get(reverse("reports-my-marks")).data["data"]["courses"][0]
        self.assertEqual(Decimal(marks["totals"]["total_marks"]), Decimal("14.00"))


class LegacyCompatibilityTests(SelfServiceTestCase):
    def test_legacy_routes_hide_auto_tasks_and_refuse_them(self):
        submission = self.submitted()
        task = submission.task
        self.as_user(self.student)
        listing = self.client.get(reverse("reports-tasks")).data["data"]["results"]
        self.assertEqual(listing, [])
        self.assertEqual(self.client.get(reverse("reports-task-detail", args=[task.pk])).status_code, 404)
        with self.assertRaises(Exception) as caught:
            services.submit_report(task=task, student=self.student, file_ids=[1])
        self.assertEqual(getattr(caught.exception, "code", ""), "use_weekly_flow")

    def test_legacy_task_still_one_report_per_student(self):
        task = ReportTask.objects.create(
            course=self.course,
            title="Target: Initech",
            due_at=timezone.now() + timedelta(days=2),
            status=ReportTask.STATUS_PUBLISHED,
        )
        self.as_user(self.student)
        file_id = self.client.post(
            reverse("reports-task-uploads", args=[task.pk]), {"file": rf.pdf()}, format="multipart"
        ).data["data"]["id"]
        response = self.client.post(
            reverse("reports-task-submit", args=[task.pk]),
            {"file_ids": [file_id]},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        self.assertEqual(response.status_code, 201, response.data)
        row = ReportSubmission.objects.get(task=task)
        self.assertEqual((row.target_name, row.target_key), ("Target: Initech", "target initech"))
        task.title = "Renamed"
        task.save()
        file_two = self.client.post(
            reverse("reports-task-uploads", args=[task.pk]), {"file": rf.pdf("b.pdf")}, format="multipart"
        ).data["data"]["id"]
        response = self.client.post(
            reverse("reports-task-submit", args=[task.pk]),
            {"file_ids": [file_id, file_two]},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(ReportSubmission.objects.filter(task=task, student=self.student).count(), 1)

    def test_duplicate_is_refused_for_auto_tasks(self):
        submission = self.submitted()
        self.as_user(self.instructor)
        response = self.client.post(reverse("reports-manage-task-duplicate", args=[submission.task_id]))
        self.assertEqual(response.status_code, 409)


class GraderQueueTests(SelfServiceTestCase):
    def test_grouped_queue_with_same_target_and_sha256_badges(self):
        mine = self.submitted("Acme Pvt Ltd")
        theirs = self.submitted("ACME", user=self.other)  # same bytes (rf.pdf) and same target
        self.submitted("Initech")
        self.as_user(self.instructor)
        response = self.client.get(reverse("reports-manage-submissions"), {"group": "week", "status": "awaiting"})
        self.assertEqual(response.status_code, 200, response.data)
        items = response.data["data"]["results"]
        self.assertEqual([item["target_key"] for item in items], ["acme", "acme", "initech"])
        by_id = {item["id"]: item for item in items}
        self.assertEqual(by_id[mine.pk]["same_target_count"], 1)
        self.assertEqual(by_id[theirs.pk]["sha256_match_count"], 1)
        self.assertTrue(by_id[mine.pk]["week_label"].startswith("Week"))
        detail = self.client.get(reverse("reports-manage-submission-detail", args=[mine.pk]), {"group": "week"})
        data = detail.data["data"]
        self.assertEqual(data["target_name"], "Acme Pvt Ltd")
        self.assertEqual(data["same_target"][0]["id"], theirs.pk)
        self.assertEqual(data["sha256_matches"][0]["submission_id"], theirs.pk)
        self.assertEqual(data["neighbours"]["next_id"], theirs.pk)

    def test_unscanned_drafts_never_reach_the_queue(self):
        target_id = self.create_target("Acme").data["data"]["id"]
        self.upload(target_id)
        self.as_user(self.instructor)
        items = self.client.get(reverse("reports-manage-submissions")).data["data"]["results"]
        self.assertEqual(items, [])
        self.assertNotIn(target_id, [item["id"] for item in items])

    def test_policy_api(self):
        self.as_user(self.instructor)
        url = reverse("reports-manage-course-policy", args=[self.course.pk])
        data = self.client.get(url).data["data"]
        self.assertTrue(data["self_service"])
        response = self.client.put(
            url, {"self_service": True, "max_targets_per_week": 3, "marks_visibility": "auto_release"}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.policy.refresh_from_db()
        self.assertEqual(self.policy.max_targets_per_week, 3)
        self.as_user(self.student)
        self.assertEqual(self.client.get(url).status_code, 403)


class SchedulerTests(SelfServiceTestCase):
    def recipients(self, prefix):
        return NotificationRecipient.objects.filter(notification__event_key__startswith=prefix)

    def test_week_open_due_and_missed_fire_exactly_once(self):
        saturday = ist(2026, 11, 14, 10)  # due Sunday 23:59 -> inside the 24 h window? no: 37 h left
        scheduler.run_scheduler(now=saturday)
        scheduler.run_scheduler(now=saturday)
        self.assertEqual(self.recipients(f"report-week-open:{self.course.pk}:2026-11-09").count(), 2)
        self.assertFalse(self.recipients("report-week-due").exists())

        sunday = ist(2026, 11, 15, 9)
        week = week_for(self.policy, sunday)
        task = weekly.ensure_week_task(self.course, self.policy, week, now=sunday)
        submission = ReportSubmission.objects.create(
            task=task, student=self.other, target_name="Acme", target_key="acme", status="submitted"
        )
        for _ in range(3):
            scheduler.run_scheduler(now=sunday)
        due = self.recipients(f"report-week-due:{self.course.pk}:2026-11-09")
        self.assertEqual(list(due.values_list("user_id", flat=True)), [self.student.pk])

        wednesday = ist(2026, 11, 18, 9)
        scheduler.run_scheduler(now=wednesday)
        scheduler.run_scheduler(now=wednesday)
        missed = self.recipients(f"report-week-missed:{self.course.pk}:2026-11-09")
        self.assertEqual(list(missed.values_list("user_id", flat=True)), [self.student.pk])
        self.assertEqual(
            ReportNoticeLog.objects.filter(key=f"report-week-missed:{self.course.pk}:2026-11-09").count(), 1
        )
        # The week before self-service existed has no task, so nobody "missed" it.
        self.assertFalse(ReportNoticeLog.objects.filter(key=f"report-week-missed:{self.course.pk}:2026-11-02").exists())
        self.assertTrue(submission.pk)

    def test_tick_is_deduplicated_and_runs_via_outbox(self):
        now = timezone.now()
        scheduler.schedule_tick(now)
        scheduler.schedule_tick(now)
        self.assertEqual(OutboxEvent.objects.filter(event_type=scheduler.EVENT_TICK).count(), 1)
        self.deliver()
        self.assertTrue(ReportNoticeLog.objects.filter(key__startswith="report-week-open").exists())

    def test_grader_digest_falls_back_to_graders_group_and_sla(self):
        self.course.instructor = None
        self.course.save()
        grader = f.make_admin(full_name="Grader")
        group = Group.objects.create(name="graders")
        grader.groups.add(group)
        submission = self.submitted()
        ReportSubmission.objects.filter(pk=submission.pk).update(submitted_at=timezone.now() - timedelta(hours=80))
        later = timezone.localtime(timezone.now()).replace(hour=10)
        if later < timezone.now():
            later = timezone.now()
        for _ in range(2):
            stats = scheduler.run_scheduler(now=later)
        digest = self.recipients(f"report-grader-digest:{self.course.pk}:")
        self.assertEqual(list(digest.values_list("user_id", flat=True)), [grader.pk])
        self.assertEqual(Notification.objects.filter(event_key__startswith="report-sla:").count(), 1)
        self.assertEqual(stats["digests"], 0)  # second run: already done

    def test_auto_release_marks(self):
        self.policy.marks_visibility = ReportPolicy.MARKS_AUTO_RELEASE
        self.policy.save()
        monday = ist(2026, 11, 16, 9)
        submission = weekly.create_target(
            course=self.course, student=self.student, target_name="Acme", week="previous", now=monday
        )
        task = submission.task
        self.assertEqual(task.marks_visibility, ReportTask.MARKS_ON_RELEASE)
        ReportFile.objects.create(
            task=task,
            owner=self.student,
            draft=submission,
            file="reports/y.bin",
            original_name="r.pdf",
            extension="pdf",
            content_type="application/pdf",
            size=10,
            scan_status=SCAN_CLEAN,
        )
        weekly.submit_target(submission_id=submission.pk, student=self.student, now=monday)
        submission.refresh_from_db()
        services.save_grade(
            submission_id=submission.pk,
            grader=self.instructor,
            action="grade",
            expected_revision=submission.revision,
            marks="9",
        )
        submission.refresh_from_db()
        self.assertFalse(services.marks_visible_to_student(submission))
        scheduler.run_scheduler(now=ist(2026, 11, 18, 10))  # grace over, +24 h delay not yet
        task.refresh_from_db()
        self.assertIsNone(task.marks_released_at)
        scheduler.run_scheduler(now=ist(2026, 11, 19, 1))
        scheduler.run_scheduler(now=ist(2026, 11, 19, 2))
        task.refresh_from_db()
        self.assertIsNotNone(task.marks_released_at)
        submission.refresh_from_db()
        self.assertTrue(services.marks_visible_to_student(submission))

    def test_housekeeping_requeues_stuck_scans_and_prunes_old_drafts(self):
        target_id = self.create_target("Acme").data["data"]["id"]
        file_id = self.upload(target_id).data["data"]["id"]
        OutboxEvent.objects.all().delete()  # the job was lost
        ReportFile.objects.filter(pk=file_id).update(created_at=timezone.now() - timedelta(hours=1))
        stats = scheduler.run_scheduler()
        self.assertEqual(stats["scans_requeued"], 1)
        self.deliver()
        self.assertEqual(ReportFile.objects.get(pk=file_id).scan_status, SCAN_CLEAN)

        old = ist(2026, 1, 5, 9)
        draft = weekly.create_target(course=self.course, student=self.student, target_name="Old", now=old)
        stats = scheduler.run_scheduler()
        self.assertGreaterEqual(stats["drafts_pruned"], 1)
        self.assertFalse(ReportSubmission.objects.filter(pk=draft.pk).exists())

    def test_draft_evidence_survives_upload_prune_and_housekeeping(self):
        # Review finding: draft files older than the staged-upload TTL (48 h)
        # were deleted by the legacy staging prune.
        target_id = self.ready_target("Acme")
        file_id = ReportFile.objects.get(draft_id=target_id).pk
        ReportFile.objects.filter(pk=file_id).update(created_at=timezone.now() - timedelta(hours=72))
        other_target = self.create_target("Globex").data["data"]["id"]
        self.assertEqual(self.upload(other_target).status_code, 202)  # an upload prunes this student's staging
        housekeeping.run_housekeeping()
        services.prune_staged_files()
        self.assertTrue(ReportFile.objects.filter(pk=file_id, draft_id=target_id).exists())
        self.assertEqual(self.submit(target_id).status_code, 201)

    def test_drafts_of_weeks_without_grace_are_pruned(self):
        self.policy.grace_hours = 0
        self.policy.save()
        old = ist(2026, 1, 5, 9)
        draft = weekly.create_target(course=self.course, student=self.student, target_name="Old", now=old)
        self.assertIsNone(draft.task.late_until)
        stats = scheduler.run_scheduler()
        self.assertGreaterEqual(stats["drafts_pruned"], 1)
        self.assertFalse(ReportSubmission.objects.filter(pk=draft.pk).exists())


class LateDigestFallbackTests(SelfServiceTestCase):
    def test_late_digest_reaches_staff_without_instructor(self):
        self.course.instructor = None
        self.course.save()
        staff = f.make_admin()
        monday = ist(2026, 11, 16, 9)
        submission = weekly.create_target(
            course=self.course, student=self.student, target_name="Acme", week="previous", now=monday
        )
        ReportFile.objects.create(
            task=submission.task,
            owner=self.student,
            draft=submission,
            file="reports/z.bin",
            original_name="r.pdf",
            extension="pdf",
            content_type="application/pdf",
            size=10,
            scan_status=SCAN_CLEAN,
        )
        weekly.submit_target(submission_id=submission.pk, student=self.student, now=monday)
        self.deliver()
        self.assertTrue(
            NotificationRecipient.objects.filter(
                user=staff, notification__event_key__startswith="report-late-digest:"
            ).exists()
        )


# ---------------------------------------------------------------------------
# Expand / backfill / contract migration (forward and reverse)
# ---------------------------------------------------------------------------
class TargetKeyMigrationTests(TransactionTestCase):
    start = [("reports", "0002_antivirus_scan_records")]
    end = [("reports", "0005_self_service_contract")]

    def migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(targets)
        return executor.loader.project_state(targets).apps

    def tearDown(self):
        self.migrate(MigrationExecutor(connection).loader.graph.leaf_nodes())

    def test_backfill_and_reverse(self):
        user = f.make_user(full_name="Legacy")
        course = f.make_course(title="Legacy course")
        old_apps = self.migrate(self.start)
        Task = old_apps.get_model("reports", "ReportTask")
        Submission = old_apps.get_model("reports", "ReportSubmission")
        task = Task.objects.create(course_id=course.pk, title="Week 3: Acme Pvt Ltd", due_at=timezone.now())
        Submission.objects.create(task=task, student_id=user.pk, status="submitted")

        new_apps = self.migrate(self.end)
        row = new_apps.get_model("reports", "ReportSubmission").objects.get()
        self.assertEqual(row.target_name, "Week 3: Acme Pvt Ltd")
        self.assertEqual(row.target_key, "week 3 acme")

        # Rollback works while every (task, student) still has one row.
        reverted = self.migrate(self.start)
        self.assertEqual(reverted.get_model("reports", "ReportSubmission").objects.count(), 1)
