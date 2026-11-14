"""Adding a notification in the back office reaches people (UI plan §4.8 bug fix)."""

from apps.courses.models import Course, Enrollment
from apps.notifications.models import Notification, NotificationRecipient
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class NotificationAdminTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.admin = User.objects.create_superuser(email="notify-admin@test.com", password="StrongPass@123", full_name="Admin")
        cls.course = Course.objects.create(title="OSINT Foundations", description="Learn.", price=10)
        cls.enrolled = User.objects.create_user(email="enrolled@test.com", password="StrongPass@123", full_name="Enrolled")
        cls.other = User.objects.create_user(email="other@test.com", password="StrongPass@123", full_name="Other")
        Enrollment.objects.create(user=cls.enrolled, course=cls.course, payment_status=Enrollment.STATUS_PAID)

    def setUp(self):
        self.client.force_login(self.admin)

    def post(self, **data):
        payload = {"audience": "course", "title": "Class moved", "body": "Friday's class starts at 8 pm.", "action_url": "", "course": "", "live_class": ""}
        payload.update(data)
        return self.client.post(reverse("admin:notifications_notification_add"), payload)

    def test_add_fans_out_to_the_course_students(self):
        response = self.post(course=str(self.course.pk))
        self.assertEqual(response.status_code, 302, getattr(response, "context", None) and response.context.get("errors"))
        notification = Notification.objects.get(title="Class moved")
        self.assertEqual(notification.kind, Notification.KIND_ANNOUNCEMENT)
        self.assertEqual(notification.created_by, self.admin)
        recipients = set(NotificationRecipient.objects.filter(notification=notification).values_list("user_id", flat=True))
        self.assertEqual(recipients, {self.enrolled.pk})

    def test_everyone_reaches_every_active_account(self):
        self.post(audience="everyone")
        notification = Notification.objects.get(title="Class moved")
        self.assertEqual(NotificationRecipient.objects.filter(notification=notification).count(), 3)

    def test_course_audience_requires_a_course(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Choose the course whose students should receive this.")
        self.assertFalse(Notification.objects.exists())

    def test_an_audience_with_nobody_is_refused(self):
        empty = Course.objects.create(title="Empty course", description="-", price=1)
        response = self.post(course=str(empty.pk))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Nobody would receive this yet")
        self.assertFalse(Notification.objects.exists())

    def test_list_shows_recipient_counts(self):
        self.post(course=str(self.course.pk))
        response = self.client.get(reverse("admin:notifications_notification_changelist"))
        self.assertContains(response, "Recipients")
        self.assertContains(response, "Class moved")
