from datetime import date, timedelta
from decimal import Decimal
from importlib import import_module
from io import StringIO

from apps.courses.admin import CourseAdminForm
from apps.courses.models import Course, Enrollment, Lecture, LectureProgress, Section
from apps.courses.serializers import CourseDetailSerializer, CourseListSerializer
from apps.payments.models import Payment
from apps.payments.order_service import create_payment_order
from apps.payments.provisioning import provision_paid_payment
from apps.users.models import User
from django.apps import apps
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
        self.assertEqual(len(osint.public_curriculum), 10)
        self.assertEqual(len(osint.expected_outcomes), 6)
        self.assertEqual(osint.price, 0)
        self.assertFalse(osint.full_payment_enabled)
        self.assertFalse(osint.show_course_image)
        self.assertFalse(bool(osint.thumbnail_file))
        self.assertEqual(pentesting.sections.count(), 6)
        self.assertEqual(pentesting.total_classes, 48)
        self.assertEqual(pentesting.start_date, date(2027, 1, 1))
        self.assertEqual(pentesting.launch_status, Course.STATUS_COMING_SOON)
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

    def test_pentesting_status_migration_only_updates_the_named_program(self):
        pentesting = Course.objects.create(
            slug="web-api-pentesting-six-month-2027",
            title="Pentesting",
            description="Web security",
            price=18999,
            category=Course.CATEGORY_WEB_PENTESTING,
            launch_status=Course.STATUS_LIVE,
        )
        other_course = Course.objects.create(
            slug="another-pentesting-course",
            title="Another Pentesting Course",
            description="Another web security program",
            price=5000,
            category=Course.CATEGORY_WEB_PENTESTING,
            launch_status=Course.STATUS_LIVE,
        )

        migration = import_module(
            "apps.courses.migrations.0030_mark_pentesting_program_coming_soon"
        )
        migration.mark_pentesting_program_coming_soon(apps, None)

        pentesting.refresh_from_db()
        other_course.refresh_from_db()
        self.assertEqual(pentesting.launch_status, Course.STATUS_COMING_SOON)
        self.assertEqual(other_course.launch_status, Course.STATUS_LIVE)

    def test_osint_enrichment_migration_preserves_videos_progress_access_and_prices(self):
        osint = Course.objects.create(
            slug="osint-professional-training-batch-iv",
            title="OSINT Batch IV",
            description="Short description",
            price=Decimal("4321.00"),
            monthly_price=Decimal("987.00"),
            is_published=True,
        )
        section = Section.objects.create(course=osint, title="Existing video module", order=1)
        lecture = Lecture.objects.create(
            section=section,
            title="Existing production video",
            video_key="courses/existing-production-video.mp4",
        )
        enrollment = Enrollment.objects.create(
            user=self.user,
            course=osint,
            payment_status=Enrollment.STATUS_PAID,
        )
        progress = LectureProgress.objects.create(
            user=self.user,
            lecture=lecture,
            last_position_seconds=918,
            max_position_seconds=918,
            duration_seconds=2481,
        )

        migration = import_module("apps.courses.migrations.0032_course_public_curriculum")
        migration.enrich_osint_batch_four(apps, None)

        osint.refresh_from_db()
        lecture.refresh_from_db()
        progress.refresh_from_db()
        self.assertEqual(len(osint.public_curriculum), 10)
        self.assertEqual(len(osint.expected_outcomes), 6)
        self.assertEqual(osint.price, Decimal("4321.00"))
        self.assertEqual(osint.monthly_price, Decimal("987.00"))
        self.assertEqual(lecture.video_key, "courses/existing-production-video.mp4")
        self.assertEqual(progress.last_position_seconds, 918)
        self.assertEqual(progress.max_position_seconds, 918)
        self.assertEqual(progress.duration_seconds, 2481)
        self.assertTrue(Enrollment.objects.filter(pk=enrollment.pk).exists())

    def test_curriculum_repair_only_fills_empty_osint_batch_four_records(self):
        empty_course = Course.objects.create(
            slug="production-osint-batch-four",
            title="OSINT PROFESSIONAL TRAINING PROGRAM (BATCH IV)",
            batch="Batch IV",
            category=Course.CATEGORY_OSINT,
            description="Existing production description",
            price=Decimal("3500.00"),
            public_curriculum=[],
        )
        preserved_course = Course.objects.create(
            slug="admin-managed-osint-batch-four",
            title="OSINT Batch IV Admin Curriculum",
            batch="Batch IV",
            category=Course.CATEGORY_OSINT,
            description="Admin managed",
            price=Decimal("3500.00"),
            public_curriculum=[
                {
                    "title": "Admin module",
                    "description": "Keep this content",
                    "topics": ["Admin topic"],
                }
            ],
        )
        section = Section.objects.create(course=empty_course, title="Existing videos", order=1)
        lecture = Lecture.objects.create(
            section=section,
            title="Existing production recording",
            video_key="courses/keep-this-video.mp4",
        )

        migration = import_module(
            "apps.courses.migrations.0033_fill_empty_osint_batch_four_curriculum"
        )
        migration.fill_empty_osint_batch_four_curriculum(apps, None)

        empty_course.refresh_from_db()
        preserved_course.refresh_from_db()
        lecture.refresh_from_db()
        self.assertEqual(len(empty_course.public_curriculum), 10)
        self.assertEqual(empty_course.price, Decimal("3500.00"))
        self.assertEqual(
            preserved_course.public_curriculum,
            [
                {
                    "title": "Admin module",
                    "description": "Keep this content",
                    "topics": ["Admin topic"],
                }
            ],
        )
        self.assertEqual(lecture.video_key, "courses/keep-this-video.mp4")

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
