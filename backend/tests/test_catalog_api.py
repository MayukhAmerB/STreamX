"""``GET /api/catalog/``, the free OSINT directory and labs access (contract §1, §3, §4)."""

from __future__ import annotations

from io import StringIO

from django.core.cache import cache
from django.core.management import call_command
from django.test import override_settings
from rest_framework.test import APITestCase

from apps.core import features
from apps.courses.models import Course
from apps.osint_labs.access import sign_pass, verify_pass
from apps.osint_labs.management.commands.import_osint_directory import DEFAULT_FILE, import_rows, load_rows
from apps.osint_labs.models import OsintChallenge, flag_hash
from apps.payments.platform_plans import seed_platform_plans
from tests import factories as f

URL = "/api/catalog/"


def seed_all():
    call_command("seed_pentesting_catalog", "--apply", stdout=StringIO())
    seed_platform_plans(apply=True)
    paths, rows = load_rows(DEFAULT_FILE)
    report = import_rows(paths, rows, apply=True)
    assert not report["errors"], report["errors"]


@override_settings(FEATURE_DEFAULT_OVERRIDES={})
class CatalogApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        features.invalidate_cache()
        self.osint = f.make_course(category=Course.CATEGORY_OSINT, launch_status=Course.STATUS_LIVE, duration="3 months")
        seed_all()

    def tearDown(self):
        features.invalidate_cache()
        cache.clear()

    def get(self, **headers):
        response = self.client.get(URL, **headers)
        self.assertEqual(response.status_code, 200, response.content)
        return response

    def test_shape_and_gates(self):
        response = self.get()
        self.assertIn("public", response["Cache-Control"])
        self.assertTrue(response["ETag"].startswith('"catalog-'))
        data = response.json()["data"]
        self.assertEqual(data["gates"]["pentesting"]["enabled"], False)
        self.assertTrue(data["gates"]["pentesting"]["reason"].startswith("Pentesting is coming soon"))
        self.assertEqual(data["gates"]["memberships"]["enabled"], False)
        self.assertEqual(data["gates"]["labs_membership_required"], {"enabled": False, "reason": ""})
        self.assertEqual([t["key"] for t in data["tiers"]], ["foundations", "offensive", "defensive", "advanced", "quick_wins"])
        self.assertEqual([t["course_count"] for t in data["tiers"]], [4, 4, 2, 4, 6])
        card = data["tiers"][0]["courses"][1]
        self.assertEqual(card["slug"], "pt-command-line")
        self.assertEqual(card["purchase"]["state"], "coming_soon")
        self.assertEqual(card["purchase"]["code"], "feature_disabled")
        self.assertEqual(card["module_count"], 8)
        self.assertEqual(card["url"], f"/courses/{card['id']}")
        tracks = {t["key"]: t for t in data["tracks"]}
        self.assertEqual(tracks["web_pentesting"]["title"], "Pentesting")
        self.assertEqual(tracks["web_pentesting"]["state"], "coming_soon")
        self.assertEqual(len(tracks["web_pentesting"]["tiers"]), 5)
        self.assertEqual([c["id"] for c in data["osint"]["courses"]], [self.osint.pk])
        self.assertEqual(data["plans"][0]["key"], "free")
        self.assertTrue(all(p["price"] is None for p in data["plans"][1:]))
        self.assertEqual(data["plans"][1]["family"], data["plans"][1]["group"])
        self.assertGreaterEqual(len(data["free_challenges"]), 20)
        self.assertEqual(data["stats"]["free_challenge_count"], len(data["free_challenges"]))
        self.assertEqual([tab["key"] for tab in data["labs"]["tabs"]], ["hub", "realworld", "blackmeridian", "certification", "exam"])

    def test_etag_round_trip_and_switch_flip(self):
        etag = self.get()["ETag"]
        self.assertEqual(self.client.get(URL, HTTP_IF_NONE_MATCH=etag).status_code, 304)
        features.set_feature("pentesting", True, by=f.make_admin())
        data = self.get().json()["data"]
        self.assertTrue(data["gates"]["pentesting"]["enabled"])
        # The switch no longer blocks; the seeded courses are still not live.
        self.assertNotEqual(data["tiers"][0]["courses"][0]["purchase"]["code"], "feature_disabled")
        self.assertNotEqual(data["tiers"][0]["courses"][0]["purchase"]["state"], "available")

    def test_payload_is_built_once_and_served_from_cache(self):
        from unittest.mock import patch

        from apps.courses import catalog_api

        self.get()
        with patch.object(catalog_api, "build_catalog", side_effect=AssertionError("rebuilt")):
            self.get()
            self.get()

    def test_course_list_items_carry_tier_fields(self):
        rows = self.client.get("/api/courses/?catalog=current").json()["data"]
        rows = rows["results"] if isinstance(rows, dict) else rows
        pt = next(row for row in rows if row["slug"] == "pt-security-thinking")
        self.assertEqual((pt["tier"], pt["tier_label"], pt["tier_order"]), ("foundations", "Foundations", 1))
        self.assertEqual(pt["module_count"], 6)
        self.assertEqual(pt["purchase_gate"]["code"], "feature_disabled")


class DirectoryTests(APITestCase):
    def setUp(self):
        cache.clear()
        paths, rows = load_rows(DEFAULT_FILE)
        import_rows(paths, rows, apply=True)
        self.student = f.make_user()

    def test_directory_is_public_link_out_metadata(self):
        data = self.client.get("/api/labs/directory/").json()["data"]
        self.assertGreaterEqual(len(data["items"]), 20)
        self.assertLessEqual(len(data["items"]), 40)
        self.assertIsNone(data["me"])
        for item in data["items"]:
            self.assertTrue(item["url"].startswith("https://"))
            self.assertEqual(item["hosting"], "link_out")
            self.assertTrue(item["source_is_free"])
            self.assertTrue(item["cta_label"].startswith("Start on "))
        self.assertEqual({p["key"] for p in data["paths"]}, {"first_steps", "going_deeper", "hard_cases"})

    def test_progress_self_reported_and_flag_for_hosted(self):
        item = OsintChallenge.objects.first()
        self.client.force_authenticate(self.student)
        response = self.client.post(f"/api/labs/directory/{item.slug}/progress/", {"done": True}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["xp"], item.xp)
        undo = self.client.post(f"/api/labs/directory/{item.slug}/progress/", {"done": False}, format="json")
        self.assertEqual(undo.json()["data"]["xp"], 0)
        hosted = OsintChallenge.objects.create(
            slug="our-hosted-case", title="Our hosted case", platform="Al Syed", url="https://labs.alsyedinitiative.com/",
            hosting="hosted", licence="MIT", attribution="Our own case", flag_sha256=flag_hash("FLAG{Right}"),
        )
        hosted.full_clean()
        wrong = self.client.post(f"/api/labs/directory/{hosted.slug}/progress/", {"done": True, "flag": "nope"}, format="json")
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(wrong.json()["errors"]["code"], "flag_incorrect")
        right = self.client.post(f"/api/labs/directory/{hosted.slug}/progress/", {"done": True, "flag": " flag{right} "},
                                 format="json")
        self.assertEqual(right.status_code, 200)

    def test_licence_rules(self):
        from django.core.exceptions import ValidationError

        bad = OsintChallenge(slug="nc-case", title="NC", platform="X", url="https://example.org/", hosting="hosted",
                             licence="CC-BY-NC-4.0", attribution="x")
        with self.assertRaises(ValidationError):
            bad.full_clean()
        members_easy = OsintChallenge(slug="m-easy", title="M", platform="X", url="https://example.org/",
                                      access_tier="members", difficulty="easy")
        with self.assertRaises(ValidationError):
            members_easy.full_clean()

    def test_import_is_idempotent(self):
        paths, rows = load_rows(DEFAULT_FILE)
        report = import_rows(paths, rows, apply=True)
        self.assertEqual(report["create"], [])
        self.assertEqual(len(report["unchanged"]), len(rows))


@override_settings(FEATURE_DEFAULT_OVERRIDES={}, LABS_PASS_SECRET="labs-test-secret-0123456789abcdef")
class LabsAccessTests(APITestCase):
    def setUp(self):
        cache.clear()
        features.invalidate_cache()
        self.student = f.make_user()
        self.admin = f.make_admin()

    def tearDown(self):
        features.invalidate_cache()

    def test_switch_off_means_open_labs(self):
        policy = self.client.get("/api/labs/policy/").json()["data"]
        self.assertFalse(policy["membership_required"])
        self.client.force_authenticate(self.student)
        ent = self.client.get("/api/labs/entitlement/").json()["data"]
        self.assertEqual(ent["allowed_difficulties"], ["easy", "medium", "expert", "professional"])

    def test_switch_on_requires_membership_and_pass_is_verifiable(self):
        features.set_feature("labs_membership_required", True, by=self.admin)
        self.client.force_authenticate(self.student)
        ent = self.client.get("/api/labs/entitlement/").json()["data"]
        self.assertEqual(ent["allowed_difficulties"], [])
        response = self.client.post("/api/ctf/labs/pass/", {}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        token = response.json()["data"]["token"]
        payload = verify_pass(token, "labs-test-secret-0123456789abcdef")
        self.assertEqual(payload["sub"], self.student.pk)
        self.assertEqual(payload["dif"], [])
        self.assertIsNone(verify_pass(token, "wrong-secret"))
        self.client.force_authenticate(self.admin)
        staff = self.client.post("/api/labs/pass/", {}, format="json").json()["data"]
        self.assertEqual(staff["allowed_difficulties"], ["easy", "medium", "expert", "professional"])

    def test_expired_pass_is_rejected(self):
        token = sign_pass({"sub": 1, "dif": ["easy"], "stf": False, "exp": 10}, "s")
        self.assertIsNone(verify_pass(token, "s", now=20))
        self.assertIsNotNone(verify_pass(token, "s", now=5))

    @override_settings(LABS_PASS_SECRET="")
    def test_pass_unconfigured_is_503(self):
        self.client.force_authenticate(self.student)
        self.assertEqual(self.client.post("/api/labs/pass/", {}, format="json").status_code, 503)
