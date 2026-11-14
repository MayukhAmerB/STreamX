"""Capabilities API (UI overhaul plan §5.2, Appendix A.1; WS-F)."""

from __future__ import annotations

from django.test import override_settings
from rest_framework.test import APITestCase

from apps.console_api import contract_fixtures
from apps.core import features
from tests import factories as f

URL = "/api/me/capabilities/"
PURCHASE_ITEM_KEYS = ("pentesting-purchase", "memberships")
OFF_REASON = "Teaching tools are switched off for now. An admin can turn them on."


class CapabilitiesTests(APITestCase):
    def setUp(self):
        features.invalidate_cache()
        self.student = f.make_user()
        self.instructor = f.make_instructor()
        self.staff = f.make_user(is_staff=True)
        self.admin = f.make_admin()

    def tearDown(self):
        features.invalidate_cache()

    def caps(self, user, url=URL, **headers):
        self.client.force_authenticate(user)
        return self.client.get(url, **headers)

    def data(self, user):
        response = self.caps(user)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def expected(self, variant):
        payload = contract_fixtures.load_fixture("capabilities")[variant]
        payload.pop("version")
        return payload

    def without_version(self, payload):
        payload = dict(payload)
        self.assertIsInstance(payload.pop("version"), int)
        # Additive switch from apps.engagement (covered by tests/test_engagement_*).
        # The contract fixture covers the teaching matrix; the purchase gates
        # (pentesting, memberships) and other additive switches are asserted
        # in PurchaseGateCapabilitiesTests below.
        payload["features"] = {key: value for key, value in payload["features"].items() if key == "teaching"}
        payload["items"] = {key: value for key, value in payload["items"].items() if key not in PURCHASE_ITEM_KEYS}
        if "status" in payload:
            payload["status"] = [row for row in payload["status"] if row["key"] == "teaching"]
        return payload

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_viewer_matrix_off(self):
        self.assertEqual(self.without_version(self.data(self.student)), self.expected("student"))
        instructor = self.without_version(self.data(self.instructor))
        self.assertEqual(instructor, self.expected("instructor_off"))
        self.assertEqual(instructor["workspaces"]["teach"]["reason"], OFF_REASON)
        for user in (self.staff, self.admin):
            self.assertEqual(self.without_version(self.data(user)), self.expected("staff_off"))

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_viewer_matrix_after_an_admin_turns_it_on(self):
        features.set_feature("teaching", True, by=self.admin)
        self.assertEqual(self.without_version(self.data(self.instructor)), self.expected("instructor_on"))
        self.assertEqual(self.without_version(self.data(self.staff)), self.expected("staff_on"))
        student = self.expected("student")
        student["features"]["teaching"]["enabled"] = True
        self.assertEqual(self.without_version(self.data(self.student)), student)

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_custom_reason_and_version_bump(self):
        before = self.data(self.instructor)["version"]
        features.set_feature("teaching", True, by=self.admin)
        features.set_feature("teaching", False, by=self.admin, reason="Teaching opens on 1 December.")
        after = self.data(self.instructor)
        self.assertGreater(after["version"], before)
        self.assertEqual(after["workspaces"]["teach"]["reason"], "Teaching opens on 1 December.")
        self.assertEqual(after["items"]["teach-grading"]["reason"], "Teaching opens on 1 December.")

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_etag_and_not_modified(self):
        first = self.caps(self.instructor)
        etag = first["ETag"]
        self.assertTrue(etag.startswith('"caps-'))
        self.assertEqual(first["Cache-Control"], "private, no-cache")
        again = self.caps(self.instructor, HTTP_IF_NONE_MATCH=etag)
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again["ETag"], etag)
        self.assertEqual(self.caps(self.instructor, HTTP_IF_NONE_MATCH=f"W/{etag}").status_code, 304)
        # Each viewer has its own tag; a flip changes it.
        self.assertNotEqual(self.caps(self.student)["ETag"], etag)
        features.set_feature("teaching", True, by=self.admin)
        changed = self.caps(self.instructor, HTTP_IF_NONE_MATCH=etag)
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed["ETag"], etag)

    def test_requires_sign_in(self):
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(URL).status_code, (401, 403))

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_embedded_in_auth_user(self):
        self.client.force_authenticate(self.instructor)
        response = self.client.get("/api/auth/user/")
        self.assertEqual(response.status_code, 200)
        embedded = response.json()["data"]["capabilities"]
        self.assertEqual(embedded, self.data(self.instructor))
        self.assertEqual(embedded["workspaces"]["teach"]["state"], "disabled")

    def test_embedded_at_sign_in(self):
        user = f.make_instructor(email="caps-login@factory.test")
        self.client.force_authenticate(None)
        response = self.client.post(
            "/api/auth/login/", {"email": user.email, "password": f.DEFAULT_PASSWORD}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("capabilities", response.json()["data"])


class PurchaseGateCapabilitiesTests(APITestCase):
    """Pentesting and membership purchase gates: disabled with the reason, never hidden."""

    def setUp(self):
        features.invalidate_cache()
        self.student = f.make_user()
        self.admin = f.make_admin()

    def tearDown(self):
        features.invalidate_cache()

    def data(self, user):
        self.client.force_authenticate(user)
        response = self.client.get(URL)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_off_items_are_disabled_with_reason_and_staff_see_status(self):
        data = self.data(self.student)
        self.assertEqual(
            data["items"]["pentesting-purchase"],
            {"state": "disabled", "reason": features.reason_for("pentesting")},
        )
        self.assertEqual(data["items"]["memberships"]["state"], "disabled")
        self.assertTrue(data["items"]["memberships"]["reason"])
        self.assertFalse(data["features"]["pentesting"]["enabled"])
        self.assertNotIn("status", data)
        staff = self.data(self.admin)
        keys = [row["key"] for row in staff["status"]]
        self.assertIn("pentesting", keys)
        self.assertIn("memberships", keys)

    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_turning_pentesting_on_enables_the_item(self):
        features.set_feature("pentesting", True, by=self.admin)
        data = self.data(self.student)
        self.assertEqual(data["items"]["pentesting-purchase"], {"state": "enabled"})
        self.assertNotIn("pentesting", [row["key"] for row in self.data(self.admin)["status"]])
