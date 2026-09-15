from decimal import Decimal

FULL_PLAN = "full"
MONTHLY_PLAN = "monthly"
BUNDLE_PLAN = "bundle"


def get_plan_amount(course, plan):
    if plan == MONTHLY_PLAN:
        amount = course.monthly_price
    elif plan == BUNDLE_PLAN:
        amount = course.bundle_price
    elif plan == FULL_PLAN:
        amount = course.price
    else:
        raise ValueError("Unsupported payment plan.")
    return Decimal(str(amount))


def get_plan_amount_paise(course, plan):
    return int(get_plan_amount(course, plan) * 100)


def get_plan_terms(course, plan):
    return {
        "installments": course.bundle_installments
        if plan == BUNDLE_PLAN
        else course.installments_required
        if plan == MONTHLY_PLAN
        else 1,
        "access_days": course.bundle_access_days
        if plan == BUNDLE_PLAN
        else course.installment_access_days
        if plan == MONTHLY_PLAN
        else 0,
        "start_date": course.start_date.isoformat() if course.start_date else None,
    }
