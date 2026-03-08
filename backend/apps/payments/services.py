import hashlib
import hmac

from django.conf import settings


class RazorpayServiceError(Exception):
    pass


def get_razorpay_client():
    if not settings.RAZORPAY_KEY_ID or not settings.RAZORPAY_KEY_SECRET:
        raise RazorpayServiceError("Razorpay credentials are not configured.")
    try:
        import razorpay
    except ModuleNotFoundError as exc:
        raise RazorpayServiceError(
            "Razorpay SDK dependency is unavailable. Install setuptools and razorpay dependencies."
        ) from exc
    return razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET))


def create_razorpay_order(*, amount_paise, currency="INR", receipt=""):
    client = get_razorpay_client()
    try:
        return client.order.create(
            {
                "amount": amount_paise,
                "currency": currency,
                "receipt": receipt or "alsyedinitiative-order",
                "payment_capture": 1,
            }
        )
    except Exception as exc:
        raise RazorpayServiceError("Failed to create Razorpay order.") from exc


def verify_razorpay_signature(*, razorpay_order_id, razorpay_payment_id, razorpay_signature):
    client = get_razorpay_client()
    payload = {
        "razorpay_order_id": razorpay_order_id,
        "razorpay_payment_id": razorpay_payment_id,
        "razorpay_signature": razorpay_signature,
    }
    try:
        client.utility.verify_payment_signature(payload)
        return True
    except Exception as exc:
        raise RazorpayServiceError("Razorpay signature verification failed.") from exc


def verify_razorpay_webhook_signature(*, payload_body, razorpay_signature):
    webhook_secret = str(getattr(settings, "RAZORPAY_WEBHOOK_SECRET", "") or "").strip()
    if not webhook_secret:
        raise RazorpayServiceError("Razorpay webhook secret is not configured.")

    signature = str(razorpay_signature or "").strip()
    if not signature:
        raise RazorpayServiceError("Missing Razorpay webhook signature header.")

    body = payload_body.encode("utf-8") if isinstance(payload_body, str) else bytes(payload_body or b"")
    if not body:
        raise RazorpayServiceError("Webhook payload is empty.")

    expected_signature = hmac.new(
        key=webhook_secret.encode("utf-8"),
        msg=body,
        digestmod=hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected_signature, signature):
        raise RazorpayServiceError("Razorpay webhook signature verification failed.")
    return True
