"""UI overhaul scaffold (WS-0): frozen contracts, settings and stub endpoints.

Owners replace the stubs (WS-C today, WS-F features/capabilities, WS-G admin);
these tests keep the *shapes* frozen (plan Appendix A) and the wiring alive.
When a real implementation lands, its owner may tighten the value checks but
must keep every key and enum checked here.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from apps.console_api import attention, contract_fixtures
from apps.core import features
from apps.core.errors import FeatureDisabled
from apps.core.exception_handler import api_exception_handler
from apps.users.capabilities import TEACH_ITEM_KEYS

FRONTEND_CONTRACTS = Path(settings.BASE_DIR).parent / "frontend" / "src" / "__contracts__" / "ui-overhaul"
OFF_REASON = "Teaching tools are switched off for now. An admin can turn them on."


def _keys(value):
    if isinstance(value, dict):
        return {key: _keys(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_keys(value[0])] if value else []
    return None


class ContractFixtureTests(SimpleTestCase):
    def test_backend_copies_match_the_frontend_contracts(self):
        if not FRONTEND_CONTRACTS.is_dir():
            self.skipTest("frontend checkout not present (backend-only image)")
        for name in contract_fixtures.FIXTURE_NAMES:
            with self.subTest(name=name):
                frontend = json.loads((FRONTEND_CONTRACTS / f"{name}.json").read_text(encoding="utf-8"))
                self.assertEqual(contract_fixtures.load_fixture(name), frontend)

    def test_capability_states_and_items_are_from_the_vocabulary(self):
        for variant, payload in contract_fixtures.load_fixture("capabilities").items():
            with self.subTest(variant=variant):
                self.assertEqual(set(payload["workspaces"]), {"learn", "teach", "admin"})
                self.assertEqual(tuple(payload["items"]), TEACH_ITEM_KEYS)
                for entry in [*payload["workspaces"].values(), *payload["items"].values()]:
                    self.assertIn(entry["state"], {"enabled", "disabled", "hidden"})
                    self.assertEqual("reason" in entry, entry["state"] == "disabled")
                self.assertEqual("status" in payload, variant.startswith("staff"))

    def test_attention_fixture_lists_the_ten_queues_in_order(self):
        for variant, payload in contract_fixtures.load_fixture("attention").items():
            with self.subTest(variant=variant):
                self.assertEqual(tuple(queue["key"] for queue in payload["queues"]), attention.QUEUE_KEYS)
                for queue in payload["queues"]:
                    self.assertIn(queue["severity"], attention.SEVERITIES)

    def test_today_fixture_kinds(self):
        kinds = {"live_now", "exam_open", "report_due", "resume", "next_class", "browse"}
        fixture = contract_fixtures.load_fixture("today")
        for variant in ("learn", "learn_browse"):
            self.assertIn(fixture[variant]["next_up"]["kind"], kinds)
            self.assertIsNone(fixture[variant]["teach"])
        self.assertIsNone(fixture["teach"]["next_up"])
        self.assertEqual(set(fixture["teach"]["teach"]), {"to_grade", "host_next", "recordings", "exams_open"})

    def test_feature_disabled_error_matches_the_error_contract(self):
        response = api_exception_handler(FeatureDisabled(OFF_REASON, details={"feature": "teaching"}), {})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.data, contract_fixtures.load_fixture("errors")["feature_disabled"])


class FeatureSettingsTests(SimpleTestCase):
    def tearDown(self):
        features._reset_stub_state_for_tests()

    def test_test_runs_turn_teaching_on_and_nothing_is_forced(self):
        # Test runs: teaching and engagement on; "pentesting" on so purchase tests keep their
        # meaning (gate tests turn it off explicitly). Production defaults stay off.
        overrides = settings.FEATURE_DEFAULT_OVERRIDES
        for key in ("teaching", "engagement", "pentesting"):
            self.assertIs(overrides.get(key), True)
        # Only test-run defaults (other workstreams add theirs). The one switch pinned
        # OFF is "monthly_ctf": it ships ON in production, and its suites turn it on
        # per test so the other suites keep exercising the same behaviour.
        self.assertEqual({key for key, value in overrides.items() if value is not True}, {"monthly_ctf"})
        self.assertEqual(settings.FEATURE_FORCE, {})
        self.assertTrue(features.is_enabled("teaching"))

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_production_default_is_off(self):
        self.assertFalse(features.is_enabled("teaching"))
        with self.assertRaises(FeatureDisabled) as caught:
            features.require("teaching")
        self.assertEqual(caught.exception.code, "feature_disabled")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.details, {"feature": "teaching"})
        self.assertEqual(caught.exception.message, OFF_REASON)

    @override_settings(FEATURE_DEFAULT_OVERRIDES={}, FEATURE_FORCE={"teaching": True})
    def test_force_wins(self):
        self.assertTrue(features.is_enabled("teaching"))
        self.assertEqual(features.forced_value("teaching"), True)

    def test_unknown_feature_is_off(self):
        self.assertFalse(features.is_enabled("nope"))
        snapshot = features.snapshot()
        self.assertNotIn("nope", snapshot)
        self.assertTrue({"teaching", "engagement", "pentesting"} <= {key for key, on in snapshot.items() if on})


class _ApiCase(APITestCase):
    def setUp(self):
        features._reset_stub_state_for_tests()
        user_model = get_user_model()
        self.student = user_model.objects.create_user(email="ws0-student@test.com", password="Strong-Pass-123!")
        self.instructor = user_model.objects.create_user(email="ws0-instructor@test.com", password="Strong-Pass-123!")
        self.instructor.role = "instructor"
        self.instructor.save(update_fields=["role"])
        self.staff = user_model.objects.create_user(email="ws0-staff@test.com", password="Strong-Pass-123!", is_staff=True)
        self.superuser = user_model.objects.create_superuser(email="ws0-root@test.com", password="Strong-Pass-123!")

    def tearDown(self):
        features._reset_stub_state_for_tests()

    def get_data(self, url, user, status=200):
        self.client.force_authenticate(user)
        response = self.client.get(url)
        self.assertEqual(response.status_code, status, response.content)
        return response.json().get("data")


class CapabilitiesApiTests(_ApiCase):
    url = "/api/me/capabilities/"

    def _expected(self, variant):
        payload = contract_fixtures.load_fixture("capabilities")[variant]
        payload.pop("version")
        return payload

    def _actual(self, user):
        data = self.get_data(self.url, user)
        self.assertIsInstance(data.pop("version"), int)
        # Additive switch from apps.engagement (covered by tests/test_engagement_*).
        self.assertIn("engagement", data["features"])
        data["features"].pop("engagement")
        # Additive switches and purchase gates from other workstreams
        # (pentesting, memberships, labs_membership_required, monthly_ctf, ...)
        # are covered by their own tests (test_capabilities_api, test_pentesting_gate).
        data["features"] = {key: value for key, value in data["features"].items() if key == "teaching"}
        for key in ("pentesting-purchase", "memberships"):
            data["items"].pop(key, None)
        if "status" in data:
            data["status"] = [row for row in data["status"] if row["key"] == "teaching"]
        return data

    def test_requires_sign_in(self):
        self.assertIn(self.client.get(self.url).status_code, (401, 403))

    def test_url_name(self):
        self.assertEqual(reverse("me-capabilities"), self.url)

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_viewer_matrix_when_teaching_is_off(self):
        self.assertEqual(self._actual(self.student), self._expected("student"))
        self.assertEqual(self._actual(self.instructor), self._expected("instructor_off"))
        self.assertEqual(self._actual(self.staff), self._expected("staff_off"))

    def test_viewer_matrix_when_teaching_is_on(self):
        student = self._expected("student")
        student["features"]["teaching"]["enabled"] = True
        self.assertEqual(self._actual(self.student), student)
        self.assertEqual(self._actual(self.instructor), self._expected("instructor_on"))
        self.assertEqual(self._actual(self.staff), self._expected("staff_on"))


class TodayApiTests(_ApiCase):
    url = "/api/console/today/"

    def test_requires_sign_in(self):
        self.assertIn(self.client.get(self.url).status_code, (401, 403))

    def test_shapes_follow_the_contract(self):
        fixture = contract_fixtures.load_fixture("today")
        learn = self.get_data(self.url, self.student)
        self.assertEqual(set(learn), set(fixture["learn"]))
        self.assertEqual(set(learn["next_up"]), set(fixture["learn"]["next_up"]))
        self.assertEqual(learn["workspace"], "learn")
        teach = self.get_data(self.url + "?workspace=teach", self.instructor)
        self.assertEqual(_keys(teach["teach"]), _keys(fixture["teach"]["teach"]))

    def test_unknown_workspace_is_rejected(self):
        self.client.force_authenticate(self.student)
        response = self.client.get(self.url + "?workspace=admin")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "validation_failed")


class AdminApiTests(_ApiCase):
    staff_urls = (
        "/api/admin/attention/",
        "/api/admin/search/?q=pay",
        "/api/admin/features/",
        "/api/admin/requests/",
        "/api/admin/recordings/",
        "/api/admin/system/health/",
    )

    def test_staff_only(self):
        for url in self.staff_urls:
            with self.subTest(url=url):
                self.client.force_authenticate(None)
                self.assertIn(self.client.get(url).status_code, (401, 403))
                self.get_data(url, self.student, status=403)
                self.get_data(url, self.instructor, status=403)
                self.get_data(url, self.staff, status=200)

    def test_attention_shape(self):
        data = self.get_data("/api/admin/attention/", self.staff)
        fixture = contract_fixtures.load_fixture("attention")["busy"]
        self.assertEqual(set(data), set(fixture))
        self.assertEqual(_keys(data["queues"]), _keys(fixture["queues"]))
        self.assertEqual(tuple(queue["key"] for queue in data["queues"]), attention.QUEUE_KEYS)
        self.assertEqual(_keys(data["switches"]), _keys(fixture["switches"]))
        self.assertIn("teaching", [switch["key"] for switch in data["switches"]])

    def test_search_shape(self):
        data = self.get_data("/api/admin/search/?q=pay", self.staff)
        self.assertEqual(set(data), set(contract_fixtures.load_fixture("search")["pay"]))
        self.assertEqual(data["q"], "pay")
        self.assertIsInstance(data["groups"], list)

    def test_feature_list_shape(self):
        data = self.get_data("/api/admin/features/", self.staff)
        fixture = contract_fixtures.load_fixture("features")["list"]
        self.assertEqual(_keys(data[0]).keys(), _keys(fixture[0]).keys())
        teaching = next(item for item in data if item["key"] == "teaching")
        self.assertEqual(teaching["version"], 0)

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_feature_flip_conflict_and_permissions(self):
        url = "/api/admin/features/teaching/"
        body = contract_fixtures.load_fixture("features")["post_request"]

        self.client.force_authenticate(self.staff)
        self.assertEqual(self.client.post(url, body, format="json").status_code, 403)

        self.client.force_authenticate(self.superuser)
        response = self.client.post(url, body, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        card = response.json()["data"]
        expected = contract_fixtures.load_fixture("features")["post_response"]
        self.assertEqual(set(card), set(expected))
        self.assertEqual(_keys(card["history"]), _keys(expected["history"]))
        self.assertTrue(card["enabled"])
        self.assertEqual(card["version"], 1)
        self.assertTrue(features.is_enabled("teaching"))
        caps = self.get_data("/api/me/capabilities/", self.instructor)
        self.assertEqual(caps["workspaces"]["teach"], {"state": "enabled"})

        self.client.force_authenticate(self.superuser)
        stale = self.client.post(url, {**body, "enabled": False}, format="json")
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(_keys(stale.json()), _keys(contract_fixtures.load_fixture("errors")["feature_changed_meanwhile"]))

        bad = self.client.post(url, {"enabled": "yes"}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.client.post("/api/admin/features/nope/", body, format="json").status_code, 404)

    @override_settings(FEATURE_FORCE={"teaching": False})
    def test_locked_feature_cannot_change(self):
        self.client.force_authenticate(self.superuser)
        response = self.client.post("/api/admin/features/teaching/", {"enabled": True}, format="json")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "feature_locked")
        listed = {item["key"]: item for item in self.get_data("/api/admin/features/", self.staff)}
        self.assertTrue(listed["teaching"]["locked"])

    def test_settings_features_alias_redirects_staff_into_the_admin(self):
        self.client.force_login(self.staff)
        response = self.client.get("/admin/settings/features/")
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith("/admin/"))
        self.client.logout()
        anonymous = self.client.get("/admin/settings/features/")
        self.assertEqual(anonymous.status_code, 302)
        self.assertIn("/admin/login/", anonymous["Location"])
