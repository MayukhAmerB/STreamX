"""PII guard (apps.profiles.pii): every detector, positives and negatives.

Pure Python: no database. Numbers are built with the real check-digit
algorithms so the tests never contain a real person's identifier.
"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.profiles import pii
from apps.profiles.pii import engine
from apps.profiles.pii.checksums import luhn_check_digit, luhn_valid, verhoeff_check_digit, verhoeff_valid
from apps.profiles.pii.detectors import handle_mentions_identity
from apps.profiles.pii.normalize import mask, normalize


def aadhaar(prefix="23456789012") -> str:
    return prefix + verhoeff_check_digit(prefix)


def card(prefix="411111111111111") -> str:
    return prefix + luhn_check_digit(prefix)


def codes(text, ctx=None):
    return [finding.code for finding in pii.scan_text(text, ctx)]


class ChecksumTests(SimpleTestCase):
    def test_verhoeff(self):
        number = aadhaar()
        self.assertTrue(verhoeff_valid(number))
        broken = number[:-1] + str((int(number[-1]) + 1) % 10)
        self.assertFalse(verhoeff_valid(broken))
        self.assertFalse(verhoeff_valid(""))
        self.assertFalse(verhoeff_valid("12ab"))
        self.assertTrue(verhoeff_valid("2363"))  # the classic worked example: 236 -> 3

    def test_luhn(self):
        self.assertTrue(luhn_valid("4111111111111111"))
        self.assertFalse(luhn_valid("4111111111111112"))
        self.assertTrue(luhn_valid(card("37828224631000")))
        self.assertFalse(luhn_valid("7"))


class NormalizeTests(SimpleTestCase):
    def test_folds_lookalikes_and_invisible_characters(self):
        text = "９８７６​５４３２１０ २०"  # full-width digits, ZWSP, Devanagari digits
        self.assertEqual(normalize(text), "9876543210 20")

    def test_dashes_and_spaces(self):
        self.assertEqual(normalize("a–b  c\r\n\r\nd"), "a-b c\nd")

    def test_mask_never_repeats_the_value(self):
        self.assertEqual(mask("9876543210"), "987••••210")
        self.assertEqual(mask("abc"), "•••")


class EmailTests(SimpleTestCase):
    def test_positive(self):
        for text in [
            "mail me: ravi.k+ctf@example.com",
            "ravi @ example.co.in",
            "ravi [at] example [dot] com",
            "ravi(at)example.com",
            "ravi at gmail dot com",
            "ravi @ gmail . com",
            "RAVI@EXAMPLE.ORG",
        ]:
            with self.subTest(text=text):
                self.assertIn("email", codes(text))

    def test_negative(self):
        for text in ["I love @mentions and #tags", "Use git@ for ssh", "email me on the platform", "a@b"]:
            with self.subTest(text=text):
                self.assertNotIn("email", codes(text))


class UpiTests(SimpleTestCase):
    def test_positive(self):
        self.assertIn("upi_id", codes("pay me at ravi99@okaxis"))
        self.assertIn("upi_id", codes("tips: 9876x@ybl"))

    def test_negative(self):
        self.assertEqual(codes("python@3.12 is great"), [])


class PhoneTests(SimpleTestCase):
    def test_indian_mobile(self):
        for text in [
            "call 9876543210",
            "+91 98765 43210",
            "+91-9876543210",
            "0091 9876543210",
            "09876543210",
            "98765-43210",
            "987 654 3210",
            "９８７６５４３２１０",
            "98​76543210",
        ]:
            with self.subTest(text=text):
                self.assertIn("phone", codes(text))

    def test_international_e164(self):
        for text in ["+1 415 555 2671", "+44 20 7946 0958", "+971-50-123-4567", "+14155552671"]:
            with self.subTest(text=text):
                self.assertIn("phone", codes(text))

    def test_landline_and_keyword(self):
        self.assertIn("phone", codes("office (011) 23456789"))
        self.assertIn("phone", codes("WhatsApp: 4471 234 567"))

    def test_negative(self):
        for text in [
            "Scored 1234567 points",
            "Scanned 192.168.100.200 and 10.0.0.1",
            "CVE-2021-44228 write-up",
            "Ranked 5 of 120 in 2024",
            "version 1.2.3.4",
            "port 8080 and 443",
        ]:
            with self.subTest(text=text):
                self.assertNotIn("phone", codes(text))


class AadhaarTests(SimpleTestCase):
    def test_positive_with_check_digit(self):
        number = aadhaar()
        for text in [number, f"{number[:4]} {number[4:8]} {number[8:]}", f"{number[:4]}-{number[4:8]}-{number[8:]}"]:
            with self.subTest(text=text):
                self.assertIn("aadhaar", codes(text))

    def test_keyword_catches_typos(self):
        number = aadhaar()
        broken = number[:-1] + str((int(number[-1]) + 1) % 10)
        self.assertNotIn("aadhaar", codes(broken))
        self.assertIn("aadhaar", codes(f"my aadhaar is {broken}"))

    def test_virtual_id(self):
        vid = "912345678901234"
        vid = vid + verhoeff_check_digit(vid)
        self.assertIn("aadhaar", codes(vid))

    def test_negative(self):
        self.assertNotIn("aadhaar", codes("0123 4567 8901"))  # cannot start with 0/1


class PanTests(SimpleTestCase):
    def test_positive(self):
        self.assertIn("pan", codes("PAN ABCPE1234F"))
        self.assertIn("pan", codes("abcpe1234f"))

    def test_negative(self):
        self.assertNotIn("pan", codes("ABCDE12345"))
        self.assertNotIn("pan", codes("ABCXE1234F"))  # fourth letter is not a holder type


class PassportTests(SimpleTestCase):
    def test_positive(self):
        self.assertIn("passport", codes("J8369854"))
        self.assertIn("passport", codes("passport no: Z1234567"))
        self.assertIn("passport", codes("Passport number is X12345678"))

    def test_negative(self):
        self.assertNotIn("passport", codes("Q1234567"))  # Q is not used for Indian passports
        self.assertNotIn("passport", codes("I passed the passport-office quiz"))


class GovernmentIdTests(SimpleTestCase):
    def test_positive(self):
        for text in [
            "ABC1234567",
            "DL-14 2011 0062821",
            "SSN 078-05-1120",
            "AB 12 34 56 C",
            "voter id: XYZ9876543",
            "roll no 21CS1043",
            "ABHA 12-3456-7890-1234",
            "GSTIN 27ABCPE1234F1Z5",
        ]:
            with self.subTest(text=text):
                self.assertTrue(set(codes(text)) & {"government_id", "pan"}, codes(text))

    def test_negative(self):
        self.assertNotIn("government_id", codes("roll the dice"))
        self.assertNotIn("government_id", codes("student id card design"))


class CardTests(SimpleTestCase):
    def test_positive(self):
        number = card()
        for text in [number, " ".join(number[i : i + 4] for i in range(0, 16, 4)), "-".join(number[i : i + 4] for i in range(0, 16, 4))]:
            with self.subTest(text=text):
                self.assertIn("card_number", codes(text))
        self.assertIn("card_number", codes(card("37828224631000")))

    def test_negative(self):
        self.assertNotIn("card_number", codes("4111111111111112"))  # Luhn fails
        self.assertNotIn("card_number", codes("1234567812345670"))  # no issuer prefix


class BankTests(SimpleTestCase):
    def test_ifsc(self):
        self.assertIn("ifsc", codes("SBIN0001234"))
        self.assertIn("ifsc", codes("ifsc: hdfc0abcdef"))
        self.assertNotIn("ifsc", codes("Lorem0ipsums"))

    def test_account_number_needs_context(self):
        self.assertIn("bank_account", codes("bank account no 123456789012"))
        self.assertIn("bank_account", codes("A/c: 1012 3456 7890"))
        self.assertNotIn("bank_account", codes("solved 123456789012 hashes"))


class AddressTests(SimpleTestCase):
    def test_positive(self):
        for text in [
            "Lajpat Nagar, New Delhi 110024",
            "PIN code 560001",
            "12, MG Road",
            "221B Baker Street",
            "House no. 45/2",
            "flat 3B",
            "my address is 4th cross, Indiranagar",
        ]:
            with self.subTest(text=text):
                self.assertIn("address", codes(text))

    def test_negative(self):
        for text in [
            "Solved 560001 challenges",
            "my IP address is 10.0.0.1",
            "email address is private",
            "Top 100 streets of OSINT",
        ]:
            with self.subTest(text=text):
                self.assertNotIn("address", codes(text))


class DateOfBirthTests(SimpleTestCase):
    def test_positive(self):
        for text in ["DOB: 12/05/2004", "date of birth 12 May 2004", "born on 3rd March 2005", "birthday: May 12", "born in 2004", "d.o.b 2004-05-12"]:
            with self.subTest(text=text):
                self.assertIn("date_of_birth", codes(text))

    def test_negative(self):
        self.assertNotIn("date_of_birth", codes("Joined on 12/05/2024"))
        self.assertNotIn("date_of_birth", codes("CTF on 12 May 2024"))


class OwnIdentityTests(SimpleTestCase):
    ctx = pii.ScanContext(full_name="Ravi Kumar Sharma", email="ravi.sharma99@example.com", phone="+91 98111 22333")

    def test_real_name_variants(self):
        for text in ["Hi, I'm Ravi Sharma", "ravi_sharma", "Sharma Ravi", "RAVI KUMAR SHARMA", "ravi.kumar"]:
            with self.subTest(text=text):
                self.assertIn("own_identity", codes(text, self.ctx))

    def test_single_first_name_alone_is_allowed(self):
        self.assertNotIn("own_identity", codes("Ravi loves OSINT", self.ctx))

    def test_email_local_part_and_phone(self):
        self.assertIn("own_identity", codes("find me as ravi.sharma99", self.ctx))
        self.assertIn("own_identity", codes("98111-22333", self.ctx))

    def test_allowed_when_admin_allows_real_names(self):
        ctx = pii.ScanContext(full_name="Ravi Sharma", allow_real_name=True)
        self.assertNotIn("own_identity", codes("I'm Ravi Sharma", ctx))

    def test_handle_identity(self):
        self.assertTrue(handle_mentions_identity("ravisharma_ctf", self.ctx))
        self.assertTrue(handle_mentions_identity("x_ravi_sharma99", self.ctx))
        self.assertFalse(handle_mentions_identity("quiet_falcon_2041", self.ctx))


class EngineTests(SimpleTestCase):
    def test_overlaps_keep_the_higher_priority(self):
        number = aadhaar()
        findings = pii.scan_text(f"aadhaar {number}")
        self.assertEqual([finding.code for finding in findings], ["aadhaar"])

    def test_findings_are_masked_and_carry_paths(self):
        findings = pii.scan_fields([("blocks[0].source", "call 9876543210")])
        self.assertEqual(findings[0].path, "blocks[0].source")
        self.assertNotIn("9876543210", findings[0].excerpt)
        self.assertNotIn("9876543210", str(findings[0].as_dict()))

    def test_summary(self):
        findings = pii.scan_text("call 9876543210 or ravi@example.com")
        text = pii.summary(findings)
        self.assertIn("a phone number", text)
        self.assertIn("an email address", text)
        self.assertEqual(pii.summary([]), "")

    def test_custom_detector_and_skip(self):
        import re

        @engine.register
        class StudentIdDetector(engine.Detector):
            code = "test_student_id"
            label = "a student ID"
            priority = 5
            pattern = re.compile(r"\bSID-\d{6}\b")

            def find(self, text, ctx):
                for match in self.pattern.finditer(text):
                    yield match.start(), match.end()

        try:
            self.assertIn("test_student_id", codes("SID-123456"))
            self.assertEqual(codes("SID-123456", pii.ScanContext(skip=frozenset({"test_student_id"}))), [])
        finally:
            engine.unregister("test_student_id")
        self.assertNotIn("test_student_id", codes("SID-123456"))

    def test_register_requires_code_and_label(self):
        with self.assertRaises(ValueError):

            @engine.register
            class Broken(engine.Detector):
                code = ""

    def test_clean_security_write_up_passes(self):
        text = (
            "Recon on the target: nmap -sV 10.10.11.42 found ports 22, 80 and 8443. "
            "CVE-2023-4863 in libwebp; exploited with a 1337-byte payload. "
            "Ranked 3rd of 120 in the 2024 OSINT CTF. Hash: 5f4dcc3b5aa765d61d8327deb882cf99."
        )
        self.assertEqual(codes(text), [])


class VerhoeffGeneratorTests(SimpleTestCase):
    def test_generated_digits_validate_for_every_length(self):
        import random

        rng = random.Random(20114)
        for length in range(1, 20):
            for _ in range(25):
                prefix = "".join(rng.choice("0123456789") for _ in range(length))
                self.assertTrue(verhoeff_valid(prefix + verhoeff_check_digit(prefix)), prefix)
