"""Al Syed Admin theme (hackpath BUILD_PLAN §2.3, WS-OFFICE).

The back office is restyled with templates + CSS only. These checks keep it
honest: the split-screen login is the template in use and still behaves like
Django's, every static file a page references exists (no 404 after the Inter
fonts were removed), the stylesheet's font faces resolve and parse, and no
hue sneaks into the palette (black, greys, white and golden white only).
"""

import colorsys
import re
from pathlib import Path

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.staticfiles import finders
from django.test import TestCase, override_settings
from django.urls import NoReverseMatch, reverse

STATIC_URL_RE = re.compile(r"""(?:href|src)="/static/([^"?#]+)""")
CSS_URL_RE = re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)""")
HEX_RE = re.compile(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")
RGB_RE = re.compile(r"rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)")


def _css(name):
    path = finders.find(f"admin/css/{name}")
    assert path, name
    return Path(path).read_text(encoding="utf-8")


def _hue_offenders(text):
    """Colours that are neither grey (channels within 6) nor golden white (hue 30-55 deg)."""
    offenders = []

    def check(r, g, b, raw):
        if max(r, g, b) - min(r, g, b) <= 6:
            return
        hue = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)[0] * 360
        if not 30 <= hue <= 55:
            offenders.append(raw)

    for match in HEX_RE.finditer(text):
        value = match.group(1)
        if len(value) == 3:
            value = "".join(c * 2 for c in value)
        check(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), match.group(0))
    for match in RGB_RE.finditer(text):
        check(*(int(x) for x in match.groups()), match.group(0))
    return offenders


@override_settings(STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class AdminThemeTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = get_user_model().objects.create_superuser(
            email="theme-admin@test.com", password="StrongPass@123", full_name="Theme Admin"
        )

    def assert_static_refs_resolve(self, response):
        html = response.content.decode()
        refs = set(STATIC_URL_RE.findall(html))
        missing = sorted(ref for ref in refs if not finders.find(ref))
        self.assertEqual(missing, [], f"missing static files on {response.request['PATH_INFO']}")
        return refs

    # --- login (T-AUTH) -------------------------------------------------------
    def test_login_uses_the_split_screen_template_and_keeps_djangos_form(self):
        response = self.client.get(reverse("admin:login") + "?next=/admin/ctf/")
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "admin/login.html")
        self.assertContains(response, 'class="hp-auth"')
        self.assertContains(response, 'id="login-form"')
        self.assertContains(response, 'name="username"')
        self.assertContains(response, 'name="password"')
        self.assertContains(response, 'name="next" value="/admin/ctf/"')
        self.assertContains(response, "csrfmiddlewaretoken")
        self.assertContains(response, 'class="hp-auth-submit"')
        refs = self.assert_static_refs_resolve(response)
        self.assertIn("admin/css/enterprise.css", refs)
        self.assertIn("admin/fonts/geist/geist-latin-wght-normal.woff2", refs)

    def test_login_still_signs_staff_in_and_follows_next(self):
        response = self.client.post(
            reverse("admin:login"),
            {"username": "theme-admin@test.com", "password": "StrongPass@123", "next": "/admin/"},
        )
        self.assertRedirects(response, "/admin/", fetch_redirect_response=False)

    def test_login_errors_are_shown(self):
        response = self.client.post(
            reverse("admin:login"), {"username": "theme-admin@test.com", "password": "wrong", "next": "/admin/"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'class="errornote"')

    # --- shell ------------------------------------------------------------------
    def test_pages_load_no_third_party_or_removed_fonts(self):
        pages = [self.client.get(reverse("admin:login"))]
        self.client.force_login(self.admin)
        pages.append(self.client.get(reverse("admin:index")))
        for response in pages:
            self.assertEqual(response.status_code, 200)
            html = response.content.decode()
            self.assertNotIn("fonts.googleapis", html)
            self.assertNotIn("inter-latin", html)
            self.assertIn('rel="preload"', html)
            self.assertIn('<meta name="theme-color" content="#000000">', html)

    def test_smoke_crawl_index_changelists_and_add_forms(self):
        """Every registered model: changelist + add form render, and their static files exist."""
        self.client.force_login(self.admin)
        index = self.client.get(reverse("admin:index"))
        self.assertEqual(index.status_code, 200)
        self.assert_static_refs_resolve(index)
        failures = []
        for model, model_admin in admin.site._registry.items():
            opts = model._meta
            for view in ("changelist", "add"):
                try:
                    url = reverse(f"admin:{opts.app_label}_{opts.model_name}_{view}")
                except NoReverseMatch:
                    continue
                if view == "add" and not model_admin.has_add_permission(_request_for(self.admin)):
                    continue
                # Singleton admins redirect the changelist to their one change form.
                response = self.client.get(url, follow=True)
                if response.status_code != 200:
                    failures.append(f"{url} -> {response.status_code}")
                    continue
                refs = set(STATIC_URL_RE.findall(response.content.decode()))
                missing = [ref for ref in refs if not finders.find(ref)]
                if missing:
                    failures.append(f"{url} missing {missing}")
        self.assertEqual(failures, [])

    # --- stylesheet ---------------------------------------------------------------
    def test_enterprise_css_font_faces_resolve(self):
        css = _css("enterprise.css")
        base = Path(finders.find("admin/css/enterprise.css")).parent
        urls = [u for u in CSS_URL_RE.findall(css) if not u.startswith("data:")]
        fonts = [u for u in urls if u.endswith(".woff2")]
        self.assertGreaterEqual(len(fonts), 4)
        for url in fonts:
            self.assertTrue((base / url).resolve().is_file(), url)

    def test_enterprise_css_comments_do_not_close_early(self):
        """A stray "*/" inside a comment (e.g. "fonts/*/OFL.txt") silently drops the next rule."""
        css = _css("enterprise.css")
        for comment in re.findall(r"/\*.*?\*/", css, flags=re.S):
            after = css[css.index(comment) + len(comment):].split("\n", 1)[0]
            self.assertNotIn("*/", after, comment[:80])
        # The Geist latin face must be a real rule, not swallowed by a comment.
        self.assertRegex(css, r'@font-face\s*\{\s*font-family:\s*"Geist";[^}]*geist-latin-wght-normal\.woff2')

    def test_admin_css_and_templates_use_no_hue(self):
        texts = {"enterprise.css": _css("enterprise.css")}
        templates = Path(__file__).resolve().parent.parent / "templates" / "admin"
        for path in templates.rglob("*.html"):
            texts[str(path.relative_to(templates))] = path.read_text(encoding="utf-8")
        offenders = {name: found for name, text in texts.items() if (found := _hue_offenders(text))}
        self.assertEqual(offenders, {})

    def test_verify_staticfiles_requires_the_geist_files(self):
        from apps.users.management.commands.verify_staticfiles import REQUIRED_ASSETS

        for asset in REQUIRED_ASSETS:
            if asset.startswith("admin/fonts/") or asset.startswith("admin/css/enterprise"):
                self.assertTrue(finders.find(asset), asset)
        self.assertFalse(any("inter-latin" in asset for asset in REQUIRED_ASSETS))


def _request_for(user):
    from django.test import RequestFactory

    request = RequestFactory().get("/admin/")
    request.user = user
    return request
