"""Re-read stale live subscriptions from Razorpay (missed webhooks). Dry run unless --apply."""

from django.core.management.base import BaseCommand

from apps.payments.subscriptions import reconcile


class Command(BaseCommand):
    help = "Reconcile platform subscriptions not updated recently with Razorpay (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--stale-hours", type=int, default=26)

    def handle(self, *args, **options):
        report = reconcile(apply=options["apply"], stale_hours=options["stale_hours"])
        mode = "APPLY" if options["apply"] else "DRY RUN"
        self.stdout.write(
            f"reconcile_subscriptions [{mode}] checked={report['checked']} changed={report['changed']} "
            f"failed={report['failed']}"
        )
        for change in report["changes"]:
            self.stdout.write(f"  #{change['id']} -> {change['status']} ({', '.join(change['fields'])})")
