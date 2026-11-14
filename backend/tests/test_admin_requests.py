"""WS-G: Console Admin › Requests and ``apps.courses.enrollment_actions``.

Approve / reject / reopen go through ``save()`` (signals fire), write a
``LogEntry``, notify the student after commit and never use
``queryset.update()`` (plan §4.6).
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from django.contrib.admin.models import LogEntry
from django.contrib.auth.models import Permission
from django.db.models.signals import post_save
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.courses import enrollment_actions as actions
from apps.courses.models import Enrollment, LiveClass, LiveClassEnrollment
from apps.notifications.models import NotificationRecipient
from tests.factories import make_admin, make_course, make_user

URL = "/api/admin/requests/"
ACTIONS_URL = "/api/admin/requests/actions/"


class RequestsFixture:
    def build(self):
        self.admin = make_admin()
        self.course = make_course(title="OSINT Foundations")
        self.live_class = LiveClass.objects.create(title="OSINT Batch IV", description="Live")
        self.sana = make_user(full_name="Sana Student", email="sana@requests.test", phone_number="+919000000001")
        self.bilal = make_user(full_name="Bilal Student", email="bilal@requests.test")
        now = timezone.now()
        self.course_request = Enrollment.objects.create(user=self.sana, course=self.course)
        Enrollment.objects.filter(pk=self.course_request.pk).update(enrolled_at=now - timedelta(days=2))
        self.live_request = LiveClassEnrollment.objects.create(user=self.bilal, live_class=self.live_class)
        LiveClassEnrollment.objects.filter(pk=self.live_request.pk).update(created_at=now - timedelta(hours=1))
        self.paid = Enrollment.objects.create(user=self.bilal, course=self.course, payment_status=Enrollment.STATUS_PAID)


class RequestsApiTests(RequestsFixture, APITestCase):
    def setUp(self):
        self.build()
        self.client.force_authenticate(self.admin)

    def test_lists_both_kinds_oldest_first(self):
        data = self.client.get(URL).json()["data"]
        self.assertEqual([row["id"] for row in data["results"]], [f"course_{self.course_request.pk}", f"live_class_{self.live_request.pk}"])
        self.assertEqual(data["count"], 2)
        self.assertEqual(data["counts"], {"pending": 2, "approved": 1, "rejected": 0})
        self.assertEqual(data["pending_by_kind"], {"course": 1, "live_class": 1})
        first = data["results"][0]
        self.assertEqual(first["student"], {"id": self.sana.pk, "name": "Sana Student", "email": "sana@requests.test", "phone": "+919000000001"})
        self.assertEqual(first["target"]["title"], "OSINT Foundations")
        self.assertEqual(first["status"], "pending")
        self.assertTrue(first["can_change"])

    def test_filters(self):
        live = self.client.get(URL, {"kind": "live_class"}).json()["data"]
        self.assertEqual([row["kind"] for row in live["results"]], ["live_class"])
        approved = self.client.get(URL, {"status": "approved"}).json()["data"]
        self.assertEqual([row["id"] for row in approved["results"]], [f"course_{self.paid.pk}"])
        searched = self.client.get(URL, {"q": "sana"}).json()["data"]
        self.assertEqual(searched["count"], 1)
        paged = self.client.get(URL, {"page_size": 1, "page": 2}).json()["data"]
        self.assertEqual([row["kind"] for row in paged["results"]], ["live_class"])

    def test_approve_saves_logs_and_notifies(self):
        saved = []
        receiver = lambda sender, instance, **kwargs: saved.append(instance.pk)  # noqa: E731
        post_save.connect(receiver, sender=Enrollment, weak=False)
        try:
            with self.captureOnCommitCallbacks(execute=True):
                response = self.client.post(ACTIONS_URL, {"ids": [f"course_{self.course_request.pk}"], "action": "approve"}, format="json")
        finally:
            post_save.disconnect(receiver, sender=Enrollment)
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual(data["changed"], 1)
        self.assertEqual(data["results"], [{"id": f"course_{self.course_request.pk}", "status": "approved", "changed": True}])
        self.course_request.refresh_from_db()
        self.assertEqual(self.course_request.payment_status, Enrollment.STATUS_PAID)
        self.assertEqual(saved, [self.course_request.pk])  # save() ran: signals fired
        entry = LogEntry.objects.get(object_id=str(self.course_request.pk), content_type__model="enrollment")
        self.assertIn("Approved", entry.get_change_message())
        notification = NotificationRecipient.objects.get(user=self.sana).notification
        self.assertIn("OSINT Foundations", notification.title)
        self.assertEqual(notification.action_url, f"/learn/{self.course.pk}")

    def test_reject_then_undo_reopens(self):
        row_id = f"live_class_{self.live_request.pk}"
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(ACTIONS_URL, {"ids": [row_id], "action": "reject"}, format="json")
        self.live_request.refresh_from_db()
        self.assertEqual(self.live_request.status, LiveClassEnrollment.STATUS_REJECTED)
        self.assertEqual(NotificationRecipient.objects.filter(user=self.bilal).count(), 1)
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(ACTIONS_URL, {"ids": [row_id], "action": "reopen"}, format="json")
        self.assertEqual(response.json()["data"]["results"][0]["status"], "pending")
        self.live_request.refresh_from_db()
        self.assertEqual(self.live_request.status, LiveClassEnrollment.STATUS_PENDING)
        self.assertEqual(NotificationRecipient.objects.filter(user=self.bilal).count(), 1)  # undo does not notify

    def test_bulk_and_no_op(self):
        ids = [f"course_{self.course_request.pk}", f"live_class_{self.live_request.pk}", f"course_{self.paid.pk}", "course_999999"]
        data = self.client.post(ACTIONS_URL, {"ids": ids, "action": "approve"}, format="json").json()["data"]
        self.assertEqual(data["changed"], 2)
        self.assertEqual([row["changed"] for row in data["results"]], [True, True, False])
        self.assertEqual(data["missing"], ["course_999999"])
        self.assertEqual(LogEntry.objects.count(), 2)  # the no-op wrote nothing
        self.assertEqual(self.client.get(URL).json()["data"]["results"], [])

    def test_validation(self):
        for body in ({"ids": [], "action": "approve"}, {"ids": ["course_1"], "action": "delete"}, {"ids": ["payment_1"], "action": "approve"}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post(ACTIONS_URL, body, format="json").status_code, 400)

    def test_permissions(self):
        staff = make_user(is_staff=True)
        self.client.force_authenticate(staff)
        self.assertEqual(self.client.get(URL).json()["data"]["results"], [])  # no view permission: nothing listed
        staff.user_permissions.add(Permission.objects.get(codename="view_enrollment"))
        staff = type(staff).objects.get(pk=staff.pk)
        self.client.force_authenticate(staff)
        row = self.client.get(URL).json()["data"]["results"][0]
        self.assertFalse(row["can_change"])
        response = self.client.post(ACTIONS_URL, {"ids": [row["id"]], "action": "approve"}, format="json")
        self.assertEqual(response.status_code, 403)
        self.client.force_authenticate(self.sana)
        self.assertEqual(self.client.get(URL).status_code, 403)


class EnrollmentActionServiceTests(RequestsFixture, TestCase):
    def setUp(self):
        self.build()

    def test_apply_to_queryset_never_uses_update(self):
        with patch("django.db.models.query.QuerySet.update", side_effect=AssertionError("queryset.update() used")):
            changed = actions.apply_to_queryset("course", Enrollment.objects.filter(pk=self.course_request.pk), "reject", by=self.admin)
        self.assertEqual(changed, 1)
        self.course_request.refresh_from_db()
        self.assertEqual(self.course_request.payment_status, Enrollment.STATUS_FAILED)
        self.assertEqual(actions.status_of("course", self.course_request), "rejected")

    def test_unknown_kind_or_action(self):
        with self.assertRaises(ValueError):
            actions.set_status("payment", 1, "approve", by=self.admin)
        with self.assertRaises(ValueError):
            actions.set_status("course", self.course_request.pk, "delete", by=self.admin)
