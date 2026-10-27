from apps.join_requests.india_locations import INDIA_STATE_DISTRICTS
from apps.join_requests.models import JoinApplication
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

APPLICATIONS_URL = "/api/join/applications/"
LOCATIONS_URL = "/api/join/locations/"


def valid_payload(**overrides):
    payload = {
        "role": "citizen",
        "full_name": "  Ayesha   Khan ",
        "age": 27,
        "phone_number": "98765 43210",
        "address": "Park Circus",
        "state": "West Bengal",
        "district": "Kolkata",
        "terms_accepted": True,
    }
    payload.update(overrides)
    return payload


class JoinLocationDirectoryTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_directory_lists_every_state_and_union_territory_with_districts(self):
        response = self.client.get(LOCATIONS_URL)

        self.assertEqual(response.status_code, 200)
        self.assertIn("max-age=3600", response["Cache-Control"])
        payload = response.data["data"]
        self.assertEqual(len(payload), 36)
        self.assertEqual([item["state"] for item in payload], sorted(INDIA_STATE_DISTRICTS))
        self.assertTrue(all(item["districts"] for item in payload))
        uttar_pradesh = next(item for item in payload if item["state"] == "Uttar Pradesh")
        self.assertEqual(len(uttar_pradesh["districts"]), 75)

    def test_district_names_are_unique_within_each_state(self):
        for state, districts in INDIA_STATE_DISTRICTS.items():
            self.assertEqual(len(districts), len(set(districts)), state)


class JoinApplicationCreateTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_valid_submission_is_stored_with_normalised_values(self):
        response = self.client.post(APPLICATIONS_URL, valid_payload(), format="json")

        self.assertEqual(response.status_code, 201, response.data)
        application = JoinApplication.objects.get(pk=response.data["data"]["application_id"])
        self.assertEqual(application.full_name, "Ayesha Khan")
        self.assertEqual(application.phone_number, "+919876543210")
        self.assertEqual(application.status, JoinApplication.STATUS_NEW)
        self.assertIsNotNone(application.terms_accepted_at)
        self.assertEqual(application.district, "Kolkata")

    def test_optional_fields_can_be_omitted(self):
        payload = valid_payload(role="lawyer")
        payload.pop("age")
        payload.pop("address")

        response = self.client.post(APPLICATIONS_URL, payload, format="json")

        self.assertEqual(response.status_code, 201, response.data)
        application = JoinApplication.objects.get()
        self.assertIsNone(application.age)
        self.assertEqual(application.address, "")

    def test_rejects_non_indian_or_malformed_numbers(self):
        for number in ("+14155552671", "12345", "5876543210", "+91 98765 4321"):
            response = self.client.post(APPLICATIONS_URL, valid_payload(phone_number=number), format="json")
            self.assertEqual(response.status_code, 400, number)
            self.assertIn("phone_number", response.data["errors"])
        self.assertFalse(JoinApplication.objects.exists())

    def test_rejects_district_outside_selected_state(self):
        response = self.client.post(
            APPLICATIONS_URL,
            valid_payload(state="Kerala", district="Kolkata"),
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("district", response.data["errors"])

    def test_rejects_unknown_state_unaccepted_terms_and_invalid_role(self):
        cases = (
            ({"state": "Atlantis"}, "state"),
            ({"terms_accepted": False}, "terms_accepted"),
            ({"role": "admin"}, "role"),
            ({"age": 12}, "age"),
        )
        for overrides, field in cases:
            response = self.client.post(APPLICATIONS_URL, valid_payload(**overrides), format="json")
            self.assertEqual(response.status_code, 400, overrides)
            self.assertIn(field, response.data["errors"], overrides)

        # Script payloads are stopped by the request firewall before reaching the view.
        response = self.client.post(
            APPLICATIONS_URL,
            valid_payload(full_name="<script>alert(1)</script>"),
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(JoinApplication.objects.exists())

    def test_duplicate_pending_submission_for_same_number_and_role_is_rejected(self):
        first = self.client.post(APPLICATIONS_URL, valid_payload(), format="json")
        self.assertEqual(first.status_code, 201)

        duplicate = self.client.post(APPLICATIONS_URL, valid_payload(), format="json")
        self.assertEqual(duplicate.status_code, 400)
        self.assertIn("phone_number", duplicate.data["errors"])

        JoinApplication.objects.update(status=JoinApplication.STATUS_REJECTED)
        retry = self.client.post(APPLICATIONS_URL, valid_payload(), format="json")
        self.assertEqual(retry.status_code, 201)


class JoinApplicationAdminTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.admin_user = get_user_model().objects.create_superuser(
            email="join-admin@test.com",
            password="StrongJoinAdminPassword123!",
        )

    def test_model_is_registered_in_django_admin(self):
        self.assertIn(JoinApplication, admin.site._registry)

    def test_admin_can_list_and_export_submissions(self):
        self.client.post(
            APPLICATIONS_URL,
            valid_payload(full_name="=HYPERLINK(1)", address="Salt Lake"),
            format="json",
        )
        self.client.force_login(self.admin_user)

        changelist = self.client.get("/admin/join_requests/joinapplication/")
        self.assertEqual(changelist.status_code, 200)
        self.assertContains(changelist, "=HYPERLINK(1)")

        export = self.client.post(
            "/admin/join_requests/joinapplication/",
            {
                "action": "export_as_csv",
                "_selected_action": list(JoinApplication.objects.values_list("pk", flat=True)),
            },
        )
        self.assertEqual(export.status_code, 200)
        self.assertEqual(export["Content-Type"], "text/csv")
        body = export.content.decode("utf-8")
        self.assertIn("Contact number", body)
        self.assertIn("+919876543210", body)
        self.assertIn("'=HYPERLINK(1)", body)
