import json
from decimal import Decimal
from io import StringIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.core.models import OutboxEvent
from apps.courses.models import Course, Enrollment
from apps.payments import credential_delivery
from apps.payments.models import CredentialDelivery, Payment
from apps.payments.provisioning import provision_paid_payment

User = get_user_model()

WA_SETTINGS = dict(
    WHATSAPP_CLOUD_API_TOKEN="token",
    WHATSAPP_PHONE_NUMBER_ID="12345",
    WHATSAPP_TEMPLATE_CREDENTIALS="login_credentials",
)


class FakeTransport:
    def __init__(self, status=200, body=None):
        self.calls = []
        self.status = status
        self.body = body if body is not None else {"messages": [{"id": "wamid.1"}]}

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append(json.loads(body))
        return self.status, json.dumps(self.body).encode()


class CredentialDeliveryBase(TestCase):
    def setUp(self):
        self.instructor = User.objects.create_user(
            email="cred-instructor@example.com", password="StrongInstructor@123",
            full_name="Instructor", role=User.ROLE_INSTRUCTOR,
        )
        self.course = Course.objects.create(
            title="Credential Course", description="d", price=Decimal("2500.00"),
            instructor=self.instructor, is_published=True,
        )

    def guest_payment(self, n=1, **extra):
        fields = dict(
            course=self.course,
            course_id_snapshot=self.course.id,
            course_title_snapshot=self.course.title,
            buyer_name=f"Buyer {n}",
            buyer_email=f"buyer{n}@example.com",
            whatsapp_number="9876543210",
            razorpay_order_id=f"order_cred_{n}",
            razorpay_payment_id=f"pay_cred_{n}",
            amount=Decimal("2500.00"),
            currency="INR",
            status=Payment.STATUS_PAID,
            provisioning_status=Payment.PROVISION_PENDING,
            paid_at=timezone.now(),
        )
        fields.update(extra)
        return Payment.objects.create(**fields)

    def provisioned(self, n=1, **extra):
        payment = self.guest_payment(n, **extra)
        provision_paid_payment(payment)
        payment.refresh_from_db()
        return payment


class AutoSendTests(CredentialDeliveryBase):
    def test_provisioning_queues_one_auto_send_and_keeps_awaiting_status(self):
        payment = self.provisioned()
        self.assertEqual(payment.provisioning_status, Payment.PROVISION_AWAITING_ADMIN)
        self.assertFalse(payment.user.has_usable_password())
        self.assertTrue(Enrollment.objects.filter(user=payment.user, course=self.course).exists())
        events = OutboxEvent.objects.filter(event_type=credential_delivery.EVENT_AUTO_SEND)
        self.assertEqual(events.count(), 1)
        self.assertEqual(events.get().payload, {"payment_id": payment.pk})
        provision_paid_payment(payment)  # provider retry
        self.assertEqual(events.count(), 1)

    @override_settings(PAYMENT_AUTO_CREDENTIALS_ENABLED=False)
    def test_switch_off_queues_nothing(self):
        self.provisioned()
        self.assertFalse(OutboxEvent.objects.filter(event_type=credential_delivery.EVENT_AUTO_SEND).exists())

    def test_auto_send_emails_registered_address_with_working_password(self):
        payment = self.provisioned()
        self.assertEqual(credential_delivery.auto_send_for_payment(payment.pk), "sent")
        user = User.objects.get(pk=payment.user_id)
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.to, ["buyer1@example.com"])
        self.assertIn(f"Username: {user.email}", message.body)
        password = message.body.split("Password: ", 1)[1].splitlines()[0]
        self.assertTrue(user.check_password(password))
        payment.refresh_from_db()
        self.assertEqual(payment.provisioning_status, Payment.PROVISION_CREDENTIALS_ISSUED)
        delivery = CredentialDelivery.objects.get(user=user)
        self.assertEqual((delivery.channel, delivery.status, delivery.sent_by), ("email", "sent", None))
        self.assertNotIn(password, delivery.error + delivery.recipient)

    def test_auto_send_is_idempotent_once_a_password_exists(self):
        payment = self.provisioned()
        credential_delivery.auto_send_for_payment(payment.pk)
        self.assertEqual(credential_delivery.auto_send_for_payment(payment.pk), "already_issued")
        self.assertEqual(len(mail.outbox), 1)

    @override_settings(**WA_SETTINGS)
    def test_auto_send_also_sends_whatsapp_template_when_configured(self):
        payment = self.provisioned()
        transport = FakeTransport()
        provider = credential_delivery.whatsapp_provider(transport=transport)
        credential_delivery.auto_send_for_payment(payment.pk, whatsapp_provider_override=provider)
        user = User.objects.get(pk=payment.user_id)
        self.assertEqual(len(transport.calls), 1)
        call = transport.calls[0]
        self.assertEqual(call["to"], "919876543210")
        self.assertEqual(call["template"]["name"], "login_credentials")
        params = [p["text"] for p in call["template"]["components"][0]["parameters"]]
        self.assertEqual(params[0], "Buyer 1")
        self.assertEqual(params[3], user.email)
        self.assertTrue(user.check_password(params[4]))
        channels = set(CredentialDelivery.objects.filter(user=user, status="sent").values_list("channel", flat=True))
        self.assertEqual(channels, {"email", "whatsapp"})

    def test_reaching_nobody_withdraws_password_and_retries(self):
        payment = self.provisioned()
        with mock.patch("apps.payments.credential_delivery.EmailMessage.send", side_effect=OSError("smtp down")):
            with self.assertRaises(credential_delivery.DeliveryFailed):
                credential_delivery.auto_send_for_payment(payment.pk)
        user = User.objects.get(pk=payment.user_id)
        self.assertFalse(user.has_usable_password())
        payment.refresh_from_db()
        self.assertEqual(payment.provisioning_status, Payment.PROVISION_AWAITING_ADMIN)
        self.assertEqual(CredentialDelivery.objects.get(user=user).status, "failed")
        # The retry succeeds once mail works again.
        self.assertEqual(credential_delivery.auto_send_for_payment(payment.pk), "sent")
        self.assertTrue(User.objects.get(pk=user.pk).has_usable_password())

    @override_settings(**WA_SETTINGS)
    def test_one_channel_failing_still_counts_as_delivered(self):
        payment = self.provisioned()
        provider = credential_delivery.whatsapp_provider(transport=FakeTransport())
        with mock.patch("apps.payments.credential_delivery.EmailMessage.send", side_effect=OSError("smtp down")):
            outcome = credential_delivery.auto_send_for_payment(payment.pk, whatsapp_provider_override=provider)
        self.assertEqual(outcome, "sent")
        self.assertTrue(User.objects.get(pk=payment.user_id).has_usable_password())

    def test_logged_in_buyer_with_own_password_gets_no_auto_send(self):
        buyer = User.objects.create_user(email="own@example.com", password="OwnPass@12345", full_name="Own")
        payment = self.guest_payment(user=buyer)
        provision_paid_payment(payment)
        self.assertFalse(OutboxEvent.objects.filter(event_type=credential_delivery.EVENT_AUTO_SEND).exists())

    def test_outbox_handler_is_registered(self):
        from apps.core.outbox import registered_handlers

        self.assertIn(credential_delivery.EVENT_AUTO_SEND, registered_handlers())


class AdminCredentialTests(CredentialDeliveryBase):
    def setUp(self):
        super().setUp()
        self.admin_user = User.objects.create_superuser(
            email="cred-admin@example.com", password="StrongAdmin@123", full_name="Admin"
        )
        self.client.force_login(self.admin_user)

    def url(self, name, user):
        return reverse(f"admin:payments_successfulpaymentuser_{name}", args=[user.pk])

    def test_admin_generate_sends_email_and_offers_whatsapp_button(self):
        payment = self.provisioned()
        response = self.client.post(self.url("generate_credentials", payment.user), {"send": ["0", "1"]})
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        password = response.context["generated_password"]
        self.assertTrue(User.objects.get(pk=payment.user_id).check_password(password))
        self.assertEqual(mail.outbox[0].to, ["buyer1@example.com"])
        self.assertContains(response, "https://wa.me/919876543210?text=")
        delivery = CredentialDelivery.objects.get(user=payment.user)
        self.assertEqual(delivery.sent_by, self.admin_user)

    def test_admin_can_generate_without_sending(self):
        payment = self.provisioned()
        response = self.client.post(self.url("generate_credentials", payment.user), {"send": "0"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(CredentialDelivery.objects.exists())

    def test_admin_email_failure_is_shown_and_password_still_usable(self):
        payment = self.provisioned()
        with mock.patch("apps.payments.credential_delivery.EmailMessage.send", side_effect=OSError("auth failed")):
            response = self.client.post(self.url("generate_credentials", payment.user), {"send": "1"})
        self.assertContains(response, "auth failed")
        self.assertTrue(User.objects.get(pk=payment.user_id).check_password(response.context["generated_password"]))

    def test_mark_whatsapp_sent_records_delivery(self):
        payment = self.provisioned()
        response = self.client.post(self.url("mark_whatsapp", payment.user))
        self.assertEqual(response.status_code, 302)
        delivery = CredentialDelivery.objects.get(user=payment.user)
        self.assertEqual((delivery.channel, delivery.status, delivery.recipient), ("whatsapp", "sent", "919876543210"))
        self.assertEqual(self.client.get(self.url("mark_whatsapp", payment.user)).status_code, 302)
        self.assertEqual(CredentialDelivery.objects.count(), 1)

    def test_bulk_action_sends_to_awaiting_buyers_and_skips_issued(self):
        first = self.provisioned(1)
        second = self.provisioned(2)
        credential_delivery.auto_send_for_payment(second.pk)
        mail.outbox.clear()
        response = self.client.post(
            reverse("admin:payments_successfulpaymentuser_changelist"),
            {"action": "generate_and_send_credentials", "_selected_action": [first.user_id, second.user_id]},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual([m.to for m in mail.outbox], [["buyer1@example.com"]])
        self.assertEqual(len(response.context["results"]), 1)
        self.assertEqual([u.pk for u in response.context["skipped"]], [second.user_id])

    def test_changelist_status_and_filter(self):
        awaiting = self.provisioned(1)
        sent = self.provisioned(2)
        credential_delivery.auto_send_for_payment(sent.pk)
        changelist = reverse("admin:payments_successfulpaymentuser_changelist")
        response = self.client.get(changelist)
        self.assertContains(response, "Awaiting password")
        self.assertContains(response, "Sent (Email)")
        response = self.client.get(changelist, {"credentials": "awaiting"})
        self.assertContains(response, awaiting.user.email)
        self.assertNotContains(response, sent.user.email)
        response = self.client.get(changelist, {"credentials": "sent"})
        self.assertContains(response, sent.user.email)
        self.assertNotContains(response, awaiting.user.email)

    def test_non_staff_cannot_reach_new_endpoints(self):
        payment = self.provisioned()
        self.client.logout()
        self.assertEqual(self.client.post(self.url("mark_whatsapp", payment.user)).status_code, 302)
        self.assertFalse(CredentialDelivery.objects.exists())


class BackfillCommandTests(CredentialDeliveryBase):
    def test_dry_run_lists_and_apply_queues_once_per_buyer(self):
        payment = self.provisioned()
        OutboxEvent.objects.all().delete()
        out = StringIO()
        call_command("send_paid_credentials", stdout=out)
        self.assertIn(f"payment#{payment.pk}", out.getvalue())
        self.assertIn("buyers=1 queued=0", out.getvalue())
        self.assertFalse(OutboxEvent.objects.exists())
        call_command("send_paid_credentials", "--apply", stdout=StringIO())
        call_command("send_paid_credentials", "--apply", stdout=StringIO())
        self.assertEqual(OutboxEvent.objects.filter(event_type=credential_delivery.EVENT_AUTO_SEND).count(), 1)
