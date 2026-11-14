"""Student profiles API (/api/profiles/): permissions, the publish flow with the
PII guard, privacy, images, reports and moderation, the feature switch,
rate-limit wiring and query counts."""

from __future__ import annotations

import io
import shutil
import tempfile

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from PIL import Image
from rest_framework.test import APIClient

from apps.core import features
from apps.profiles import services
from apps.profiles.models import ProfileAuditLog, ProfileImage, ProfileReport, ProfileSiteSettings, StudentProfile
from tests import factories as f


def jpeg(size=(800, 600), exif=None) -> bytes:
    buffer = io.BytesIO()
    kwargs = {"format": "JPEG"}
    if exif is not None:
        kwargs["exif"] = exif
    Image.new("RGB", size, (40, 40, 40)).save(buffer, **kwargs)
    return buffer.getvalue()


class ProfileApiCase(TestCase):
    def setUp(self):
        super().setUp()
        features.invalidate_cache()
        cache.clear()
        self.root = tempfile.mkdtemp(prefix="profiles-api-")
        self.override = override_settings(
            PROFILES_PRIVATE_ROOT=self.root,
            REPORTS_ANTIVIRUS_SCANNER="fake",
            FEATURE_DEFAULT_OVERRIDES={"public_profiles": True, "engagement": True},
        )
        self.override.enable()
        self.student = f.make_user(full_name="Ravi Kumar Sharma", email="ravi.sharma99@example.com", phone_number="+91 98111 22333")
        self.other = f.make_user(full_name="Meera Iyer")
        self.client = APIClient()
        self.client.force_authenticate(self.student)

    def tearDown(self):
        self.override.disable()
        features.invalidate_cache()
        shutil.rmtree(self.root, ignore_errors=True)
        super().tearDown()

    # helpers
    def me(self):
        response = self.client.get("/api/profiles/me/")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def save(self, document, version=None):
        data = self.me() if version is None else None
        return self.client.put(
            "/api/profiles/me/draft/",
            {"document": document, "draft_version": data["draft_version"] if data else version},
            format="json",
        )

    def doc(self, bio="", **extra):
        document = {
            "theme": {"accent": "gold", "align": "center", "banner": "lines", "tagline": "hand"},
            "header": {"display_name": "Quiet Falcon", "tagline": "Learning OSINT one case at a time"},
            "blocks": [
                {"id": "bio", "type": "bio", "source": bio or "I hunt **public** clues. See [my notes](https://github.com/quiet-falcon)."},
                {"id": "skills", "type": "skills", "items": [{"name": "Recon", "level": "practising"}]},
                {"id": "links", "type": "links", "items": [{"label": "GitHub", "url": "https://github.com/quiet-falcon"}]},
            ],
        }
        document.update(extra)
        return document

    def publish(self):
        return self.client.post("/api/profiles/me/publish/", {}, format="json")

    def anon(self):
        return APIClient()


class OwnerFlowTests(ProfileApiCase):
    def test_first_get_creates_a_handle_profile_with_no_real_name(self):
        data = self.me()
        # Automatic, non-identifying handle (owner privacy rule) with a one-time prompt.
        self.assertRegex(data["handle"], r"^operative_[a-z2-7]{6}$")
        self.assertTrue(data["handle_auto"])
        self.assertTrue(data["handle_prompt"])
        self.assertNotIn("ravi", data["handle"])
        self.assertEqual(data["draft"]["header"]["display_name"], data["handle"])
        self.assertFalse(data["is_published"])
        self.assertEqual(data["settings"]["visibility"], "members")
        self.assertFalse(data["settings"]["allow_real_names"])
        self.assertEqual(StudentProfile.objects.count(), 1)
        self.me()
        self.assertEqual(StudentProfile.objects.count(), 1, "idempotent")
        self.assertTrue(ProfileAuditLog.objects.filter(action="created").exists())

    def test_save_draft_then_publish_then_public_view(self):
        response = self.save(self.doc())
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["warnings"], [])
        self.assertTrue(response.json()["data"]["has_unpublished_changes"])
        response = self.publish()
        self.assertEqual(response.status_code, 200, response.content)
        handle = response.json()["data"]["handle"]
        self.assertFalse(response.json()["data"]["has_unpublished_changes"])

        # Members-only by default: anonymous visitors are asked to sign in.
        anon = self.anon().get(f"/api/profiles/u/{handle}/")
        self.assertEqual(anon.status_code, 403)
        self.assertEqual(anon.json()["code"], "profile_members_only")

        viewer = APIClient()
        viewer.force_authenticate(self.other)
        page = viewer.get(f"/api/profiles/u/{handle}/")
        self.assertEqual(page.status_code, 200, page.content)
        data = page.json()["data"]
        self.assertEqual(data["header"]["display_name"], "Quiet Falcon")
        self.assertIsNone(data["header"]["real_name"])
        self.assertFalse(data["is_owner"])
        self.assertTrue(data["can_report"])
        bio = data["blocks"][0]
        self.assertEqual(bio["type"], "bio")
        self.assertNotIn("source", bio, "the public page gets the parsed document only")
        self.assertEqual(page["Cache-Control"], "private, no-store")
        self.assertIn("default-src 'none'", page["Content-Security-Policy"])
        self.assertNotIn("ravi", page.content.decode().lower())
        self.assertNotIn("example.com", page.content.decode().lower())

        # Draft edits do not leak before the next publish.
        self.save(self.doc(bio="A brand new bio"))
        data = viewer.get(f"/api/profiles/u/{handle}/").json()["data"]
        self.assertNotIn("brand new", str(data))

    def test_public_visibility_lets_anonymous_visitors_in(self):
        self.save(self.doc())
        self.publish()
        response = self.client.patch("/api/profiles/me/settings/", {"visibility": "public"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        handle = response.json()["data"]["handle"]
        page = self.anon().get(f"/api/profiles/u/{handle.upper()}/")
        self.assertEqual(page.status_code, 200)
        self.assertFalse(page.json()["data"]["can_report"])
        self.assertEqual(page["X-Robots-Tag"], "noarchive")

    def test_publish_is_blocked_by_the_pii_guard_with_masked_findings(self):
        bad = self.doc(bio="Ping me on WhatsApp +91 98765 43210 or ravi.sharma99@example.com")
        bad["header"]["tagline"] = "Ravi Sharma here"
        response = self.save(bad)
        self.assertEqual(response.status_code, 200)
        warnings = response.json()["data"]["warnings"]
        self.assertTrue(warnings)
        response = self.publish()
        self.assertEqual(response.status_code, 422, response.content)
        body = response.json()
        self.assertEqual(body["code"], "pii_detected")
        findings = body["errors"]["findings"]
        self.assertEqual({item["code"] for item in findings} >= {"phone", "own_identity"}, True)
        self.assertIn("header.tagline", {item["path"] for item in findings})
        self.assertNotIn("98765 43210", response.content.decode())
        self.assertFalse(StudentProfile.objects.get(user=self.student).is_published)
        entry = ProfileAuditLog.objects.get(action="publish_blocked")
        self.assertIn("phone", entry.details["codes"])
        self.assertNotIn("98765", str(entry.details))

    def test_each_detector_blocks_publishing(self):
        from apps.profiles.pii.checksums import luhn_check_digit, verhoeff_check_digit

        samples = {
            "email": "write to falcon@protonmail.com",
            "phone": "+44 20 7946 0958",
            "aadhaar": "23456789012" + verhoeff_check_digit("23456789012"),
            "pan": "ABCPE1234F",
            "passport": "passport no: J8369854",
            "card_number": "411111111111111" + luhn_check_digit("411111111111111"),
            "ifsc": "SBIN0001234",
            "address": "Lajpat Nagar, New Delhi 110024",
            "date_of_birth": "DOB: 12/05/2004",
            "government_id": "voter id: XYZ9876543",
            "own_identity": "I am Ravi Sharma",
        }
        for code, text in samples.items():
            with self.subTest(code=code):
                self.assertEqual(self.save(self.doc(bio=text)).status_code, 200)
                response = self.publish()
                self.assertEqual(response.status_code, 422, f"{code}: {response.content}")
                self.assertIn(code, {item["code"] for item in response.json()["errors"]["findings"]})

    def test_real_names_are_never_shown_even_with_the_retired_admin_switch(self):
        # Owner privacy rule: profiles show the handle only; real names appear
        # only on certificates. The old admin switch is ignored.
        rules = ProfileSiteSettings.load()
        rules.allow_real_names = True
        rules.save()
        response = self.client.patch("/api/profiles/me/settings/", {"show_real_name": True}, format="json")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "real_names_not_allowed")
        self.assertFalse(self.me()["settings"]["allow_real_names"])
        # The PII guard keeps blocking the owner's real name.
        self.save(self.doc(bio="Hi, I am Ravi Sharma."))
        self.assertEqual(self.publish().status_code, 422)
        self.save(self.doc())
        self.assertEqual(self.publish().status_code, 200)
        handle = self.me()["handle"]
        viewer = APIClient()
        viewer.force_authenticate(self.other)
        response = viewer.get(f"/api/profiles/u/{handle}/")
        self.assertIsNone(response.json()["data"]["header"]["real_name"])
        self.assertNotIn("Ravi", response.content.decode())

    def test_stale_draft_version_conflicts(self):
        version = self.me()["draft_version"]
        self.assertEqual(self.save(self.doc(), version=version).status_code, 200)
        response = self.save(self.doc(bio="second tab"), version=version)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "draft_version_conflict")

    def test_xss_and_bad_links_never_reach_storage(self):
        attempts = [
            self.doc(bio="<script>alert(1)</script>"),
            self.doc(bio="[x](javascript:alert(1))"),
            self.doc(bio="<img src=x onerror=alert(1)>"),
            {**self.doc(), "blocks": [{"type": "links", "items": [{"label": "x", "url": "data:text/html,<script>alert(1)</script>"}]}]},
            {**self.doc(), "blocks": [{"type": "links", "items": [{"label": "x", "url": "http://plain.example.com"}]}]},
            {**self.doc(), "header": {"display_name": "\" onmouseover=\"alert(1)"}},
        ]
        before = StudentProfile.objects.get_or_create(user=self.student, defaults={"handle": "seed_falcon_1000"})[0].draft
        for document in attempts:
            with self.subTest(document=str(document)[:80]):
                response = self.save(document)
                self.assertGreaterEqual(response.status_code, 400)
                self.assertLess(response.status_code, 500)
        self.assertEqual(StudentProfile.objects.get(user=self.student).draft, before)

    def test_handle_rules(self):
        self.me()
        cases = {
            "ravisharma": "handle_identity",
            "Ravi_Sharma99": "handle_identity",
            "ab": "validation_failed",
            "_bad_": "validation_failed",
            "bad__double": "validation_failed",
            "admin": "validation_failed",
            "has space": "validation_failed",
        }
        for handle, code in cases.items():
            with self.subTest(handle=handle):
                response = self.client.post("/api/profiles/me/handle/", {"handle": handle}, format="json")
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(response.json()["code"], code)
        other_profile = services.get_or_create_profile(self.other)
        response = self.client.post("/api/profiles/me/handle/", {"handle": other_profile.handle}, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "handle_taken")
        response = self.client.post("/api/profiles/me/handle/", {"handle": "@Night_Owl_42"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["handle"], "night_owl_42")
        self.assertEqual(response.json()["data"]["draft"]["header"]["display_name"], "night_owl_42")
        response = self.client.post("/api/profiles/me/handle/", {"handle": "night_owl_43"}, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "handle_change_too_soon")

    def test_unpublish(self):
        self.save(self.doc())
        handle = self.publish().json()["data"]["handle"]
        response = self.client.post("/api/profiles/me/unpublish/", {}, format="json")
        self.assertEqual(response.status_code, 200)
        viewer = APIClient()
        viewer.force_authenticate(self.other)
        self.assertEqual(viewer.get(f"/api/profiles/u/{handle}/").status_code, 404)
        # The owner still sees a preview of their draft.
        own = self.client.get(f"/api/profiles/u/{handle}/")
        self.assertEqual(own.status_code, 200)
        self.assertTrue(own.json()["data"]["preview"])

    def test_preview_shows_the_draft_to_the_owner(self):
        self.save(self.doc(bio="draft words"))
        response = self.client.get("/api/profiles/me/preview/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("draft words", str(response.json()["data"]["blocks"]))

    def test_badges_show_only_earned_ones(self):
        from apps.engagement.models import BadgeAward

        BadgeAward.objects.create(user=self.student, badge_key="first_lecture")
        BadgeAward.objects.create(user=self.student, badge_key="lecture_10")
        document = self.doc()
        document["blocks"].append({"type": "badges", "badge_keys": ["first_lecture", "lecture_10", "lecture_50"]})
        response = self.save(document)
        self.assertEqual(response.status_code, 200, response.content)
        badges_block = next(block for block in response.json()["data"]["draft"]["blocks"] if block["type"] == "badges")
        self.assertEqual(badges_block["badge_keys"], ["first_lecture", "lecture_10"], "unearned keys dropped")
        self.assertEqual({badge["key"] for badge in response.json()["data"]["earned_badges"]}, {"first_lecture", "lecture_10"})
        handle = self.publish().json()["data"]["handle"]
        BadgeAward.objects.filter(badge_key="lecture_10").update(revoked_at="2026-01-01T00:00:00Z")
        viewer = APIClient()
        viewer.force_authenticate(self.other)
        block = next(b for b in viewer.get(f"/api/profiles/u/{handle}/").json()["data"]["blocks"] if b["type"] == "badges")
        self.assertEqual([badge["key"] for badge in block["items"]], ["first_lecture"], "a revoked badge disappears")

    def test_leaderboard_privacy_toggle(self):
        response = self.client.patch("/api/profiles/me/settings/", {"show_on_leaderboards": False}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIs(response.json()["data"]["settings"]["show_on_leaderboards"], False)
        response = self.client.patch("/api/profiles/me/settings/", {"show_on_leaderboards": True}, format="json")
        self.assertIs(response.json()["data"]["settings"]["show_on_leaderboards"], True)


class ImageApiTests(ProfileApiCase):
    def upload(self, data, kind="gallery", name="p.jpg"):
        return self.client.post(
            "/api/profiles/me/images/", {"file": SimpleUploadedFile(name, data, content_type="image/jpeg"), "kind": kind}, format="multipart"
        )

    def test_upload_use_publish_and_serve(self):
        exif = Image.Exif()
        exif.get_ifd(0x8825).update({1: "N", 2: (28.0, 36.0, 50.0)})
        response = self.upload(jpeg(exif=exif), kind="avatar")
        self.assertEqual(response.status_code, 200, response.content)
        image_id = response.json()["data"]["image"]["id"]
        stored = ProfileImage.objects.get(pk=image_id)
        self.assertTrue(stored.file.name.endswith(".bin"))
        self.assertNotIn(self.root, stored.file.name, "stored by relative name")
        with self.assertRaises(ValueError):
            stored.file.url  # noqa: B018 - private storage refuses direct links
        self.assertIn("location", ProfileAuditLog.objects.get(action="image_added").details["stripped"])

        document = self.doc()
        document["header"]["avatar_id"] = image_id
        self.assertEqual(self.save(document).status_code, 200)
        media = f"/api/profiles/media/{image_id}/"

        viewer = APIClient()
        viewer.force_authenticate(self.other)
        self.assertEqual(viewer.get(media).status_code, 404, "not visible before publishing")
        owner = self.client.get(media)
        self.assertEqual(owner.status_code, 200)
        self.assertEqual(owner["Content-Type"], "image/webp")
        self.assertEqual(owner["X-Content-Type-Options"], "nosniff")
        self.assertIn("sandbox", owner["Content-Security-Policy"])

        handle = self.publish().json()["data"]["handle"]
        response = viewer.get(media)
        self.assertEqual(response.status_code, 200)
        body = b"".join(response.streaming_content)
        self.assertNotIn(b"Exif", body)
        self.assertEqual(self.anon().get(media).status_code, 404, "members-only profile")
        page = viewer.get(f"/api/profiles/u/{handle}/").json()["data"]
        self.assertEqual(page["header"]["avatar"], media)

        # An image that is not in the published snapshot stays private.
        second = self.upload(jpeg(), kind="gallery").json()["data"]["image"]["id"]
        self.assertEqual(viewer.get(f"/api/profiles/media/{second}/").status_code, 404)

        # Deleting removes it from the draft and the published snapshot.
        response = self.client.delete(f"/api/profiles/me/images/{image_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["data"]["draft"]["header"]["avatar_id"])
        self.assertIsNone(viewer.get(f"/api/profiles/u/{handle}/").json()["data"]["header"]["avatar"])
        self.assertEqual(viewer.get(media).status_code, 404)

    def test_cannot_use_someone_elses_image(self):
        other_client = APIClient()
        other_client.force_authenticate(self.other)
        theirs = other_client.post(
            "/api/profiles/me/images/", {"file": SimpleUploadedFile("p.jpg", jpeg(), content_type="image/jpeg"), "kind": "avatar"}, format="multipart"
        ).json()["data"]["image"]["id"]
        document = self.doc()
        document["header"]["avatar_id"] = theirs
        self.assertEqual(self.save(document).status_code, 400)
        self.assertEqual(self.client.delete(f"/api/profiles/me/images/{theirs}/").status_code, 404)

    def test_limits_and_refusals(self):
        for _ in range(services.MAX_AVATARS):
            self.assertEqual(self.upload(jpeg(), kind="avatar").status_code, 200)
        response = self.upload(jpeg(), kind="avatar")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "image_limit")
        response = self.upload(b"<svg onload=alert(1)>", name="x.svg")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "image_type")
        self.assertTrue(ProfileAuditLog.objects.filter(action="image_rejected").exists())
        response = self.client.post("/api/profiles/me/images/", {"kind": "gallery"}, format="multipart")
        self.assertEqual(response.status_code, 400)


class ReportAndModerationTests(ProfileApiCase):
    def setUp(self):
        super().setUp()
        self.save(self.doc())
        self.handle = self.publish().json()["data"]["handle"]
        self.reporter = APIClient()
        self.reporter.force_authenticate(self.other)
        self.admin = f.make_admin()
        self.staff = APIClient()
        self.staff.force_authenticate(self.admin)

    def test_report_once_then_hide_and_restore(self):
        url = f"/api/profiles/u/{self.handle}/report/"
        response = self.reporter.post(url, {"reason": "personal_info", "details": "Shows a phone number"}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        again = self.reporter.post(url, {"reason": "spam"}, format="json")
        self.assertEqual(again.status_code, 409)
        self.assertEqual(again.json()["code"], "already_reported")
        own = self.client.post(url, {"reason": "spam"}, format="json")
        self.assertEqual(own.status_code, 400)
        self.assertIn(self.anon().post(url, {"reason": "spam"}, format="json").status_code, (401, 403))
        self.assertEqual(self.reporter.post(url, {"reason": "nope"}, format="json").status_code, 400)

        queue = self.staff.get("/api/profiles/moderation/reports/")
        self.assertEqual(queue.status_code, 200)
        self.assertEqual([row["handle"] for row in queue.json()["data"]["reports"]], [self.handle])
        self.assertEqual(self.reporter.get("/api/profiles/moderation/reports/").status_code, 403)

        response = self.staff.post(f"/api/profiles/moderation/profiles/{self.handle}/hide/", {"reason": "Shared a phone number"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(ProfileReport.objects.get().status, "actioned")
        self.assertEqual(self.reporter.get(f"/api/profiles/u/{self.handle}/").status_code, 404)
        own = self.client.get("/api/profiles/me/").json()["data"]
        self.assertEqual(own["status"], "hidden")
        self.assertEqual(own["hidden_reason"], "Shared a phone number")
        blocked = self.publish()
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.json()["code"], "profile_hidden")
        self.assertEqual(self.staff.get(f"/api/profiles/u/{self.handle}/").status_code, 200, "staff still see it")

        self.assertEqual(self.reporter.post(f"/api/profiles/moderation/profiles/{self.handle}/restore/", {}, format="json").status_code, 403)
        response = self.staff.post(f"/api/profiles/moderation/profiles/{self.handle}/restore/", {}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.reporter.get(f"/api/profiles/u/{self.handle}/").status_code, 200)
        actions = set(ProfileAuditLog.objects.values_list("action", flat=True))
        self.assertTrue({"reported", "hidden", "restored", "published"} <= actions)

    def test_dismiss(self):
        self.reporter.post(f"/api/profiles/u/{self.handle}/report/", {"reason": "spam"}, format="json")
        report = ProfileReport.objects.get()
        response = self.staff.post(f"/api/profiles/moderation/reports/{report.pk}/dismiss/", {"reason": "Looks fine"}, format="json")
        self.assertEqual(response.status_code, 200)
        report.refresh_from_db()
        self.assertEqual(report.status, "dismissed")
        # A dismissed report lets the same member report again later.
        self.assertEqual(self.reporter.post(f"/api/profiles/u/{self.handle}/report/", {"reason": "spam"}, format="json").status_code, 201)

    def test_inactive_owner_disappears(self):
        self.student.is_active = False
        self.student.save(update_fields=["is_active"])
        self.assertEqual(self.reporter.get(f"/api/profiles/u/{self.handle}/").status_code, 404)

    def test_unknown_handles_are_404(self):
        for handle in ["nobody_here", "x" * 64, "..%2f..%2fetc"]:
            with self.subTest(handle=handle):
                self.assertEqual(self.reporter.get(f"/api/profiles/u/{handle}/").status_code, 404)


class FeatureSwitchTests(ProfileApiCase):
    def test_every_endpoint_is_off_when_the_switch_is_off(self):
        self.save(self.doc())
        handle = self.publish().json()["data"]["handle"]
        with override_settings(FEATURE_DEFAULT_OVERRIDES={"public_profiles": False}):
            features.invalidate_cache()
            checks = [
                self.client.get("/api/profiles/me/"),
                self.client.put("/api/profiles/me/draft/", {"document": self.doc()}, format="json"),
                self.client.post("/api/profiles/me/publish/", {}, format="json"),
                self.client.patch("/api/profiles/me/settings/", {"visibility": "public"}, format="json"),
                self.client.get(f"/api/profiles/u/{handle}/"),
                self.anon().get(f"/api/profiles/u/{handle}/"),
            ]
            for response in checks:
                self.assertEqual(response.status_code, 403, response.content)
                self.assertEqual(response.json()["code"], "feature_disabled")
                self.assertEqual(response.json()["errors"]["feature"], "public_profiles")
        features.invalidate_cache()
        self.assertTrue(StudentProfile.objects.get(user=self.student).is_published, "data is kept")

    def test_production_default_is_on(self):
        # Owner decision: student profiles are on from release day.
        feature = features.get_feature("public_profiles")
        self.assertIsNotNone(feature)
        self.assertTrue(feature.default)

    def test_requires_authentication_for_owner_endpoints(self):
        anon = self.anon()
        for method, url in [("get", "/api/profiles/me/"), ("post", "/api/profiles/me/publish/"), ("get", "/api/profiles/moderation/reports/")]:
            with self.subTest(url=url):
                self.assertIn(getattr(anon, method)(url).status_code, (401, 403))


class ThrottleAndQueryTests(ProfileApiCase):
    def test_views_use_the_profile_throttles(self):
        from apps.profiles import throttles, views

        self.assertIn(throttles.ProfilePublicThrottle, views.PublicProfileView.throttle_classes)
        self.assertIn(throttles.ProfilePublicThrottle, views.ProfileMediaView.throttle_classes)
        scopes = {type(t).__name__ for t in views.MyImagesView().get_throttles()}
        self.assertIn("ProfileUploadThrottle", scopes)
        scopes = {type(t).__name__ for t in views.ReportProfileView().get_throttles()}
        self.assertIn("ProfileReportThrottle", scopes)

    @override_settings(PROFILES_PUBLIC_RATE="3/minute")
    def test_public_rate_limit(self):
        self.save(self.doc())
        handle = self.publish().json()["data"]["handle"]
        self.client.patch("/api/profiles/me/settings/", {"visibility": "public"}, format="json")
        from apps.profiles.throttles import ProfilePublicThrottle

        with self.settings(), _patched_rate(ProfilePublicThrottle, "3/minute"):
            cache.clear()
            statuses = [self.anon().get(f"/api/profiles/u/{handle}/").status_code for _ in range(5)]
        self.assertEqual(statuses[:3], [200, 200, 200])
        self.assertEqual(statuses[-1], 429)

    def test_public_page_query_count_is_constant(self):
        from apps.engagement.models import BadgeAward

        for key in ("first_lecture", "lecture_10", "deep_focus"):
            BadgeAward.objects.create(user=self.student, badge_key=key)
        document = self.doc()
        document["blocks"].append({"type": "badges", "badge_keys": ["first_lecture", "lecture_10", "deep_focus"]})
        self.save(document)
        handle = self.publish().json()["data"]["handle"]
        viewer = APIClient()
        viewer.force_authenticate(self.other)
        viewer.get(f"/api/profiles/u/{handle}/")
        with CaptureQueriesContext(connection) as queries:
            response = viewer.get(f"/api/profiles/u/{handle}/")
        self.assertEqual(response.status_code, 200)
        self.assertLessEqual(len(queries), 4, [q["sql"][:120] for q in queries])


class _patched_rate:
    def __init__(self, cls, rate):
        self.cls, self.rate = cls, rate

    def __enter__(self):
        self.old = self.cls.rate
        self.cls.rate = self.rate

    def __exit__(self, *exc):
        self.cls.rate = self.old
