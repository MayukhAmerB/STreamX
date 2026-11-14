"""Weekly-report target keys (apps.core.textnorm.target_key / near_duplicates).

Review finding "reports / target normaliser": the old key dropped the URL path
and the domain ending, so distinct OSINT targets ("acme.com" / "acme.org",
"facebook.com/john" / "facebook.com/jane") collided as an exact duplicate,
which is a hard 409 the student cannot override. These vectors pin the
redesign:

* true duplicates (case, spacing, punctuation, Unicode, legal forms, URL
  decoration) share one key;
* legitimately distinct targets (domains, TLDs, identifying URL paths,
  handles, IPs, e-mails) never share a key;
* probably-the-same targets are near-duplicates: a warning the student can
  confirm past, never a 409 duplicate.
"""

from __future__ import annotations

import itertools

from apps.core import textnorm
from apps.core.textnorm import near_duplicates, pair_score, target_key, target_kind
from django.test import SimpleTestCase

from tests.test_reports_self_service import SelfServiceTestCase

# Every group is one target written many ways: all members share one key, and
# no two groups share a key.
EQUIVALENCE_CLASSES: dict[str, list[str]] = {
    # --- organisation names -------------------------------------------------
    "acme": [
        "Acme",
        "acme",
        "ACME",
        "  Acme  ",
        "Acme Pvt Ltd",
        "Acme Pvt. Ltd.",
        "ACME Private Limited",
        "Acme (OPC) Private Limited",
        "Acme Ltd",
        "Acme Limited",
        "Acme, Inc.",
        "Acme Inc",
        "Acme Incorporated",
        "Acme LLC",
        "Acme L.L.C.",
        "Acme LLP",
        "Acme Corp.",
        "Acme Corporation",
        "Acme Co.",
        "Acme & Co.",
        "Acme and Company",
        "Acme GmbH",
        "Acme AG",
        "Acme S.A.",
        "Acme B.V.",
        "Acme PLC",
        "Acme Pte. Ltd.",
        "Acme Sdn. Bhd.",
        "Acme Pty Ltd",
        "Acme Group",
        "Acme Holdings Ltd",
        "Acme International",
        "The Acme Company",
        "M/s Acme Pvt Ltd",
        "M/s. Acme",
        "ＡＣＭＥ",  # full-width (NFKC)
        "Acme​",  # zero-width space
        "‮Acme",  # bidi override
        "acme\tpvt\nltd",
        '"Acme"',
        "«Acme»",
        "Acme.",
        "acme!",
    ],
    "tata consultancy services": [
        "Tata Consultancy Services",
        "TATA CONSULTANCY SERVICES LIMITED",
        "Tata  Consultancy   Services Ltd.",
        "tata-consultancy-services",
        "Tata_Consultancy_Services",
    ],
    "cafe coffee day": ["Café Coffee Day", "CAFE COFFEE DAY", "Café Coffee Day", "Café Coffee Day Pvt Ltd"],
    "jp morgan": ["J.P. Morgan", "JP Morgan", "J. P. Morgan", "jp morgan", "J.P. Morgan Inc."],
    "johnson and johnson": ["Johnson & Johnson", "Johnson and Johnson", "JOHNSON & JOHNSON PVT LTD", "Johnson+Johnson"],
    "mcdonalds": ["McDonald's", "McDonald’s", "MCDONALDS", "McDonalds Corporation"],
    "the company": ["The Company", "the company", "THE COMPANY"],
    "company watch": ["Company Watch", "company watch ltd"],
    "limited edition labs": ["Limited Edition Labs", "Limited Edition Labs Pvt Ltd"],
    "123 industries": ["123 Industries Pvt Ltd", "123 INDUSTRIES"],
    "elon musk": ["Elon Musk", "elon  musk", "ELON MUSK"],
    "imran khan": ["Imran Khan", "imran khan"],
    "عمران خان": ["عمران خان", "عِمران خان"],  # Arabic harakat are diacritics
    "ac dc": ["AC/DC", "ac-dc", "AC DC"],
    # --- domains: the whole host is the key, TLD included ---------------------
    "acme.com": [
        "acme.com",
        "ACME.COM",
        "www.acme.com",
        "acme.com.",
        "https://www.acme.com/",
        "http://acme.com",
        "HTTPS://ACME.COM:443/en/contact?utm_source=x#top",
        "https://acme.com/about-us",
        "https://www.acme.com/index.html",
        "acme.com/careers/",
        "<https://acme.com>",
        "hxxps://acme.com/",
        "https://user:pass@acme.com/",
    ],
    "acme.org": ["acme.org", "https://www.acme.org/about"],
    "acme.io": ["acme.io", "https://acme.io/"],
    "acme.co.in": ["acme.co.in", "http://acme.co.in/about-us", "www.acme.co.in"],
    "acme.in": ["acme.in", "https://acme.in/"],
    "shop.acme.com": ["shop.acme.com", "https://shop.acme.com/products"],
    "acme-labs.com": ["acme-labs.com", "https://www.Acme-Labs.com/"],
    "münchen.de": ["münchen.de", "xn--mnchen-3ya.de", "https://xn--mnchen-3ya.de/"],
    "john.tumblr.com": ["john.tumblr.com", "https://john.tumblr.com/post/1"],
    # --- ordinary sites: a path that names someone else stays ------------------
    "example.edu/~alice": ["example.edu/~alice", "https://www.example.edu/~alice/"],
    "example.edu/~bob": ["example.edu/~bob"],
    "example.org/alice": ["example.org/alice", "https://example.org/en/alice"],
    # --- profile platforms: the identifying path is the key --------------------
    "facebook.com": ["facebook.com", "https://www.facebook.com/", "fb.com"],
    "facebook.com/john": [
        "facebook.com/john",
        "https://www.facebook.com/John/",
        "https://m.facebook.com/john?ref=bookmarks",
        "fb.com/john",
        "https://web.facebook.com/john/about",
        "https://www.facebook.com/john/posts/12345",
        "facebook.com/john#photos",
    ],
    "facebook.com/jane": ["facebook.com/jane", "https://facebook.com/Jane"],
    "facebook.com/profile.php?id=123": [
        "facebook.com/profile.php?id=123",
        "https://m.facebook.com/profile.php?id=123#about",
        "https://www.facebook.com/profile.php?sk=about&id=123",
    ],
    "facebook.com/profile.php?id=456": ["https://www.facebook.com/profile.php?id=456"],
    "facebook.com/groups/osint-india": ["https://www.facebook.com/groups/osint-india/members"],
    "x.com/elonmusk": [
        "x.com/elonmusk",
        "twitter.com/elonmusk",
        "https://twitter.com/ElonMusk",
        "https://mobile.twitter.com/elonmusk?lang=en",
        "https://x.com/elonmusk/status/123456?s=20",
    ],
    "x.com/jack": ["https://x.com/jack"],
    "linkedin.com/in/john-doe": [
        "linkedin.com/in/john-doe",
        "https://www.linkedin.com/in/john-doe/",
        "https://in.linkedin.com/in/John-Doe/details/experience/",
    ],
    "linkedin.com/company/acme": ["https://www.linkedin.com/company/acme/about/"],
    "instagram.com/acme": ["instagram.com/acme", "https://www.instagram.com/acme/?igshid=abc", "instagr.am/acme"],
    "instagram.com/p/cxyz": ["https://www.instagram.com/p/Cxyz/"],
    "github.com/torvalds": ["github.com/torvalds", "https://github.com/Torvalds"],
    "github.com/torvalds/linux": ["github.com/torvalds/linux", "https://github.com/torvalds/linux/tree/master/kernel"],
    "github.com/torvalds/subsurface": ["https://github.com/torvalds/subsurface"],
    "reddit.com/r/osint": ["https://www.reddit.com/r/OSINT/", "reddit.com/r/osint/top"],
    "reddit.com/u/osint": ["https://old.reddit.com/u/osint"],
    "t.me/durov": ["t.me/durov", "https://telegram.me/durov"],
    "youtube.com/watch?v=dQw4w9WgXcQ": [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ?si=tracking",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    ],
    "youtube.com/watch?v=DQW4W9WGXCQ": ["https://www.youtube.com/watch?v=DQW4W9WGXCQ"],  # ids are case-sensitive
    "youtube.com/@mrbeast": ["youtube.com/@MrBeast", "https://www.youtube.com/@mrbeast/videos"],
    "youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA": ["https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/about"],
    "play.google.com/store/apps/details?id=com.whatsapp": [
        "https://play.google.com/store/apps/details?id=com.whatsapp&hl=en_IN"
    ],
    # --- handles, e-mails, IPs -----------------------------------------------
    "@acme_hq": ["@acme_hq", "@Acme_HQ", "@ACME_HQ."],
    "@acmehq": ["@acmehq"],
    "@john.doe": ["@john.doe", "@John.Doe"],
    "john@acme.com": ["john@acme.com", "John@ACME.com", "mailto:john@acme.com"],
    "jane@acme.com": ["jane@acme.com"],
    "john@acme.org": ["john@acme.org"],
    "192.168.1.1": ["192.168.1.1", "http://192.168.1.1:8080/admin", "https://192.168.1.1/"],
    "192.168.1.2": ["192.168.1.2"],
    "10.0.0.0/8": ["10.0.0.0/8", "10.1.2.3/8"],
    "2001:db8::1": ["2001:db8::1", "2001:DB8:0:0:0:0:0:1", "[2001:db8::1]", "http://[2001:db8::1]:8080/"],
}

NOT_A_TARGET = ["", "   ", "!!!", "---", "​", "@", "...", "“”"]

# Near-duplicates: different keys, probably one target -> a warning
# (similar_target) the student can confirm past.
NEAR_DUPLICATES = [
    ("Acme Pvt Ltd", "acme.com"),
    ("Acme Pvt Ltd", "acme.co.in"),
    ("acme.com", "acme.org"),
    ("acme.com", "acme.co.in"),
    ("acme.com", "shop.acme.com"),
    ("acme.com", "acme.com/alice"),
    ("Acme", "@acme"),
    ("Acme", "instagram.com/acme"),
    ("Acme Ltd", "linkedin.com/company/acme"),
    ("@acme_hq", "Acme HQ"),
    ("@acme_hq", "@acmehq"),
    ("x.com/elonmusk", "@elonmusk"),
    ("facebook.com/john.smith", "instagram.com/john.smith"),
    ("youtube.com/@MrBeast", "MrBeast"),
    ("john.tumblr.com", "@john"),
    ("Globex Systems", "Globex Sytsems"),  # one typo
    ("Globex Systems", "Glo bex Systems"),  # spacing
    ("facebook.com/john-smith", "facebook.com/john-smyth"),  # typo on one platform
    ("acmecorp.com", "acmecrop.com"),
    ("AC/DC", "ACDC"),
    ("Elon Musk", "Musk Elon"),
    ("github.com/torvalds/linux", "github.com/torvalds/subsurface"),  # one owner
    ("Infosys", "Infosys BPM"),
    ("Node.js", "Node JS"),
]

# Distinct targets that must not even warn.
UNRELATED = [
    ("facebook.com/john", "facebook.com/jane"),
    ("facebook.com/profile.php?id=123", "facebook.com/profile.php?id=456"),
    ("x.com/elonmusk", "x.com/jack"),
    ("linkedin.com/in/john-doe", "linkedin.com/in/jane-roe"),
    ("192.168.1.1", "192.168.1.2"),
    ("10.0.0.1", "10.0.0.10"),
    ("2001:db8::1", "2001:db8::2"),
    ("@john", "@jane"),
    ("john@acme.com", "jane@acme.com"),
    ("info@acme.com", "info@globex.com"),
    ("john.tumblr.com", "jane.tumblr.com"),
    ("example.edu/~alice", "example.edu/~bob"),
    ("Tata Motors", "Tata Steel"),
    ("Acme", "Globex"),
    ("acme.com", "globex.com"),
    ("github.com/torvalds", "github.com/gvanrossum"),
    ("youtube.com/watch?v=dQw4w9WgXcQ", "youtube.com/watch?v=9bZkp7q19f0"),
]

KINDS = {
    "Acme Pvt Ltd": textnorm.KIND_NAME,
    "acme.com": textnorm.KIND_DOMAIN,
    "https://acme.com/about": textnorm.KIND_DOMAIN,
    "example.org/alice": textnorm.KIND_PROFILE,
    "facebook.com/john": textnorm.KIND_PROFILE,
    "youtube.com/@MrBeast": textnorm.KIND_PROFILE,
    "@acme_hq": textnorm.KIND_HANDLE,
    "john@acme.com": textnorm.KIND_EMAIL,
    "192.168.1.1": textnorm.KIND_IP,
    "2001:db8::1": textnorm.KIND_IP,
    "10.0.0.0/8": textnorm.KIND_IP,
}


class TargetKeyEquivalenceTests(SimpleTestCase):
    def test_every_variant_has_its_groups_key(self):
        for expected, variants in EQUIVALENCE_CLASSES.items():
            for value in variants:
                with self.subTest(value=value):
                    self.assertEqual(target_key(value), expected)

    def test_no_two_groups_share_a_key(self):
        # All group keys are pairwise different: none of these targets can be
        # refused as a duplicate of another.
        keys = list(EQUIVALENCE_CLASSES)
        self.assertEqual(len(keys), len(set(keys)))
        for left, right in itertools.combinations(EQUIVALENCE_CLASSES.items(), 2):
            for a, b in itertools.product(left[1], right[1]):
                if target_key(a) == target_key(b):
                    self.fail(f"{a!r} and {b!r} collide as {target_key(a)!r}")

    def test_review_finding_vectors_stay_distinct(self):
        pairs = [
            ("facebook.com/john", "facebook.com/jane"),
            ("acme.com", "acme.org"),
            ("acme.com", "acme.co.in"),
            ("acme.com", "Acme Pvt Ltd"),
            ("@acme_hq", "Acme HQ"),
            ("192.168.1.1", "192.168.1.2"),
            ("github.com/torvalds/linux", "github.com/torvalds"),
            ("example.edu/~alice", "example.edu/~bob"),
        ]
        for a, b in pairs:
            with self.subTest(a=a, b=b):
                self.assertNotEqual(target_key(a), target_key(b))

    def test_keys_are_stable_under_renormalisation(self):
        for variants in EQUIVALENCE_CLASSES.values():
            for value in variants:
                with self.subTest(value=value):
                    key = target_key(value)
                    self.assertEqual(target_key(key), key)

    def test_not_a_target(self):
        for value in NOT_A_TARGET:
            with self.subTest(value=value):
                self.assertEqual(target_key(value), "")
        self.assertEqual(target_key(None), "")

    def test_key_kinds(self):
        for value, kind in KINDS.items():
            with self.subTest(value=value):
                self.assertEqual(target_kind(target_key(value)), kind)

    def test_long_keys_fit_the_column_and_stay_distinct(self):
        base = "https://github.com/" + "a" * 300
        first, second = target_key(base + "/one"), target_key(base + "/two")
        self.assertLessEqual(len(first), textnorm.TARGET_KEY_MAX_LENGTH)
        self.assertLessEqual(len(second), textnorm.TARGET_KEY_MAX_LENGTH)
        self.assertNotEqual(first, second)
        self.assertEqual(first, target_key(base + "/one/issues"))
        long_name = "Acme " + "Very " * 60 + "Long Name"
        self.assertLessEqual(len(target_key(long_name)), textnorm.TARGET_KEY_MAX_LENGTH)
        self.assertNotEqual(target_key(long_name), target_key(long_name + " Two"))

    def test_text_that_only_looks_like_a_url_is_a_name(self):
        self.assertEqual(target_key("Acme . com"), "acme com")
        self.assertEqual(target_key("mailto:"), "mailto")
        self.assertEqual(target_key("javascript:alert(1)"), "javascript alert 1")
        self.assertEqual(target_kind(target_key("file:///etc/passwd")), textnorm.KIND_NAME)


class NearDuplicateTests(SimpleTestCase):
    def test_probable_duplicates_warn(self):
        for a, b in NEAR_DUPLICATES:
            with self.subTest(a=a, b=b):
                key, other = target_key(a), target_key(b)
                self.assertNotEqual(key, other, "a near-duplicate must not be an exact (409) duplicate")
                self.assertGreaterEqual(pair_score(key, other), textnorm.NEAR_DUPLICATE_THRESHOLD)
                self.assertEqual(pair_score(key, other), pair_score(other, key))
                self.assertEqual([item for item, _score in near_duplicates(key, [("row", other)])], ["row"])

    def test_distinct_targets_do_not_warn(self):
        for a, b in UNRELATED:
            with self.subTest(a=a, b=b):
                key, other = target_key(a), target_key(b)
                self.assertNotEqual(key, other)
                self.assertLess(pair_score(key, other), textnorm.NEAR_DUPLICATE_THRESHOLD)
                self.assertEqual(near_duplicates(key, [("row", other)]), [])

    def test_equal_keys_are_not_near_duplicates(self):
        self.assertEqual(pair_score("acme", "acme"), 0.0)
        self.assertEqual(near_duplicates("acme", [(1, "acme"), (2, "")]), [])

    def test_scores_rank_best_first_and_stay_below_an_exact_match(self):
        key = target_key("Globex Systems")
        rows = [(1, target_key("Globex")), (2, target_key("Glo bex Systems")), (3, target_key("globex.com"))]
        found = near_duplicates(key, rows)
        self.assertEqual([item for item, _score in found][0], 2)
        self.assertTrue(all(score < 1.0 for _item, score in found))

    def test_only_plain_names_go_to_pg_trgm(self):
        # weekly.similar_targets asks PostgreSQL similarity() about raw keys;
        # for URL/e-mail/IP keys that score counts the shared host, so those
        # stay with the Python check.
        self.assertTrue(textnorm.trigram_comparable(target_key("Acme Pvt Ltd")))
        for value in ("acme.com", "facebook.com/john", "@acme", "john@acme.com", "10.0.0.1"):
            with self.subTest(value=value):
                self.assertFalse(textnorm.trigram_comparable(target_key(value)))


class CtfRulesUnaffectedTests(SimpleTestCase):
    def test_named_rules_keep_their_behaviour(self):
        # The CTF answer digests depend on these exact outputs.
        cases = [
            (None, "  Héllo   World ", "héllo world"),
            (["strip_url_scheme", "strip_www", "strip_trailing_slash"], "https://www.Example.com/", "Example.com"),
            (["strip_leading_at", "casefold"], "@Handle", "handle"),
            (["strip_quotes"], "«quoted»", "quoted"),
            (["digits_only"], "۱۲۳-45", "12345"),
            (["nfkc", "casefold", "strip_punctuation", "remove_whitespace"], "Ａcme, Inc.", "acmeinc"),
            (["strip_diacritics"], "Café", "Cafe"),
        ]
        for rules, value, expected in cases:
            with self.subTest(rules=rules, value=value):
                self.assertEqual(textnorm.normalize(value, rules), expected)


class TargetKeyApiTests(SelfServiceTestCase):
    """The submit flow: equal key -> 409 duplicate_target; a near-duplicate ->
    409 similar_target that ``confirm_different`` overrides; distinct targets
    are created straight away."""

    def assertCreated(self, name, **extra):
        response = self.create_target(name, **extra)
        self.assertEqual(response.status_code, 201, (name, response.data))
        return response

    def assertConflict(self, name, code):
        response = self.create_target(name)
        self.assertEqual(response.status_code, 409, (name, response.data))
        self.assertEqual(response.data["code"], code, name)
        return response

    def test_distinct_profiles_and_addresses_are_separate_targets(self):
        for name in (
            "facebook.com/john",
            "facebook.com/jane",
            "https://www.facebook.com/profile.php?id=123",
            "https://www.facebook.com/profile.php?id=456",
            "192.168.1.1",
            "192.168.1.2",
            "@alice",
            "@bob",
        ):
            with self.subTest(name=name):
                self.assertCreated(name)
        self.assertConflict("https://m.facebook.com/John/?ref=bookmarks", "duplicate_target")
        self.assertConflict("http://192.168.1.1:8080/", "duplicate_target")
        # The same name as a handle is probably the same person: a warning.
        self.assertConflict("@john", "similar_target")
        self.assertCreated("@john", confirm_different=True)

    def test_other_domains_with_the_same_name_warn_instead_of_refusing(self):
        self.assertCreated("Acme Pvt Ltd")
        self.assertConflict("acme", "duplicate_target")
        for name in ("acme.com", "acme.org"):
            with self.subTest(name=name):
                warning = self.assertConflict(name, "similar_target")
                self.assertTrue(warning.data["errors"]["needs_confirmation"])
                self.assertIn("Acme Pvt Ltd", [item["target_name"] for item in warning.data["errors"]["suggestions"]])
                self.assertCreated(name, confirm_different=True)
        # Once reported, the same domain written another way is the duplicate.
        self.assertConflict("https://www.acme.com/about-us", "duplicate_target")
