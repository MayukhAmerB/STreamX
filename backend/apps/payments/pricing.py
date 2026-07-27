from decimal import Decimal

from django.conf import settings


FULL_PLAN = "full"
MONTHLY_PLAN = "monthly"


def get_plan_amount(plan):
    setting_name = (
        "COURSE_MONTHLY_PRICE_INR"
        if plan == MONTHLY_PLAN
        else "COURSE_FULL_PRICE_INR"
    )
    return Decimal(str(getattr(settings, setting_name)))


def get_plan_amount_paise(plan):
    return int(get_plan_amount(plan) * 100)
