"""Certificate + congratulations letter delivery (outbox handlers).

``certification.deliver`` sends one ``CertificateDelivery`` (one channel, one
round). Idempotency:

* the event carries ``round``; an event for an older round, or a delivery
  already ``sent`` / ``skipped``, does nothing (never twice per certificate
  per round; a new round only comes from an explicit staff resend);
* WhatsApp records each document's provider message id as soon as it is
  accepted (``provider_parts``), so a retry after a partial failure only
  sends what is missing.

Failures: a retryable error marks the row ``retrying`` and re-raises, so the
outbox retries it with exponential backoff and jitter; the last attempt (or
a permanent error) marks it ``failed`` with the error text. Consent is checked
again at send time (a student may have opted out since).
"""

from __future__ import annotations

import logging

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.utils import timezone
from django.utils.html import escape

from apps.core.outbox import PermanentFailure, outbox_handler
from apps.engagement import certificate_render, certificates

from . import letter, whatsapp
from .grading import band_range
from .models import CertificateDelivery
from .services import EVENT_DECIDE, EVENT_DELIVER, decide_participation, preferences_for, whatsapp_block_reason

logger = logging.getLogger("apps.certification.delivery")

MAX_ATTEMPTS = 8


def _max_attempts() -> int:
    return max(1, int(getattr(settings, "CERTIFICATION_DELIVERY_MAX_ATTEMPTS", MAX_ATTEMPTS) or MAX_ATTEMPTS))


# --- content ---------------------------------------------------------------------------------------------
def _hall_of_fame_listed(delivery) -> bool:
    try:
        entry = delivery.certificate.hall_of_fame_entry
    except Exception:  # noqa: BLE001 - RelatedObjectDoesNotExist
        entry = None
    return bool(entry is not None and not entry.is_hidden and preferences_for(delivery.user).hall_of_fame_listed)


def letter_facts(delivery) -> letter.LetterFacts:
    decision = delivery.decision
    return letter.facts_for(
        delivery.certificate,
        exam_title=decision.exam.title,
        band=decision.band,
        listed_in_hall_of_fame=_hall_of_fame_listed(delivery),
    )


def documents(delivery) -> dict:
    certificate = delivery.certificate
    facts = letter_facts(delivery)
    return {
        "facts": facts,
        "certificate_pdf": certificate_render.certificate_pdf(certificate),
        "certificate_filename": f"{certificate.reference}-certificate.pdf",
        "letter_pdf": letter.letter_pdf(facts),
        "letter_filename": letter.letter_filename(certificate.reference),
    }


def email_subject(facts) -> str:
    return f"Congratulations, you are certified · {certificates.ISSUER_NAME}"


def email_text(facts) -> str:
    return (
        f"Dear {facts.name},\n\n"
        f"Congratulations. You have passed the {facts.exam_title} and are now certified "
        f"({facts.band} band).\n\n"
        f"Certificate reference: {facts.reference}\n"
        f"Verify it at any time: {facts.verify_url}\n\n"
        "Your certificate and your letter of congratulations are attached to this e-mail as PDF files.\n\n"
        f"With our warmest congratulations,\n{certificates.SIGNATORY}\n"
    )


def email_html(facts) -> str:
    e = escape
    band_text = band_range(facts.band)
    hall = (
        "<p style=\"margin:0 0 16px;color:#a1a1a1;font-size:15px;line-height:24px\">Your handle has also been added to the "
        "Al Syed Initiative Hall of Fame. You can remove it at any time from your profile settings.</p>"
        if facts.listed_in_hall_of_fame
        else ""
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>{e(email_subject(facts))}</title></head>
<body style="margin:0;padding:0;background:#000000;font-family:Georgia,'IBM Plex Serif',serif;color:#fafafa">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#0a0a0a;border:1px solid #e6d29c">
<tr><td style="padding:36px 36px 8px">
<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:4px;color:#f3e2b3">AL SYED INITIATIVE</p>
<div style="width:56px;height:1px;background:#f3e2b3;margin:14px 0 28px"></div>
<p style="margin:0 0 8px;font-style:italic;color:#a1a1a1;font-size:17px">Dear</p>
<h1 style="margin:0 0 24px;font-weight:600;font-size:34px;line-height:40px;color:#fafafa">{e(facts.name)}</h1>
<p style="margin:0 0 16px;color:#d4d4d4;font-size:16px;line-height:26px">Congratulations. You have passed the
<strong style="color:#fafafa">{e(facts.exam_title)}</strong> and are now certified.</p>
</td></tr>
<tr><td style="padding:0 36px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #262626;border-bottom:1px solid #262626">
<tr>
<td style="padding:18px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:2px;color:#8a8a8a">RESULT<br>
<span style="font-family:Georgia,serif;font-size:20px;letter-spacing:0;color:#f3e2b3">{e(facts.band)}</span>
{f'<br><span style="font-size:11px;letter-spacing:0;color:#8a8a8a">{e(band_text)}</span>' if band_text else ''}</td>
<td style="padding:18px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:2px;color:#8a8a8a">DATE<br>
<span style="font-family:Georgia,serif;font-size:17px;letter-spacing:0;color:#fafafa">{e(facts.issued_on)}</span></td>
</tr>
<tr><td colspan="2" style="padding:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:2px;color:#8a8a8a">REFERENCE NUMBER<br>
<span style="font-family:'Courier New',monospace;font-size:16px;letter-spacing:1px;color:#fafafa">{e(facts.reference)}</span></td></tr>
</table>
</td></tr>
<tr><td style="padding:28px 36px 8px">
<p style="margin:0 0 16px;color:#a1a1a1;font-size:15px;line-height:24px">Your certificate and your letter of congratulations
are attached as PDF files. Anyone can verify your certificate at any time:</p>
<p style="margin:0 0 24px"><a href="{e(facts.verify_url)}" style="display:inline-block;background:#f3e2b3;color:#0a0a0a;
text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:600;font-size:14px;padding:12px 22px;border-radius:999px">Verify the certificate</a></p>
<p style="margin:0 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a8a8a;word-break:break-all">{e(facts.verify_url)}</p>
{hall}
</td></tr>
<tr><td style="padding:8px 36px 36px">
<p style="margin:0;font-style:italic;color:#a1a1a1;font-size:15px">With our warmest congratulations,</p>
<p style="margin:6px 0 0;font-style:italic;font-size:24px;color:#fafafa">{e(certificates.SIGNATORY)}</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#737373">You receive this because you passed an Al Syed Initiative certification exam.</p>
</td></tr></table></body></html>"""


# --- senders ---------------------------------------------------------------------------------------------
class SkipDelivery(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def send_email(delivery) -> str:
    to = str(delivery.user.email or "").strip()
    if not to:
        raise SkipDelivery("no_email")
    docs = documents(delivery)
    facts = docs["facts"]
    sender = str(getattr(settings, "CERTIFICATION_EMAIL_FROM", "") or "").strip() or settings.DEFAULT_FROM_EMAIL
    message = EmailMultiAlternatives(
        subject=email_subject(facts),
        body=email_text(facts),
        from_email=sender,
        to=[to],
        headers={"X-Entity-Ref-ID": delivery.idempotency_key, "X-ASI-Delivery-Round": str(delivery.round)},
    )
    message.attach_alternative(email_html(facts), "text/html")
    message.attach(docs["certificate_filename"], docs["certificate_pdf"], "application/pdf")
    message.attach(docs["letter_filename"], docs["letter_pdf"], "application/pdf")
    message.send(fail_silently=False)
    return f"email:{delivery.idempotency_key}:{delivery.round}"


def send_whatsapp(delivery, provider=None) -> str:
    block = whatsapp_block_reason(delivery.user, preferences_for(delivery.user))
    if block:
        raise SkipDelivery(block)
    provider = provider or whatsapp.provider_from_settings()
    if provider is None:
        raise SkipDelivery("whatsapp_not_configured")
    to = whatsapp.normalize_phone(delivery.user.phone_number, provider.config.default_country_code)
    docs = documents(delivery)
    facts = docs["facts"]
    parts = dict(delivery.provider_parts or {})
    plan = [
        ("certificate", provider.config.certificate_template, docs["certificate_pdf"], docs["certificate_filename"],
         [facts.name, delivery.certificate.title, facts.reference, facts.verify_url]),
    ]
    if provider.config.letter_template:
        plan.append(("letter", provider.config.letter_template, docs["letter_pdf"], docs["letter_filename"], [facts.name]))
    for key, template, data, filename, params in plan:
        if parts.get(key):
            continue
        media_id = provider.upload_document(data, filename)
        parts[key] = provider.send_document_template(
            to=to, template=template, media_id=media_id, filename=filename, body_params=params
        )
        CertificateDelivery.objects.filter(pk=delivery.pk).update(provider_parts=parts, updated_at=timezone.now())
        delivery.provider_parts = parts
    return parts.get("certificate", "")


SENDERS = {CertificateDelivery.CHANNEL_EMAIL: send_email, CertificateDelivery.CHANNEL_WHATSAPP: send_whatsapp}


def _claim(delivery_id, round_number):
    """Lock the row and count the attempt; None when there is nothing to do."""
    with transaction.atomic():
        row = (
            CertificateDelivery.objects.select_for_update()
            .select_related("user", "certificate", "decision__exam")
            .filter(pk=delivery_id)
            .first()
        )
        if row is None or row.round != int(round_number or 0):
            return None
        if row.status in (CertificateDelivery.STATUS_SENT, CertificateDelivery.STATUS_SKIPPED, CertificateDelivery.STATUS_FAILED):
            return None
        if row.certificate.revoked_at is not None:
            row.status, row.skip_reason = CertificateDelivery.STATUS_SKIPPED, "certificate_revoked"
            row.save(update_fields=["status", "skip_reason", "updated_at"])
            return None
        row.attempts += 1
        row.save(update_fields=["attempts", "updated_at"])
        return row


def _finish(row, **fields):
    CertificateDelivery.objects.filter(pk=row.pk, round=row.round).update(updated_at=timezone.now(), **fields)


def deliver(delivery_id, round_number, *, final_attempt: bool = False, provider=None) -> str:
    """Send one delivery round. Returns sent | skipped | noop; raises for a retry."""
    row = _claim(delivery_id, round_number)
    if row is None:
        return "noop"
    sender = SENDERS[row.channel]
    try:
        if row.channel == CertificateDelivery.CHANNEL_WHATSAPP:
            message_id = sender(row, provider=provider)
        else:
            message_id = sender(row)
    except SkipDelivery as skip:
        _finish(row, status=CertificateDelivery.STATUS_SKIPPED, skip_reason=skip.reason[:40])
        logger.info("certification.delivery_skipped id=%s reason=%s", row.pk, skip.reason)
        return "skipped"
    except whatsapp.WhatsAppError as exc:
        permanent = not exc.retryable
        status = CertificateDelivery.STATUS_FAILED if (permanent or final_attempt) else CertificateDelivery.STATUS_RETRYING
        _finish(row, status=status, last_error=str(exc)[:2000])
        if permanent:
            raise PermanentFailure(str(exc)) from exc
        raise
    except Exception as exc:  # noqa: BLE001 - SMTP / rendering errors: retry with backoff
        status = CertificateDelivery.STATUS_FAILED if final_attempt else CertificateDelivery.STATUS_RETRYING
        _finish(row, status=status, last_error=f"{type(exc).__name__}: {exc}"[:2000])
        raise
    _finish(
        row,
        status=CertificateDelivery.STATUS_SENT,
        sent_at=timezone.now(),
        provider_message_id=str(message_id or "")[:200],
        last_error="",
        skip_reason="",
    )
    logger.info("certification.delivery_sent id=%s channel=%s round=%s", row.pk, row.channel, row.round)
    return "sent"


@outbox_handler(EVENT_DELIVER, max_attempts=MAX_ATTEMPTS)
def handle_deliver(event):
    payload = event.payload or {}
    final = int(event.attempts or 0) >= int(event.max_attempts or _max_attempts())
    return deliver(payload.get("delivery_id"), payload.get("round"), final_attempt=final)


@outbox_handler(EVENT_DECIDE, max_attempts=8)
def handle_decide(event):
    participation_id = (event.payload or {}).get("participation_id")
    if participation_id:
        decide_participation(int(participation_id))
