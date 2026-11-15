"""Al Syed Admin sidebar: every registered model sits in a job group (UI plan §4.2, §4.8)."""

from apps.users.templatetags import enterprise_admin
from apps.users.templatetags.enterprise_admin import JOB_GROUPS, MODEL_JOBS, enterprise_nav_groups
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class AdminNavGroupsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = get_user_model().objects.create_superuser(
            email="nav-admin@test.com", password="StrongPass@123", full_name="Nav Admin"
        )

    def test_every_registered_model_is_in_a_job_group(self):
        missing = sorted(
            f"{model._meta.app_label}.{model._meta.model_name}"
            for model in admin.site._registry
            if f"{model._meta.app_label}.{model._meta.model_name}" not in MODEL_JOBS
        )
        self.assertEqual(missing, [], "Add these models to MODEL_JOBS so they are not 'Not grouped yet'")

    def test_every_mapping_points_at_a_known_group(self):
        keys = {key for key, _title, _icon in JOB_GROUPS}
        self.assertEqual({group for group, _label in MODEL_JOBS.values()} - keys, set())

    def test_the_sidebar_shows_the_job_groups_and_no_ungrouped_bucket(self):
        self.client.force_login(self.admin)
        response = self.client.get(reverse("admin:index"))
        self.assertEqual(response.status_code, 200)
        groups = enterprise_nav_groups(response.context["available_apps"])
        titles = [group["title"] for group in groups]
        self.assertEqual(
            titles,
            ["Live classes", "Content", "Students & sales", "Billing", "Assessments", "Community", "Settings", "System"],
        )
        self.assertNotIn("Not grouped yet", titles)
        for title in titles:
            self.assertContains(response, f'<span class="enterprise-sidenav-label">{title.replace("&", "&amp;")}</span>', html=False)

    def test_enrolment_admins_are_visible_again(self):
        self.client.force_login(self.admin)
        response = self.client.get(reverse("admin:index"))
        self.assertContains(response, reverse("admin:courses_enrollment_changelist"))
        self.assertContains(response, ">Enrolment requests<")
        self.assertContains(response, reverse("admin:courses_liveclassenrollment_changelist"))
        self.assertContains(response, ">Live-class requests<")

    def test_jobs_are_named_for_the_work_not_the_model(self):
        groups = {
            entry["key"]: (group["key"], entry["name"])
            for group in enterprise_nav_groups(self._apps())
            for entry in group["models"]
        }
        self.assertEqual(groups["realtime.owncastchatidentity"], ("live", "Live chat moderation"))
        self.assertEqual(groups["users.asyncjob"], ("system", "Async jobs"))
        self.assertEqual(groups["authtoken.tokenproxy"], ("system", "API tokens"))

    def test_only_the_current_group_is_open(self):
        self.client.force_login(self.admin)
        response = self.client.get(reverse("admin:payments_payment_changelist"))
        html = response.content.decode()
        self.assertEqual(html.count("<details open>"), 1)
        self.assertIn('data-nav-group="students"', html)
        start = html.index('data-nav-group="students"')
        self.assertIn("<details open>", html[start : start + 120])

    def test_an_unknown_model_falls_into_not_grouped_yet(self):
        apps = [{"app_label": "zzz", "models": [{"object_name": "Thing", "name": "Things", "admin_url": "/admin/zzz/thing/"}]}]
        groups = enterprise_admin.enterprise_nav_groups(apps)
        self.assertEqual([group["title"] for group in groups], ["Not grouped yet"])

    def _apps(self):
        from django.test import RequestFactory

        request = RequestFactory().get("/admin/")
        request.user = self.admin
        return admin.site.get_app_list(request)
