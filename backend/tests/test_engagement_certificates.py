"""Verifiable certificates (apps.engagement.certificates): reference numbers and
their check character, race-safe issuing, the real-name snapshot and audited
corrections, revocation, the public API (no e-mail or phone), slug -> reference
redirects, the rendered files, the QR code, the verification origin and its
deploy check, Monthly CTF finalist certificates, and verification with the
switch off."""

from __future__ import annotations

import io
import json
import re
import threading
from datetime import timedelta
from unittest import mock, skipUnless

from apps.core import features
from apps.engagement import certificate_render, certificates, rules, services
from apps.engagement.models import Achievement, AppendOnlyError, Certificate, CertificateRevision
from django.core.cache import cache
from django.db import connections
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from tests import factories as f
from tests.engagement_support import item, reset_engagement_state

API = "/api/engagement/certificates/"
REFERENCE_RE = re.compile(r"^ASI-\d{4}-(OSINT|PEN|COURSE|EXAM|CTF|BADGE|LEVEL)-\d{6,}-[0-9A-Z]$")


def _award_level(user, points=1510, key="lvl"):  # just past Operative (1,500 XP)
    return services.award(user.pk, item(rules.KIND_MANUAL, points, key))


def _strings(value):
    """Every key and string value in a JSON-like payload."""
    if isinstance(value, dict):
        for key, inner in value.items():
            yield str(key)
            yield from _strings(inner)
    elif isinstance(value, (list, tuple)):
        for inner in value:
            yield from _strings(inner)
    elif value is not None:
        yield str(value)


# --- reference numbers ---------------------------------------------------------------------------------
class ReferenceNumberTests(TestCase):
    def test_format(self):
        reference = certificates.format_reference(2026, "OSINT", 42)
        self.assertRegex(reference, REFERENCE_RE)
        self.assertTrue(reference.startswith("ASI-2026-OSINT-000042-"))
        self.assertEqual(certificates.parse_reference(reference), reference)
        self.assertTrue(certificates.is_valid_reference(reference))
        self.assertRegex(certificates.format_reference(2027, "PEN", 1234567), r"^ASI-2027-PEN-1234567-[0-9A-Z]$")
        with self.assertRaises(ValueError):
            certificates.format_reference(2026, "NOPE", 1)

    def test_every_single_character_typo_is_detected(self):
        for sequence in (1, 42, 999, 123456):
            reference = certificates.format_reference(2026, "EXAM", sequence)
            for index, original in enumerate(reference):
                if original == "-":
                    continue
                for replacement in certificates.ALPHABET:
                    if replacement == original:
                        continue
                    typo = reference[:index] + replacement + reference[index + 1:]
                    self.assertFalse(certificates.is_valid_reference(typo), typo)

    def test_neighbour_swaps_are_detected(self):
        reference = certificates.format_reference(2026, "OSINT", 381927)
        body = reference.replace("-", "")
        swaps = [
            body[:i] + body[i + 1] + body[i] + body[i + 2:]
            for i in range(len(body) - 1)
            if body[i] != body[i + 1]
        ]
        detected = sum(1 for swap in swaps if not certificates._check_ok(swap))
        self.assertGreaterEqual(detected / len(swaps), 0.9)

    def test_parse_forgives_case_spaces_dashes_and_lookalikes(self):
        reference = certificates.format_reference(2026, "BADGE", 7)
        self.assertEqual(certificates.parse_reference(reference.lower()), reference)
        self.assertEqual(certificates.parse_reference(f"  {reference.replace('-', ' ')} "), reference)
        self.assertEqual(certificates.parse_reference(reference.replace("-", "")), reference)
        self.assertEqual(certificates.parse_reference(reference.replace("000007", "OOOOO7")), reference)
        self.assertFalse(certificates.is_valid_reference(reference.lower()))  # valid, but not canonical

    def test_bad_input(self):
        good = certificates.format_reference(2026, "OSINT", 9)
        wrong_check = good[:-1] + ("0" if good[-1] != "0" else "1")
        with self.assertRaises(certificates.BadReference) as raised:
            certificates.parse_reference(wrong_check)
        self.assertEqual(raised.exception.code, "check")
        for text in ("", "ASI", "ASI-2026-XYZ-000001-0", "ASI-2026-OSINT-12-0", "hello", "ASI-26-OSINT-000001-0"):
            with self.assertRaises(certificates.BadReference):
                certificates.parse_reference(text)


# --- issuing ---------------------------------------------------------------------------------------------
class IssueTests(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def test_awarded_achievements_are_certified_with_the_real_name(self):
        student = f.make_user(full_name="  Asha   Kumar ")
        _award_level(student)
        achievement = Achievement.objects.get(user=student, key="operative")
        certificate = achievement.certificate
        self.assertRegex(certificate.reference, REFERENCE_RE)
        self.assertIn("-LEVEL-", certificate.reference)
        self.assertEqual(certificate.recipient_name, "Asha Kumar")
        self.assertEqual(certificate.title, "Operative")
        self.assertEqual(certificate.reference, certificates.format_reference(
            timezone.localtime(certificate.issued_at, rules.IST).year, "LEVEL", certificate.pk))
        self.assertEqual(list(certificate.revisions.values_list("action", "revision")), [("issue", 1)])
        # The snapshot does not follow later account edits.
        student.full_name = "Someone Else"
        student.save(update_fields=["full_name"])
        certificate.refresh_from_db()
        self.assertEqual(certificate.recipient_name, "Asha Kumar")

    def test_types(self):
        student = f.make_user(full_name="Ravi Rao")
        osint = f.make_course(title="OSINT Batch 7", batch="B7", category="osint")
        pen = f.make_course(title="Web Pentesting", category="web_pentesting")
        rows = {
            "course-osint": Achievement.objects.create(user=student, kind="course", key=str(osint.pk), title="Course completed", subtitle=osint.title),
            "course-pen": Achievement.objects.create(user=student, kind="course", key=str(pen.pk), title="Course completed", subtitle=pen.title),
            "exam": Achievement.objects.create(user=student, kind="badge", key="exam_ace", title="Exam Ace"),
            "badge": Achievement.objects.create(user=student, kind="badge", key="streak_7", title="Week Warrior"),
        }
        issued = {name: certificates.ensure_for_achievement(row) for name, row in rows.items()}
        self.assertEqual({name: cert.cert_type for name, cert in issued.items()},
                         {"course-osint": "OSINT", "course-pen": "PEN", "exam": "EXAM", "badge": "BADGE"})
        self.assertEqual(issued["course-osint"].title, "OSINT Batch 7")
        self.assertEqual(issued["course-osint"].programme, "Open Source Intelligence programme · Batch B7")
        self.assertEqual(issued["course-osint"].heading, "Certificate of Completion")
        self.assertEqual(len({cert.reference for cert in issued.values()}), 4)

    def test_issuing_is_idempotent_and_certificates_are_permanent(self):
        student = f.make_user(full_name="Asha Kumar")
        achievement = Achievement.objects.create(user=student, kind="badge", key="first_live", title="First Live Class")
        first = certificates.ensure_for_achievement(achievement)
        self.assertEqual(certificates.ensure_for_achievement(achievement).pk, first.pk)
        self.assertEqual(Certificate.objects.filter(achievement=achievement).count(), 1)
        with self.assertRaises(AppendOnlyError):
            first.delete()
        with self.assertRaises(AppendOnlyError):
            Certificate.objects.filter(pk=first.pk).delete()
        with self.assertRaises(AppendOnlyError):
            CertificateRevision.objects.filter(certificate=first).update(reason="x")

    def test_a_failed_certificate_never_breaks_the_award(self):
        student = f.make_user(full_name="Asha Kumar")
        from unittest import mock

        with mock.patch("apps.engagement.certificates._create", side_effect=RuntimeError("boom")):
            result = _award_level(student)
        self.assertEqual(result.total_xp, 1510)
        achievement = Achievement.objects.get(user=student, key="operative")
        self.assertFalse(Certificate.objects.filter(achievement=achievement).exists())
        # Issued on first use instead.
        response = APIClient().get(f"{API}{achievement.slug}/")
        self.assertEqual(response.status_code, 301)
        self.assertTrue(Certificate.objects.filter(achievement=achievement).exists())

    def test_backfill_command(self):
        from django.core.management import call_command

        student = f.make_user(full_name="Asha Kumar")
        for key in ("streak_3", "streak_7"):
            Achievement.objects.create(user=student, kind="badge", key=key, title=key)
        out = io.StringIO()
        call_command("engagement_issue_certificates", stdout=out)
        self.assertIn("2 achievement(s) and 0 Monthly CTF certificate reward(s) have no certificate", out.getvalue())
        self.assertEqual(Certificate.objects.count(), 0)
        call_command("engagement_issue_certificates", "--apply", stdout=io.StringIO())
        call_command("engagement_issue_certificates", "--apply", stdout=io.StringIO())
        self.assertEqual(Certificate.objects.count(), 2)


class ConcurrentIssueTests(TransactionTestCase):
    """Real threads, each with its own database connection."""

    def _run(self, targets):
        errors = []
        results = []
        barrier = threading.Barrier(len(targets))

        def work(achievement_id):
            try:
                barrier.wait(timeout=10)
                row = Achievement.objects.get(pk=achievement_id)
                results.append(certificates.ensure_for_achievement(row).reference)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
            finally:
                connections.close_all()

        threads = [threading.Thread(target=work, args=(target,)) for target in targets]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        return results, errors

    def test_unique_references_under_concurrency(self):
        student = f.make_user(full_name="Asha Kumar")
        rows = [Achievement.objects.create(user=student, kind="badge", key=f"k{n}", title=f"Badge {n}").pk for n in range(8)]
        results, errors = self._run(rows)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 8)
        self.assertEqual(len(set(results)), 8)
        self.assertTrue(all(certificates.is_valid_reference(reference) for reference in results))
        # The same achievement from many threads: exactly one certificate.
        same = Achievement.objects.create(user=student, kind="badge", key="same", title="Same").pk
        results, errors = self._run([same] * 6)
        self.assertEqual(errors, [])
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(Certificate.objects.filter(achievement_id=same).count(), 1)
        self.assertEqual(Certificate.objects.count(), 9)


# --- API ----------------------------------------------------------------------------------------------------
class CertificateApiCase(TestCase):
    def setUp(self):
        super().setUp()
        reset_engagement_state()
        cache.clear()
        self.student = f.make_user(full_name="Asha Kumar", email="asha.private@example.test")
        if hasattr(self.student, "phone"):
            self.student.phone = "+919876543210"
            self.student.save()
        _award_level(self.student)
        self.achievement = Achievement.objects.get(user=self.student, key="operative")
        self.certificate = self.achievement.certificate
        self.reference = self.certificate.reference
        self.staff = f.make_admin()

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def get(self, ref, suffix=""):
        return APIClient().get(f"{API}{ref}/{suffix}")

    def staff_post(self, action, data, user=None):
        client = APIClient()
        client.force_authenticate(user or self.staff)
        return client.post(f"/api/engagement/staff/certificates/{self.reference}/{action}/", data, format="json")


class PublicApiTests(CertificateApiCase):
    def test_lookup(self):
        response = self.get(self.reference)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("public", response["Cache-Control"])
        data = response.json()["data"]
        self.assertEqual((data["reference"], data["status"], data["valid"]), (self.reference, "verified", True))
        self.assertEqual(data["recipient_name"], "Asha Kumar")
        self.assertEqual(data["title"], "Operative")
        self.assertTrue(data["verify_url"].endswith(f"/certificates/{self.reference}"))
        self.assertIn(self.reference, data["print"]["texts"]["referenceValue"])
        self.assertEqual(data["print"]["texts"]["name"], "Asha Kumar")
        self.assertIn("linkedin.com/profile/add", data["linkedin_add_url"])
        self.assertIn(f"certId={self.reference}", data["linkedin_add_url"])
        self.assertIn("certUrl=", data["linkedin_add_url"])

    def test_no_email_phone_or_ids_are_exposed(self):
        data = self.get(self.reference).json()["data"]
        blob = json.dumps(data).lower()
        self.assertNotIn("asha.private", blob)
        self.assertNotIn("example.test", blob)
        self.assertNotIn("9876543210", blob)
        keys = {key for key in _strings(data) if key.isidentifier()}
        for forbidden in ("email", "phone", "user_id", "user", "revoked_reason", "id"):
            self.assertNotIn(forbidden, set(_strings(data)) & keys, forbidden)

    def test_slug_and_loose_spellings_redirect_to_the_reference(self):
        for spelling in (self.achievement.slug, self.reference.lower(), self.reference.replace("-", " ")):
            response = self.get(spelling)
            self.assertEqual(response.status_code, 301, spelling)
            self.assertEqual(response["Location"], f"{API}{self.reference}/")
        pdf = self.get(self.achievement.slug, "certificate.pdf")
        self.assertEqual(pdf.status_code, 301)
        self.assertEqual(pdf["Location"], f"{API}{self.reference}/certificate.pdf")
        followed = APIClient().get(f"{API}{self.achievement.slug}/", follow=True)
        self.assertEqual(followed.json()["data"]["reference"], self.reference)

    def test_typos_unknown_and_garbage(self):
        typo = self.reference[:-1] + ("0" if self.reference[-1] != "0" else "1")
        response = self.get(typo)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "certificate_reference_typo")
        unknown = certificates.format_reference(2026, "OSINT", 999999)
        self.assertEqual(self.get(unknown).json()["code"], "certificate_not_found")
        self.assertEqual(self.get(unknown).status_code, 404)
        self.assertEqual(self.get("not-a-real-slug").status_code, 404)
        self.assertEqual(self.get("ASI-2026-NOPE-000001-0").json()["code"], "certificate_reference_invalid")

    def test_files_carry_the_reference(self):
        pdf = self.get(self.reference, "certificate.pdf")
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(pdf["Content-Type"], "application/pdf")
        self.assertIn("attachment", pdf["Content-Disposition"])
        self.assertTrue(pdf.content.startswith(b"%PDF-1.4"))
        self.assertIn(self.reference.encode(), pdf.content)  # searchable text layer and metadata
        self.assertIn(b"(Asha Kumar) Tj", pdf.content)
        self.assertIn(b"/MediaBox [0 0 841.89 595.28]", pdf.content)  # A4 landscape
        png = self.get(self.reference, "certificate.png")
        self.assertEqual(png["Content-Type"], "image/png")
        self.assertIn(self.reference.encode(), png.content)
        image = Image.open(io.BytesIO(png.content))
        self.assertEqual(image.size, (2339, 1654))
        self.assertEqual(image.text["Reference"], self.reference)
        self.assertIn("attachment", APIClient().get(f"{API}{self.reference}/certificate.png?download=1")["Content-Disposition"])
        og = self.get(self.reference, "preview.png")
        self.assertEqual(Image.open(io.BytesIO(og.content)).size, (1200, 630))
        self.assertIn(self.reference.encode(), og.content)

    def test_web_view_and_pdf_share_the_print_block(self):
        data = self.get(self.reference).json()["data"]
        canvas = certificate_render.draw_certificate(self.certificate)
        printed = {text for text, *_ in canvas.runs}
        for key, value in data["print"]["texts"].items():
            if value:
                self.assertIn(value, printed, key)

    def test_share_page_has_open_graph_tags(self):
        response = self.get(self.reference, "share/")
        self.assertEqual(response.status_code, 200)
        html = response.content.decode()
        self.assertIn('property="og:image"', html)
        self.assertIn(f"/certificates/{self.reference}/preview.png", html)
        self.assertIn('rel="canonical" href="', html)
        self.assertIn(f"/certificates/{self.reference}", html)
        self.assertIn("summary_large_image", html)
        self.assertNotIn("asha.private", html)
        # Served at /certificates/<ref> to crawlers by the gateway: never cached for people,
        # and people who land on it go to "?view=page", which the gateway always gives the SPA.
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertIn("User-Agent", [part.strip() for part in response["Vary"].split(",")])
        self.assertRegex(html, rf'http-equiv="refresh" content="0; url=[^"]*/certificates/{self.reference}\?view=page"')

    def test_verification_works_with_the_switch_off(self):
        features.set_feature("engagement", False, by=self.staff)
        self.assertEqual(self.get(self.reference).status_code, 200)
        self.assertEqual(self.get(self.reference, "certificate.pdf").status_code, 200)
        self.assertEqual(self.get(self.achievement.slug).status_code, 301)
        self.assertEqual(APIClient().get(f"/api/engagement/achievements/{self.achievement.slug}/").status_code, 200)
        self.assertEqual(self.staff_post("revoke", {"reason": "Issued in error"}).status_code, 200)

    def test_my_achievements_list_the_reference(self):
        client = APIClient()
        client.force_authenticate(self.student)
        rows = client.get("/api/engagement/achievements/").json()["data"]["achievements"]
        row = next(item for item in rows if item["key"] == "operative")
        self.assertEqual(row["reference"], self.reference)
        self.assertTrue(row["verify_url"].endswith(f"/certificates/{self.reference}"))


class StaffTests(CertificateApiCase):
    def test_name_correction_reissues_with_the_same_reference(self):
        before_png = self.get(self.reference, "certificate.png").content
        response = self.staff_post("correct-name", {"recipient_name": "Asha  Kumari", "reason": "Spelling on her ID card"})
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual((data["reference"], data["revision"], data["recipient_name"]), (self.reference, 2, "Asha Kumari"))
        self.certificate.refresh_from_db()
        self.assertEqual((self.certificate.reference, self.certificate.revision), (self.reference, 2))
        entry = self.certificate.revisions.get(action="correct_name")
        self.assertEqual((entry.name_before, entry.name_after, entry.revision), ("Asha Kumar", "Asha Kumari", 2))
        self.assertEqual((entry.reason, entry.actor_id, entry.actor_email), ("Spelling on her ID card", self.staff.pk, self.staff.email))
        self.assertEqual([row["action"] for row in data["audit"]], ["issue", "correct_name"])
        public = self.get(self.reference).json()["data"]
        self.assertEqual(public["recipient_name"], "Asha Kumari")
        self.assertIn("Revision 2", public["print"]["texts"]["footer"])
        self.assertNotEqual(self.get(self.reference, "certificate.png").content, before_png)
        self.assertIn(b"(Asha Kumari) Tj", self.get(self.reference, "certificate.pdf").content)

    def test_correction_rules(self):
        self.assertEqual(self.staff_post("correct-name", {"recipient_name": "New Name", "reason": "x"}).status_code, 400)
        self.assertEqual(self.staff_post("correct-name", {"recipient_name": "<b>", "reason": "Bad input"}).status_code, 400)
        self.assertEqual(self.staff_post("correct-name", {"recipient_name": "Asha Kumar", "reason": "No change"}).status_code, 400)
        student_try = self.staff_post("correct-name", {"recipient_name": "Hacker", "reason": "Because"}, user=self.student)
        self.assertEqual(student_try.status_code, 403)
        self.assertEqual(APIClient().post(f"/api/engagement/staff/certificates/{self.reference}/correct-name/", {}).status_code, 401)
        self.certificate.refresh_from_db()
        self.assertEqual((self.certificate.recipient_name, self.certificate.revision), ("Asha Kumar", 1))

    def test_revoke_and_reinstate(self):
        self.assertEqual(self.staff_post("revoke", {"reason": "Academic misconduct"}).status_code, 200)
        data = self.get(self.reference).json()["data"]
        self.assertEqual((data["status"], data["valid"]), ("revoked", False))
        self.assertIsNotNone(data["revoked_at"])
        self.assertNotIn("Academic misconduct", json.dumps(data))
        self.assertEqual(data["print"]["stamp"], "REVOKED")
        self.assertIn(b"(REVOKED) Tj", self.get(self.reference, "certificate.pdf").content)
        self.assertEqual(self.staff_post("revoke", {"reason": "Again"}).status_code, 400)
        self.assertEqual(self.staff_post("reinstate", {"reason": "Appeal upheld"}).status_code, 200)
        self.assertEqual(self.get(self.reference).json()["data"]["status"], "verified")
        actions = list(self.certificate.revisions.order_by("created_at", "id").values_list("action", flat=True))
        self.assertEqual(actions, ["issue", "revoke", "reinstate"])

    def test_revoking_the_achievement_revokes_the_certificate(self):
        badge_client = APIClient()
        badge_client.force_authenticate(self.staff)
        payload = {"user_id": self.student.pk, "badge_key": "exam_ace", "action": "award", "reason": "Offline exam"}
        self.assertEqual(badge_client.post("/api/engagement/staff/badges/", payload, format="json").status_code, 200)
        certificate = Achievement.objects.get(user=self.student, key="exam_ace").certificate
        self.assertIn("-EXAM-", certificate.reference)
        self.assertEqual(self.get(certificate.reference).json()["data"]["status"], "verified")
        badge_client.post("/api/engagement/staff/badges/", {**payload, "action": "revoke", "reason": "Mistake"}, format="json")
        self.assertEqual(self.get(certificate.reference).json()["data"]["status"], "revoked")
        badge_client.post("/api/engagement/staff/badges/", payload, format="json")
        self.assertEqual(self.get(certificate.reference).json()["data"]["status"], "verified")
        self.assertEqual(Certificate.objects.filter(achievement__key="exam_ace").count(), 1)


class ThrottleTests(CertificateApiCase):
    def test_public_lookup_is_rate_limited(self):
        from apps.engagement.throttles import CertificateLookupThrottle

        original = CertificateLookupThrottle.rate
        CertificateLookupThrottle.rate = "3/minute"
        try:
            codes = [self.get(self.reference).status_code for _ in range(5)]
        finally:
            CertificateLookupThrottle.rate = original
        self.assertEqual(codes[:3], [200, 200, 200])
        self.assertEqual(codes[-1], 429)


# --- QR code -------------------------------------------------------------------------------------------
# A fixed 21 x 21 test pattern (dark border and diagonal) standing in for an encoded QR code.
FAKE_QR = [[1 if x in (0, 20) or y in (0, 20) or x == y else 0 for x in range(21)] for y in range(21)]


class QrCodeTests(CertificateApiCase):
    def test_svg_path_merges_runs(self):
        self.assertEqual(certificates.qr_path([[1, 1, 0], [0, 1, 0]]), "M0 0h2v1h-2zM1 1h1v1h-1z")
        self.assertEqual(certificates.qr_path([[0, 0], [0, 0]]), "")

    def test_qr_on_the_page_image_and_pdf(self):
        with (
            mock.patch.object(certificates, "qr_matrix", return_value=FAKE_QR),
            mock.patch.object(certificates, "qr_available", return_value=True),
        ):
            data = self.get(self.reference).json()["data"]
            png = self.get(self.reference, "certificate.png").content
            pdf = self.get(self.reference, "certificate.pdf")
        qr = data["qr"]
        self.assertEqual((qr["modules"], qr["quiet"]), (21, certificates.QR_QUIET_ZONE))
        self.assertEqual(qr["path"], certificates.qr_path(FAKE_QR))
        self.assertTrue(qr["url"].endswith(f"/certificates/{self.reference}"))
        self.assertEqual(data["print"]["texts"]["qrCaption"], "SCAN TO VERIFY")
        self.assertNotIn("qr", data["print"])  # the matrix is sent once, as the SVG path
        self.assertEqual(pdf.status_code, 200)
        # The paper square sits in the black panel with a dark module in its top-left corner.
        image = Image.open(io.BytesIO(png)).convert("RGB")
        spec = certificate_render.LAYOUT["qr"]
        scale = certificate_render.PRINT_SCALE
        count = len(FAKE_QR) + 2 * spec["quiet"]
        module = int((spec["size"] * scale) // count)
        left = round(spec["cx"] * scale - module * count / 2) + spec["quiet"] * module
        top = round(spec["cy"] * scale - module * count / 2) + spec["quiet"] * module
        dark = image.getpixel((left + module // 2, top + module // 2))
        light = image.getpixel((left + module + module // 2, top + 2 * module + module // 2))
        quiet = image.getpixel((left - module // 2, top - module // 2))
        self.assertLess(max(dark), 40)
        self.assertGreater(min(light), 230)
        self.assertGreater(min(quiet), 230)  # the quiet zone is paper, not the black panel
        colours = {pixel for _count, pixel in image.crop((left, top, left + module * 21, top + module * 21)).getcolors(1 << 16)}
        self.assertTrue(all(max(c) - min(c) <= 3 for c in colours))  # monochrome: greys only

    def test_without_a_qr_library_the_address_is_printed(self):
        with (
            mock.patch.object(certificates, "qr_matrix", return_value=None),
            mock.patch.object(certificates, "qr_available", return_value=False),
        ):
            data = self.get(self.reference).json()["data"]
            self.assertEqual(self.get(self.reference, "certificate.pdf").status_code, 200)
        self.assertIsNone(data["qr"])
        self.assertEqual(data["print"]["texts"]["qrCaption"], "")
        self.assertIn(f"/certificates/{self.reference}", data["print"]["texts"]["footer"])

    @skipUnless(certificates.qr_available(), "segno is not installed (pip install -r requirements.txt)")
    def test_real_qr_encodes_the_certificate_url(self):
        matrix = certificates.qr_matrix(certificates.public_url(self.reference))
        size = len(matrix)
        self.assertTrue(all(len(row) == size for row in matrix))
        self.assertEqual((size - 21) % 4, 0)
        # Finder pattern in the top-left corner: a dark 7-module edge, then a light ring inside.
        self.assertEqual(matrix[0][:7], [1] * 7)
        self.assertEqual(matrix[1][1:6], [0] * 5)
        self.assertEqual(self.get(self.reference).json()["data"]["qr"]["modules"], size)


# --- verification origin and deploy check ------------------------------------------------------------------
class OriginTests(TestCase):
    @override_settings(APP_ENV="production", FRONTEND_PUBLIC_ORIGIN="https://alsyedinitiative.com/", FRONTEND_URL="http://internal:5173")
    def test_origin_comes_from_frontend_public_origin(self):
        reference = certificates.format_reference(2026, "OSINT", 1)
        self.assertEqual(certificates.public_url(reference), f"https://alsyedinitiative.com/certificates/{reference}")
        self.assertEqual(certificates.short_url(reference), f"alsyedinitiative.com/certificates/{reference}")

    @override_settings(APP_ENV="production", FRONTEND_PUBLIC_ORIGIN="", FRONTEND_URL="http://internal:5173")
    def test_production_never_prints_an_internal_address(self):
        from apps.engagement.checks import check_certificate_origin

        self.assertEqual(certificates.public_origin(), "https://alsyedinitiative.com")
        messages = check_certificate_origin()
        self.assertIn("engagement.I001", [message.id for message in messages])
        self.assertTrue(all(message.level < 30 for message in messages))  # INFO: never blocks a production start

    @override_settings(APP_ENV="production", FRONTEND_PUBLIC_ORIGIN="http://alsyedinitiative.com")
    def test_insecure_origin_is_reported(self):
        from apps.engagement.checks import check_certificate_origin

        self.assertIn("engagement.I002", [message.id for message in check_certificate_origin()])

    @override_settings(APP_ENV="development", FRONTEND_PUBLIC_ORIGIN="", FRONTEND_URL="http://localhost:5173")
    def test_development_uses_frontend_url_and_skips_the_check(self):
        from apps.engagement.checks import check_certificate_origin

        self.assertEqual(certificates.public_origin(), "http://localhost:5173")
        self.assertEqual(check_certificate_origin(), [])


# --- Monthly CTF finalist certificates ---------------------------------------------------------------------
@override_settings(FEATURE_DEFAULT_OVERRIDES={"teaching": True, "engagement": False, "monthly_ctf": True})
class CtfCertificateTests(TestCase):
    """Issued on finalisation even with the engagement switch off; old CTF slugs redirect."""

    def setUp(self):
        super().setUp()
        cache.clear()
        from apps.ctf import season_services
        from apps.ctf.season_models import CtfSeason

        from tests.test_monthly_ctf import ANSWER, make_season

        self.season_services = season_services
        opens = timezone.now() - timedelta(days=2)
        self.season = make_season(opens_at=opens, closes_at=timezone.now() + timedelta(days=1))
        self.users = [f.make_user(full_name=f"Finalist Number {n}") for n in range(12)]
        for index, user in enumerate(self.users):
            season_services.submit_answer(self.season, user, ANSWER, now=opens + timedelta(minutes=1 + index))
        CtfSeason.objects.filter(pk=self.season.pk).update(closes_at=timezone.now() - timedelta(hours=1))
        self.season.refresh_from_db()

    def finalise(self):
        from apps.core.outbox import drain_outbox

        with self.captureOnCommitCallbacks(execute=True):
            self.season_services.finalise(self.season)
        drain_outbox(batch_size=50)

    def test_finalists_get_reference_numbered_certificates_with_real_names(self):
        from django.core.management import call_command

        self.assertFalse(features.is_enabled("engagement"))
        self.finalise()
        rows = list(Certificate.objects.filter(cert_type="CTF").select_related("ctf_reward").order_by("ctf_reward__rank"))
        self.assertEqual(len(rows), 10)
        self.assertEqual(len({row.reference for row in rows}), 10)
        self.assertTrue(all(certificates.is_valid_reference(row.reference) and "-CTF-" in row.reference for row in rows))
        champion = rows[0]
        self.assertEqual(champion.recipient_name, "Finalist Number 0")  # the real name, not the CTF handle
        self.assertEqual((champion.heading, champion.statement), ("Certificate of Excellence", "won first place in"))
        self.assertEqual(rows[1].statement, "placed 2nd in")
        self.assertEqual(rows[9].statement, "finished as a top-ten finalist in")
        self.assertEqual(champion.title, self.season.title)
        self.assertIn("Final rank 1", champion.programme)
        # Idempotent: replaying the event or the backfill issues nothing new.
        self.assertEqual(certificates.issue_for_ctf_season(self.season.pk), 0)
        call_command("engagement_issue_certificates", "--apply", stdout=io.StringIO())
        self.assertEqual(Certificate.objects.filter(cert_type="CTF").count(), 10)

    def test_old_ctf_slug_redirects_and_revocation_shows(self):
        from apps.ctf.season_models import CtfSeasonReward

        self.finalise()
        reward = CtfSeasonReward.objects.get(season=self.season, kind="certificate", rank=1)
        certificate = reward.engagement_certificate
        response = APIClient().get(f"{API}{reward.verify_slug}/")
        self.assertEqual(response.status_code, 301)
        self.assertEqual(response["Location"], f"{API}{certificate.reference}/")
        data = APIClient().get(f"{API}{certificate.reference}/").json()["data"]
        self.assertEqual((data["type"], data["status"], data["recipient_name"]), ("CTF", "verified", "Finalist Number 0"))
        # The Monthly CTF's own verification endpoint is untouched.
        self.assertEqual(APIClient().get(f"/api/ctf/seasons/certificates/{reward.verify_slug}/").status_code, 200)
        self.season_services.revoke_reward(reward, actor=f.make_admin(), reason="Rule breach")
        data = APIClient().get(f"{API}{certificate.reference}/").json()["data"]
        self.assertEqual((data["status"], data["valid"]), ("revoked", False))
        self.assertNotIn("Rule breach", json.dumps(data))

    def test_rewards_before_this_release_are_certified_on_first_lookup(self):
        from apps.ctf.season_models import CtfSeasonReward

        with mock.patch("apps.engagement.certificate_signals.publish"):
            self.finalise()
        self.assertEqual(Certificate.objects.filter(cert_type="CTF").count(), 0)
        reward = CtfSeasonReward.objects.get(season=self.season, kind="certificate", rank=3)
        response = APIClient().get(f"{API}{reward.verify_slug}/", follow=True)
        self.assertEqual(response.json()["data"]["statement"], "placed 3rd in")
        self.assertEqual(Certificate.objects.filter(cert_type="CTF").count(), 1)

    def test_a_failing_hook_never_breaks_finalisation(self):
        from apps.ctf.season_models import CtfSeason

        with mock.patch("apps.engagement.certificate_signals.publish", side_effect=RuntimeError("boom")):
            self.finalise()
        self.season.refresh_from_db()
        self.assertEqual(self.season.status, CtfSeason.STATUS_FINALISED)
