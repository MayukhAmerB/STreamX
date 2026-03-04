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
                "receipt": receipt or "alsyedacademy-order",
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
