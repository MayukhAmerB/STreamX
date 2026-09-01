from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase


class OpenAPIContractAccessTests(APITestCase):
    def setUp(self):
        user_model = get_user_model()
        self.student = user_model.objects.create_user(
            email="schema-student@test.com",
            password="StrongSchemaPassword123!",
        )
        self.admin = user_model.objects.create_superuser(
            email="schema-admin@test.com",
            password="StrongSchemaPassword123!",
        )
        self.url = reverse("openapi-schema")

    def test_schema_is_not_public(self):
        response = self.client.get(self.url)
        self.assertIn(response.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))

    def test_schema_requires_admin(self):
        self.client.force_authenticate(self.student)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_receives_api_only_contract(self):
        self.client.force_authenticate(self.admin)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        contract = response.content.decode("utf-8")
        self.assertIn("/courses/", contract)
        self.assertNotIn("/admin/admin", contract)
