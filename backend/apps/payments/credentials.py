import secrets
import string

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from .models import Payment


SAFE_LETTERS = "".join(character for character in string.ascii_letters if character not in "OIl")
SAFE_DIGITS = "23456789"
PASSWORD_SYMBOLS = "!@#$%^&*"


def generate_account_password():
    characters = [
        *(secrets.choice(SAFE_LETTERS) for _ in range(8)),
        *(secrets.choice(SAFE_DIGITS) for _ in range(2)),
        *(secrets.choice(PASSWORD_SYMBOLS) for _ in range(2)),
    ]
    secrets.SystemRandom().shuffle(characters)
    return "".join(characters)


@transaction.atomic
def issue_credentials_for_paid_user(*, user_id):
    User = get_user_model()
    user = User.objects.select_for_update().get(pk=user_id)
    payment = (
        Payment.objects.select_for_update()
        .filter(user=user, status=Payment.STATUS_PAID)
        .order_by("-paid_at", "-created_at", "-id")
        .first()
    )
    if payment is None:
        raise ValueError("Credentials can only be issued for a successfully paid account.")

    password = generate_account_password()
    user.set_password(password)
    user.active_session_version += 1
    user.save(update_fields=["password", "active_session_version", "updated_at"])

    issued_at = timezone.now()
    Payment.objects.filter(user=user, status=Payment.STATUS_PAID).update(
        provisioning_status=Payment.PROVISION_CREDENTIALS_ISSUED,
        credentials_issued_at=issued_at,
        updated_at=issued_at,
    )
    payment.provisioning_status = Payment.PROVISION_CREDENTIALS_ISSUED
    payment.credentials_issued_at = issued_at
    return payment, password
