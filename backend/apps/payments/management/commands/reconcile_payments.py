"""Check open (created/pending) payment orders against Razorpay. DRY RUN unless --apply.

    python manage.py reconcile_payments                      # report only (Razorpay GETs, no writes)
    python manage.py reconcile_payments --max-age-hours 4000 --limit 300
    python manage.py reconcile_payments --apply              # finalize captured, close dead orders

Finalizing uses the same idempotent path as the Razorpay webhook. See
apps/payments/reconciliation.py.
"""

import json

from django.core.management.base import BaseCommand

from apps.payments.reconciliation import reconcile_stuck_payments


class Command(BaseCommand):
    help = "Reconcile stuck Razorpay orders (course, platform and billing). Dry run unless --apply."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write changes (default: dry run).")
        parser.add_argument("--min-age-minutes", type=int, default=None)
        parser.add_argument("--max-age-hours", type=int, default=None)
        parser.add_argument("--limit", type=int, default=None)
        parser.add_argument(
            "--supersede-after-hours",
            type=int,
            default=None,
            help="Close never-attempted/failed-only orders older than this (0 = never).",
        )
        parser.add_argument("--json", action="store_true", help="Print the full report as JSON.")

    def handle(self, *args, **options):
        report = reconcile_stuck_payments(
            apply=options["apply"],
            min_age_minutes=options["min_age_minutes"],
            max_age_hours=options["max_age_hours"],
            limit=options["limit"],
            supersede_after_hours=options["supersede_after_hours"],
        )
        if options["json"]:
            self.stdout.write(json.dumps(report.as_dict(), indent=2, default=str))
            return
        mode = "APPLY" if report.apply else "DRY RUN"
        self.stdout.write(
            f"reconcile_payments [{mode}] checked={report.checked} captured={report.captured} "
            f"finalized={report.finalized} superseded={report.superseded} unpaid={report.unpaid} "
            f"in_progress={report.in_progress} needs_review={report.needs_review} errors={report.errors}"
            + (f" stopped={report.stopped}" if report.stopped else "")
        )
        for row in report.rows:
            self.stdout.write(
                f"  {row['kind']}#{row['id']} {row['order_id']} {row.get('state', '-')} -> {row.get('result', '-')}"
                + (f" ({row['detail']})" if row.get("detail") else "")
            )
