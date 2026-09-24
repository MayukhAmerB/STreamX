from unittest.mock import patch

from apps.social_accounts.models import SocialAccount, SocialAccountCategory
from django.contrib import admin
from django.core.cache import cache
from django.core.exceptions import ValidationError
from rest_framework.test import APITestCase


class SocialAccountDirectoryTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_primary_categories_are_seeded(self):
        categories = list(
            SocialAccountCategory.objects.filter(slug__in=("youtube", "instagram", "x", "facebook"))
            .order_by("sort_order")
            .values_list("slug", flat=True)
        )
        self.assertEqual(categories, ["youtube", "instagram", "x", "facebook"])

    @patch("apps.social_accounts.models.validate_safe_public_url", return_value=None)
    def test_public_directory_is_ordered_and_excludes_inactive_records(self, _validate_url):
        instagram = SocialAccountCategory.objects.get(slug="instagram")
        youtube = SocialAccountCategory.objects.get(slug="youtube")
        SocialAccount.objects.create(
            category=instagram,
            account_name="Al Syed Initiative",
            handle="@alsyedinitiative",
            url="https://www.instagram.com/alsyedinitiative/",
            managed_by="Al Syed team",
            sort_order=20,
        )
        first_account = SocialAccount.objects.create(
            category=instagram,
            account_name="AS Learning",
            handle="@aslearning",
            url="https://www.instagram.com/aslearning/",
            managed_by="Education team",
            description="Training announcements and resources.",
            sort_order=10,
        )
        SocialAccount.objects.create(
            category=instagram,
            account_name="Retired account",
            url="https://www.instagram.com/retired-account/",
            is_active=False,
        )
        SocialAccount.objects.create(
            category=youtube,
            account_name="Official channel",
            url="https://www.youtube.com/@alsyedinitiative",
        )
        youtube.is_active = False
        youtube.save(update_fields=("is_active", "updated_at"))

        response = self.client.get("/api/as-accounts/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "public, max-age=60, stale-while-revalidate=120")
        payload = response.data["data"]
        instagram_data = next(item for item in payload if item["slug"] == "instagram")
        self.assertNotIn("youtube", {item["slug"] for item in payload})
        self.assertEqual(instagram_data["account_count"], 2)
        self.assertEqual(
            [item["account_name"] for item in instagram_data["accounts"]],
            ["AS Learning", "Al Syed Initiative"],
        )
        self.assertEqual(instagram_data["accounts"][0]["id"], first_account.pk)
        self.assertEqual(
            set(instagram_data["accounts"][0]),
            {"id", "account_name", "handle", "url", "managed_by", "description", "status_label"},
        )

    def test_models_reject_active_content_and_non_public_urls(self):
        category = SocialAccountCategory(name="Unsafe<script>alert(1)</script>")
        with self.assertRaises(ValidationError):
            category.full_clean()

        instagram = SocialAccountCategory.objects.get(slug="instagram")
        account = SocialAccount(
            category=instagram,
            account_name="Internal target",
            url="http://127.0.0.1/admin",
        )
        with self.assertRaises(ValidationError):
            account.full_clean()

    def test_models_are_available_in_django_admin(self):
        self.assertIn(SocialAccountCategory, admin.site._registry)
        self.assertIn(SocialAccount, admin.site._registry)
