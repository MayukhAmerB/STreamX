"""Platform plans: what they cost, whether they can be bought, what they cover.

Every rule about Bootcamp / Lifetime (one-time) and the memberships
(subscriptions) lives here:

* the seed rows (proposed INR prices, all shipped **disabled and unconfirmed**);
* whether a plan can be bought now (``plan_gate``): the ``pentesting`` switch
  for plans that include Pentesting courses, the ``memberships`` switch for
  subscriptions, then the plan's own confirmed price and ``is_enabled``;
* the public card payload (``public_plan``): the price is shown only once the
  owner confirmed it (BUILD_PLAN D10);
* the courses a plan unlocks (``plan_scope_course_ids``) and the monthly
  membership bundle (IST calendar month).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.courses.models import Course

from .models import MembershipBundle, PlatformPlan
from .plans import format_inr, to_paise, to_rupees

IST = ZoneInfo("Asia/Kolkata")

STATE_AVAILABLE = "available"
STATE_COMING_SOON = "coming_soon"
STATE_UNAVAILABLE = "unavailable"

CODE_FEATURE_DISABLED = "feature_disabled"
CODE_PRICE_UNCONFIRMED = "price_unconfirmed"
CODE_PLAN_DISABLED = "plan_disabled"

PRICE_AT_LAUNCH = "Price at launch"
UNCONFIRMED_REASON = "Opens once the price is confirmed."
DISABLED_REASON = "This plan is not open yet."

PERIOD_LABELS = {
    PlatformPlan.PERIOD_MONTHLY: "/month",
    PlatformPlan.PERIOD_YEARLY: "/year",
    PlatformPlan.PERIOD_NONE: "one-time",
}

FREE_PLAN_KEY = "free"
FREE_PLAN_HREF = "/osint/free"

# ---------------------------------------------------------------------------
# Seed (proposed prices = half of the reference tiers; owner decision Q1)
# ---------------------------------------------------------------------------
FOUNDATIONS_SLUGS = ("pt-security-thinking", "pt-command-line", "pt-os-internals", "pt-packets")

MEMBERSHIP_BENEFITS = (
    "Every paid lab, from expert to professional",
    "New investigation cases every month",
    "Monthly live OSINT CTF with a members' leaderboard",
    "Hints, and official write-ups and video walkthroughs once a case retires",
    "The OSINT certification exam",
    "XP, badges and rank",
    "Members' community and live Q&A",
    "Toolkits and cheat sheets",
    "This month's course bundle: class recordings picked each month",
)

SEED_PLANS = (
    {
        "key": "ctf_starter_monthly",
        "product": PlatformPlan.PRODUCT_CTF_STARTER,
        "title": "Starter",
        "subtitle": "Easy and medium labs, plus the class recordings of one batch.",
        "badge": "",
        "cta_label": "Start Starter",
        "price_inr": Decimal("500.00"),
        "billing_period": PlatformPlan.PERIOD_MONTHLY,
        "display_order": 20,
        "highlighted": False,
        "features": [
            {"text": "Easy and medium challenges in the labs", "included": True},
            {"text": "Recorded classes of one batch", "included": True},
            {"text": "Progress and XP on every challenge", "included": True},
            {"text": "Expert and professional labs", "included": False},
            {"text": "Live classes, reports, exams and certificates", "included": False},
        ],
    },
    {
        "key": "ctf_labs_monthly",
        "product": PlatformPlan.PRODUCT_CTF_LABS,
        "title": "CTF Labs membership",
        "subtitle": "Every lab, new cases each month and a course bundle that changes monthly.",
        "badge": "Most complete",
        "cta_label": "Join the labs",
        "price_inr": Decimal("1649.00"),
        "billing_period": PlatformPlan.PERIOD_MONTHLY,
        "display_order": 30,
        "highlighted": True,
        "features": [{"text": text, "included": True} for text in MEMBERSHIP_BENEFITS],
    },
    {
        "key": "pentesting_bootcamp",
        "product": PlatformPlan.PRODUCT_PT_BOOTCAMP,
        "title": "Foundations Bootcamp",
        "subtitle": "The four Foundations courses, yours for life.",
        "badge": "",
        "cta_label": "Start bootcamp",
        "price_inr": Decimal("1649.00"),
        "billing_period": PlatformPlan.PERIOD_NONE,
        "display_order": 40,
        "highlighted": False,
        "features": [
            {"text": "Security thinking, the command line, OS internals, packets", "included": True},
            {"text": "Lifetime access to these four courses", "included": True},
            {"text": "Offensive, defensive and advanced tiers", "included": False},
        ],
        "course_slugs": FOUNDATIONS_SLUGS,
    },
    {
        "key": "pentesting_membership_monthly",
        "product": PlatformPlan.PRODUCT_PT_MEMBERSHIP,
        "title": "Pentesting membership",
        "subtitle": "Every Pentesting course while you are a member.",
        "badge": "Best way to start",
        "cta_label": "Become a member",
        "price_inr": Decimal("1649.00"),
        "billing_period": PlatformPlan.PERIOD_MONTHLY,
        "display_order": 50,
        "highlighted": True,
        "include_future": True,
        "features": [
            {"text": "All five tiers, including new courses as they open", "included": True},
            {"text": "Cancel any time; access runs to the end of the paid month", "included": True},
            {"text": "Live OSINT cohorts", "included": False},
        ],
    },
    {
        "key": "pentesting_membership_yearly",
        "product": PlatformPlan.PRODUCT_PT_MEMBERSHIP,
        "title": "Pentesting membership (yearly)",
        "subtitle": "Every Pentesting course, billed once a year.",
        "badge": "Save 40%",
        "cta_label": "Become a member",
        "price_inr": Decimal("11899.00"),
        "billing_period": PlatformPlan.PERIOD_YEARLY,
        "display_order": 51,
        "highlighted": False,
        "include_future": True,
        "features": [
            {"text": "All five tiers, including new courses as they open", "included": True},
            {"text": "One payment a year", "included": True},
            {"text": "Live OSINT cohorts", "included": False},
        ],
    },
    {
        "key": "pentesting_lifetime",
        "product": PlatformPlan.PRODUCT_PT_LIFETIME,
        "title": "Lifetime",
        "subtitle": "Every Pentesting course, now and later, for one payment.",
        "badge": "",
        "cta_label": "Get lifetime access",
        "price_inr": Decimal("8399.00"),
        "billing_period": PlatformPlan.PERIOD_NONE,
        "display_order": 60,
        "highlighted": False,
        "include_future": True,
        "features": [
            {"text": "Every Pentesting course, including future ones", "included": True},
            {"text": "No renewals", "included": True},
            {"text": "Live OSINT cohorts", "included": False},
        ],
    },
)


def seed_platform_plans(*, apply: bool = False) -> dict:
    """Create the missing seed plans (never edits an existing row). Returns a report."""
    report = {"create": [], "exists": []}
    existing = set(PlatformPlan.objects.filter(key__in=[row["key"] for row in SEED_PLANS]).values_list("key", flat=True))
    for row in SEED_PLANS:
        (report["exists"] if row["key"] in existing else report["create"]).append(row["key"])
    if not apply or not report["create"]:
        return report
    with transaction.atomic():
        for row in SEED_PLANS:
            if row["key"] not in report["create"]:
                continue
            data = {key: value for key, value in row.items() if key not in {"course_slugs", "highlighted"}}
            group = PlatformPlan.group_for(row["product"])
            highlighted = bool(row.get("highlighted")) and not PlatformPlan.objects.filter(
                catalog_group=group, highlighted=True
            ).exists()
            plan = PlatformPlan(**data, highlighted=highlighted, is_enabled=False)
            plan.save()
            slugs = row.get("course_slugs") or ()
            if slugs:
                plan.courses.set(Course.objects.filter(slug__in=slugs))
    return report


# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------
def _pentesting_on() -> bool:
    from apps.courses.features import pentesting_enabled

    return pentesting_enabled()


def _memberships_on() -> bool:
    from .features import memberships_enabled

    return memberships_enabled()


def plan_gate(plan: PlatformPlan) -> tuple[str, str, str]:
    """(state, code, reason) for buying ``plan`` now; ("available", "", "") when it can be bought."""
    from apps.core import features

    if plan.includes_pentesting and not _pentesting_on():
        return STATE_COMING_SOON, CODE_FEATURE_DISABLED, features.reason_for("pentesting")
    if plan.is_subscription and not _memberships_on():
        return STATE_COMING_SOON, CODE_FEATURE_DISABLED, features.reason_for("memberships")
    if not plan.price_is_confirmed:
        return STATE_COMING_SOON, CODE_PRICE_UNCONFIRMED, UNCONFIRMED_REASON
    if not plan.is_enabled or plan.enable_blockers():
        return STATE_COMING_SOON, CODE_PLAN_DISABLED, DISABLED_REASON
    return STATE_AVAILABLE, "", ""


def gate_feature_key(plan: PlatformPlan) -> str | None:
    """The switch currently blocking ``plan``, if any (for the 403 body)."""
    if plan.includes_pentesting and not _pentesting_on():
        return "pentesting"
    if plan.is_subscription and not _memberships_on():
        return "memberships"
    return None


def pending_confirmation_count() -> int:
    """Plans still waiting for the owner to confirm a price (admin home queue)."""
    plans = PlatformPlan.objects.only("price_inr", "confirmed_price", "price_confirmed_at")
    return sum(1 for plan in plans if not plan.price_is_confirmed)


@transaction.atomic
def confirm_price(plan: PlatformPlan, *, by) -> PlatformPlan:
    """Record that the owner confirmed the plan's current INR price (does not enable it)."""
    from django.core.exceptions import ValidationError

    plan = PlatformPlan.objects.select_for_update().get(pk=plan.pk)
    if plan.price_inr is None or plan.price_inr <= 0:
        raise ValidationError("Set a price above zero before confirming it.")
    plan.confirmed_price = plan.price_inr
    plan.price_confirmed_at = timezone.now()
    plan.price_confirmed_by = by if getattr(by, "pk", None) else None
    plan.save()
    return plan


# ---------------------------------------------------------------------------
# Scope: which courses a plan unlocks
# ---------------------------------------------------------------------------
def plan_scope_course_ids(plan: PlatformPlan) -> set[int]:
    if plan.product in PlatformPlan.OSINT_PRODUCTS:
        return set()
    ids = set(plan.courses.values_list("id", flat=True))
    if plan.include_future:
        ids.update(
            Course.objects.filter(category=Course.CATEGORY_WEB_PENTESTING, is_published=True).values_list(
                "id", flat=True
            )
        )
    return ids


def plan_covers_course(plan: PlatformPlan, course) -> bool:
    if plan.product in PlatformPlan.OSINT_PRODUCTS:
        return False
    if plan.include_future and course.category == Course.CATEGORY_WEB_PENTESTING and course.is_published:
        return True
    return plan.courses.filter(pk=course.pk).exists()


# ---------------------------------------------------------------------------
# Monthly membership bundle (IST calendar month)
# ---------------------------------------------------------------------------
def ist_month_start(at=None) -> date:
    return timezone.localtime(at or timezone.now(), IST).date().replace(day=1)


def current_bundle(at=None) -> MembershipBundle | None:
    return (
        MembershipBundle.objects.filter(month=ist_month_start(at), status=MembershipBundle.STATUS_PUBLISHED)
        .prefetch_related("courses")
        .first()
    )


def bundle_course_ids(at=None) -> set[int]:
    """Courses whose recordings CTF Labs members may play now: this month's bundle + always-included."""
    ids = set(
        Course.objects.filter(
            membership_bundles__month=ist_month_start(at),
            membership_bundles__status=MembershipBundle.STATUS_PUBLISHED,
        ).values_list("id", flat=True)
    )
    ids.update(Course.objects.filter(membership_always_included=True).values_list("id", flat=True))
    return ids


@transaction.atomic
def copy_previous_bundle(month: date, *, by=None) -> MembershipBundle:
    """Create (or fill an empty draft for) ``month`` from the latest earlier bundle."""
    month = month.replace(day=1)
    bundle, _created = MembershipBundle.objects.select_for_update().get_or_create(month=month)
    previous = MembershipBundle.objects.filter(month__lt=month).order_by("-month").first()
    if previous is not None and not bundle.courses.exists():
        bundle.courses.set(previous.courses.all())
        if not bundle.note:
            bundle.note = f"Copied from {previous.month:%Y-%m}"
            bundle.save(update_fields=["note", "updated_at"])
    return bundle


@transaction.atomic
def publish_bundle(bundle: MembershipBundle, *, by=None) -> MembershipBundle:
    bundle = MembershipBundle.objects.select_for_update().get(pk=bundle.pk)
    bundle.status = MembershipBundle.STATUS_PUBLISHED
    bundle.published_at = timezone.now()
    bundle.published_by = by if getattr(by, "pk", None) else None
    bundle.save(update_fields=["status", "published_at", "published_by", "updated_at"])
    return bundle


# ---------------------------------------------------------------------------
# Public payload (contract §1 PlanPublic)
# ---------------------------------------------------------------------------
def _price_fields(plan: PlatformPlan) -> dict:
    if not plan.price_is_confirmed:
        return {"price": None, "price_label": PRICE_AT_LAUNCH}
    return {"price": format(to_rupees(plan.price_inr), ".2f"), "price_label": format_inr(plan.price_inr)}


def free_plan_payload(*, directory_count: int = 0) -> dict:
    return {
        "key": FREE_PLAN_KEY,
        "product": "free",
        "group": PlatformPlan.GROUP_OSINT,
        "kind": "free",
        "title": "Free",
        "subtitle": "A guided directory of free OSINT challenges and the monthly community CTF.",
        "badge": "",
        "highlighted": False,
        "display_order": 0,
        "cta_label": "Start free",
        "billing_period": PlatformPlan.PERIOD_NONE,
        "price": "0.00",
        "price_label": "Free",
        "period_label": "forever",
        "currency": "INR",
        "features": [
            {"text": f"{directory_count} hand-picked free challenges" if directory_count else "Hand-picked free challenges", "included": True},
            {"text": "Our learning path, progress tracking and XP", "included": True},
            {"text": "The monthly community CTF", "included": True},
            {"text": "Members-only labs", "included": False},
        ],
        "state": STATE_AVAILABLE,
        "code": "",
        "reason": "",
        "entitlements": [],
        "starter_course": None,
        "included_this_month": None,
        "href": FREE_PLAN_HREF,
    }


def public_plan(plan: PlatformPlan, *, bundle_courses=None) -> dict:
    state, code, reason = plan_gate(plan)
    payload = {
        "key": plan.key,
        "product": plan.product,
        "group": plan.catalog_group or PlatformPlan.group_for(plan.product),
        "kind": plan.kind or PlatformPlan.kind_for(plan.product),
        "title": plan.title,
        "subtitle": plan.subtitle,
        "badge": plan.badge,
        "highlighted": bool(plan.highlighted),
        "display_order": int(plan.display_order),
        "cta_label": plan.cta_label or "Choose plan",
        "billing_period": plan.billing_period,
        **_price_fields(plan),
        "period_label": PERIOD_LABELS.get(plan.billing_period, ""),
        "currency": "INR",
        "features": list(plan.features or []),
        "state": state,
        "code": code,
        "reason": reason,
        "entitlements": plan.entitlement_keys(),
        "starter_course": (
            {"id": plan.starter_course_id, "title": plan.starter_course.title}
            if plan.product == PlatformPlan.PRODUCT_CTF_STARTER and plan.starter_course_id
            else None
        ),
        "included_this_month": None,
        "href": None,
    }
    if plan.product == PlatformPlan.PRODUCT_CTF_LABS:
        payload["included_this_month"] = {
            "month": ist_month_start().strftime("%Y-%m"),
            "courses": list(bundle_courses or []),
        }
    return payload


def public_plans(*, directory_count: int = 0) -> list[dict]:
    plans = list(PlatformPlan.objects.select_related("starter_course").order_by("display_order", "id"))
    bundle_courses = None
    if any(plan.product == PlatformPlan.PRODUCT_CTF_LABS for plan in plans):
        bundle_courses = [
            {"id": row["id"], "title": row["title"]}
            for row in Course.objects.filter(id__in=bundle_course_ids()).order_by("title").values("id", "title")
        ]
    return [free_plan_payload(directory_count=directory_count)] + [
        public_plan(plan, bundle_courses=bundle_courses) for plan in plans
    ]


def plan_amount_paise(plan: PlatformPlan) -> int:
    return to_paise(plan.price_inr)


def total_count_for(plan: PlatformPlan) -> int:
    if plan.billing_period == PlatformPlan.PERIOD_YEARLY:
        return int(getattr(settings, "MEMBERSHIP_TOTAL_COUNT_YEARLY", 10))
    return int(getattr(settings, "MEMBERSHIP_TOTAL_COUNT_MONTHLY", 120))
