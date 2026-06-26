from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.campaigns.models import Campaign, CampaignSiteVisit, CampaignVolunteer


@override_settings(
    REST_FRAMEWORK={
        "DEFAULT_AUTHENTICATION_CLASSES": [],
        "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
        "DEFAULT_THROTTLE_CLASSES": [],
    }
)
class CampaignApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.campaign = Campaign.objects.create(
            name="Test Campaign",
            campaign_number="101",
            is_featured=True,
            is_active=True,
        )

    def test_public_campaign_list_only_returns_active_campaigns(self):
        Campaign.objects.create(name="Archived Campaign", is_active=False)

        response = self.client.get("/api/campaigns/")

        self.assertEqual(response.status_code, 200)
        names = [item["name"] for item in response.data["data"]]
        self.assertIn("Test Campaign", names)
        self.assertNotIn("Archived Campaign", names)

    def test_site_visit_counter_counts_unique_browser_keys(self):
        first_response = self.client.post(
            "/api/campaigns/visits/",
            {"visitor_key": "campaign-test-visitor-0001"},
            format="json",
        )
        second_response = self.client.post(
            "/api/campaigns/visits/",
            {"visitor_key": "campaign-test-visitor-0001"},
            format="json",
        )

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(first_response.data["data"]["site_visits"], 1)
        self.assertEqual(second_response.data["data"]["site_visits"], 1)
        self.assertEqual(CampaignSiteVisit.objects.count(), 1)
        self.assertEqual(CampaignSiteVisit.objects.get().visit_count, 2)

    def test_site_visit_counter_rejects_invalid_keys(self):
        response = self.client.post("/api/campaigns/visits/", {"visitor_key": "<script>"}, format="json")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(CampaignSiteVisit.objects.count(), 0)

    def test_public_volunteer_submit_creates_database_record(self):
        response = self.client.post(
            "/api/campaigns/volunteers/",
            {
                "campaign_id": self.campaign.id,
                "full_name": "Volunteer One",
                "age": 24,
                "whatsapp_number": "+91 98765 43210",
                "alternate_number": "",
                "city": "Mumbai",
                "state": "Maharashtra",
                "gender": "male",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        volunteer = CampaignVolunteer.objects.get()
        self.assertEqual(volunteer.full_name, "Volunteer One")
        self.assertEqual(volunteer.age, 24)
        self.assertEqual(volunteer.campaign, self.campaign)

    def test_public_volunteer_submit_rejects_active_content(self):
        response = self.client.post(
            "/api/campaigns/volunteers/",
            {
                "campaign_id": self.campaign.id,
                "full_name": "<script>alert(1)</script>",
                "age": 24,
                "whatsapp_number": "+91 98765 43210",
                "city": "Mumbai",
                "state": "Maharashtra",
                "gender": "male",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(CampaignVolunteer.objects.count(), 0)

    def test_admin_campaign_api_requires_login(self):
        response = self.client.get("/api/campaigns/admin/campaigns/")

        self.assertEqual(response.status_code, 403)

    def test_admin_login_allows_campaign_management(self):
        User = get_user_model()
        User.objects.create_user(
            email="admin@example.com",
            password="strong-admin-pass-123",
            full_name="Admin",
            is_staff=True,
        )

        login_response = self.client.post(
            "/api/campaigns/admin/login/",
            {"username": "admin@example.com", "password": "strong-admin-pass-123"},
            format="json",
        )
        self.assertEqual(login_response.status_code, 200)

        create_response = self.client.post(
            "/api/campaigns/admin/campaigns/",
            {
                "name": "Created From Admin",
                "campaign_number": "202",
                "is_featured": False,
                "is_active": True,
                "sort_order": 2,
            },
            format="json",
        )

        self.assertEqual(create_response.status_code, 201)
        self.assertTrue(Campaign.objects.filter(name="Created From Admin").exists())
