"""Sanitisation for student profiles: text, links, the bio Markdown subset,
the allowlist HTML sanitiser and the document normaliser. No raw HTML ever.

Pure Python: no database.
"""

from __future__ import annotations

import uuid

from django.test import SimpleTestCase

from apps.core.errors import ValidationFailed
from apps.profiles import document, richtext
from apps.profiles.sanitize import LINK_REL, clean_text, clean_url, contains_markup, sanitize_html

# A broad list of XSS payloads (OWASP cheat sheet style, mXSS and encoding tricks).
XSS_VECTORS = [
    "<script>alert(1)</script>",
    "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "<svg><script>alert(1)</script></svg>",
    "<iframe src=javascript:alert(1)>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<a href=\"jav&#x09;ascript:alert(1)\">x</a>",
    "<body onload=alert(1)>",
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
    "<details open ontoggle=alert(1)>",
    "<input autofocus onfocus=alert(1)>",
    "<object data=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">",
    "<embed src=javascript:alert(1)>",
    "<form action=javascript:alert(1)><button>x</button></form>",
    "<meta http-equiv=\"refresh\" content=\"0;url=javascript:alert(1)\">",
    "<base href=\"javascript:/\">",
    "<style>@import 'javascript:alert(1)';</style>",
    "<template><img src=x onerror=alert(1)></template>",
    "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">",
    "<!--<img src=x onerror=alert(1)>-->",
    "<![CDATA[<script>alert(1)</script>]]>",
    "<<script>script>alert(1)<</script>/script>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "&#60;script&#62;alert(1)&#60;/script&#62;",
    "<a href=\"&#106;avascript:alert(1)\">x</a>",
    "<div style=\"background:url(javascript:alert(1))\">",
    "<isindex type=image src=1 onerror=alert(1)>",
    "<video><source onerror=\"alert(1)\">",
    "<x onclick=alert(1)>click",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "\" onmouseover=\"alert(1)",
    "' autofocus onfocus='alert(1)",
]

BAD_URLS = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "jav&#x09;ascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/png;base64,AAAA",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "http://example.com",
    "//example.com/x",
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://example.com@evil.example",
    "https://127.0.0.1/",
    "https://10.0.0.5/admin",
    "https://192.168.1.1",
    "https://[::1]/",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/",
    "https://intranet.local/",
    "https://example.com:8443/",
    "https://exa mple.com",
    "https://example.com/\"onmouseover=\"alert(1)",
    "https://example.com/<script>",
    "https://example.com/‮gnp.exe",
    "https://example​.com",
    "https://nodot/",
    "",
    "https://",
]


class CleanTextTests(SimpleTestCase):
    def test_every_xss_vector_is_refused(self):
        for vector in XSS_VECTORS:
            with self.subTest(vector=vector):
                with self.assertRaises(ValidationFailed):
                    clean_text(vector, field="bio", max_length=4000, multiline=True)

    def test_plain_text_with_comparison_signs_is_fine(self):
        self.assertEqual(clean_text("a < b and 3 > 2 <3", field="t", max_length=100), "a < b and 3 > 2 <3")
        self.assertFalse(contains_markup("x < y"))

    def test_controls_bidi_and_invisible_characters_are_removed(self):
        value = "he‮llo​ wor\u0000ld⁦ ­!"
        self.assertEqual(clean_text(value, field="t", max_length=100), "hello world !")

    def test_whitespace_and_length(self):
        self.assertEqual(clean_text("  a \n  b  ", field="t", max_length=10), "a b")
        self.assertEqual(clean_text("a\n\n\n\nb", field="t", max_length=10, multiline=True), "a\n\nb")
        with self.assertRaises(ValidationFailed):
            clean_text("x" * 11, field="t", max_length=10)
        with self.assertRaises(ValidationFailed):
            clean_text("", field="t", max_length=10, required=True)
        with self.assertRaises(ValidationFailed):
            clean_text(42, field="t", max_length=10)


class CleanUrlTests(SimpleTestCase):
    def test_bad_urls(self):
        for url in BAD_URLS:
            with self.subTest(url=url):
                with self.assertRaises(ValidationFailed):
                    clean_url(url, field="url")

    def test_good_urls_are_normalised(self):
        self.assertEqual(clean_url("https://Example.COM/Path?q=1#x", field="url"), "https://example.com/Path?q=1#x")
        self.assertEqual(clean_url("https://github.com:443/user", field="url"), "https://github.com/user")
        self.assertEqual(clean_url("https://bücher.example/", field="url"), "https://xn--bcher-kva.example/")

    def test_non_string(self):
        with self.assertRaises(ValidationFailed):
            clean_url(None, field="url")


class SanitizeHtmlTests(SimpleTestCase):
    def test_vectors_leave_no_active_content(self):
        import re

        from apps.profiles.sanitize import ALLOWED_TAGS

        for vector in XSS_VECTORS:
            with self.subTest(vector=vector):
                out = sanitize_html(vector)
                # Only allowlisted tags survive; text such as "javascript:" is escaped data, not markup.
                for tag in re.findall(r"<\s*/?\s*([a-zA-Z][\w-]*)", out):
                    self.assertIn(tag.lower(), ALLOWED_TAGS, out)
                for attrs in re.findall(r"<[a-zA-Z][^>]*>", out):
                    self.assertNotRegex(attrs.lower(), r"\son[a-z]+\s*=|style\s*=|src\s*=", out)
                    for href in re.findall(r'href="([^"]*)"', attrs):
                        self.assertTrue(href.startswith("https://"), out)

    def test_allowlist_keeps_safe_markup_and_forces_rel(self):
        html = '<p>Hi <strong>there</strong> <a href="https://example.com/x" onclick="x()" style="x">link</a></p><ul><li>a</li></ul>'
        out = sanitize_html(html)
        self.assertIn("<strong>there</strong>", out)
        self.assertIn(f'href="https://example.com/x" rel="{LINK_REL}" target="_blank"', out)
        self.assertNotIn("onclick", out)
        self.assertNotIn("style", out)
        self.assertIn("<ul><li>a</li></ul>", out)

    def test_bad_links_lose_their_anchor(self):
        self.assertEqual(sanitize_html('<a href="javascript:alert(1)">x</a>'), "x")
        self.assertEqual(sanitize_html('<a href="http://example.com">x</a>'), "x")

    def test_unclosed_tags_are_closed_and_text_escaped(self):
        self.assertEqual(sanitize_html("<p><strong>a"), "<p><strong>a</strong></p>")
        self.assertEqual(sanitize_html("1 < 2 & 3"), "1 &lt; 2 &amp; 3")


class RichTextTests(SimpleTestCase):
    def test_parse_subset(self):
        doc = richtext.parse("### Hello\nSome **bold** and *it* and `code`\n\n- one\n- [two](https://example.com)\n\n> quoted")
        types = [block["type"] for block in doc["content"]]
        self.assertEqual(types, ["heading", "paragraph", "list", "quote"])
        paragraph = doc["content"][1]["content"]
        self.assertIn({"type": "text", "text": "bold", "marks": ["bold"]}, paragraph)
        self.assertIn({"type": "text", "text": "code", "marks": ["code"]}, paragraph)
        link = doc["content"][2]["items"][1][0]
        self.assertEqual(link, {"type": "link", "text": "two", "href": "https://example.com"})
        self.assertTrue(richtext.is_valid(doc))

    def test_links_must_be_https(self):
        for href in ["javascript:alert(1)", "http://example.com", "data:text/html,x", "https://127.0.0.1"]:
            with self.subTest(href=href):
                with self.assertRaises(ValidationFailed):
                    richtext.parse(f"[x]({href})")

    def test_limits(self):
        with self.assertRaises(ValidationFailed):
            richtext.parse("x" * (richtext.MAX_SOURCE_LENGTH + 1))
        with self.assertRaises(ValidationFailed):
            richtext.parse(" ".join(f"[l{i}](https://e{i}.example.com)" for i in range(richtext.MAX_LINKS + 1)))

    def test_is_valid_rejects_tampered_documents(self):
        bad = [
            None,
            {"type": "doc"},
            {"type": "doc", "content": [{"type": "html", "content": "<script>"}]},
            {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "link", "text": "x", "href": "javascript:alert(1)"}]}]},
            {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x", "marks": ["script"]}]}]},
            {"type": "doc", "content": [{"type": "list", "items": "nope"}]},
        ]
        for doc in bad:
            with self.subTest(doc=doc):
                self.assertFalse(richtext.is_valid(doc))
                self.assertEqual(richtext.render_html(doc), "")

    def test_render_html_escapes_text(self):
        doc = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "<img src=x onerror=alert(1)>"}]}]}
        self.assertEqual(richtext.render_html(doc), "<p>&lt;img src=x onerror=alert(1)&gt;</p>")

    def test_plain_text_includes_link_targets(self):
        doc = richtext.parse("see [me](https://example.com/ravi)")
        self.assertIn("https://example.com/ravi", richtext.plain_text(doc))


class DocumentTests(SimpleTestCase):
    def setUp(self):
        self.avatar = str(uuid.uuid4())
        self.gallery = str(uuid.uuid4())
        self.owned = {self.avatar: "avatar", self.gallery: "gallery"}

    def normalize(self, raw, badges=None):
        return document.normalize_document(raw, handle="quiet_falcon", owned_images=self.owned, badge_keys=(lambda: badges))

    def test_rebuilds_from_known_keys_only(self):
        raw = {
            "v": 99,
            "evil": "<script>",
            "theme": {"accent": "red", "align": "left", "font": "comic"},
            "header": {"display_name": "Falcon", "tagline": "Curious about OSINT", "avatar_id": self.avatar, "onload": "x"},
            "blocks": [
                {"type": "bio", "source": "Hello **world**", "html": "<b>x</b>"},
                {"type": "skills", "items": [{"name": "Recon", "level": "expert"}]},
                {"type": "links", "items": [{"label": "GitHub", "url": "https://github.com/x"}]},
                {"type": "gallery", "items": [{"image_id": self.gallery, "alt": "Lab"}, {"image_id": self.gallery}]},
                {"type": "badges", "badge_keys": ["first_lecture", "made_up"]},
            ],
        }
        clean, fields = self.normalize(raw, badges={"first_lecture"})
        self.assertEqual(clean["v"], document.DOC_VERSION)
        self.assertNotIn("evil", clean)
        self.assertEqual(clean["theme"], {"accent": "gold", "align": "left", "banner": "lines", "tagline": "hand"})
        self.assertEqual(set(clean["header"]), {"display_name", "tagline", "avatar_id", "banner_id"})
        bio = clean["blocks"][0]
        self.assertNotIn("html", bio)
        self.assertEqual(bio["doc"]["content"][0]["type"], "paragraph")
        self.assertEqual(clean["blocks"][1]["items"], [{"name": "Recon", "level": "learning"}])
        self.assertEqual(clean["blocks"][2]["items"][0]["host"], "github.com")
        self.assertEqual(len(clean["blocks"][3]["items"]), 1, "duplicate gallery image dropped")
        self.assertEqual(clean["blocks"][4]["badge_keys"], ["first_lecture"])
        paths = dict(fields)
        self.assertEqual(paths["header.tagline"], "Curious about OSINT")
        self.assertIn("blocks[2].items[0].url", paths)

    def test_images_must_be_owned_and_of_the_right_kind(self):
        with self.assertRaises(ValidationFailed):
            self.normalize({"header": {"avatar_id": str(uuid.uuid4())}})
        with self.assertRaises(ValidationFailed):
            self.normalize({"header": {"avatar_id": self.gallery}})
        with self.assertRaises(ValidationFailed):
            self.normalize({"header": {"banner_id": "../../etc/passwd"}})

    def test_shape_and_limits(self):
        with self.assertRaises(ValidationFailed):
            self.normalize({"blocks": [{"type": "bio"}, {"type": "bio"}]})
        with self.assertRaises(ValidationFailed):
            self.normalize({"blocks": [{"type": "script"}]})
        with self.assertRaises(ValidationFailed):
            self.normalize({"blocks": [{"type": "links", "items": [{"url": "https://e.example"}] * 9}]})
        with self.assertRaises(ValidationFailed):
            self.normalize({"header": {"tagline": "one two three four five six seven eight nine"}})
        with self.assertRaises(ValidationFailed):
            self.normalize({"blocks": "nope"})
        with self.assertRaises(ValidationFailed):
            self.normalize({"blocks": [{"type": "links", "items": [{"url": "javascript:alert(1)"}]}]})
        with self.assertRaises(ValidationFailed):
            self.normalize({"blocks": [{"type": "writeups", "items": [{"title": "<img src=x onerror=alert(1)>"}]}]})

    def test_default_document_round_trips(self):
        clean, _fields = self.normalize(document.default_document("quiet_falcon"))
        self.assertEqual([block["type"] for block in clean["blocks"]], ["bio", "badges", "skills", "writeups", "links"])

    def test_referenced_image_ids(self):
        clean, _ = self.normalize({"header": {"avatar_id": self.avatar}, "blocks": [{"type": "gallery", "items": [{"image_id": self.gallery}]}]})
        self.assertEqual(document.referenced_image_ids(clean), {self.avatar, self.gallery})
        self.assertEqual(document.referenced_image_ids(None), set())
