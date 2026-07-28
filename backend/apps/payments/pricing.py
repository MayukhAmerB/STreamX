from decimal import Decimal

FULL_PLAN = "full"
MONTHLY_PLAN = "monthly"


def get_plan_amount(course, plan):
    if plan == MONTHLY_PLAN:
        amount = course.monthly_price
    elif plan == FULL_PLAN:
        amount = course.price
    else:
        raise ValueError("Unsupported payment plan.")
    return Decimal(str(amount))


def get_plan_amount_paise(course, plan):
    return int(get_plan_amount(course, plan) * 100)
