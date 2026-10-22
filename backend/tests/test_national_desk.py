import datetime

from apps.national_desk.models import (
    FirFilingGuide,
    LawsSection,
    LawTopic,
    NationalDeskSettings,
    TrackerOverview,
    TrackerUpdate,
)
from django.contrib import admin
from django.core.cache import cache
from django.core.exceptions import ValidationError
from rest_framework.test import APITestCase


class NationalDeskContentTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_seed_materialises_singletons_and_rows(self):
        self.assertTrue(NationalDeskSettings.objects.filter(pk=1).exists())
        self.assertTrue(FirFilingGuide.objects.filter(pk=1).exists())
        self.assertTrue(LawsSection.objects.filter(pk=1).exists())
        self.assertTrue(TrackerOverview.objects.filter(pk=1).exists())
        self.assertEqual(LawTopic.objects.count(), 5)
        self.assertEqual(TrackerUpdate.objects.count(), 5)

    def test_public_endpoint_returns_full_payload(self):
        response = self.client.get("/api/national-desk/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "public, max-age=60, stale-while-revalidate=120")
        self.assertTrue(response.data["success"])
        data = response.data["data"]

        self.assertTrue(data["is_published"])
        self.assertTrue(data["instagram"]["enabled"])
        self.assertIn("instagram.com", data["instagram"]["url"])

        self.assertEqual(data["file_fir"]["title"], "How to File an FIR")
        self.assertEqual(data["file_fir"]["audio_duration"], "12:48")

        self.assertEqual(len(data["laws"]["topics"]), 5)
        self.assertEqual(data["laws"]["topics"][0]["title"], "Your Right to File a Complaint")
        self.assertEqual(data["laws"]["topics"][0]["icon_key"], "book")

        self.assertEqual(
            data["tracker"]["stats"],
            {"total_filed": 37, "in_progress": 18, "completed": 12, "planned": 7},
        )
        self.assertEqual(len(data["tracker"]["updates"]), 5)
        first_update = data["tracker"]["updates"][0]
        self.assertEqual(first_update["city"], "Lucknow")
        self.assertEqual(first_update["status_display"], "Completed")
        self.assertEqual(first_update["date"], "18 Oct 2025")

    def test_inactive_topics_and_updates_are_excluded(self):
        LawTopic.objects.filter(icon_key="shield").update(is_active=False)
        TrackerUpdate.objects.filter(city="Kolkata").update(is_active=False)

        response = self.client.get("/api/national-desk/")
        data = response.data["data"]

        self.assertEqual(len(data["laws"]["topics"]), 4)
        titles = [item["title"] for item in data["laws"]["topics"]]
        self.assertNotIn("What to Do After Filing the FIR", titles)

        cities = [item["city"] for item in data["tracker"]["updates"]]
        self.assertNotIn("Kolkata", cities)

    def test_law_topics_are_ordered_by_sort_order(self):
        response = self.client.get("/api/national-desk/")
        topics = response.data["data"]["laws"]["topics"]
        self.assertEqual(
            [item["icon_key"] for item in topics],
            ["book", "person", "clipboard", "scale", "shield"],
        )

    def test_settings_is_a_singleton(self):
        extra = NationalDeskSettings(is_published=False)
        extra.save()
        self.assertEqual(NationalDeskSettings.objects.count(), 1)
        self.assertEqual(NationalDeskSettings.load().pk, 1)

    def test_models_reject_active_content(self):
        topic = LawTopic(title="<script>alert(1)</script>", body="x")
        with self.assertRaises(ValidationError):
            topic.full_clean()

    def test_settings_rejects_non_public_instagram_url(self):
        settings_row = NationalDeskSettings.load()
        settings_row.instagram_url = "http://127.0.0.1/admin"
        with self.assertRaises(ValidationError):
            settings_row.full_clean()

    def test_tracker_update_requires_event_date(self):
        update = TrackerUpdate(city="Pune", region="Maharashtra")
        with self.assertRaises(ValidationError):
            update.full_clean()

    def test_valid_tracker_update_saves(self):
        update = TrackerUpdate(
            city="Pune",
            region="Maharashtra",
            status="planned",
            status_note="Upcoming",
            event_date=datetime.date(2025, 10, 20),
            sort_order=60,
        )
        update.save()
        self.assertTrue(TrackerUpdate.objects.filter(city="Pune").exists())

    def test_models_are_registered_in_admin(self):
        for model in (
            NationalDeskSettings,
            FirFilingGuide,
            LawsSection,
            LawTopic,
            TrackerOverview,
            TrackerUpdate,
        ):
            self.assertIn(model, admin.site._registry)
