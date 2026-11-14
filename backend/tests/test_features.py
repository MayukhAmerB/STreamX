"""Feature switch registry and storage (UI overhaul plan §5.1, WS-F)."""

from __future__ import annotations

from unittest import mock

from django.contrib.admin.models import LogEntry
from django.test import TestCase, override_settings

from apps.core import features
from apps.core.errors import Conflict, FeatureDisabled, NotFound, PermissionDenied, ValidationFailed
from apps.core.models import FeatureFlag, FeatureFlagChange
from tests import factories as f

OFF_REASON = "Teaching tools are switched off for now. An admin can turn them on."


class FeatureTestCase(TestCase):
    """Starts and ends every test with no cached overrides."""

    def setUp(self):
        super().setUp()
        features.invalidate_cache()
        self.admin = f.make_admin(full_name="Ayesha Admin")

    def tearDown(self):
        # A switch flipped inside a TestCase transaction never commits: forget
        # the pending-write marker too, or later suites keep reading switches
        # from the database (their query counts).
        features._pending.dirty = False
        features.invalidate_cache()
        super().tearDown()


@override_settings(FEATURE_DEFAULT_OVERRIDES={})
class RegistryTests(FeatureTestCase):
    def test_production_default_is_off_and_registered_in_core(self):
        feature = features.get_feature("teaching")
        self.assertIsNotNone(feature)
        self.assertFalse(feature.default)
        self.assertEqual(feature.label, "Teachers section")
        self.assertEqual(feature.disabled_reason, OFF_REASON)
        self.assertFalse(features.is_enabled("teaching"))
        snapshot = features.snapshot()
        # Every switch ships off in production (teaching and the additive ones:
        # pentesting, memberships, labs_membership_required, ...).
        for key in ("teaching", "engagement", "pentesting", "memberships", "labs_membership_required"):
            self.assertIn(key, snapshot)
        # The exceptions ship ON by owner decision: attendance, and the reward
        # systems from release day (engagement, the Monthly CTF, student profiles).
        for key in ("attendance", "engagement", "monthly_ctf", "public_profiles"):
            self.assertIs(snapshot.pop(key), True, key)
            self.assertTrue(features.get_feature(key).default, key)
        self.assertEqual(snapshot, {key: False for key in snapshot})
        self.assertEqual(FeatureFlag.objects.count(), 0, "off comes from the registry, not a data migration")

    def test_require_raises_feature_disabled_with_the_reason(self):
        with self.assertRaises(FeatureDisabled) as caught:
            features.require("teaching")
        self.assertEqual((caught.exception.status, caught.exception.code), (403, "feature_disabled"))
        self.assertEqual(caught.exception.message, OFF_REASON)
        self.assertEqual(caught.exception.details, {"feature": "teaching"})

    def test_unknown_keys_are_off_and_cannot_be_set(self):
        self.assertFalse(features.is_enabled("does_not_exist"))
        with self.assertRaises(NotFound):
            features.set_feature("does_not_exist", True, by=self.admin)

    def test_keys_must_be_snake_case(self):
        with self.assertRaises(ValueError):
            features.register_feature(features.Feature(key="Bad-Key", label="x", summary="x"))

    def test_impact_counts_non_staff_instructors(self):
        f.make_instructor()
        f.make_instructor()
        f.make_instructor(is_staff=True)
        f.make_user()
        self.assertEqual(features.impact("teaching"), {"instructor_accounts": 2, "live_now": 0})

    def test_impact_counts_instructor_classes_on_air(self):
        from apps.realtime.models import RealtimeSession

        instructor = f.make_instructor()
        f.make_realtime_session(host=instructor, status=RealtimeSession.STATUS_LIVE)
        f.make_realtime_session(host=instructor, status=RealtimeSession.STATUS_SCHEDULED)
        f.make_realtime_session(host=self.admin, status=RealtimeSession.STATUS_LIVE)
        self.assertEqual(features.impact("teaching")["live_now"], 1)


@override_settings(FEATURE_DEFAULT_OVERRIDES={})
class OverrideTests(FeatureTestCase):
    def test_db_override_wins_over_default(self):
        features.set_feature("teaching", True, by=self.admin, note="Spring term", expected_version=0)
        self.assertTrue(features.is_enabled("teaching"))
        self.assertEqual(features.state("teaching")["version"], 1)

    def test_force_wins_over_the_db_and_locks_the_switch(self):
        features.set_feature("teaching", True, by=self.admin)
        with override_settings(FEATURE_FORCE={"teaching": False}):
            self.assertFalse(features.is_enabled("teaching"))
            self.assertEqual(features.forced_value("teaching"), False)
            with self.assertRaises(PermissionDenied) as caught:
                features.set_feature("teaching", True, by=self.admin)
            self.assertEqual(caught.exception.code, "feature_locked")

    def test_custom_reason_while_off(self):
        features.set_feature("teaching", True, by=self.admin)
        features.set_feature("teaching", False, by=self.admin, reason="Teaching opens on 1 December.")
        self.assertEqual(features.reason_for("teaching"), "Teaching opens on 1 December.")
        with self.assertRaises(FeatureDisabled) as caught:
            features.require("teaching")
        self.assertEqual(caught.exception.message, "Teaching opens on 1 December.")
        # Turning on clears it; turning off again without one uses the registry reason.
        features.set_feature("teaching", True, by=self.admin)
        features.set_feature("teaching", False, by=self.admin)
        self.assertEqual(features.reason_for("teaching"), OFF_REASON)

    def test_reason_and_note_are_validated(self):
        with self.assertRaises(ValidationFailed):
            features.set_feature("teaching", False, by=self.admin, reason="<script>alert(1)</script>")
        with self.assertRaises(ValidationFailed):
            features.set_feature("teaching", False, by=self.admin, reason="x" * 161)
        with self.assertRaises(ValidationFailed):
            features.set_feature("teaching", True, by=self.admin, note="<img src=x onerror=alert(1)>")
        self.assertEqual(FeatureFlagChange.objects.count(), 0)


@override_settings(FEATURE_DEFAULT_OVERRIDES={})
class WriteTests(FeatureTestCase):
    def test_change_writes_row_history_and_log_entry(self):
        state = features.set_feature("teaching", True, by=self.admin, note="Onboarding the OSINT batch", expected_version=0)
        row = FeatureFlag.objects.get(key="teaching")
        self.assertEqual((row.enabled, row.version, row.updated_by), (True, 1, self.admin))
        change = FeatureFlagChange.objects.get()
        self.assertEqual((change.from_enabled, change.to_enabled), (False, True))
        self.assertEqual(change.note, "Onboarding the OSINT batch")
        self.assertEqual(change.changed_by_email, self.admin.email)
        entry = LogEntry.objects.get()
        self.assertEqual(entry.user, self.admin)
        self.assertIn("Turned on", entry.get_change_message())
        self.assertEqual(state["history"][0]["to"], True)
        self.assertEqual(set(state["history"][0]), {"from", "to", "note", "changed_by", "changed_at"})

    def test_no_op_writes_nothing(self):
        features.set_feature("teaching", False, by=self.admin)
        self.assertEqual(FeatureFlag.objects.count(), 0)
        features.set_feature("teaching", True, by=self.admin)
        features.set_feature("teaching", True, by=self.admin, expected_version=1)
        self.assertEqual(FeatureFlagChange.objects.count(), 1)
        self.assertEqual(LogEntry.objects.count(), 1)
        self.assertEqual(FeatureFlag.objects.get().version, 1)

    def test_stale_version_is_a_409_conflict_naming_who_changed_it(self):
        features.set_feature("teaching", True, by=self.admin, expected_version=0)
        other = f.make_admin()
        with self.assertRaises(Conflict) as caught:
            features.set_feature("teaching", False, by=other, expected_version=0)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "feature_changed_meanwhile"))
        self.assertIn("Ayesha Admin changed this", caught.exception.message)
        self.assertEqual(caught.exception.details, {"feature": "teaching", "version": 1})
        self.assertTrue(features.is_enabled("teaching"))

    def test_history_is_capped_at_ten_newest_first(self):
        for index in range(12):
            features.set_feature("teaching", index % 2 == 0, by=self.admin, note=f"flip {index}")
        history = features.state("teaching")["history"]
        self.assertEqual(len(history), 10)
        self.assertEqual(history[0]["note"], "flip 11")
        self.assertEqual(features.history_count("teaching"), 12)

    def test_request_id_and_ip_are_recorded(self):
        request = mock.Mock(request_id="req-1234567890", META={"REMOTE_ADDR": "203.0.113.9"})
        with mock.patch("config.client_ip.resolve_client_ip", return_value="203.0.113.9"):
            features.set_feature("teaching", True, by=self.admin, request=request)
        change = FeatureFlagChange.objects.get()
        self.assertEqual((change.request_id, change.ip), ("req-1234567890", "203.0.113.9"))


@override_settings(FEATURE_DEFAULT_OVERRIDES={}, FEATURE_PROCESS_MEMO_SECONDS=2)
class CacheTests(FeatureTestCase):
    def test_reads_are_cached_and_invalidated_on_commit(self):
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            features.set_feature("teaching", True, by=self.admin)
        self.assertEqual(len(callbacks), 1)
        features.invalidate_cache()
        with self.assertNumQueries(1):
            self.assertTrue(features.is_enabled("teaching"))
        with self.assertNumQueries(0):  # process memo
            self.assertTrue(features.is_enabled("teaching"))
            self.assertTrue(features.is_enabled("teaching"))
        # Another process: the memo is gone but the shared cache still answers.
        with features._memo_lock:
            features._memo["overrides"] = None
        with self.assertNumQueries(0):
            self.assertTrue(features.is_enabled("teaching"))
        # A change drops the shared snapshot on commit, so every worker re-reads it.
        from django.conf import settings
        from django.core.cache import cache

        self.assertIsNotNone(cache.get(settings.FEATURE_SNAPSHOT_CACHE_KEY))
        with self.captureOnCommitCallbacks(execute=True):
            features.set_feature("teaching", False, by=self.admin)
        self.assertIsNone(cache.get(settings.FEATURE_SNAPSHOT_CACHE_KEY))
        self.assertFalse(features.is_enabled("teaching"))

    def test_on_commit_logs_the_change(self):
        with self.assertLogs("apps.core.features", level="INFO") as logs:
            with self.captureOnCommitCallbacks(execute=True):
                features.set_feature("teaching", True, by=self.admin)
        self.assertTrue(any("feature_flag.changed feature=teaching" in line for line in logs.output))

    def test_fail_closed_when_cache_and_database_are_down(self):
        with self.captureOnCommitCallbacks(execute=True):
            features.set_feature("teaching", True, by=self.admin)
        features.invalidate_cache()
        broken_cache = mock.Mock(**{"get.side_effect": ConnectionError("redis down")})
        with mock.patch.object(features, "cache", broken_cache), mock.patch.object(
            features, "_load_from_db", side_effect=RuntimeError("db down")
        ):
            self.assertFalse(features.is_enabled("teaching"))  # registry default (off), never raises
            with self.assertRaises(FeatureDisabled):
                features.require("teaching")

    def test_cache_down_falls_back_to_the_database(self):
        with self.captureOnCommitCallbacks(execute=True):
            features.set_feature("teaching", True, by=self.admin)
        features.invalidate_cache()
        broken_cache = mock.Mock(**{"get.side_effect": ConnectionError("redis down")})
        with mock.patch.object(features, "cache", broken_cache):
            self.assertTrue(features.is_enabled("teaching"))


class TestDefaultTests(TestCase):
    def test_test_runs_default_teaching_on(self):
        features.invalidate_cache()
        self.assertTrue(features.is_enabled("teaching"))
