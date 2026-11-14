"""Al Syed Admin overview: the attention queues come from the shared service (UI plan §4.4)."""

from unittest import mock

from apps.console_api.contract_fixtures import load_fixture
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


def _busy(user):
    return load_fixture("attention")["busy"]


def _all_clear(user):
    return load_fixture("attention")["all_clear"]


class AdminIndexTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.admin = get_user_model().objects.create_superuser(
            email="index-admin@test.com", password="StrongPass@123", full_name="Ayesha Admin"
        )

    def setUp(self):
        self.client.force_login(self.admin)

    def get(self):
        return self.client.get(reverse("admin:index"))

    def test_busy_queues_render_as_tiles_from_get_queues(self):
        with mock.patch("apps.console_api.attention.get_queues", side_effect=_busy) as get_queues:
            response = self.get()
        get_queues.assert_called_once()
        self.assertEqual(response.status_code, 200)
        html = response.content.decode()
        self.assertEqual(html.count('class="enterprise-queue-card'), 3)
        self.assertIn('data-queue="reports_to_grade"', html)
        self.assertIn('data-count-up="12"', html)
        self.assertContains(response, "3 things need you.")
        self.assertContains(response, 'href="/console/admin/requests"')

    def test_only_the_busiest_queue_has_the_champagne_button(self):
        with mock.patch("apps.console_api.attention.get_queues", side_effect=_busy):
            html = self.get().content.decode()
        self.assertEqual(html.count('class="button default"'), 1)
        # "high" severity sorts first: the enrolment queue is the one primary action.
        first = html.index('class="enterprise-queue-card is-busiest"')
        self.assertIn('data-queue="enrolment_requests"', html[first : first + 200])

    def test_zero_count_queues_collapse_into_one_all_clear_line(self):
        with mock.patch("apps.console_api.attention.get_queues", side_effect=_busy):
            response = self.get()
        self.assertContains(response, "data-all-clear", count=1)
        self.assertContains(response, "Failed uploads and processing, payments to action")
        self.assertNotContains(response, 'data-queue="payments_to_action"')

    def test_all_clear_shows_no_tiles(self):
        with mock.patch("apps.console_api.attention.get_queues", side_effect=_all_clear):
            response = self.get()
        self.assertNotContains(response, 'class="enterprise-queue-card')
        self.assertContains(response, "All clear. Nothing needs you right now.")

    def test_a_failing_service_never_breaks_the_admin_home(self):
        with mock.patch("apps.console_api.attention.get_queues", side_effect=RuntimeError("boom")):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "The attention queues could not be loaded.")

    def test_overview_layout_sections(self):
        with mock.patch("apps.console_api.attention.get_queues", side_effect=_busy):
            response = self.get()
        for text in ("Needs attention", "Today's classes", "Quick actions", "Platform switches", "Recent activity", "Browse every section"):
            self.assertContains(response, text)
        self.assertContains(response, "OSINT Batch IV")
        self.assertContains(response, "Teachers section")
        self.assertContains(response, "Good ")
        self.assertContains(response, "Ayesha")
        self.assertContains(response, "<title>Overview | Al Syed Admin</title>", html=False)
        # The 69-link wall is gone: sections live in a collapsed disclosure.
        self.assertContains(response, '<details class="enterprise-browse" data-browse>', html=False)

    def test_staff_without_any_permission_still_get_a_working_home(self):
        staff = get_user_model().objects.create_user(
            email="plain-staff@test.com", password="StrongPass@123", full_name="Plain Staff", is_staff=True
        )
        self.client.force_login(staff)
        response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "You do not have permission")
