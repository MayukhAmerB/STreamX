"""Django back office: Settings › Features (UI overhaul plan §5.5; WS-F)."""

from __future__ import annotations

from django.contrib.auth.models import Permission
from django.test import TestCase, override_settings

from apps.core import features
from apps.core.models import FeatureFlag, FeatureFlagChange
from tests import factories as f

URL = "/admin/core/featureflag/"
HISTORY_URL = "/admin/core/featureflagchange/"


@override_settings(FEATURE_DEFAULT_OVERRIDES={})
class FeaturesPageTests(TestCase):
    def setUp(self):
        features.invalidate_cache()
        self.admin = f.make_admin(full_name="Ayesha Admin")
        self.client.force_login(self.admin)

    def tearDown(self):
        features.invalidate_cache()

    def post(self, data, **headers):
        return self.client.post(URL, data, **headers)

    def test_page_renders_the_teachers_card(self):
        f.make_instructor()
        response = self.client.get(URL)
        self.assertEqual(response.status_code, 200)
        html = response.content.decode()
        self.assertIn("<h1>Features</h1>", html)
        self.assertIn("Teachers section", html)
        self.assertIn('role="switch"', html)
        self.assertIn('aria-checked="false"', html)
        self.assertIn("Turn on the Teachers section?", html)
        self.assertIn("1 instructor account", html)
        self.assertIn("Default · off for new installs", html)
        self.assertIn('name="csrfmiddlewaretoken"', html)

    def test_alias_redirects_to_the_page(self):
        response = self.client.get("/admin/settings/features/")
        self.assertRedirects(response, URL, fetch_redirect_response=False)

    def test_post_flips_audits_and_redirects_with_undo(self):
        response = self.post({"key": "teaching", "enabled": "1", "expected_version": "0", "note": "Spring term"})
        self.assertRedirects(response, f"{URL}?changed=teaching", fetch_redirect_response=False)
        self.assertTrue(features.is_enabled("teaching"))
        change = FeatureFlagChange.objects.get()
        self.assertEqual((change.note, change.changed_by), ("Spring term", self.admin))
        page = self.client.get(f"{URL}?changed=teaching").content.decode()
        self.assertIn("Teachers section is on. Instructors will see it within seconds.", page)
        self.assertIn(">Undo</button>", page)
        self.assertIn("Turned on by Ayesha Admin", page)
        self.assertIn("History (1)", page)
        self.assertIn("Spring term", page)

    def test_undo_posts_the_previous_state_and_is_audited(self):
        self.post({"key": "teaching", "enabled": "1", "expected_version": "0"})
        self.post({"key": "teaching", "enabled": "0", "expected_version": "1", "undo": "1"})
        self.assertFalse(features.is_enabled("teaching"))
        self.assertEqual(FeatureFlagChange.objects.order_by("-id").first().note, "Undo")
        self.assertEqual(FeatureFlagChange.objects.count(), 2)

    def test_turning_off_with_a_custom_reason(self):
        features.set_feature("teaching", True, by=self.admin)
        self.post({"key": "teaching", "enabled": "0", "expected_version": "1", "reason": "Teaching opens on 1 December."})
        self.assertEqual(features.reason_for("teaching"), "Teaching opens on 1 December.")
        self.assertIn("Teaching opens on 1 December.", self.client.get(URL).content.decode())

    def test_stale_version_shows_the_conflict_and_fresh_state(self):
        other = f.make_admin(full_name="Omar Admin")
        features.set_feature("teaching", True, by=other)
        response = self.post({"key": "teaching", "enabled": "1", "expected_version": "0"})
        self.assertEqual(response.status_code, 409)
        html = response.content.decode()
        self.assertIn("Omar Admin changed this", html)
        self.assertIn("Review and try again.", html)
        self.assertIn('aria-checked="true"', html)
        self.assertEqual(FeatureFlag.objects.get().version, 1)

    def test_fetch_post_returns_the_card_and_undo(self):
        response = self.post(
            {"key": "teaching", "enabled": "1", "expected_version": "0"}, HTTP_X_REQUESTED_WITH="fetch"
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["undo"], {"key": "teaching", "enabled": False, "version": 1, "message": body["message"]})
        self.assertIn('aria-checked="true"', body["card_html"])
        stale = self.post({"key": "teaching", "enabled": "0", "expected_version": "0"}, HTTP_X_REQUESTED_WITH="fetch")
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["code"], "feature_changed_meanwhile")
        self.assertIn("ff-confirm__error", stale.json()["card_html"])

    def test_invalid_reason_is_refused_in_the_card(self):
        response = self.post({"key": "teaching", "enabled": "0", "expected_version": "0", "reason": "<script>x</script>"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Remove the script or markup", response.content.decode())

    @override_settings(FEATURE_FORCE={"teaching": True})
    def test_locked_switch_is_disabled_with_the_reason(self):
        html = self.client.get(URL).content.decode()
        self.assertIn("Locked by server configuration.", html)
        self.assertIn('aria-disabled="true"', html)
        response = self.post({"key": "teaching", "enabled": "0", "expected_version": "0"})
        self.assertEqual(response.status_code, 403)

    def test_unknown_key_is_404(self):
        self.assertEqual(self.post({"key": "nope", "enabled": "1"}).status_code, 404)

    def test_add_and_delete_are_not_offered(self):
        self.assertEqual(self.client.get(f"{URL}add/").status_code, 403)
        row = FeatureFlag.objects.create(key="teaching", enabled=True, version=1)
        self.assertRedirects(self.client.get(f"{URL}{row.pk}/change/"), URL, fetch_redirect_response=False)


@override_settings(FEATURE_DEFAULT_OVERRIDES={})
class FeaturesPagePermissionTests(TestCase):
    def setUp(self):
        features.invalidate_cache()

    def tearDown(self):
        features.invalidate_cache()

    def test_signed_out_and_non_staff_go_to_login(self):
        self.assertIn("/admin/login/", self.client.get(URL)["Location"])
        self.client.force_login(f.make_user())
        self.assertIn("/admin/login/", self.client.get(URL)["Location"])

    def test_staff_without_permission_is_refused(self):
        self.client.force_login(f.make_user(is_staff=True))
        self.assertEqual(self.client.get(URL).status_code, 403)
        self.assertEqual(self.client.post(URL, {"key": "teaching", "enabled": "1"}).status_code, 403)
        self.assertFalse(features.is_enabled("teaching"))

    def test_view_only_staff_see_a_disabled_switch(self):
        staff = f.make_user(is_staff=True)
        staff.user_permissions.add(Permission.objects.get(codename="view_featureflag"))
        self.client.force_login(staff)
        html = self.client.get(URL).content.decode()
        self.assertIn("You can see this switch but not change it.", html)
        self.assertEqual(self.client.post(URL, {"key": "teaching", "enabled": "1"}).status_code, 403)

    def test_change_permission_is_enough(self):
        staff = f.make_user(is_staff=True)
        staff.user_permissions.add(Permission.objects.get(codename="change_featureflag"))
        self.client.force_login(staff)
        response = self.client.post(URL, {"key": "teaching", "enabled": "1", "expected_version": "0"})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(features.is_enabled("teaching"))

    def test_history_is_read_only(self):
        admin = f.make_admin()
        features.set_feature("teaching", True, by=admin, note="for the history list")
        self.client.force_login(admin)
        response = self.client.get(HISTORY_URL)
        self.assertEqual(response.status_code, 200)
        self.assertIn("for the history list", response.content.decode())
        change = FeatureFlagChange.objects.get()
        self.assertEqual(self.client.get(f"{HISTORY_URL}add/").status_code, 403)
        self.client.post(f"{HISTORY_URL}{change.pk}/delete/", {"post": "yes"})
        self.assertTrue(FeatureFlagChange.objects.filter(pk=change.pk).exists())
