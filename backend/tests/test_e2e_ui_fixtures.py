"""E2E fixtures for the UI overhaul quality specs (WS-I): ``admin-queues`` and
``features`` build real rows with the production models, report problems
instead of hiding them, and are idempotent per seed.

``apps.e2e_support`` is only installed by ``config.settings.e2e``; the fixture
module has no models, so it is exercised directly under the test settings.
"""

import tempfile

from django.test import TestCase, override_settings

from apps.e2e_support import ui_fixtures
from apps.e2e_support.seeding import seed

_MEDIA = tempfile.mkdtemp(prefix="e2e-ui-fixtures-")


@override_settings(MEDIA_ROOT=_MEDIA, CTF_ANSWER_PEPPER="e2e-pepper-0123456789abcdef0123456789abcdef")
class AdminQueuesFixtureTests(TestCase):
    def setUp(self):
        self.manifest = seed()

    def test_every_queue_row_is_created_with_production_models(self):
        from apps.courses.models import Enrollment, LectureQuestion, LiveClassEnrollment, PublicEnrollmentLead
        from apps.payments.models import Payment
        from apps.realtime.recording.models import ClassRecording
        from apps.recording_uploads.models import RecordingUpload
        from apps.reports.models import ReportSubmission

        result = ui_fixtures.admin_queues_fixture({})
        errors = {name: value for name, value in result["created"].items() if isinstance(value, dict) and "error" in value}
        self.assertEqual(errors, {})
        self.assertEqual(Enrollment.objects.filter(payment_status=Enrollment.STATUS_PENDING).count(), 1)
        self.assertEqual(LiveClassEnrollment.objects.filter(status=LiveClassEnrollment.STATUS_PENDING).count(), 1)
        self.assertEqual(PublicEnrollmentLead.objects.filter(status=PublicEnrollmentLead.STATUS_NEW).count(), 1)
        self.assertEqual(LectureQuestion.objects.filter(status=LectureQuestion.STATUS_NEW).count(), 1)
        self.assertEqual(ReportSubmission.objects.filter(status__in=ReportSubmission.AWAITING_GRADING).count(), 1)
        self.assertEqual(ClassRecording.objects.filter(needs_review=True).count(), 1)
        self.assertEqual(RecordingUpload.objects.filter(status=RecordingUpload.STATUS_FAILED).count(), 1)
        self.assertEqual(Payment.objects.filter(provisioning_status=Payment.PROVISION_AWAITING_ADMIN).count(), 1)

    def test_second_call_adds_nothing(self):
        from apps.courses.models import PublicEnrollmentLead

        ui_fixtures.admin_queues_fixture({})
        again = ui_fixtures.admin_queues_fixture({})
        self.assertTrue(again.get("already"))
        self.assertEqual(PublicEnrollmentLead.objects.count(), 1)

    def test_a_failing_row_is_reported_and_the_others_still_exist(self):
        from apps.courses.models import PublicEnrollmentLead

        original = PublicEnrollmentLead.objects.create

        def broken(**kwargs):
            raise RuntimeError("model drift")

        PublicEnrollmentLead.objects.create = broken
        try:
            result = ui_fixtures.admin_queues_fixture({})
        finally:
            PublicEnrollmentLead.objects.create = original
        self.assertIn("model drift", result["created"]["lead"]["error"])
        self.assertNotIn("error", result["created"]["enrolment_request"])


@override_settings(MEDIA_ROOT=_MEDIA, CTF_ANSWER_PEPPER="e2e-pepper-0123456789abcdef0123456789abcdef")
class FeaturesFixtureTests(TestCase):
    def setUp(self):
        seed()

    def test_set_goes_through_the_feature_service_and_reads_back(self):
        from apps.core import features

        with override_settings(FEATURE_DEFAULT_OVERRIDES={}):
            self.assertFalse(features.is_enabled("teaching"))
            on = ui_fixtures.features_fixture({"set": {"teaching": True}})
            self.assertTrue(on["features"]["teaching"])
            # Setting the current value again writes nothing and still answers.
            self.assertTrue(ui_fixtures.features_fixture({"set": {"teaching": True}})["features"]["teaching"])
            off = ui_fixtures.features_fixture({"set": {"teaching": False}})
            self.assertFalse(off["features"]["teaching"])

    def test_read_only_call_returns_the_snapshot(self):
        self.assertIn("teaching", ui_fixtures.features_fixture({})["features"])
