"""Back office for platform plans, memberships and the free OSINT directory (contract §8)."""

from __future__ import annotations

from datetime import date

from django.test import TestCase
from django.urls import reverse

from apps.osint_labs.management.commands.import_osint_directory import DEFAULT_FILE, import_rows, load_rows
from apps.osint_labs.models import OsintChallenge
from apps.payments import platform_plans
from apps.payments.models import MembershipBundle, PlatformPlan
from tests import factories as f


class PlatformAdminTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = f.make_admin()
        platform_plans.seed_platform_plans(apply=True)
        paths, rows = load_rows(DEFAULT_FILE)
        import_rows(paths, rows, apply=True)

    def setUp(self):
        self.client.force_login(self.admin)

    def run_action(self, url, action, ids):
        return self.client.post(url, {"action": action, "_selected_action": [str(pk) for pk in ids], "index": 0})

    def test_every_new_back_office_page_renders(self):
        plan = PlatformPlan.objects.get(key="ctf_labs_monthly")
        bundle = MembershipBundle.objects.create(month=date(2026, 11, 1))
        challenge = OsintChallenge.objects.order_by("pk").first()
        urls = [
            reverse("admin:payments_platformplan_changelist"),
            reverse("admin:payments_platformplan_change", args=[plan.pk]),
            reverse("admin:payments_platformgrant_changelist"),
            reverse("admin:payments_platformgrant_add"),
            reverse("admin:payments_platformsubscription_changelist"),
            reverse("admin:payments_membershipbundle_changelist"),
            reverse("admin:payments_membershipbundle_change", args=[bundle.pk]),
            reverse("admin:osint_labs_osintchallenge_changelist"),
            reverse("admin:osint_labs_osintchallenge_change", args=[challenge.pk]),
            reverse("admin:osint_labs_osintpath_changelist"),
        ]
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)

    def test_confirm_price_action_records_who_and_keeps_the_plan_off(self):
        plan = PlatformPlan.objects.get(key="pentesting_bootcamp")
        response = self.run_action(reverse("admin:payments_platformplan_changelist"), "confirm_price", [plan.pk])
        self.assertEqual(response.status_code, 302)
        plan.refresh_from_db()
        self.assertTrue(plan.price_is_confirmed)
        self.assertEqual(plan.price_confirmed_by, self.admin)
        self.assertFalse(plan.is_enabled, "confirming a price never switches the plan on")

    def test_price_edit_after_confirmation_unconfirms_and_disables(self):
        plan = platform_plans.confirm_price(PlatformPlan.objects.get(key="pentesting_lifetime"), by=self.admin)
        plan.price_inr = plan.price_inr + 1
        plan.save()
        plan.refresh_from_db()
        self.assertFalse(plan.price_is_confirmed)
        self.assertFalse(plan.is_enabled)

    def test_bundle_publish_and_copy_actions(self):
        course = f.make_course(title="OSINT Batch IV")
        bundle = MembershipBundle.objects.create(month=date(2026, 11, 1))
        bundle.courses.set([course])
        url = reverse("admin:payments_membershipbundle_changelist")
        self.assertEqual(self.run_action(url, "publish", [bundle.pk]).status_code, 302)
        bundle.refresh_from_db()
        self.assertEqual(bundle.status, MembershipBundle.STATUS_PUBLISHED)
        self.assertEqual(bundle.published_by, self.admin)

        self.assertEqual(self.run_action(url, "copy_to_next_month", [bundle.pk]).status_code, 302)
        december = MembershipBundle.objects.get(month=date(2026, 12, 1))
        self.assertEqual(december.status, MembershipBundle.STATUS_DRAFT, "a copy is a draft until published")
        self.assertEqual(list(december.courses.all()), [course])

        page = self.client.get(reverse("admin:payments_membershipbundle_change", args=[bundle.pk]))
        self.assertContains(page, "OSINT Batch IV")

    def test_directory_starter_list_is_link_out_metadata_with_licences(self):
        self.assertGreaterEqual(OsintChallenge.objects.count(), 20)
        self.assertLessEqual(OsintChallenge.objects.count(), 40)
        for challenge in OsintChallenge.objects.all():
            with self.subTest(slug=challenge.slug):
                self.assertTrue(challenge.url.startswith("https://"))
                self.assertEqual(challenge.hosting, "link_out")
                self.assertTrue(challenge.attribution)
