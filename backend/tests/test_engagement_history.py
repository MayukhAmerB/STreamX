"""Reward history for the profile tabs (``/api/engagement/me/history/``), the
student's highlighted rewards (``/api/engagement/me/highlights/``) and how
highlights show on the public profile (handle only, certificates as a plain
badge with no reference, link or real name)."""

from __future__ import annotations

import json

from apps.core import features
from apps.engagement import history, rules, services
from apps.engagement.models import Achievement, BadgeAward, Certificate, RewardHighlight
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from tests import factories as f
from tests.engagement_support import item, reset_engagement_state

HISTORY = "/api/engagement/me/history/"
HIGHLIGHTS = "/api/engagement/me/highlights/"


@override_settings(FEATURE_DEFAULT_OVERRIDES={"public_profiles": True, "engagement": True})
class RewardHistoryTests(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()
        cache.clear()
        self.student = f.make_user(full_name="Asha Kumar", email="asha.history@example.test")
        for index in range(3):
            services.award(self.student.pk, item(rules.KIND_MANUAL, 600, f"hist-{index}"))
        self.certificate = Achievement.objects.get(user=self.student, key="operative").certificate
        BadgeAward.objects.get_or_create(user=self.student, badge_key="first_lecture")
        self.course = f.make_course(title="OSINT Investigator", batch="Batch 3")
        f.make_enrollment(user=self.student, course=self.course)
        self.client = APIClient()
        self.client.force_authenticate(self.student)

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def test_requires_sign_in(self):
        self.assertEqual(APIClient().get(HISTORY).status_code, 401)
        self.assertEqual(APIClient().patch(HIGHLIGHTS, {}, format="json").status_code, 401)

    def test_history_lists_xp_badges_batches_and_own_certificates(self):
        response = self.client.get(HISTORY, {"page_size": 2})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "private, no-store")
        data = response.json()["data"]
        self.assertEqual(data["summary"]["total_xp"], 1800)
        xp = data["xp"]
        self.assertEqual((xp["page"], xp["page_size"], xp["total"], xp["has_more"]), (1, 2, 3, True))
        self.assertEqual(
            set(xp["items"][0]), {"id", "date", "day", "source", "source_label", "amount", "description"}
        )
        self.assertEqual((xp["items"][0]["source"], xp["items"][0]["amount"]), (rules.KIND_MANUAL, 600))
        last = self.client.get(HISTORY, {"page": 2, "page_size": 2}).json()["data"]["xp"]
        self.assertEqual((len(last["items"]), last["has_more"]), (1, False))
        self.assertIn("first_lecture", [badge["key"] for badge in data["badges"]])
        self.assertTrue(all("earned_at" in badge and badge["highlighted"] is False for badge in data["badges"]))
        batch = data["batches"][0]
        self.assertEqual((batch["course_title"], batch["batch"], batch["status"]), ("OSINT Investigator", "Batch 3", "active"))
        cert = next(row for row in data["certificates"] if row["reference"] == self.certificate.reference)
        self.assertEqual((cert["valid"], cert["highlighted"]), (True, False))
        self.assertEqual(cert["url"], f"/certificates/{self.certificate.reference}")
        self.assertEqual(data["highlights"], {"badges": [], "certificates": [], "max": 3})
        self.assertEqual(self.client.get(HISTORY, {"page": "x"}).status_code, 400)

    def test_history_never_lists_other_students_certificates(self):
        other = f.make_user()
        services.award(other.pk, item(rules.KIND_MANUAL, 1600, "other"))
        other_ref = Achievement.objects.get(user=other, key="operative").certificate.reference
        body = self.client.get(HISTORY).content.decode()
        self.assertNotIn(other_ref, body)

    def test_history_works_with_the_engagement_switch_off(self):
        with override_settings(FEATURE_DEFAULT_OVERRIDES={"public_profiles": True, "engagement": False}):
            features.invalidate_cache()
            response = self.client.get(HISTORY)
        features.invalidate_cache()
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(response.json()["data"]["engagement_enabled"])

    def test_highlights_rules(self):
        ref = self.certificate.reference
        response = self.client.patch(HIGHLIGHTS, {"badges": ["first_lecture"], "certificates": [ref.lower()]}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"], {"badges": ["first_lecture"], "certificates": [ref], "max": 3})
        data = self.client.get(HISTORY).json()["data"]
        self.assertTrue(next(b for b in data["badges"] if b["key"] == "first_lecture")["highlighted"])
        self.assertTrue(next(c for c in data["certificates"] if c["reference"] == ref)["highlighted"])
        # Sending one list keeps the other.
        self.assertEqual(self.client.patch(HIGHLIGHTS, {"badges": []}, format="json").json()["data"]["certificates"], [ref])
        # Not held, too many, someone else's, wrong shapes.
        bad = self.client.patch(HIGHLIGHTS, {"badges": ["exam_ace"]}, format="json")
        self.assertEqual((bad.status_code, bad.json()["code"]), (400, "validation_failed"))
        self.assertIn("badges", bad.json()["errors"])
        for key in ("streak_3", "streak_7", "lecture_10"):
            BadgeAward.objects.get_or_create(user=self.student, badge_key=key)
        too_many = self.client.patch(HIGHLIGHTS, {"badges": ["first_lecture", "streak_3", "streak_7"]}, format="json")
        self.assertEqual(too_many.status_code, 400)
        self.assertIn("highlights", too_many.json()["errors"])
        other = f.make_user()
        services.award(other.pk, item(rules.KIND_MANUAL, 1600, "other"))
        other_ref = Achievement.objects.get(user=other, key="operative").certificate.reference
        stolen = self.client.patch(HIGHLIGHTS, {"certificates": [other_ref]}, format="json")
        self.assertEqual(stolen.status_code, 400)
        self.assertIn("certificates", stolen.json()["errors"])
        self.assertEqual(self.client.patch(HIGHLIGHTS, {"badges": "first_lecture"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(HIGHLIGHTS, {"badges": ["streak_3"]}, format="json").status_code, 200)
        self.assertEqual(
            list(RewardHighlight.objects.filter(user=self.student).values_list("kind", "key")),
            [("badge", "streak_3"), ("certificate", ref)],
        )

    def test_public_profile_shows_highlights_as_badges_without_links_or_names(self):
        ref = self.certificate.reference
        self.client.patch(HIGHLIGHTS, {"badges": ["first_lecture"], "certificates": [ref]}, format="json")
        from apps.profiles.models import StudentProfile
        from django.utils import timezone

        StudentProfile.objects.create(
            user=self.student, handle="quiet_falcon", visibility=StudentProfile.VISIBILITY_PUBLIC,
            published_at=timezone.now(), published={"blocks": []},
        )
        response = APIClient().get("/api/profiles/u/quiet_falcon/")
        self.assertEqual(response.status_code, 200, response.content)
        highlights = response.json()["data"]["highlights"]
        self.assertEqual([row["kind"] for row in highlights], ["badge", "certificate"])
        self.assertEqual(highlights[1]["title"], history.certificate_badge_title(self.certificate))
        blob = json.dumps(highlights)
        for secret in (ref, "Asha", "/certificates/", "asha.history"):
            self.assertNotIn(secret, blob)
        # A revoked certificate drops off the public profile.
        Certificate.objects.filter(pk=self.certificate.pk).update(revoked_at=timezone.now())
        self.assertEqual([row["kind"] for row in history.public_highlights(self.student.pk)], ["badge"])

    def test_certificate_badge_titles(self):
        self.assertEqual(history.certificate_badge_title(Certificate(cert_type=Certificate.TYPE_OSINT)), "Certified OSINT Investigator")
        self.assertTrue(history.certificate_badge_title(self.certificate).startswith("Certified"))
