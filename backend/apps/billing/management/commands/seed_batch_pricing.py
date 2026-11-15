"""Create the owner's four plans for one batch (a live course).

    python manage.py seed_batch_pricing --course 12            # dry run: prints the plan
    python manage.py seed_batch_pricing --course 12 --apply    # writes it

Idempotent: rows that already exist (matched by key) are reported and left as
they are, so amounts an admin changed later are never overwritten.
"""

from __future__ import annotations

from decimal import Decimal

from django.apps import apps as django_apps
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.billing.models import Plan, PlanEntitlement, PlanFeature, Price, Product

CORE_KEYS = ["free_ctfs", "easy_ctfs", "side_courses"]
EXTRA_KEYS = ["weekly_challenges", "special_ctfs", "resources", "all_labs"]

CORE_FEATURES = ["Live classes (course access)", "Free CTFs", "Easy CTFs", "Side courses that bridge the gap"]
EXTRA_FEATURES = ["Weekly OSINT challenges", "Special OSINT CTFs", "Extra resources", "All labs"]


def batch_spec(course_id: int) -> list[dict]:
    course_key = f"course_access:{course_id}"
    return [
        {
            "key": f"batch-{course_id}-monthly-core",
            "name": "Monthly - Live classes",
            "amount": Decimal("1000.00"),
            "billing_type": Price.RECURRING,
            "interval": Price.MONTH,
            "access_days": 30,
            "keys": [course_key, *CORE_KEYS],
            "features": CORE_FEATURES,
            "highlight": False,
            "badge": "",
            "sort": 10,
        },
        {
            "key": f"batch-{course_id}-monthly-all",
            "name": "Monthly - Everything",
            "amount": Decimal("1500.00"),
            "billing_type": Price.RECURRING,
            "interval": Price.MONTH,
            "access_days": 30,
            "keys": [course_key, *CORE_KEYS, *EXTRA_KEYS],
            "features": ["Everything in the ₹1,000 plan", *EXTRA_FEATURES],
            "highlight": True,
            "badge": "Entire package",
            "sort": 20,
        },
        {
            "key": f"batch-{course_id}-once-course",
            "name": "One-time - Course only",
            "amount": Decimal("3500.00"),
            "billing_type": Price.ONE_TIME,
            "interval": "",
            "access_days": None,
            "keys": [course_key],
            "features": ["The full course (live classes and recordings)", "Lifetime access"],
            "highlight": False,
            "badge": "",
            "sort": 30,
        },
        {
            "key": f"batch-{course_id}-once-all",
            "name": "One-time - Everything",
            "amount": Decimal("4500.00"),
            "billing_type": Price.ONE_TIME,
            "interval": "",
            "access_days": None,
            "keys": [course_key, *CORE_KEYS, *EXTRA_KEYS],
            "features": ["The full course", *CORE_FEATURES[1:], *EXTRA_FEATURES, "Lifetime access"],
            "highlight": True,
            "badge": "Best value",
            "sort": 40,
        },
    ]


def seed_batch_pricing(course_id: int, *, apply: bool = False) -> dict:
    Course = django_apps.get_model("courses", "Course")
    course = Course.objects.filter(pk=course_id).first()
    if course is None:
        raise CommandError(f"Course {course_id} does not exist.")
    product_key = f"batch-{course_id}"
    report = {"product": product_key, "course": course.title, "create": [], "exists": [], "applied": apply}
    product = Product.objects.filter(key=product_key).first()
    (report["exists"] if product else report["create"]).append(f"product {product_key}")
    for spec in batch_spec(course_id):
        exists = Plan.objects.filter(key=spec["key"]).exists()
        line = f"plan {spec['key']}: INR {spec['amount']} {spec['billing_type']} -> {', '.join(spec['keys'])}"
        (report["exists"] if exists else report["create"]).append(line)
    if not apply:
        return report
    with transaction.atomic():
        if product is None:
            product = Product.objects.create(
                key=product_key,
                name=f"{course.title} access"[:200],
                description=f"Access plans for {course.title}.",
                metadata={"course_id": course_id},
            )
        for spec in batch_spec(course_id):
            if Plan.objects.filter(key=spec["key"]).exists():
                continue
            price = Price(
                product=product,
                label=spec["name"],
                amount=spec["amount"],
                currency="INR",
                billing_type=spec["billing_type"],
                interval=spec["interval"],
                interval_count=1,
                access_days=spec["access_days"],
                sort_order=spec["sort"],
                is_highlighted=spec["highlight"],
            )
            price.full_clean()
            price.save()
            plan = Plan.objects.create(
                product=product,
                price=price,
                key=spec["key"],
                name=spec["name"],
                badge=spec["badge"],
                is_highlighted=spec["highlight"],
                sort_order=spec["sort"],
            )
            for index, text in enumerate(spec["features"]):
                PlanFeature.objects.create(plan=plan, text=text, sort_order=index)
            for key in spec["keys"]:
                row = PlanEntitlement(plan=plan, key=key)
                row.full_clean()
                row.save()
    return report


class Command(BaseCommand):
    help = "Create the four batch plans (monthly 1,000 / 1,500, one-time 3,500 / 4,500). Dry run unless --apply."

    def add_arguments(self, parser):
        parser.add_argument("--course", type=int, required=True, help="Course (batch) id.")
        parser.add_argument("--apply", action="store_true", help="Write the changes (default: dry run).")

    def handle(self, *args, **options):
        report = seed_batch_pricing(options["course"], apply=options["apply"])
        mode = "APPLIED" if report["applied"] else "DRY RUN (nothing written; add --apply)"
        self.stdout.write(f"{mode}: {report['product']} for '{report['course']}'")
        for line in report["create"]:
            self.stdout.write(f"  create  {line}")
        for line in report["exists"]:
            self.stdout.write(f"  exists  {line}")
