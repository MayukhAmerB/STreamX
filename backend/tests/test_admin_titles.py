"""Al Syed Admin titles, banners, changelist states and the palette search (UI plan §4.5, §4.8)."""

from unittest import mock

from apps.courses.models import Course
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class AdminTitleTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = get_user_model().objects.create_superuser(
            email="titles-admin@test.com", password="StrongPass@123", full_name="Titles Admin"
        )

    def setUp(self):
        self.client.force_login(self.admin)

    def test_one_site_name(self):
        self.assertEqual(admin.site.site_header, "Al Syed Admin")
        self.assertEqual(admin.site.site_title, "Al Syed Admin")
        self.assertEqual(admin.site.index_title, "Overview")
        response = self.client.get(reverse("admin:payments_payment_changelist"))
        self.assertContains(response, "Al Syed")
        self.assertNotContains(response, "Enterprise Control")
        self.assertNotContains(response, "Al syed Initiative Admin")

    def test_changelist_h1_is_the_plain_plural_name(self):
        response = self.client.get(reverse("admin:payments_payment_changelist"))
        self.assertContains(response, "<h1>Payments</h1>", html=True)
        self.assertContains(response, "<title>Payments | Al Syed Admin</title>", html=False)
        self.assertNotContains(response, "Select payment to change")

    def test_handles_are_called_live_chat_moderation(self):
        response = self.client.get(reverse("admin:realtime_owncastchatidentity_changelist"))
        self.assertContains(response, "<h1>Live chat moderation</h1>", html=True)
        self.assertNotContains(response, "<h1>Handles</h1>", html=True)

    def test_change_form_h1_is_the_object_name(self):
        course = Course.objects.create(title="OSINT Foundations", description="Learn OSINT.", price=4999)
        response = self.client.get(reverse("admin:courses_course_change", args=[course.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "<h1>OSINT Foundations</h1>", html=True)
        self.assertNotContains(response, "<h1>Change course</h1>", html=True)

    def test_add_form_h1_names_the_new_thing(self):
        response = self.client.get(reverse("admin:courses_liveclass_add"))
        self.assertContains(response, "<h1>New live class</h1>", html=True)

    def test_course_form_has_tabs_and_no_top_save_bar(self):
        course = Course.objects.create(title="Tabs Course", description="Tabs.", price=10)
        response = self.client.get(reverse("admin:courses_course_change", args=[course.pk]))
        html = response.content.decode()
        for key, label in (("basics", "Basics"), ("pricing", "Pricing"), ("schedule", "Schedule &amp; batch"), ("page", "Page copy"), ("publishing", "Publishing")):
            self.assertIn(f'href="#tab-{key}" data-tab="{key}">{label}</a>', html)
            self.assertIn(f'id="tab-{key}"', html)
        self.assertEqual(html.count('class="submit-row"'), 1)
        self.assertLess(html.index('id="tab-basics"'), html.index('id="tab-pricing"'))
        self.assertLess(html.index('id="tab-pricing"'), html.index('id="tab-publishing"'))

    def test_duplicated_screens_point_to_the_console(self):
        cases = {
            "admin:ctf_ctfexam_changelist": ("Assessments &rsaquo; Exams", "/console/admin/exams"),
            "admin:reports_reporttask_changelist": ("Assessments &rsaquo; Grading", "/console/admin/grading"),
            "admin:realtime_classrecording_changelist": ("Content &rsaquo; Recordings", "/console/admin/recordings"),
            "admin:recording_uploads_recordinguploadtoken_changelist": ("Content &rsaquo; Upload", "/console/admin/recordings/upload"),
            "admin:courses_lecturequestion_changelist": ("Community &rsaquo; Questions", "/console/admin/community?tab=questions"),
        }
        for name, (where, href) in cases.items():
            with self.subTest(name=name):
                response = self.client.get(reverse(name))
                self.assertEqual(response.status_code, 200)
                self.assertContains(response, "data-console-banner")
                self.assertContains(response, f"Daily work for this lives in Console &rsaquo; {where}.", html=False)
                self.assertContains(response, f'href="{href}"', html=False)

    def test_screens_without_a_console_home_have_no_banner(self):
        response = self.client.get(reverse("admin:payments_payment_changelist"))
        self.assertNotContains(response, "data-console-banner")

    def test_empty_list_explains_what_will_appear(self):
        response = self.client.get(reverse("admin:payments_payment_changelist"))
        self.assertContains(response, "Nothing here yet")
        self.assertContains(response, "Payments appear here as soon as a student starts a checkout.")

    def test_empty_search_offers_to_clear_it(self):
        response = self.client.get(reverse("admin:payments_payment_changelist") + "?q=nobody-at-all")
        self.assertContains(response, "No payments match")
        self.assertContains(response, "Clear search and filters")

    def test_filters_are_a_disclosure_with_a_count(self):
        response = self.client.get(reverse("admin:payments_payment_changelist") + "?status__exact=paid")
        self.assertContains(response, "data-filters")
        self.assertContains(response, "<span>Filters (1)</span>", html=False)

    def test_header_offers_the_palette_and_the_console(self):
        response = self.client.get(reverse("admin:index"))
        self.assertContains(response, 'id="enterprise-palette"')
        self.assertContains(response, 'id="enterprise-palette-data"')
        self.assertContains(response, 'href="/console/admin"')
        self.assertContains(response, "admin/css/enterprise.css")
        self.assertNotContains(response, "inter-latin")


class AdminPaletteSearchTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = get_user_model().objects.create_superuser(
            email="palette-admin@test.com", password="StrongPass@123", full_name="Palette Admin"
        )

    def test_json_uses_the_shared_search_service(self):
        self.client.force_login(self.admin)
        payload = {"q": "sana", "groups": [{"key": "people", "label": "People", "items": [{"id": "user_1", "title": "Sana", "subtitle": "s@x.test", "href": "/admin/users/user/1/change/"}]}]}
        with mock.patch("apps.console_api.search.search", return_value=payload) as search:
            response = self.client.get(reverse("admin:enterprise_search"), {"q": "sana", "format": "json"})
        search.assert_called_once()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)
        self.assertIn("no-store", response["Cache-Control"])

    def test_short_queries_do_not_search(self):
        self.client.force_login(self.admin)
        with mock.patch("apps.console_api.search.search") as search:
            response = self.client.get(reverse("admin:enterprise_search"), {"q": "s", "format": "json"})
        search.assert_not_called()
        self.assertEqual(response.json(), {"q": "s", "groups": []})

    def test_html_page_is_the_no_js_fallback(self):
        self.client.force_login(self.admin)
        payload = {"q": "osint", "groups": [{"key": "courses", "label": "Courses", "items": [{"id": "course_1", "title": "OSINT Foundations", "subtitle": "", "href": "/admin/courses/course/1/change/"}]}]}
        with mock.patch("apps.console_api.search.search", return_value=payload):
            response = self.client.get(reverse("admin:enterprise_search"), {"q": "osint"})
        self.assertContains(response, "<h1>Search</h1>", html=True)
        self.assertContains(response, "OSINT Foundations")

    def test_requires_staff(self):
        response = self.client.get(reverse("admin:enterprise_search"), {"q": "sana", "format": "json"})
        self.assertEqual(response.status_code, 302)
        student = get_user_model().objects.create_user(email="student-palette@test.com", password="StrongPass@123", full_name="S")
        self.client.force_login(student)
        response = self.client.get(reverse("admin:enterprise_search"), {"q": "sana", "format": "json"})
        self.assertEqual(response.status_code, 302)
