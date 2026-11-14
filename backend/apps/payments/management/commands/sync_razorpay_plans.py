"""Create Razorpay plans for confirmed subscription plans that have no plan id yet.

Razorpay plans are immutable: a confirmed price gets its own plan. Dry run
unless --apply. Never enables a plan (the owner does that in admin).
"""

from django.core.management.base import BaseCommand

from apps.payments.models import PlatformPlan
from apps.payments.plans import to_paise
from apps.payments.services import RazorpayServiceError, create_razorpay_plan


class Command(BaseCommand):
    help = "Create Razorpay plans for confirmed, id-less subscription plans (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        plans = [
            plan
            for plan in PlatformPlan.objects.filter(kind=PlatformPlan.KIND_SUBSCRIPTION, razorpay_plan_id="")
            if plan.price_is_confirmed and plan.billing_period in (PlatformPlan.PERIOD_MONTHLY, PlatformPlan.PERIOD_YEARLY)
        ]
        if not plans:
            self.stdout.write("Nothing to create: no confirmed subscription plan is missing a Razorpay plan id.")
            return
        for plan in plans:
            line = f"  {plan.key}: {plan.billing_period} INR {plan.price_inr}"
            if not options["apply"]:
                self.stdout.write(line + " (dry run)")
                continue
            try:
                remote = create_razorpay_plan(
                    period=plan.billing_period,
                    interval=1,
                    amount_paise=to_paise(plan.price_inr),
                    name=plan.title,
                    description=plan.subtitle,
                    notes={"plan_key": plan.key},
                )
            except RazorpayServiceError as exc:
                self.stderr.write(f"{line}: failed ({exc})")
                continue
            PlatformPlan.objects.filter(pk=plan.pk, razorpay_plan_id="").update(razorpay_plan_id=remote["id"])
            self.stdout.write(f"{line}: created {remote['id']}")
