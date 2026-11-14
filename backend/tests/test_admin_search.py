"""WS-G: command palette record search ``GET /api/admin/search/?q=`` (plan §4.5)."""

from __future__ import annotations

from django.contrib.auth.models import Permission
from django.test import override_settings
from rest_framework.test import APITestCase

from apps.console_api import search
from apps.payments.models import Payment
from apps.realtime.recording.models import ClassRecording
from tests.factories import make_admin, make_course, make_ctf_exam, make_payment, make_realtime_session, make_user


class AdminSearchTests(APITestCase):
    def setUp(self):
        self.admin = make_admin(full_name="Ayesha Admin")
        self.payal = make_user(full_name="Payal Sharma", email="payal@example.com")
        self.course = make_course(title="OSINT Payloads 101")
        self.payment = make_payment(
            user=self.payal, course=self.course, razorpay_order_id="order_E2EPAY1042", status=Payment.STATUS_PAID
        )

    def find(self, q, user=None, status=200):
        self.client.force_authenticate(user or self.admin)
        response = self.client.get("/api/admin/search/", {"q": q})
        self.assertEqual(response.status_code, status, response.content)
        return response.json().get("data")

    def test_groups_in_order_with_item_shape(self):
        data = self.find("pay")
        self.assertEqual(data["q"], "pay")
        keys = [group["key"] for group in data["groups"]]
        self.assertEqual(keys, ["people", "courses", "payments"])
        payment = data["groups"][2]["items"][0]
        self.assertEqual(
            payment,
            {
                "id": f"pay_{self.payment.pk}",
                "title": "Order order_E2EPAY1042",
                "subtitle": "payal@example.com · ₹499 · Paid",
                "href": f"/admin/payments/payment/{self.payment.pk}/change/",
            },
        )
        person = data["groups"][0]["items"][0]
        self.assertEqual(person["title"], "Payal Sharma")
        self.assertEqual(person["subtitle"], "payal@example.com · Student")
        self.assertEqual(data["groups"][1]["items"][0]["href"], f"/console/admin/courses/{self.course.pk}")

    def test_minimum_length(self):
        self.assertEqual(self.find("p"), {"q": "p", "groups": []})
        self.assertEqual(self.find("   "), {"q": "", "groups": []})
        with override_settings(ADMIN_SEARCH_MIN_CHARS=4):
            self.assertEqual(self.find("pay")["groups"], [])

    def test_limit_per_group(self):
        for n in range(7):
            make_user(full_name=f"Zed Person {n}")
        people = self.find("zed")["groups"][0]
        self.assertEqual(people["key"], "people")
        self.assertEqual(len(people["items"]), search.group_limit())
        with override_settings(ADMIN_SEARCH_GROUP_LIMIT=2):
            self.assertEqual(len(self.find("zed")["groups"][0]["items"]), 2)

    def test_staff_only(self):
        self.client.force_authenticate(None)
        self.assertIn(self.client.get("/api/admin/search/", {"q": "pay"}).status_code, (401, 403))
        self.find("pay", user=self.payal, status=403)

    def test_people_and_payments_need_view_permissions(self):
        staff = make_user(is_staff=True)
        keys = [group["key"] for group in self.find("pay", user=staff)["groups"]]
        self.assertEqual(keys, ["courses"])
        staff.user_permissions.add(Permission.objects.get(codename="view_payment"))
        staff = type(staff).objects.get(pk=staff.pk)
        keys = [group["key"] for group in self.find("pay", user=staff)["groups"]]
        self.assertEqual(keys, ["courses", "payments"])

    def test_classes_exams_recordings(self):
        session = make_realtime_session(title="Recon live class")
        exam = make_ctf_exam(slug="recon-final", title="Recon final")
        recording = ClassRecording.objects.create(source=ClassRecording.SOURCE_SERVER, session=session)
        data = self.find("recon")
        groups = {group["key"]: group["items"] for group in data["groups"]}
        self.assertEqual(groups["classes"][0]["href"], f"/console/admin/classes/{session.pk}/studio")
        self.assertEqual(groups["exams"][0]["href"], f"/console/admin/exams/{exam.slug}")
        self.assertEqual(groups["recordings"][0]["href"], f"/console/admin/recordings?open=cr_{recording.pk}")
