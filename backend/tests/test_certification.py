"""Automatic certification (apps.certification): pass/fail rules and idempotency,
re-grade with audit and staff-confirmed revocation, certificate + letter,
e-mail delivery with both PDFs, the WhatsApp provider (mocked HTTP: success,
failure, retry, disabled), consent and opt-out, no double send, staff resend,
and the Hall of Fame (auto-add, opt-out, staff hide, handles only: never a
real name or e-mail)."""

from __future__ import annotations

import io
import json
from decimal import Decimal
from unittest import mock

from apps.certification import delivery as delivery_module
from apps.certification import grading, hall_of_fame, letter, services, sweep, whatsapp
from apps.certification.models import (
    CertificateDelivery,
    CertificationAudit,
    CertificationDecision,
    CertificationPreferences,
    ExamCertificationPolicy,
    HallOfFameAudit,
    HallOfFameEntry,
)
from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.ctf import services as ctf_services
from apps.ctf.answers import hash_answers
from apps.ctf.models import CtfParticipation
from apps.engagement.models import Certificate
from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from tests import factories as f

PEPPER = "certification-test-pepper-0123456789abcdefghij"
WA = {
    "WHATSAPP_CLOUD_API_TOKEN": "test-token",
    "WHATSAPP_PHONE_NUMBER_ID": "1234567890",
    "WHATSAPP_TEMPLATE_CERTIFICATE": "asi_certificate_issued",
    "WHATSAPP_TEMPLATE_LETTER": "asi_congratulations_letter",
}
NO_WA = {key: "" for key in WA}


class FakeTransport:
    """Records calls; answers from a script of (status, body) or exceptions."""

    def __init__(self, script=None):
        self.calls = []
        self.script = list(script or [])
        self.counter = 0

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        if self.script:
            item = self.script.pop(0)
            if isinstance(item, Exception):
                raise item
            status, payload = item
            return status, json.dumps(payload).encode()
        self.counter += 1
        if url.endswith("/media"):
            return 200, json.dumps({"id": f"media-{self.counter}"}).encode()
        return 200, json.dumps({"messages": [{"id": f"wamid.{self.counter}"}]}).encode()


@override_settings(CTF_ANSWER_PEPPER=PEPPER, **NO_WA)
class CertificationBase(TestCase):
    def setUp(self):
        cache.clear()
        mail.outbox = []
        self.course = f.make_course(title="OSINT Batch 7", batch="7")
        self.exam = f.make_ctf_exam(eligible_courses=[self.course], slug="osint-certification", title="OSINT Certification Exam")
        # 10 questions x 100 points: 7 solved = 70 %.
        self.questions = [
            f.make_ctf_question(exam=self.exam, key=f"q{i}", order=i, points=100, answers=[f"answer {i}"],
                                category="geoint" if i <= 5 else "socmint")
            for i in range(1, 11)
        ]
        self.policy = ExamCertificationPolicy.objects.create(exam=self.exam)
        self.student = self.make_student("Asha Rao", phone="+91 98765 43210")

    def make_student(self, name, *, phone="", email=None):
        user = f.make_user(full_name=name, phone_number=phone, **({"email": email} if email else {}))
        f.make_enrollment(user=user, course=self.course)
        return user

    def sit(self, user, solved, *, wrong=(), finish=True):
        ctf_services.start_participation(exam=self.exam, user=user)
        for index in wrong:
            ctf_services.submit_attempt(exam=self.exam, user=user, question_key=f"q{index}", answer="nope")
        for index in solved:
            ctf_services.submit_attempt(exam=self.exam, user=user, question_key=f"q{index}", answer=f"answer {index}")
        if finish:
            ctf_services.finish_participation(exam=self.exam, user=user)
        return CtfParticipation.objects.get(exam=self.exam, user=user)

    def drain(self, rounds=5):
        for _ in range(rounds):
            stats = drain_outbox(batch_size=100)
            if not stats["claimed"]:
                break

    def decision(self, user=None):
        return CertificationDecision.objects.get(exam=self.exam, user=user or self.student)

    def profile(self, user, handle, *, public=True):
        from apps.profiles.models import StudentProfile

        return StudentProfile.objects.create(
            user=user,
            handle=handle,
            visibility=StudentProfile.VISIBILITY_PUBLIC if public else StudentProfile.VISIBILITY_MEMBERS,
            published_at=timezone.now() if public else None,
        )


# --- decision rules ------------------------------------------------------------------------------------
class DecisionRuleTests(CertificationBase):
    def test_exact_pass_mark_passes_and_issues_a_certificate(self):
        self.sit(self.student, range(1, 8))
        self.drain()
        decision = self.decision()
        self.assertEqual(decision.outcome, "passed")
        self.assertEqual(decision.percent, Decimal("70.00"))
        self.assertEqual(decision.band, "Pass")
        certificate = decision.certificate
        self.assertRegex(certificate.reference, r"^ASI-\d{4}-OSINT-\d{6,}-[0-9A-Z]$")
        self.assertEqual(certificate.recipient_name, "Asha Rao")
        self.assertEqual(certificate.title, "OSINT Certification Exam")
        self.assertIn("Batch 7", certificate.programme)
        self.assertTrue(certificate.is_valid)
        self.assertTrue(CertificationAudit.objects.filter(decision=decision, action="decided").exists())

    def test_below_pass_mark_fails_without_certificate(self):
        self.sit(self.student, range(1, 7))
        self.drain()
        decision = self.decision()
        self.assertEqual(decision.outcome, "failed")
        self.assertIsNone(decision.certificate)
        self.assertEqual(Certificate.objects.count(), 0)
        self.assertEqual(CertificateDelivery.objects.count(), 0)
        self.assertFalse(HallOfFameEntry.objects.filter(source="auto").exists())

    def test_configurable_pass_mark_and_distinction_band(self):
        self.policy.pass_mark_percent = Decimal("90")
        self.policy.save()
        other = self.make_student("Bilal Khan")
        self.sit(self.student, range(1, 9))  # 80 %
        self.sit(other, range(1, 11))  # 100 %
        self.drain()
        self.assertEqual(self.decision().outcome, "failed")
        self.assertEqual(self.decision(other).outcome, "passed")
        self.assertEqual(self.decision(other).band, "Distinction")

    def test_section_minimum_can_fail_an_overall_pass(self):
        self.policy.section_minimums = {"socmint": 60}
        self.policy.full_clean()
        self.policy.save()
        self.sit(self.student, [1, 2, 3, 4, 5, 6, 7])  # 70 % overall, socmint 2/5 = 40 %
        self.drain()
        decision = self.decision()
        self.assertEqual(decision.outcome, "failed")
        self.assertFalse(decision.sections["socmint"]["met"])
        self.assertTrue(any("socmint" in reason for reason in decision.reasons))

    def test_policy_validation_rejects_unknown_sections(self):
        from django.core.exceptions import ValidationError

        self.policy.section_minimums = {"astrology": 50}
        with self.assertRaises(ValidationError):
            self.policy.full_clean()

    def test_one_decision_per_student_even_when_triggered_repeatedly(self):
        participation = self.sit(self.student, range(1, 9))
        self.drain()
        for _ in range(3):
            services.decide_participation(participation.pk)
            services.queue_decision(participation.pk)
            sweep.run_sweep()
        self.drain()
        self.assertEqual(CertificationDecision.objects.count(), 1)
        self.assertEqual(Certificate.objects.count(), 1)
        self.assertEqual(CertificateDelivery.objects.filter(channel="email").count(), 1)
        self.assertEqual(len(mail.outbox), 1)

    def test_active_participation_is_not_decided_and_staff_preview_never(self):
        participation = self.sit(self.student, range(1, 9), finish=False)
        self.assertIsNone(services.decide_participation(participation.pk))
        admin = f.make_admin()
        ctf_services.start_participation(exam=self.exam, user=admin)
        ctf_services.finish_participation(exam=self.exam, user=admin)
        self.drain()
        sweep.run_sweep()
        self.assertFalse(CertificationDecision.objects.exists())

    def test_exam_without_policy_is_untouched(self):
        self.policy.is_enabled = False
        self.policy.save()
        self.sit(self.student, range(1, 11))
        self.drain()
        sweep.run_sweep()
        self.assertFalse(CertificationDecision.objects.exists())
        self.assertFalse(OutboxEvent.objects.filter(event_type=services.EVENT_DECIDE).exists())

    def test_sweep_decides_participations_expired_in_bulk(self):
        participation = self.sit(self.student, range(1, 9), finish=False)
        # The CTF scheduler expires with .update() (no signal): the sweep catches it.
        CtfParticipation.objects.filter(pk=participation.pk).update(status="expired")
        self.assertIsNotNone(sweep.schedule_sweep())
        self.drain()
        self.assertEqual(self.decision().outcome, "passed")
        self.assertIsNone(sweep.schedule_sweep())

    def test_window_closing_decides_active_students(self):
        participation = self.sit(self.student, range(1, 9), finish=False)
        self.exam.closes_at = timezone.now() - timezone.timedelta(seconds=1)
        self.exam.opens_at = timezone.now() - timezone.timedelta(hours=2)
        self.exam.save()
        self.assertEqual(sweep.run_sweep(), 1)
        self.assertEqual(self.decision().participation_id, participation.pk)

    def test_hook_is_fail_safe(self):
        with mock.patch("apps.certification.services.queue_decision", side_effect=RuntimeError("boom")):
            participation = self.sit(self.student, range(1, 9))
        self.assertEqual(participation.status, "submitted")
        sweep.run_sweep()
        self.assertEqual(self.decision().outcome, "passed")


# --- re-grade ------------------------------------------------------------------------------------------
class RegradeTests(CertificationBase):
    def correct_key(self, question, answers):
        question.answer_hashes = hash_answers(self.exam.slug, question.key, answers, question.normalization)
        question.save(update_fields=["answer_hashes"])

    def test_answer_key_correction_upgrades_fail_to_pass(self):
        self.sit(self.student, range(1, 7), wrong=[7])  # 60 %, answered "nope" on q7
        self.drain()
        self.assertEqual(self.decision().outcome, "failed")
        self.correct_key(self.questions[6], ["answer 7", "nope"])
        stats = services.regrade_exam(self.exam, actor=f.make_admin(), reason="Q7 also accepts nope")
        self.assertEqual(stats["upgraded"], 1)
        decision = self.decision()
        self.assertEqual(decision.outcome, "passed")
        self.assertEqual(decision.revision, 2)
        self.assertIsNotNone(decision.certificate)
        actions = list(decision.audit.values_list("action", flat=True))
        self.assertIn("regraded", actions)
        self.assertIn("certificate_issued", actions)

    def test_pass_to_fail_is_flagged_until_staff_confirm(self):
        self.sit(self.student, range(1, 8))  # 70 %
        self.drain()
        self.profile(self.student, "asha_r")
        certificate = self.decision().certificate
        self.correct_key(self.questions[0], ["a corrected answer"])
        stats = services.regrade_exam(self.exam, reason="Q1 key was wrong")
        self.assertEqual(stats["flagged"], 1)
        decision = self.decision()
        self.assertEqual(decision.outcome, "passed")
        self.assertEqual(decision.review_state, "revocation_pending")
        certificate.refresh_from_db()
        self.assertTrue(certificate.is_valid, "no revocation without staff confirmation")

        staff = f.make_admin()
        client = APIClient()
        client.force_authenticate(staff)
        response = client.post(f"/api/certification/staff/decisions/{decision.pk}/confirm-revocation/",
                               {"reason": "Q1 key corrected; below pass mark"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        decision.refresh_from_db()
        certificate.refresh_from_db()
        self.assertEqual(decision.outcome, "failed")
        self.assertFalse(certificate.is_valid)
        self.assertTrue(HallOfFameEntry.objects.get(certificate=certificate).is_hidden)
        self.assertIn("revocation_confirmed", list(decision.audit.values_list("action", flat=True)))
        self.assertTrue(certificate.revisions.filter(action="revoke").exists())
        self.assertNotIn("asha_r", json.dumps(hall_of_fame.public_payload()))

    def test_dismissed_revocation_keeps_the_certificate(self):
        self.sit(self.student, range(1, 8))
        self.drain()
        self.correct_key(self.questions[0], ["other"])
        services.regrade_exam(self.exam)
        decision = services.dismiss_revocation(self.decision(), actor=f.make_admin(), reason="Old key was right")
        self.assertEqual(decision.review_state, "")
        self.assertTrue(decision.certificate.is_valid)

    def test_regrade_refuses_with_a_mismatched_answer_key(self):
        self.sit(self.student, range(1, 8))
        self.drain()
        with override_settings(CTF_ANSWER_PEPPER="another-pepper-0123456789abcdefghijklmnop"):
            with self.assertRaises(grading.AnswerKeyMismatch):
                services.regrade_exam(self.exam)

    def test_students_cannot_use_staff_endpoints(self):
        client = APIClient()
        client.force_authenticate(self.student)
        response = client.post(f"/api/certification/staff/exams/{self.exam.slug}/regrade/", {}, format="json")
        self.assertEqual(response.status_code, 403)


# --- certificate, letter and e-mail ----------------------------------------------------------------------
class DeliveryTests(CertificationBase):
    def test_email_carries_html_and_both_pdfs_once(self):
        self.sit(self.student, range(1, 10))
        self.drain()
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.to, [self.student.email])
        self.assertIn("certified", message.subject)
        html = message.alternatives[0][0]
        self.assertIn("Asha Rao", html)
        reference = self.decision().certificate.reference
        self.assertIn(reference, html)
        self.assertIn(f"/certificates/{reference}", html)
        names = [attachment[0] for attachment in message.attachments]
        self.assertEqual(names, [f"{reference}-certificate.pdf", f"{reference}-congratulations-letter.pdf"])
        for _name, content, mime in message.attachments:
            self.assertEqual(mime, "application/pdf")
            self.assertTrue(content.startswith(b"%PDF-1.4"))
        row = CertificateDelivery.objects.get(channel="email")
        self.assertEqual(row.status, "sent")
        self.assertEqual(row.idempotency_key, f"{reference}:email")
        # Re-delivering the same round is a no-op: never twice.
        self.assertEqual(delivery_module.deliver(row.pk, row.round), "noop")
        services.plan_deliveries(row.decision, row.certificate)
        self.drain()
        self.assertEqual(len(mail.outbox), 1)

    def test_letter_pdf_is_searchable_and_mentions_the_essentials(self):
        self.sit(self.student, range(1, 10))
        self.drain()
        certificate = self.decision().certificate
        facts = letter.facts_for(certificate, exam_title=self.exam.title, band="Merit", listed_in_hall_of_fame=True)
        pdf = letter.letter_pdf(facts)
        self.assertTrue(pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF"))
        for needle in (b"Asha Rao", certificate.reference.encode(), b"Merit", b"Al Syed Initiative", b"Verify this certificate"):
            self.assertIn(needle, pdf)
        self.assertGreater(len(letter.letter_png(facts)), 10_000)

    def test_smtp_failure_retries_then_fails_and_staff_can_resend(self):
        with mock.patch("django.core.mail.EmailMultiAlternatives.send", side_effect=OSError("smtp down")):
            self.sit(self.student, range(1, 10))
            self.drain(rounds=2)
            row = CertificateDelivery.objects.get(channel="email")
            self.assertEqual(row.status, "retrying")
            self.assertIn("smtp down", row.last_error)
            event = OutboxEvent.objects.get(event_type=services.EVENT_DELIVER)
            self.assertEqual(event.status, "pending")
            self.assertGreater(event.available_at, timezone.now())
            self.assertEqual(delivery_module.deliver.__name__, "deliver")
            with self.assertRaises(OSError):
                delivery_module.deliver(row.pk, row.round, final_attempt=True)
        row.refresh_from_db()
        self.assertEqual(row.status, "failed")
        staff = f.make_admin()
        client = APIClient()
        client.force_authenticate(staff)
        response = client.post(f"/api/certification/staff/deliveries/{row.pk}/resend/", {"reason": "SMTP fixed"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.drain()
        row.refresh_from_db()
        self.assertEqual((row.status, row.round), ("sent", 2))
        self.assertEqual(len(mail.outbox), 1)
        self.assertTrue(CertificationAudit.objects.filter(action="delivery_resent").exists())

    def test_resend_never_overrides_whatsapp_opt_out(self):
        CertificationPreferences.objects.create(user=self.student, whatsapp_opt_out=True)
        with override_settings(**WA):
            self.sit(self.student, range(1, 10))
            self.drain()
            row = CertificateDelivery.objects.get(channel="whatsapp")
            self.assertEqual((row.status, row.skip_reason), ("skipped", "opted_out"))
            from apps.core.errors import ValidationFailed

            with self.assertRaises(ValidationFailed):
                services.resend(row, actor=f.make_admin(), reason="try again")

    def test_my_letter_endpoint_is_owner_only(self):
        self.sit(self.student, range(1, 10))
        self.drain()
        reference = self.decision().certificate.reference
        client = APIClient()
        client.force_authenticate(self.student)
        response = client.get(f"/api/certification/me/letters/{reference}/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.content.startswith(b"%PDF"))
        mine = client.get("/api/certification/me/").json()["data"]["results"]
        self.assertEqual(mine[0]["certificate"]["reference"], reference)
        client.force_authenticate(self.make_student("Other Person"))
        self.assertEqual(client.get(f"/api/certification/me/letters/{reference}/").status_code, 404)


# --- WhatsApp provider -----------------------------------------------------------------------------------
@override_settings(**WA)
class WhatsAppTests(CertificationBase):
    def pass_exam(self):
        self.sit(self.student, range(1, 10))
        # Run only the decision; deliveries are sent by hand with a fake transport.
        for event in OutboxEvent.objects.filter(event_type=services.EVENT_DECIDE):
            services.decide_participation(event.payload["participation_id"])
        return CertificateDelivery.objects.get(channel="whatsapp")

    def test_success_sends_both_documents_with_template_parameters(self):
        row = self.pass_exam()
        self.assertEqual(row.status, "queued")
        transport = FakeTransport()
        provider = whatsapp.provider_from_settings(transport=transport)
        self.assertEqual(delivery_module.deliver(row.pk, row.round, provider=provider), "sent")
        row.refresh_from_db()
        self.assertEqual(row.status, "sent")
        self.assertEqual(set(row.provider_parts), {"certificate", "letter"})
        self.assertEqual(row.provider_message_id, row.provider_parts["certificate"])
        urls = [call["url"] for call in transport.calls]
        self.assertEqual(urls, [
            "https://graph.facebook.com/v21.0/1234567890/media",
            "https://graph.facebook.com/v21.0/1234567890/messages",
        ] * 2)
        self.assertEqual(transport.calls[0]["headers"]["Authorization"], "Bearer test-token")
        message = json.loads(transport.calls[1]["body"])
        self.assertEqual(message["to"], "919876543210")
        self.assertEqual(message["template"]["name"], "asi_certificate_issued")
        header = message["template"]["components"][0]["parameters"][0]
        self.assertEqual(header["type"], "document")
        self.assertTrue(header["document"]["filename"].endswith("-certificate.pdf"))
        body = [p["text"] for p in message["template"]["components"][1]["parameters"]]
        self.assertEqual(body[0], "Asha Rao")
        self.assertIn(row.certificate.reference, body)
        self.assertEqual(json.loads(transport.calls[3]["body"])["template"]["name"], "asi_congratulations_letter")
        # Never twice.
        self.assertEqual(delivery_module.deliver(row.pk, row.round, provider=provider), "noop")
        self.assertEqual(len(transport.calls), 4)

    def test_server_error_retries_and_only_missing_parts_are_resent(self):
        row = self.pass_exam()
        script = [(200, {"id": "m1"}), (200, {"messages": [{"id": "wamid.cert"}]}), (200, {"id": "m2"}),
                  (503, {"error": {"code": 131016, "message": "Service unavailable"}})]
        provider = whatsapp.provider_from_settings(transport=FakeTransport(script))
        with self.assertRaises(whatsapp.WhatsAppError):
            delivery_module.deliver(row.pk, row.round, provider=provider)
        row.refresh_from_db()
        self.assertEqual(row.status, "retrying")
        self.assertEqual(row.provider_parts, {"certificate": "wamid.cert"})
        transport = FakeTransport()
        self.assertEqual(delivery_module.deliver(row.pk, row.round, provider=whatsapp.provider_from_settings(transport=transport)), "sent")
        self.assertEqual(len(transport.calls), 2, "the certificate is not sent again")
        row.refresh_from_db()
        self.assertEqual(set(row.provider_parts), {"certificate", "letter"})

    def test_network_error_is_retryable_and_final_attempt_fails(self):
        row = self.pass_exam()
        provider = whatsapp.provider_from_settings(transport=FakeTransport([TimeoutError("slow")]))
        with self.assertRaises(whatsapp.WhatsAppError) as ctx:
            delivery_module.deliver(row.pk, row.round, provider=provider, final_attempt=True)
        self.assertTrue(ctx.exception.retryable)
        row.refresh_from_db()
        self.assertEqual(row.status, "failed")

    def test_client_error_is_permanent(self):
        from apps.core.outbox import PermanentFailure

        row = self.pass_exam()
        provider = whatsapp.provider_from_settings(
            transport=FakeTransport([(400, {"error": {"code": 132001, "message": "Template does not exist"}})])
        )
        with self.assertRaises(PermanentFailure):
            delivery_module.deliver(row.pk, row.round, provider=provider)
        row.refresh_from_db()
        self.assertEqual(row.status, "failed")
        self.assertIn("Template does not exist", row.last_error)

    def test_outbox_retries_with_backoff(self):
        row = self.pass_exam()
        with mock.patch.object(whatsapp, "urllib_transport", FakeTransport([(500, {})] * 4)):
            drain_outbox(batch_size=100)
        row.refresh_from_db()
        self.assertEqual(row.status, "retrying")
        event = OutboxEvent.objects.get(event_type=services.EVENT_DELIVER, payload__delivery_id=row.pk)
        self.assertEqual((event.status, event.attempts), ("pending", 1))
        self.assertGreater(event.available_at, timezone.now())

    @override_settings(**NO_WA)
    def test_disabled_until_configured_never_fakes_success(self):
        self.assertIsNone(whatsapp.provider_from_settings())
        self.sit(self.student, range(1, 10))
        self.drain()
        row = CertificateDelivery.objects.get(channel="whatsapp")
        self.assertEqual((row.status, row.skip_reason, row.provider_message_id), ("skipped", "whatsapp_not_configured", ""))
        self.assertEqual(CertificateDelivery.objects.get(channel="email").status, "sent")

    def test_no_phone_or_opt_out_means_no_whatsapp(self):
        no_phone = self.make_student("No Phone")
        opted = self.make_student("Opted Out", phone="9876500000")
        CertificationPreferences.objects.create(user=opted, whatsapp_opt_out=True)
        self.sit(no_phone, range(1, 10))
        self.sit(opted, range(1, 10))
        for event in OutboxEvent.objects.filter(event_type=services.EVENT_DECIDE):
            services.decide_participation(event.payload["participation_id"])
        self.assertEqual(CertificateDelivery.objects.get(user=no_phone, channel="whatsapp").skip_reason, "no_phone")
        self.assertEqual(CertificateDelivery.objects.get(user=opted, channel="whatsapp").skip_reason, "opted_out")

    def test_preferences_choose_the_channels(self):
        CertificationPreferences.objects.create(user=self.student, delivery_channel="whatsapp")
        row = self.pass_exam()
        self.assertEqual(row.status, "queued")
        email = CertificateDelivery.objects.get(channel="email")
        self.assertEqual((email.status, email.skip_reason), ("skipped", "preference_whatsapp_only"))

    def test_whatsapp_only_falls_back_to_email_when_whatsapp_cannot_deliver(self):
        student = self.make_student("Email Fallback")
        CertificationPreferences.objects.create(user=student, delivery_channel="whatsapp")
        self.sit(student, range(1, 10))
        for event in OutboxEvent.objects.filter(event_type=services.EVENT_DECIDE):
            services.decide_participation(event.payload["participation_id"])
        self.assertEqual(CertificateDelivery.objects.get(user=student, channel="email").status, "queued")

    def test_opting_out_after_queueing_is_respected_at_send_time(self):
        row = self.pass_exam()
        CertificationPreferences.objects.create(user=self.student, whatsapp_opt_out=True)
        transport = FakeTransport()
        self.assertEqual(delivery_module.deliver(row.pk, row.round, provider=whatsapp.provider_from_settings(transport=transport)), "skipped")
        self.assertEqual(transport.calls, [])

    def test_phone_normalisation(self):
        self.assertEqual(whatsapp.normalize_phone("+91 98765 43210"), "919876543210")
        self.assertEqual(whatsapp.normalize_phone("098765 43210"), "919876543210")
        self.assertEqual(whatsapp.normalize_phone("0044 20 7946 0958"), "442079460958")
        self.assertEqual(whatsapp.normalize_phone("12"), "")


# --- preferences -----------------------------------------------------------------------------------------
class PreferencesApiTests(CertificationBase):
    def test_defaults_and_updates(self):
        client = APIClient()
        client.force_authenticate(self.student)
        data = client.get("/api/certification/me/preferences/").json()["data"]
        self.assertEqual((data["delivery_channel"], data["whatsapp_opt_out"], data["hall_of_fame_listed"]), ("both", False, True))
        self.assertTrue(data["has_phone"])
        response = client.patch("/api/certification/me/preferences/",
                                {"delivery_channel": "email", "whatsapp_opt_out": True, "hall_of_fame_listed": False}, format="json")
        self.assertEqual(response.status_code, 200)
        prefs = CertificationPreferences.objects.get(user=self.student)
        self.assertEqual((prefs.delivery_channel, prefs.whatsapp_opt_out, prefs.hall_of_fame_listed), ("email", True, False))
        bad = client.patch("/api/certification/me/preferences/", {"delivery_channel": "fax"}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(APIClient().get("/api/certification/me/preferences/").status_code, 401)


# --- Hall of Fame ----------------------------------------------------------------------------------------
class HallOfFameTests(CertificationBase):
    def public(self, **params):
        response = APIClient().get("/api/certification/hall-of-fame/", params)
        self.assertEqual(response.status_code, 200)
        return response

    def test_pass_adds_the_handle_with_batch_achievement_date_and_certificate(self):
        self.profile(self.student, "asha_r")
        self.sit(self.student, range(1, 11))
        self.drain()
        data = self.public().json()["data"]
        entry = next(item for item in data["entries"] if item["handle"] == "asha_r")
        reference = self.decision().certificate.reference
        self.assertEqual(entry["batch"], "Batch 7")
        self.assertEqual(entry["achievement"], "Certified OSINT Investigator")
        self.assertEqual(entry["achieved_on"], timezone.localdate().isoformat())
        self.assertTrue(reference)
        # Certificates are private to their holder: the wall never links to one.
        self.assertEqual((entry["certificate_url"], entry["certificate_reference"], entry["has_certificate"]), (None, None, True))
        self.assertNotIn(reference, self.public().content.decode())
        self.assertEqual(entry["profile_url"], "/u/asha_r")
        self.assertEqual(entry["band"], "Distinction")
        self.assertEqual(data["counters"]["graduates"], 1)
        self.assertEqual(data["counters"]["verified_certificates"], 1)
        self.assertEqual(data["featured"]["recent"][0]["handle"], "asha_r")
        self.assertEqual(data["featured"]["top"][0]["handle"], "asha_r")
        self.assertTrue(HallOfFameAudit.objects.filter(action="added").exists())

    def test_never_shows_real_name_or_email(self):
        self.profile(self.student, "asha_r")
        no_profile = self.make_student("Zainab Qureshi")
        self.sit(self.student, range(1, 11))
        self.sit(no_profile, range(1, 11))
        self.drain()
        legacy = HallOfFameEntry.objects.filter(seed_key__startswith="legacy:").first()
        legacy.user = no_profile
        legacy.save()
        body = self.public().content.decode()
        for secret in ("Asha Rao", "Zainab Qureshi", self.student.email, no_profile.email, "Araxis"):
            self.assertNotIn(secret, body)
        # A student without a handle is not listed until they choose one.
        self.assertEqual(self.public().json()["data"]["counters"]["graduates"], 1)

    def test_automatic_handles_wait_until_the_student_chooses_one(self):
        from django.core.management import call_command

        from apps.profiles.models import StudentProfile

        profile = StudentProfile.objects.create(
            user=self.student, handle="operative_ab12cd", handle_auto=True,
            visibility=StudentProfile.VISIBILITY_PUBLIC, published_at=timezone.now(),
        )
        self.sit(self.student, range(1, 11))
        self.drain()
        body = self.public().content.decode()
        self.assertNotIn("operative_ab12cd", body)
        self.assertNotIn("Asha Rao", body)
        self.assertEqual(self.public().json()["data"]["counters"]["graduates"], 0)
        # A staff-set handle that is really the automatic one is not shown either.
        HallOfFameEntry.objects.filter(user=self.student).update(display_handle="operative_ab12cd")
        self.assertNotIn("operative_ab12cd", self.public().content.decode())
        awaiting = list(hall_of_fame.awaiting_handle_queryset())
        self.assertEqual([row.user_id for row in awaiting], [self.student.pk])
        out = io.StringIO()
        call_command("hall_of_fame_awaiting_handles", "--emails", stdout=out)
        self.assertEqual(out.getvalue().split(), [self.student.email])
        # The student chooses a handle: the entry appears automatically.
        profile.handle, profile.handle_auto = "asha_r", False
        profile.save()
        entry = self.public().json()["data"]["entries"][0]
        self.assertEqual(entry["handle"], "asha_r")
        self.assertEqual(list(hall_of_fame.awaiting_handle_queryset()), [])
        out = io.StringIO()
        call_command("hall_of_fame_awaiting_handles", stdout=out)
        self.assertIn("Every listed graduate has chosen a handle", out.getvalue())

    def test_legacy_entries_keep_their_published_handle(self):
        legacy = HallOfFameEntry.objects.filter(seed_key__startswith="legacy:").exclude(display_handle="").first()
        if legacy is None:
            self.skipTest("no seeded legacy entry with a handle")
        self.assertIn(legacy.display_handle, self.public().content.decode())

    def test_members_only_profile_shows_the_handle_without_a_link(self):
        self.profile(self.student, "asha_r", public=False)
        self.sit(self.student, range(1, 11))
        self.drain()
        entry = self.public().json()["data"]["entries"][0]
        self.assertEqual((entry["handle"], entry["profile_url"]), ("asha_r", None))

    def test_opt_out_hides_and_opt_in_restores(self):
        self.profile(self.student, "asha_r")
        self.sit(self.student, range(1, 11))
        self.drain()
        prefs = CertificationPreferences.objects.create(user=self.student, hall_of_fame_listed=False)
        self.assertNotIn("asha_r", self.public().content.decode())
        prefs.hall_of_fame_listed = True
        prefs.save()
        self.assertIn("asha_r", self.public().content.decode())

    def test_staff_hide_and_restore_are_audited(self):
        self.profile(self.student, "asha_r")
        self.sit(self.student, range(1, 11))
        self.drain()
        entry = HallOfFameEntry.objects.get(source="auto")
        client = APIClient()
        client.force_authenticate(f.make_admin())
        self.assertEqual(client.post(f"/api/certification/staff/hall-of-fame/{entry.pk}/hide/", {"reason": "x"}, format="json").status_code, 400)
        self.assertEqual(client.post(f"/api/certification/staff/hall-of-fame/{entry.pk}/hide/", {"reason": "Requested by family"}, format="json").status_code, 200)
        self.assertNotIn("asha_r", self.public().content.decode())
        self.assertEqual(client.post(f"/api/certification/staff/hall-of-fame/{entry.pk}/restore/", {"reason": "Cleared"}, format="json").status_code, 200)
        self.assertIn("asha_r", self.public().content.decode())
        self.assertEqual(list(entry.audit.order_by("id").values_list("action", flat=True)), ["added", "hidden", "restored"])
        student = APIClient()
        student.force_authenticate(self.student)
        self.assertEqual(student.post(f"/api/certification/staff/hall-of-fame/{entry.pk}/hide/", {"reason": "nope"}, format="json").status_code, 403)

    def test_curated_entries_are_preserved_and_public_only_once_mapped(self):
        seeded = HallOfFameEntry.objects.filter(seed_key__startswith="legacy:")
        self.assertEqual(seeded.count(), 19)
        self.assertEqual(self.public().json()["data"]["counters"]["graduates"], 0)
        araxis = seeded.get(legacy_name="Araxis")
        hall_of_fame.set_display_handle(araxis, handle="Araxis", actor=f.make_admin())
        mapped = seeded.get(legacy_name="Spectre")
        mapped.user = self.student
        mapped.save()
        self.profile(self.student, "spectre_x")
        data = self.public().json()["data"]
        handles = [entry["handle"] for entry in data["entries"]]
        self.assertEqual(handles, ["spectre_x", "Araxis"])  # Batch 2 first (newest batch)
        self.assertNotIn("Spectre\"", json.dumps(data))
        self.assertEqual([batch["label"] for batch in data["batches"]], ["Batch 2", "Batch 1"])
        self.assertEqual(self.public(batch="Batch 1").json()["data"]["entries"][0]["handle"], "Araxis")

    def test_curated_entry_merges_with_the_automatic_one(self):
        curated = HallOfFameEntry.objects.create(user=self.student, batch_label="Batch 7", source="manual", legacy_name="Asha")
        self.profile(self.student, "asha_r")
        self.sit(self.student, range(1, 11))
        self.drain()
        curated.refresh_from_db()
        self.assertEqual(curated.certificate, self.decision().certificate)
        self.assertEqual(HallOfFameEntry.objects.filter(user=self.student).count(), 1)

    def rename_course(self, title, batch=""):
        self.course.title, self.course.batch = title, batch
        self.course.save(update_fields=["title", "batch"])

    def test_batch_number_reads_roman_and_arabic_numerals(self):
        cases = {
            "OSINT PROFESSIONAL TRAINING PROGRAM (BATCH III)": 3,
            "OSINT PROFESSIONAL TRAINING PROGRAM (BATCH IV)": 4,
            "Batch 12": 12,
            "batch-2 evening": 2,
            "Batch No. 6": 6,
            "Batch #XIV": 14,
            "6-MONTH WEB & API PENTESTING COURSE": None,  # a number, but not a batch number
            "Batch January 2027": None,
            "Batch IIII": None,  # not a well-formed numeral
            "Batch civil": None,
            "Batch 0": None,
            "": None,
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(hall_of_fame.batch_number(text), expected)
        self.assertEqual(hall_of_fame.batch_number("III", bare=True), 3)
        self.assertEqual(hall_of_fame.batch_number("5", bare=True), 5)
        self.assertIsNone(hall_of_fame.batch_number("III"))  # a lone numeral only counts in a batch field

    def test_course_without_batch_field_groups_by_the_batch_in_its_title(self):
        self.rename_course("OSINT PROFESSIONAL TRAINING PROGRAM (BATCH III)")
        self.profile(self.student, "asha_r")
        self.sit(self.student, range(1, 11))
        self.drain()
        entry = HallOfFameEntry.objects.get(decision=self.decision())
        self.assertEqual((entry.batch_label, entry.batch_order), ("Batch 3", 3))
        data = self.public().json()["data"]
        self.assertEqual(data["entries"][0]["group"], "Batch 3")
        self.assertIn("Batch 3", [batch["label"] for batch in data["batches"]])
        self.assertNotIn(str(timezone.localdate().year), [batch["label"] for batch in data["batches"]])

    def test_roman_batch_field_is_normalised(self):
        self.rename_course("OSINT Professional Training Program", batch="IV")
        self.sit(self.student, range(1, 11))
        self.drain()
        entry = HallOfFameEntry.objects.get(decision=self.decision())
        self.assertEqual((entry.batch_label, entry.batch_order), ("Batch 4", 4))

    def test_course_without_any_batch_number_falls_back_to_its_title(self):
        self.rename_course("Advanced GEOINT Workshop")
        self.sit(self.student, range(1, 11))
        self.drain()
        entry = HallOfFameEntry.objects.get(decision=self.decision())
        self.assertEqual(entry.batch_label, "Advanced GEOINT Workshop")
        self.assertEqual(entry.batch_order, timezone.localdate().year)

    def test_title_batch_merges_with_the_curated_entry_of_that_batch(self):
        self.rename_course("OSINT PROFESSIONAL TRAINING PROGRAM (BATCH III)")
        curated = HallOfFameEntry.objects.create(user=self.student, batch_label="Batch 3", batch_order=3, source="manual")
        self.sit(self.student, range(1, 11))
        self.drain()
        curated.refresh_from_db()
        self.assertEqual(curated.certificate, self.decision().certificate)
        self.assertEqual((curated.batch_label, curated.batch_order), ("Batch 3", 3))
        self.assertEqual(HallOfFameEntry.objects.filter(user=self.student).count(), 1)

    def test_pagination(self):
        for index in range(5):
            HallOfFameEntry.objects.create(display_handle=f"h{index}", batch_label="Batch 9", batch_order=9, position=index)
        data = self.public(page_size=2).json()["data"]
        self.assertEqual((len(data["entries"]), data["total"], data["has_more"]), (2, 5, True))
        last = self.public(page_size=2, page=3).json()["data"]
        self.assertEqual((len(last["entries"]), last["has_more"]), (1, False))

    def test_honoured_since_is_the_2025_founding_year(self):
        self.assertIsNone(self.public().json()["data"]["counters"]["since"])  # nobody public yet
        araxis = HallOfFameEntry.objects.get(seed_key__startswith="legacy:", legacy_name="Araxis")
        hall_of_fame.set_display_handle(araxis, handle="Araxis", actor=f.make_admin())
        # The undated curated batches were honoured in the founding year.
        self.assertEqual(self.public().json()["data"]["counters"]["since"], 2025)
        HallOfFameEntry.objects.create(display_handle="later", batch_label="Batch 9", batch_order=9, achieved_on="2026-10-01")
        self.assertEqual(self.public().json()["data"]["counters"]["since"], 2025)
        araxis.is_hidden = True
        araxis.save()
        self.assertEqual(self.public().json()["data"]["counters"]["since"], 2026)
        HallOfFameEntry.objects.create(display_handle="typo", batch_label="Batch 9", batch_order=9, achieved_on="2019-01-01")
        self.assertEqual(self.public().json()["data"]["counters"]["since"], 2025)  # never before the founding


# --- PostgreSQL row locks ------------------------------------------------------------------------------
class RowLockTests(CertificationBase):
    """PostgreSQL refuses FOR UPDATE on the nullable side of an outer join (``batch_course``,
    ``participation``, ``certificate``): every lock that is combined with ``select_related`` must
    lock only its own row (``of=("self",)``). SQLite ignores FOR UPDATE, so the calls are recorded."""

    def _record_locks(self):
        from django.db.models.query import QuerySet

        calls = []
        original = QuerySet.select_for_update

        def recording(qs, *args, **kwargs):
            calls.append((qs.model.__name__, kwargs.get("of", ())))
            return original(qs, *args, **kwargs)

        return calls, mock.patch.object(QuerySet, "select_for_update", recording)

    def test_decide_and_regrade_and_revocation_lock_only_their_own_rows(self):
        participation = self.sit(self.student, range(1, 8))
        calls, patcher = self._record_locks()
        with patcher:
            decision = services.decide_participation(participation.pk)
            services.regrade_decision(decision)
        self.assertEqual(decision.outcome, "passed")
        locks = dict(calls)
        self.assertEqual(locks["CtfParticipation"], ("self",))
        self.assertEqual(locks["CertificationDecision"], ("self",))

    def test_select_for_update_of_self_compiles_for_postgresql(self):
        from django.db import connection

        queryset = (
            CtfParticipation.objects.select_for_update(of=("self",))
            .select_related("exam", "user", "batch_course")
            .filter(pk=1)
        )
        sql = str(queryset.query)  # builds without error; the join on batch_course stays an outer join
        self.assertIn("LEFT OUTER JOIN", sql)
        self.assertEqual(queryset.query.select_for_update_of, ("self",))
        self.assertIsNotNone(connection.vendor)
