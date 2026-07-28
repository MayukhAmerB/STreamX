from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from apps.courses.models import Course
from apps.payments.models import Payment, SuccessfulPaymentUser


User = get_user_model()


class SuccessfulPaymentUserAdminTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(
            email="paid-admin@example.com",
            password="StrongAdmin@123",
            full_name="Paid Admin",
        )
        self.instructor = User.objects.create_user(
            email="paid-instructor@example.com",
            password="StrongInstructor@123",
            full_name="Paid Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        self.course = Course.objects.create(
            title="Paid Admin Course",
            description="Admin credential test course.",
            price=Decimal("3500.00"),
            instructor=self.instructor,
            is_published=True,
        )
        self.paid_user = User.objects.create_user(
            email="adl-0099@adlfront.com",
            password=None,
            full_name="Paid Student",
            phone_number="+919876543210",
        )
        self.paid_user.set_unusable_password()
        self.paid_user.save(update_fields=["password"])
        self.payment = Payment.objects.create(
            user=self.paid_user,
            course=self.course,
            user_email_snapshot=self.paid_user.email,
            course_id_snapshot=self.course.id,
            course_title_snapshot=self.course.title,
            buyer_name=self.paid_user.full_name,
            buyer_email="student-contact@example.com",
            whatsapp_number="+919876543210",
            alternate_number="+919123456789",
            razorpay_order_id="order_paid_admin_123",
            razorpay_payment_id="pay_paid_admin_123",
            invoice_number="ADL-202607-PAIDADMIN",
            amount=Decimal("3500.00"),
            currency="INR",
            status=Payment.STATUS_PAID,
            provisioning_status=Payment.PROVISION_AWAITING_ADMIN,
            paid_at=timezone.now(),
        )

    def test_separate_admin_list_shows_paid_account_and_requested_details(self):
        self.client.force_login(self.admin_user)
        response = self.client.get(
            reverse("admin:payments_successfulpaymentuser_changelist")
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, self.paid_user.email)
        self.assertContains(response, self.payment.buyer_email)
        self.assertContains(response, self.payment.whatsapp_number)
        self.assertContains(response, self.payment.razorpay_payment_id)
        self.assertContains(response, self.payment.invoice_number)
        self.assertContains(response, "Generate password")

    def test_user_without_successful_payment_is_not_listed(self):
        unpaid_user = User.objects.create_user(
            email="adl-unpaid@adlfront.com",
            password=None,
            full_name="Unpaid Student",
        )
        Payment.objects.create(
            user=unpaid_user,
            course=self.course,
            buyer_name=unpaid_user.full_name,
            buyer_email="unpaid-contact@example.com",
            whatsapp_number="+919999999999",
            razorpay_order_id="order_unpaid_admin_123",
            amount=Decimal("3500.00"),
            currency="INR",
            status=Payment.STATUS_CREATED,
        )
        self.client.force_login(self.admin_user)

        response = self.client.get(
            reverse("admin:payments_successfulpaymentuser_changelist")
        )

        self.assertNotContains(response, unpaid_user.email)

    def test_existing_account_with_successful_payment_is_not_listed(self):
        existing_user = User.objects.create_user(
            email="existing-student@example.com",
            password="ExistingStudent@123",
            full_name="Existing Student",
        )
        Payment.objects.create(
            user=existing_user,
            course=self.course,
            buyer_name=existing_user.full_name,
            buyer_email=existing_user.email,
            whatsapp_number="+919888888888",
            razorpay_order_id="order_existing_admin_123",
            razorpay_payment_id="pay_existing_admin_123",
            invoice_number="ADL-202607-EXISTING",
            amount=Decimal("3500.00"),
            currency="INR",
            status=Payment.STATUS_PAID,
            paid_at=timezone.now(),
        )
        self.client.force_login(self.admin_user)

        response = self.client.get(
            reverse("admin:payments_successfulpaymentuser_changelist")
        )

        self.assertNotContains(response, existing_user.email)

    def test_admin_can_generate_actual_account_password_for_paid_account(self):
        self.client.force_login(self.admin_user)
        url = reverse(
            "admin:payments_successfulpaymentuser_generate_credentials",
            args=[self.paid_user.pk],
        )

        confirmation = self.client.get(url)
        self.assertEqual(confirmation.status_code, 200)
        self.assertContains(confirmation, self.payment.razorpay_payment_id)

        response = self.client.post(url)
        self.assertEqual(response.status_code, 200)
        generated_password = response.context["generated_password"]
        self.assertEqual(len(generated_password), 12)

        self.paid_user.refresh_from_db()
        self.payment.refresh_from_db()
        self.assertTrue(self.paid_user.check_password(generated_password))
        self.assertContains(response, "actual account password")
        self.assertNotContains(response, "Temporary password")
        self.assertEqual(
            self.payment.provisioning_status,
            Payment.PROVISION_CREDENTIALS_ISSUED,
        )
        self.assertIsNotNone(self.payment.credentials_issued_at)
        self.assertNotIn(
            generated_password,
            str(self.payment.gateway_details),
        )

    def test_credential_endpoint_requires_admin_authentication(self):
        url = reverse(
            "admin:payments_successfulpaymentuser_generate_credentials",
            args=[self.paid_user.pk],
        )
        response = self.client.get(url)
        self.assertEqual(response.status_code, 302)
