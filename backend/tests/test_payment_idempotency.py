from datetime import timedelta
from types import SimpleNamespace

from apps.payments.idempotency import (
    IdempotencyConflict,
    claim_create_order,
    complete_claim,
)
from apps.payments.models import PaymentIdempotencyRecord
from django.test import TestCase, override_settings
from django.utils import timezone


@override_settings(PAYMENT_IDEMPOTENCY_LEASE_SECONDS=60)
class PaymentIdempotencyLeaseTests(TestCase):
    def setUp(self):
        self.user = SimpleNamespace(is_authenticated=True, pk=42)
        self.buyer_email = "buyer@example.com"
        self.request_payload = {
            "course_id": 19,
            "plan": "full",
            "buyer_name": "Test Buyer",
            "buyer_email": self.buyer_email,
            "whatsapp_number": "+91 98765 43210",
            "server_amount": "3500.00",
            "currency": "INR",
        }
        self.raw_key = "checkout-processing-lease-0001"

    def claim(self):
        return claim_create_order(
            raw_key=self.raw_key,
            user=self.user,
            buyer_email=self.buyer_email,
            request_payload=self.request_payload,
        )

    def test_stale_processing_claim_is_reclaimed_and_fences_the_previous_owner(self):
        previous_owner = self.claim()
        PaymentIdempotencyRecord.objects.filter(pk=previous_owner.record.pk).update(
            updated_at=timezone.now() - timedelta(days=1)
        )

        reclaimed_owner = self.claim()

        self.assertFalse(reclaimed_owner.replay)
        self.assertEqual(reclaimed_owner.record.pk, previous_owner.record.pk)

        self.assertFalse(complete_claim(
            previous_owner,
            payment=None,
            response_payload={"success": False, "message": "late former owner"},
            response_status=503,
        ))
        reclaimed_owner.record.refresh_from_db()
        self.assertEqual(
            reclaimed_owner.record.status,
            PaymentIdempotencyRecord.STATUS_PROCESSING,
        )

        self.assertTrue(complete_claim(
            reclaimed_owner,
            payment=None,
            response_payload={"success": True, "message": "reclaimed owner completed"},
            response_status=201,
        ))
        reclaimed_owner.record.refresh_from_db()
        self.assertEqual(
            reclaimed_owner.record.status,
            PaymentIdempotencyRecord.STATUS_COMPLETED,
        )
        self.assertEqual(reclaimed_owner.record.response_status, 201)
        self.assertEqual(
            reclaimed_owner.record.response_payload["message"],
            "reclaimed owner completed",
        )

    def test_fresh_processing_claim_remains_exclusive(self):
        self.claim()

        with self.assertRaisesRegex(
            IdempotencyConflict,
            "already being processed",
        ):
            self.claim()
