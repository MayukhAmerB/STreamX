"""CTF answer normalisation, peppered HMAC verification and the pepper check."""

from unittest import mock

from apps.ctf import answers
from apps.ctf.checks import check_answer_pepper
from django.test import SimpleTestCase, override_settings

PEPPER = "test-pepper-0123456789abcdefghijklmnopqrstuvwxyz"


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class NormalisationTests(SimpleTestCase):
    def assertRule(self, rule, raw, expected):
        self.assertEqual(answers.normalize(raw, [rule]), expected, rule)

    def test_each_rule(self):
        self.assertRule("nfkc", "ｆｕｌｌ width ﬁ", "full width fi")
        self.assertRule("trim", "  padded \n", "padded")
        self.assertRule("collapse_whitespace", "a \t\n  b", "a b")
        self.assertRule("remove_whitespace", " 12 34\t56 ", "123456")
        self.assertRule("casefold", "Straße MAIN", "strasse main")
        self.assertRule("strip_punctuation", "St. John's, (UK)!", "St Johns UK")
        self.assertRule("strip_diacritics", "Café Zürich Šibenik", "Cafe Zurich Sibenik")
        self.assertRule("strip_url_scheme", "HTTPS://example.org/x", "example.org/x")
        self.assertRule("strip_www", "www.example.org", "example.org")
        self.assertRule("strip_trailing_slash", "example.org/path//", "example.org/path")
        self.assertRule("strip_leading_at", "@@handle", "handle")
        self.assertRule("strip_quotes", "“quoted”", "quoted")
        self.assertRule("digits_only", "Date: 1999-12-31", "19991231")
        self.assertRule("digits_only", "۱۹۹۹", "1999")  # Urdu digits count

    def test_rules_apply_in_order_and_default(self):
        self.assertEqual(
            answers.normalize(" https://www.Example.org/ ", ["trim", "strip_url_scheme", "strip_www", "casefold"]),
            "example.org/",
        )
        self.assertEqual(answers.normalize("  Mixed   CASE "), "mixed case")
        self.assertEqual(answers.validate_rules([]), list(answers.DEFAULT_RULES))

    def test_unknown_and_repeated_rules_are_rejected(self):
        with self.assertRaises(ValueError):
            answers.validate_rules(["casefold", "eval"])
        with self.assertRaises(ValueError):
            answers.validate_rules(["trim", "trim"])


@override_settings(CTF_ANSWER_PEPPER=PEPPER)
class VerificationTests(SimpleTestCase):
    def test_digest_binds_exam_and_question(self):
        base = answers.answer_digest("exam-a", "q1", "answer")
        self.assertRegex(base, r"^[0-9a-f]{64}$")
        self.assertNotEqual(base, answers.answer_digest("exam-b", "q1", "answer"))
        self.assertNotEqual(base, answers.answer_digest("exam-a", "q2", "answer"))
        self.assertNotEqual(base, answers.answer_digest("exam-a", "q1", "answer2"))
        # The separator cannot be forged by shifting text between parts.
        self.assertNotEqual(answers.answer_digest("exam", "a-q", "x"), answers.answer_digest("exam-a", "q", "x"))

    def test_pepper_changes_every_digest(self):
        first = answers.answer_digest("exam", "q", "answer")
        with override_settings(CTF_ANSWER_PEPPER=PEPPER + "-rotated"):
            self.assertNotEqual(first, answers.answer_digest("exam", "q", "answer"))
            self.assertNotEqual(answers.answer_key_id(), "")

    def test_verify_accepts_any_variant_after_normalisation(self):
        rules = ["nfkc", "trim", "collapse_whitespace", "casefold", "strip_punctuation"]
        hashes = answers.hash_answers("exam", "q", ["Port Zz", "Zz Harbour"], rules)
        self.assertEqual(len(hashes), 2)
        self.assertEqual(answers.verify("exam", "q", "  zz   HARBOUR. ", rules, hashes), (True, "zz harbour"))
        self.assertEqual(answers.verify("exam", "q", "port zz!", rules, hashes)[0], True)
        self.assertEqual(answers.verify("exam", "q", "Zz Harbor", rules, hashes)[0], False)
        # Same answer for a different question does not match.
        self.assertFalse(answers.verify("exam", "other", "Port Zz", rules, hashes)[0])
        self.assertEqual(answers.verify("exam", "q", "   ", rules, hashes), (False, ""))

    def test_hash_answers_deduplicates_and_rejects_empty(self):
        self.assertEqual(len(answers.hash_answers("e", "q", ["ABC", "abc", " abc "], None)), 1)
        with self.assertRaises(ValueError):
            answers.hash_answers("e", "q", ["!!!"], ["strip_punctuation"])

    def test_compare_digest_runs_for_every_stored_hash(self):
        hashes = answers.hash_answers("exam", "q", ["one", "two", "three"], None)
        with mock.patch("apps.ctf.answers.hmac.compare_digest", wraps=answers.hmac.compare_digest) as compare:
            correct, _normalized = answers.verify("exam", "q", "one", None, hashes)
        self.assertTrue(correct)
        self.assertEqual(compare.call_count, 3)  # no short-circuit on the first match


class PepperConfigurationTests(SimpleTestCase):
    @override_settings(CTF_ANSWER_PEPPER="", APP_ENV="development", SECRET_KEY="dev-secret-for-tests")
    def test_development_derives_a_stable_stand_in(self):
        first = answers.answer_digest("e", "q", "a")
        self.assertEqual(first, answers.answer_digest("e", "q", "a"))
        self.assertEqual(check_answer_pepper(), [])

    @override_settings(CTF_ANSWER_PEPPER="", APP_ENV="production")
    def test_production_without_pepper_is_not_configured(self):
        with self.assertRaises(answers.CtfNotConfigured) as caught:
            answers.answer_digest("e", "q", "a")
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(caught.exception.code, "ctf_not_configured")
        self.assertEqual([item.id for item in check_answer_pepper()], ["ctf.I001"])

    @override_settings(CTF_ANSWER_PEPPER="too-short", APP_ENV="production")
    def test_short_pepper_fails_the_check(self):
        self.assertEqual([item.id for item in check_answer_pepper()], ["ctf.E001"])

    @override_settings(CTF_ANSWER_PEPPER="x" * 40, SECRET_KEY="x" * 40, APP_ENV="production")
    def test_pepper_equal_to_secret_key_fails_the_check(self):
        self.assertIn("ctf.E001", [item.id for item in check_answer_pepper()])

    @override_settings(CTF_ANSWER_PEPPER=PEPPER, APP_ENV="production")
    def test_strong_pepper_passes(self):
        self.assertEqual(check_answer_pepper(), [])
