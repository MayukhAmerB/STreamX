"""Generate a paid buyer's login and send it to their registered email and WhatsApp.

Pipeline::

    payment captured (verify / webhook / reconciliation)
      -> provision_paid_payment: ADL####@adlfront.com login, no password yet
      -> outbox "payments.credentials.auto_send" (published in the same transaction)
      -> worker: auto_send_for_payment -> fresh password -> email + WhatsApp

    Django admin > Successful Payment Users
      -> "Generate and send" (one buyer or many): same issue_and_send, by an admin

Both paths reach the buyer's own email (``Payment.buyer_email``) and WhatsApp
number (``Payment.whatsapp_number``) entered at checkout.

The password is never stored in plain text and never logged. Every send is
recorded as a :class:`CredentialDelivery` row. An automatic run that reaches
nobody puts the account back to "awaiting password" and retries, so a password
is never left set that nobody received.

WhatsApp is sent automatically through the WhatsApp Business Cloud API once
``WHATSAPP_CLOUD_API_TOKEN``, ``WHATSAPP_PHONE_NUMBER_ID`` and
``WHATSAPP_TEMPLATE_CREDENTIALS`` are set (an APPROVED template whose body has
5 parameters: name, course, login URL, username, password). Until then the
admin page shows a one-click WhatsApp button with the same message.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from urllib.parse import quote

from django.conf import settings
from django.core.mail import EmailMessage, get_connection

from config.audit import log_security_event

from .credentials import issue_credentials_for_paid_user
from .models import CredentialDelivery, Payment

logger = logging.getLogger("apps.payments.credential_delivery")

EVENT_AUTO_SEND = "payments.credentials.auto_send"
ERROR_MAX_CHARS = 500


class DeliveryFailed(Exception):
    """An automatic send reached nobody; the outbox retries it."""


@dataclass
class CredentialResult:
    user: object
    payment: Payment
    password: str
    message: str
    whatsapp_number: str = ""
    whatsapp_url: str = ""
    email: CredentialDelivery | None = None
    whatsapp: CredentialDelivery | None = None
    retryable: bool = False
    deliveries: list = field(default_factory=list)

    @property
    def email_sent(self) -> bool:
        return bool(self.email and self.email.status == CredentialDelivery.STATUS_SENT)

    @property
    def whatsapp_sent(self) -> bool:
        return bool(self.whatsapp and self.whatsapp.status == CredentialDelivery.STATUS_SENT)

    @property
    def any_sent(self) -> bool:
        return self.email_sent or self.whatsapp_sent


# --- settings ---------------------------------------------------------------------------------------------
def auto_send_enabled() -> bool:
    return bool(getattr(settings, "PAYMENT_AUTO_CREDENTIALS_ENABLED", True))


def login_url() -> str:
    base = str(getattr(settings, "FRONTEND_URL", "") or "").strip().rstrip("/")
    return f"{base}/login" if base else "/login"


def _country_code() -> str:
    return str(getattr(settings, "WHATSAPP_DEFAULT_COUNTRY_CODE", "91") or "91")


def whatsapp_template() -> str:
    return str(getattr(settings, "WHATSAPP_TEMPLATE_CREDENTIALS", "") or "").strip()


def whatsapp_provider(transport=None):
    """The Cloud API provider for credential messages, or None until configured."""
    from apps.certification import whatsapp as wa

    token = str(getattr(settings, "WHATSAPP_CLOUD_API_TOKEN", "") or "").strip()
    phone_id = str(getattr(settings, "WHATSAPP_PHONE_NUMBER_ID", "") or "").strip()
    if not (token and phone_id and whatsapp_template()):
        return None
    try:
        timeout = float(getattr(settings, "WHATSAPP_HTTP_TIMEOUT_SECONDS", 15) or 15)
    except (TypeError, ValueError):
        timeout = 15.0
    config = wa.WhatsAppConfig(
        token=token,
        phone_number_id=phone_id,
        certificate_template="",
        language=str(getattr(settings, "WHATSAPP_TEMPLATE_LANGUAGE", "en") or "en"),
        api_version=str(getattr(settings, "WHATSAPP_API_VERSION", "v21.0") or "v21.0"),
        graph_base=str(getattr(settings, "WHATSAPP_GRAPH_BASE_URL", wa.DEFAULT_GRAPH_BASE) or wa.DEFAULT_GRAPH_BASE).rstrip("/"),
        default_country_code=_country_code(),
        timeout=max(1.0, min(60.0, timeout)),
    )
    return wa.WhatsAppCloudProvider(config, transport=transport)


# --- content ----------------------------------------------------------------------------------------------
def latest_paid_payment(user):
    return (
        Payment.objects.filter(user=user, status=Payment.STATUS_PAID)
        .select_related("course")
        .order_by("-paid_at", "-created_at", "-id")
        .first()
    )


def _course_title(payment) -> str:
    return str(payment.course_title_snapshot or getattr(payment.course, "title", "") or "your course")


def _buyer_name(user, payment) -> str:
    return str(payment.buyer_name or user.full_name or "").strip()


def credential_subject(payment) -> str:
    return f"Your Al Syed Initiative login - {_course_title(payment)}"


def credential_message(*, user, password, payment) -> str:
    name = _buyer_name(user, payment)
    lines = [
        f"Hello {name}," if name else "Hello,",
        "",
        f"Thank you for your payment for {_course_title(payment)}"
        + (f" (invoice {payment.invoice_number})." if payment.invoice_number else "."),
        "",
        "Your login details:",
        f"Website: {login_url()}",
        f"Username: {user.email}",
        f"Password: {password}",
        "",
        "Sign in with the username above (not your personal email).",
        "Keep these details private.",
        "",
        "Al Syed Initiative",
    ]
    return "\n".join(lines)


def whatsapp_number(payment, user=None) -> str:
    from apps.certification.whatsapp import normalize_phone

    for raw in (payment.whatsapp_number, getattr(user, "phone_number", "")):
        digits = normalize_phone(raw, _country_code())
        if digits:
            return digits
    return ""


def whatsapp_link(number: str, message: str) -> str:
    return f"https://wa.me/{number}?text={quote(message, safe='')}" if number else ""


# --- senders (never raise) --------------------------------------------------------------------------------
def _record(*, user, payment, channel, status, recipient="", error="", actor=None):
    return CredentialDelivery.objects.create(
        user=user,
        payment=payment,
        channel=channel,
        status=status,
        recipient=str(recipient or "")[:255],
        error=str(error or "")[:ERROR_MAX_CHARS],
        sent_by=actor if getattr(actor, "pk", None) else None,
    )


def send_credentials_email(*, user, password, payment, message=None, actor=None):
    """Email the login to the buyer's registered email. Returns (delivery, retryable)."""
    recipient = str(payment.buyer_email or "").strip()
    if not recipient:
        return _record(
            user=user, payment=payment, channel=CredentialDelivery.CHANNEL_EMAIL,
            status=CredentialDelivery.STATUS_SKIPPED, error="No registered email on the payment.", actor=actor,
        ), False
    sender = str(getattr(settings, "CREDENTIALS_EMAIL_FROM", "") or "").strip() or settings.DEFAULT_FROM_EMAIL
    timeout = max(3, int(getattr(settings, "CREDENTIALS_EMAIL_TIMEOUT_SECONDS", 15) or 15))
    try:
        EmailMessage(
            subject=credential_subject(payment),
            body=message or credential_message(user=user, password=password, payment=payment),
            from_email=sender,
            to=[recipient],
            connection=get_connection(timeout=timeout),
        ).send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001 - SMTP/network errors are shown to the admin
        # The text comes from the mail server, never from the message body (no password in it).
        logger.warning("payments.credentials_email_failed user_id=%s error=%s", user.pk, type(exc).__name__)
        return _record(
            user=user, payment=payment, channel=CredentialDelivery.CHANNEL_EMAIL,
            status=CredentialDelivery.STATUS_FAILED, recipient=recipient,
            error=f"{type(exc).__name__}: {exc}", actor=actor,
        ), True
    return _record(
        user=user, payment=payment, channel=CredentialDelivery.CHANNEL_EMAIL,
        status=CredentialDelivery.STATUS_SENT, recipient=recipient, actor=actor,
    ), False


def send_credentials_whatsapp(*, user, password, payment, number, actor=None, provider=None):
    """Send the login template to the buyer's WhatsApp. Returns (delivery or None, retryable).

    None means WhatsApp is not configured: nothing is recorded and the admin
    page offers the manual WhatsApp button instead.
    """
    from apps.certification.whatsapp import WhatsAppError

    provider = provider or whatsapp_provider()
    if provider is None:
        return None, False
    if not number:
        return _record(
            user=user, payment=payment, channel=CredentialDelivery.CHANNEL_WHATSAPP,
            status=CredentialDelivery.STATUS_SKIPPED, error="No usable WhatsApp number on the payment.", actor=actor,
        ), False
    try:
        provider.send_text_template(
            to=number,
            template=whatsapp_template(),
            body_params=[_buyer_name(user, payment) or "there", _course_title(payment), login_url(), user.email, password],
        )
    except WhatsAppError as exc:
        logger.warning("payments.credentials_whatsapp_failed user_id=%s retryable=%s", user.pk, exc.retryable)
        return _record(
            user=user, payment=payment, channel=CredentialDelivery.CHANNEL_WHATSAPP,
            status=CredentialDelivery.STATUS_FAILED, recipient=number, error=str(exc), actor=actor,
        ), bool(exc.retryable)
    except Exception as exc:  # noqa: BLE001
        logger.warning("payments.credentials_whatsapp_failed user_id=%s error=%s", user.pk, type(exc).__name__)
        return _record(
            user=user, payment=payment, channel=CredentialDelivery.CHANNEL_WHATSAPP,
            status=CredentialDelivery.STATUS_FAILED, recipient=number, error=f"{type(exc).__name__}: {exc}", actor=actor,
        ), True
    return _record(
        user=user, payment=payment, channel=CredentialDelivery.CHANNEL_WHATSAPP,
        status=CredentialDelivery.STATUS_SENT, recipient=number, actor=actor,
    ), False


# --- the one operation both paths use ---------------------------------------------------------------------
def issue_and_send(*, user, actor=None, send_email=True, send_whatsapp=True, request=None, source="admin",
                   whatsapp_provider_override=None) -> CredentialResult:
    """Set a fresh password for a paid buyer and send it to their email and WhatsApp.

    The password is committed before any send, so a failed send never loses
    it for the admin: the admin page still shows it with a WhatsApp button.
    """
    payment, password = issue_credentials_for_paid_user(user_id=user.pk)
    user.refresh_from_db()
    payment = Payment.objects.select_related("course").get(pk=payment.pk)
    message = credential_message(user=user, password=password, payment=payment)
    number = whatsapp_number(payment, user)
    result = CredentialResult(
        user=user, payment=payment, password=password, message=message,
        whatsapp_number=number, whatsapp_url=whatsapp_link(number, message),
    )
    if send_email:
        result.email, retry = send_credentials_email(
            user=user, password=password, payment=payment, message=message, actor=actor
        )
        result.retryable |= retry
        result.deliveries.append(result.email)
    if send_whatsapp:
        result.whatsapp, retry = send_credentials_whatsapp(
            user=user, password=password, payment=payment, number=number, actor=actor,
            provider=whatsapp_provider_override,
        )
        result.retryable |= retry
        if result.whatsapp is not None:
            result.deliveries.append(result.whatsapp)
    log_security_event(
        "payment.credentials_issued",
        request=request,
        source=source,
        target_user_id=user.pk,
        payment_id=payment.pk,
        email_status=result.email.status if result.email else "not_requested",
        whatsapp_status=result.whatsapp.status if result.whatsapp else "manual",
    )
    return result


def _withdraw_undelivered_password(user) -> None:
    """Nobody received the new password: back to "awaiting password" so a retry can issue another."""
    from .provisioning import withdraw_undelivered_credentials  # provisioning imports this module

    withdraw_undelivered_credentials(user_id=user.pk)


# --- automatic path ---------------------------------------------------------------------------------------
def queue_auto_send(payment) -> None:
    """Called inside provisioning's transaction: the event exists only if the payment commits."""
    if not auto_send_enabled():
        return
    from apps.core.outbox import publish

    publish(EVENT_AUTO_SEND, {"payment_id": payment.pk}, dedupe_key=f"credentials:auto:{payment.pk}")


def auto_send_for_payment(payment_id, *, whatsapp_provider_override=None) -> str:
    """Outbox handler body. Idempotent: an account that already has a password is left alone."""
    if not auto_send_enabled():
        return "disabled"
    payment = Payment.objects.select_related("user").filter(pk=payment_id).first()
    if payment is None or payment.status != Payment.STATUS_PAID or not payment.user_id:
        return "not_applicable"
    user = payment.user
    if user.has_usable_password():
        return "already_issued"
    result = issue_and_send(user=user, source="auto", whatsapp_provider_override=whatsapp_provider_override)
    if result.any_sent:
        return "sent"
    _withdraw_undelivered_password(user)
    if result.retryable:
        raise DeliveryFailed(f"credentials for user {user.pk} reached no channel; retrying")
    return "unreachable"


def record_whatsapp_sent(*, user, actor=None, request=None) -> CredentialDelivery:
    """The admin confirms they sent the login with the WhatsApp button (we cannot see wa.me)."""
    payment = latest_paid_payment(user)
    delivery = _record(
        user=user,
        payment=payment,
        channel=CredentialDelivery.CHANNEL_WHATSAPP,
        status=CredentialDelivery.STATUS_SENT,
        recipient=whatsapp_number(payment, user) if payment else "",
        actor=actor,
    )
    log_security_event(
        "admin.payment_credentials_whatsapp_marked",
        request=request,
        target_user_id=user.pk,
        payment_id=getattr(payment, "pk", None),
    )
    return delivery
