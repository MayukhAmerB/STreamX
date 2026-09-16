from datetime import date, timedelta
from decimal import Decimal
from io import StringIO

from apps.courses.admin import CourseAdminForm
from apps.courses.models import Course, Enrollment
from apps.courses.serializers import CourseDetailSerializer, CourseListSerializer
from apps.payments.models import Payment
from apps.payments.order_service import create_payment_order
from apps.payments.provisioning import provision_paid_payment
from apps.users.models import User
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone


class ProgramCatalogTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="program-test@example.com", password="test-only-password")

    def test_setup_preserves_existing_rows_and_admin_edits(self):
        original = Course.objects.create(title="Existing OSINT", description="Existing material", price=777)
        enrollment = Enrollment.objects.create(user=self.user, course=original, payment_status="paid")
        call_command("setup_course_experience", publish=True, stdout=StringIO())
        osint = Course.objects.get(slug="osint-professional-training-batch-iv")
        pentesting = Course.objects.get(slug="web-api-pentesting-six-month-2027")
        self.assertEqual(osint.duration, "3 months")
        self.assertEqual(osint.price, 0)
        self.assertFalse(osint.full_payment_enabled)
        self.assertFalse(osint.show_course_image)
        self.assertFalse(bool(osint.thumbnail_file))
        self.assertEqual(pentesting.sections.count(), 6)
        self.assertEqual(pentesting.total_classes, 48)
        self.assertEqual(pentesting.start_date, date(2027, 1, 1))
        self.assertEqual(pentesting.monthly_price * pentesting.installments_required, Decimal("25794"))
        osint.price = 4999
        osint.card_title = "Admin course title"
        osint.show_course_image = True
        osint.save()
        call_command("setup_course_experience", publish=True, stdout=StringIO())
        osint.refresh_from_db()
        original.refresh_from_db()
        enrollment.refresh_from_db()
        self.assertEqual(osint.price, 4999)
        self.assertEqual(osint.card_title, "Admin course title")
        self.assertTrue(osint.show_course_image)
        self.assertEqual(original.price, 777)
        self.assertEqual(enrollment.payment_status, "paid")

    @override_settings(DIRECT_COURSE_PAYMENTS_ENABLED=True)
    def test_admin_prices_and_card_content_reach_course_api(self):
        countdown_end = timezone.now() + timedelta(days=14)
        course = Course.objects.create(
            title="Course",
            description="Details",
            price=6999,
            monthly_price=1250,
            card_title="Research",
            card_highlights=["Admin bullet"],
            is_published=True,
            bundle_payment_enabled=True,
            bundle_price=3000,
            hero_countdown_end_at=countdown_end,
            hero_countdown_label="Batch enrollment closes in",
        )
        data = CourseDetailSerializer(course, context={}).data
        list_data = CourseListSerializer(course, context={}).data
        self.assertEqual(data["price"], "6999.00")
        self.assertEqual(data["bundle_price"], "3000.00")
        self.assertEqual(data["card_title"], "Research")
        self.assertEqual(data["card_highlights"], ["Admin bullet"])
        self.assertEqual(data["hero_countdown_label"], "Batch enrollment closes in")
        self.assertIsNotNone(data["hero_countdown_end_at"])
        self.assertEqual(list_data["hero_countdown_label"], "Batch enrollment closes in")
        self.assertIsNotNone(list_data["hero_countdown_end_at"])
        self.assertFalse(data["show_course_image"])
        admin_form = CourseAdminForm(instance=course)
        self.assertEqual(admin_form.fields["card_highlights"].initial, "Admin bullet")
        self.assertIn("homepage countdown", admin_form.fields["hero_countdown_end_at"].help_text.lower())

    def test_bundle_snapshots_terms_handles_future_start_and_retries(self):
        course = Course.objects.create(
            title="Bundle",
            description="Details",
            price=18999,
            bundle_price=10999,
            bundle_payment_enabled=True,
            start_date=timezone.now().date() + timedelta(days=60),
        )
        result = create_payment_order(
            user=self.user,
            course=course,
            amount=10999,
            amount_paise=1099900,
            plan="bundle",
            checkout_profile={
                "buyer_name": "Test Student",
                "buyer_email": self.user.email,
                "whatsapp_number": "+919876543210",
            },
            gateway_create_order=lambda **kwargs: {"id": "order_bundle1", "currency": "INR"},
        )
        payment = result.payment
        self.assertEqual(payment.terms_snapshot["installments"], 2)
        course.bundle_access_days = 1
        course.bundle_installments = 10
        course.save()
        payment.status = "paid"
        payment.razorpay_payment_id = "pay_bundle1"
        payment.save()
        enrollment = provision_paid_payment(payment)
        self.assertEqual(enrollment.access_expires_at.date(), course.start_date + timedelta(days=90))
        expiry = enrollment.access_expires_at
        provision_paid_payment(payment)
        enrollment.refresh_from_db()
        self.assertEqual(enrollment.access_expires_at, expiry)
        second = Payment.objects.create(
            user=self.user,
            course=course,
            amount=10999,
            plan="bundle",
            status="paid",
            razorpay_payment_id="pay_bundle2",
            terms_snapshot=payment.terms_snapshot,
        )
        provision_paid_payment(second)
        enrollment.refresh_from_db()
        self.assertEqual(enrollment.access_type, "lifetime")
        self.assertIsNone(enrollment.access_expires_at)

    def test_installment_never_downgrades_existing_permanent_access(self):
        course = Course.objects.create(title="Legacy", description="Existing course", price=100)
        enrollment = Enrollment.objects.create(
            user=self.user, course=course, payment_status="paid", access_type="legacy"
        )
        payment = Payment.objects.create(
            user=self.user,
            course=course,
            amount=10,
            plan="monthly",
            status="paid",
            razorpay_payment_id="pay_keep_access",
        )
        provision_paid_payment(payment)
        enrollment.refresh_from_db()
        self.assertEqual(enrollment.access_type, "lifetime")
        self.assertIsNone(enrollment.access_expires_at)
