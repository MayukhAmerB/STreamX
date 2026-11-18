"""Send logins to paid buyers who never received one (dry run unless --apply).

    python manage.py send_paid_credentials            # list who is waiting
    python manage.py send_paid_credentials --apply    # queue the automatic send for each

Each buyer gets the same automatic send as a new payment: a fresh password to
their registered email and WhatsApp, through the outbox worker (with retries).
"""

from django.core.management.base import BaseCommand

from apps.core.outbox import publish
from apps.payments.credential_delivery import EVENT_AUTO_SEND
from apps.payments.models import Payment


class Command(BaseCommand):
    help = "Queue login delivery for paid buyers still awaiting a password. Dry run unless --apply."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Queue the sends (default: dry run).")
        parser.add_argument("--payment", type=int, action="append", default=None, help="Only this payment id (repeatable).")

    def handle(self, *args, **options):
        payments = (
            Payment.objects.filter(status=Payment.STATUS_PAID, provisioning_status=Payment.PROVISION_AWAITING_ADMIN)
            .exclude(user__isnull=True)
            .select_related("user")
            .order_by("user_id", "-paid_at", "-id")
        )
        if options["payment"]:
            payments = payments.filter(pk__in=options["payment"])
        seen, queued = set(), 0
        for payment in payments:
            user = payment.user
            if user.pk in seen or user.has_usable_password():
                continue
            seen.add(user.pk)
            self.stdout.write(
                f"payment#{payment.pk} {user.email} email={'yes' if payment.buyer_email else 'NO'} "
                f"whatsapp={'yes' if payment.whatsapp_number else 'NO'} course={payment.course_title_snapshot}"
            )
            if options["apply"]:
                publish(EVENT_AUTO_SEND, {"payment_id": payment.pk}, dedupe_key=f"credentials:backfill:{payment.pk}")
                queued += 1
        mode = "APPLY" if options["apply"] else "DRY RUN"
        self.stdout.write(f"send_paid_credentials [{mode}] buyers={len(seen)} queued={queued}")
