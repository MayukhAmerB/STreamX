"""Payment plan catalog: the single source of truth for what a course sells.

Every rule about payment plans lives here and nowhere else:

* which plans exist and which Course fields hold each plan's switch, price,
  installment count and access window (``CATALOG``);
* the amount a plan charges, in rupees (``Decimal``) and paise (``int``);
* the terms snapshotted onto a Payment when its order is created;
* whether a course is open for purchase, and whether one user may buy one plan;
* the admin-configurable payment card for each plan (title, subtitle, feature
  bullets, badge, highlight, position, button label) with defaults computed at
  read time, so courses saved before cards existed render exactly as before;
* validation of a course's card configuration (2 to 4 cards, or none).

Price rule: a plan's amount is fixed when its order is created. It is stored on
``Payment.amount`` (and in the Razorpay order) and its access terms on
``Payment.terms_snapshot``. Verification, webhooks, reconciliation and
provisioning only ever compare against that stored order, never the live
catalog, so editing a price changes orders created afterwards and nothing else.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from config.model_validators import validate_no_active_content
from django.conf import settings
from django.core.exceptions import ValidationError

from apps.courses.models import Course, Enrollment

from .models import BatchPass, Payment

MONTHLY_PLAN = Payment.PLAN_MONTHLY
FULL_PLAN = Payment.PLAN_FULL
BUNDLE_PLAN = Payment.PLAN_BUNDLE
BATCH_PASS_PLAN = Payment.PLAN_BATCH_PASS

CURRENCY = "INR"
CENT = Decimal("0.01")
MIN_CARDS = 2
MAX_CARDS = 4


@dataclass(frozen=True)
class PlanSpec:
    plan: str
    admin_label: str
    enabled_field: str
    price_field: str
    installments_field: str | None
    access_days_field: str | None
    default_order: int
    # plan_label on payment receipts; existing clients (mobile) display it verbatim.
    receipt_label: str

    @property
    def is_installment(self):
        return self.installments_field is not None


CATALOG = (
    PlanSpec(
        plan=MONTHLY_PLAN,
        admin_label="Monthly installments (EMI)",
        enabled_field="installment_payment_enabled",
        price_field="monthly_price",
        installments_field="installments_required",
        access_days_field="installment_access_days",
        default_order=1,
        receipt_label="Plan 1 - Monthly Payment",
    ),
    PlanSpec(
        plan=FULL_PLAN,
        admin_label="One-time payment (lifetime)",
        enabled_field="full_payment_enabled",
        price_field="price",
        installments_field=None,
        access_days_field=None,
        default_order=2,
        receipt_label="Plan 2 - One-Time Payment",
    ),
    PlanSpec(
        plan=BUNDLE_PLAN,
        admin_label="Bundle",
        enabled_field="bundle_payment_enabled",
        price_field="bundle_price",
        installments_field="bundle_installments",
        access_days_field="bundle_access_days",
        default_order=3,
        receipt_label="3-Month Bundle",
    ),
    PlanSpec(
        plan=BATCH_PASS_PLAN,
        admin_label="All future batches pass",
        enabled_field="batch_pass_payment_enabled",
        price_field="batch_pass_price",
        installments_field=None,
        access_days_field=None,
        default_order=4,
        receipt_label="Plan 3 - All Future Batches Pass",
    ),
)
PLANS = {spec.plan: spec for spec in CATALOG}
PLAN_IDS = tuple(PLANS)
# One payment unlocks the course for life.
PERMANENT_PLANS = tuple(spec.plan for spec in CATALOG if not spec.is_installment)
# Each payment unlocks a time window; paying every installment makes it lifetime.
INSTALLMENT_PLANS = tuple(spec.plan for spec in CATALOG if spec.is_installment)


def get_plan_spec(plan):
    try:
        return PLANS[plan]
    except KeyError:
        raise ValueError("Unsupported payment plan.") from None


# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------


def to_rupees(value):
    """Exact two-decimal rupee amount; never a float."""
    try:
        amount = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0.00")
    if not amount.is_finite():
        return Decimal("0.00")
    return amount.quantize(CENT, rounding=ROUND_HALF_UP)


def to_paise(value):
    return int((to_rupees(value) * 100).to_integral_value())


def get_plan_amount(course, plan):
    """Rupees charged by one payment of ``plan`` at the current catalog price."""
    return to_rupees(getattr(course, get_plan_spec(plan).price_field))


def get_plan_amount_paise(course, plan):
    return to_paise(get_plan_amount(course, plan))


def get_plan_installments(course, plan):
    spec = get_plan_spec(plan)
    if not spec.is_installment:
        return 1
    return max(int(getattr(course, spec.installments_field) or 1), 1)


def get_plan_access_days(course, plan):
    """Days each payment unlocks; 0 means lifetime."""
    spec = get_plan_spec(plan)
    if not spec.access_days_field:
        return 0
    return max(int(getattr(course, spec.access_days_field) or 1), 1)


def get_plan_terms(course, plan):
    """Access terms frozen onto the Payment when its order is created.

    Provisioning and refunds read ``installments``/``access_days``/``start_date``
    from the snapshot, so later catalog edits never change a bought plan.
    """
    return {
        "installments": get_plan_installments(course, plan),
        "access_days": get_plan_access_days(course, plan),
        "start_date": course.start_date.isoformat() if course.start_date else None,
        "amount": format(get_plan_amount(course, plan), ".2f"),
        "title": card_config(course, plan)["title"],
    }


def is_plan_enabled(course, plan):
    """The admin switched the plan on and gave it a positive price."""
    spec = get_plan_spec(plan)
    return bool(getattr(course, spec.enabled_field, False)) and get_plan_amount(course, plan) > 0


def enabled_plan_ids(course):
    return [spec.plan for spec in CATALOG if is_plan_enabled(course, spec.plan)]


# ---------------------------------------------------------------------------
# Can this course / this user buy?
# ---------------------------------------------------------------------------

COURSE_BLOCK_MESSAGES = {
    "checkout_disabled": "Online enrollment is temporarily unavailable.",
    "course_unpublished": "This course is not open for enrollment.",
    "course_not_live": "Enrollment for this course opens soon.",
    "registration_closed": "Registration for this batch is closed.",
    "price_not_configured": "Pricing will be announced soon.",
}
INSTRUCTOR_OWN_COURSE_MESSAGE = "Instructors cannot purchase their own course."
OWNS_PASS_MESSAGE = "You already hold the all future batches pass."
OWNS_COURSE_MESSAGE = "You already have access to this course."
OWNS_LIFETIME_MESSAGE = "You already have lifetime access to this course."


def course_open_for_enrollment(course):
    return bool(
        course.is_published
        and course.launch_status == Course.STATUS_LIVE
        and not course.registration_closed
    )


def course_purchase_block(course):
    """Machine code for why nobody can buy this course right now, or ""."""
    if not getattr(settings, "DIRECT_COURSE_PAYMENTS_ENABLED", False):
        return "checkout_disabled"
    if not course.is_published:
        return "course_unpublished"
    if course.launch_status != Course.STATUS_LIVE:
        return "course_not_live"
    if course.registration_closed:
        return "registration_closed"
    if not enabled_plan_ids(course):
        return "price_not_configured"
    return ""


_UNSET = object()


def _authenticated(user):
    return bool(user is not None and getattr(user, "is_authenticated", False))


def _user_enrollment(user, course):
    return Enrollment.objects.filter(user=user, course=course).first()


def user_has_active_pass(user):
    return _authenticated(user) and BatchPass.objects.filter(user=user, is_active=True).exists()


def user_owned_plan_message(course, plan, user, *, enrollment=_UNSET, has_active_pass=_UNSET):
    """Why a signed-in user already owns what ``plan`` would sell, or None.

    Guests are identified only by a typed email, so they never get an answer
    here: telling them would disclose what any email has bought. A guest's
    duplicate one-time purchase is caught after capture instead
    (entitlements.is_duplicate_guest_purchase).
    """
    if not _authenticated(user):
        return None
    if plan == BATCH_PASS_PLAN:
        # Lifetime course access alone does not include future batches, so
        # those students may still upgrade; only an existing pass blocks.
        owns_pass = user_has_active_pass(user) if has_active_pass is _UNSET else has_active_pass
        return OWNS_PASS_MESSAGE if owns_pass else None
    if enrollment is _UNSET:
        enrollment = _user_enrollment(user, course)
    if not enrollment or not enrollment.has_active_access():
        return None
    if plan == FULL_PLAN:
        return OWNS_COURSE_MESSAGE
    if enrollment.access_type in (Enrollment.ACCESS_LEGACY, Enrollment.ACCESS_LIFETIME):
        # A running installment plan may keep paying; permanent access may not.
        return OWNS_LIFETIME_MESSAGE
    return None


def plan_unavailable_reason(course, plan, user=None, *, course_block=_UNSET, enrollment=_UNSET, has_active_pass=_UNSET):
    """Human-readable reason this viewer cannot buy ``plan`` now, or None."""
    block = course_purchase_block(course) if course_block is _UNSET else course_block
    if block:
        return COURSE_BLOCK_MESSAGES.get(block, COURSE_BLOCK_MESSAGES["course_unpublished"])
    if not is_plan_enabled(course, plan):
        return "This plan is not offered for this course."
    if _authenticated(user) and user.id == course.instructor_id:
        return INSTRUCTOR_OWN_COURSE_MESSAGE
    return user_owned_plan_message(
        course, plan, user, enrollment=enrollment, has_active_pass=has_active_pass
    )


# ---------------------------------------------------------------------------
# Payment cards: admin-configurable presentation with read-time defaults
# ---------------------------------------------------------------------------

CARD_TEXT_LIMITS = {"title": 60, "subtitle": 120, "badge": 30, "cta_label": 40}
CARD_KEYS = ("title", "subtitle", "features", "badge", "highlighted", "order", "cta_label")
MAX_CARD_FEATURES = 6
MAX_FEATURE_LENGTH = 120
DEFAULT_CTA_LABEL = "Enroll Now"
# The plan picker showed these when a course had no catalog features.
FALLBACK_CARD_FEATURES = (
    "Complete configured course curriculum",
    "Access issued after verified payment",
    "Server-authoritative pricing",
    "Razorpay-secured checkout",
)
DEFAULT_CARD_FEATURE_COUNT = 4


def format_inr(value):
    """Indian-grouped rupees: ₹1,500 / ₹1,00,000 / ₹1,499.50."""
    amount = to_rupees(value)
    sign = "-" if amount < 0 else ""
    amount = abs(amount)
    whole, _, fraction = format(amount, ".2f").partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join([*groups, tail])
    text = f"₹{whole}" if fraction == "00" else f"₹{whole}.{fraction}"
    return f"{sign}{text}"


def _plural(count, singular, plural=None):
    return singular if count == 1 else (plural or f"{singular}s")


def _default_card_features(course):
    configured = getattr(course, "course_card_features", None)
    titles = []
    if isinstance(configured, list):
        for item in configured:
            title = str(item.get("title") or "").strip() if isinstance(item, dict) else ""
            if title:
                titles.append(title[:MAX_FEATURE_LENGTH])
    return titles[:DEFAULT_CARD_FEATURE_COUNT] or list(FALLBACK_CARD_FEATURES)


def _bundle_title(access_days):
    return "3-Month Bundle" if access_days == 90 else f"{access_days}-Day Bundle"


def default_card(course, plan):
    """The card a plan shows when the admin has not overridden anything.

    Reproduces the plan picker's hard-coded cards for existing courses.
    """
    spec = get_plan_spec(plan)
    installments = get_plan_installments(course, plan)
    access_days = get_plan_access_days(course, plan)
    if plan == MONTHLY_PLAN:
        title = "Monthly"
        subtitle = f"{installments} monthly {_plural(installments, 'payment')}"
    elif plan == BUNDLE_PLAN:
        title = _bundle_title(access_days)
        subtitle = f"{installments} bundle {_plural(installments, 'payment')}"
    elif plan == FULL_PLAN:
        title = "One-Time"
        subtitle = "Paid once"
    else:
        title = "All Future Batches"
        subtitle = "Paid once"
    return {
        "title": title,
        "subtitle": subtitle,
        "features": _default_card_features(course),
        "badge": "Lifetime access" if plan == FULL_PLAN else "",
        "highlighted": plan == FULL_PLAN,
        "order": spec.default_order,
        "cta_label": DEFAULT_CTA_LABEL,
    }


def _clean_text(value, key, plan):
    text = " ".join(str(value or "").split())
    limit = CARD_TEXT_LIMITS[key]
    if len(text) > limit:
        raise ValidationError(f"{get_plan_spec(plan).admin_label} card: {key.replace('_', ' ')} cannot exceed {limit} characters.")
    validate_no_active_content(text, f"payment_cards.{plan}.{key}")
    return text


def _clean_features(value, plan):
    if isinstance(value, str):
        value = value.splitlines()
    if not isinstance(value, (list, tuple)):
        raise ValidationError(f"{get_plan_spec(plan).admin_label} card: features must be a list of lines.")
    features = [" ".join(str(item or "").split()) for item in value]
    features = [item for item in features if item]
    label = get_plan_spec(plan).admin_label
    if len(features) > MAX_CARD_FEATURES:
        raise ValidationError(f"{label} card: use at most {MAX_CARD_FEATURES} feature bullets ({len(features)} given).")
    for index, feature in enumerate(features):
        if len(feature) > MAX_FEATURE_LENGTH:
            raise ValidationError(
                f"{label} card: feature {index + 1} cannot exceed {MAX_FEATURE_LENGTH} characters."
            )
        validate_no_active_content(feature, f"payment_cards.{plan}.features[{index}]")
    return features


def _clean_order(value, plan):
    if isinstance(value, bool):
        value = None
    try:
        order = int(value)
    except (TypeError, ValueError):
        order = None
    if order is None or not 1 <= order <= MAX_CARDS:
        raise ValidationError(f"{get_plan_spec(plan).admin_label} card: position must be a whole number from 1 to {MAX_CARDS}.")
    return order


def clean_card_value(plan, key, value):
    """Validate and normalize one card override value."""
    if key in CARD_TEXT_LIMITS:
        return _clean_text(value, key, plan)
    if key == "features":
        return _clean_features(value, plan)
    if key == "highlighted":
        if not isinstance(value, bool):
            raise ValidationError(f"{get_plan_spec(plan).admin_label} card: highlighted must be true or false.")
        return value
    if key == "order":
        return _clean_order(value, plan)
    raise ValidationError(f"Unknown payment card setting '{key}'.")


def sanitize_payment_cards(value):
    """Normalize stored card overrides: {plan: {setting: value}}; raises ValidationError."""
    if value in (None, "", {}):
        return {}
    if not isinstance(value, dict):
        raise ValidationError("Payment cards must be an object keyed by plan.")
    cleaned = {}
    for plan, overrides in value.items():
        if plan not in PLANS:
            raise ValidationError(f"Unknown payment plan '{plan}'. Use one of: {', '.join(PLAN_IDS)}.")
        if overrides in (None, {}):
            continue
        if not isinstance(overrides, dict):
            raise ValidationError(f"{get_plan_spec(plan).admin_label} card settings must be an object.")
        plan_cleaned = {}
        for key, item in overrides.items():
            if key not in CARD_KEYS:
                raise ValidationError(f"Unknown payment card setting '{key}'. Use: {', '.join(CARD_KEYS)}.")
            plan_cleaned[key] = clean_card_value(plan, key, item)
        # Blank text and empty bullet lists mean "use the default"; a blank badge means "no badge".
        plan_cleaned = {
            key: item
            for key, item in plan_cleaned.items()
            if key == "badge" or item not in ("", [])
        }
        if plan_cleaned:
            cleaned[plan] = plan_cleaned
    return cleaned


def card_config(course, plan):
    """Defaults merged with the course's stored overrides.

    Invalid stored values (written outside the admin) fall back to the default
    for that one setting instead of breaking the payment page.
    """
    config = default_card(course, plan)
    stored = getattr(course, "payment_cards", None)
    overrides = stored.get(plan) if isinstance(stored, dict) else None
    if not isinstance(overrides, dict):
        return config
    for key, value in overrides.items():
        if key not in CARD_KEYS:
            continue
        try:
            cleaned = clean_card_value(plan, key, value)
        except ValidationError:
            continue
        if key == "badge" or cleaned not in ("", []):
            config[key] = cleaned
    return config


def _price_labels(course, plan, amount):
    installments = get_plan_installments(course, plan)
    if plan == MONTHLY_PLAN:
        price_label = f"{format_inr(amount)} / month"
        unit = _plural(installments, "month")
    elif plan == BUNDLE_PLAN:
        price_label = f"{format_inr(amount)} / installment"
        unit = _plural(installments, "installment")
    else:
        return f"{format_inr(amount)} one payment", None
    if installments <= 1:
        return price_label, None
    return price_label, f"{format_inr(amount * installments)} total over {installments} {unit}"


def _access_label(course, plan):
    access_days = get_plan_access_days(course, plan)
    if plan == MONTHLY_PLAN:
        return f"{access_days}-day access per installment"
    if plan == BUNDLE_PLAN:
        return f"{access_days}-day access window"
    if plan == BATCH_PASS_PLAN:
        return "Lifetime access + every future batch"
    return "Lifetime access"


def resolve_course_plans(course, user=None, *, enrollment=_UNSET, has_active_pass=_UNSET):
    """The payment cards a viewer sees: enabled plans only, priced and ordered.

    Amounts and price/total/access labels are always computed from the
    plan's charged amount, never typed by the admin, so a card can never
    advertise a price different from what create-order charges.
    """
    plan_ids = enabled_plan_ids(course)
    if not plan_ids:
        return []
    course_block = course_purchase_block(course)
    if _authenticated(user) and not course_block:
        if enrollment is _UNSET and any(plan != BATCH_PASS_PLAN for plan in plan_ids):
            enrollment = _user_enrollment(user, course)
        if has_active_pass is _UNSET and BATCH_PASS_PLAN in plan_ids:
            has_active_pass = user_has_active_pass(user)

    ranked = []
    for plan in plan_ids:
        config = card_config(course, plan)
        amount = get_plan_amount(course, plan)
        price_label, total_label = _price_labels(course, plan, amount)
        reason = plan_unavailable_reason(
            course,
            plan,
            user,
            course_block=course_block,
            enrollment=enrollment,
            has_active_pass=has_active_pass,
        )
        sort_key = (config["order"], get_plan_spec(plan).default_order)
        ranked.append(
            (sort_key, {
                "plan": plan,
                "title": config["title"],
                "subtitle": config["subtitle"],
                "amount": format(amount, ".2f"),
                "currency": CURRENCY,
                "price_label": price_label,
                "total_label": total_label,
                "installments": get_plan_installments(course, plan) if get_plan_spec(plan).is_installment else None,
                "access_label": _access_label(course, plan),
                "features": list(config["features"]),
                "badge": config["badge"] or None,
                "highlighted": bool(config["highlighted"]),
                "cta_label": config["cta_label"],
                "order": config["order"],
                "available": reason is None,
                "unavailable_reason": reason,
            })
        )
    cards = [card for _, card in sorted(ranked, key=lambda item: item[0])]
    highlighted_seen = False
    for position, card in enumerate(cards, start=1):
        card["order"] = position
        # Only one card is ever emphasized, even if stored data says otherwise.
        card["highlighted"] = card["highlighted"] and not highlighted_seen
        highlighted_seen = highlighted_seen or card["highlighted"]
    return cards


def payment_cards_per_row(card_count):
    """Grid columns for the plan picker: 2, 3 or 4."""
    return min(max(int(card_count), MIN_CARDS), MAX_CARDS)


# ---------------------------------------------------------------------------
# Validation of a course's card configuration
# ---------------------------------------------------------------------------


def payment_card_errors(course):
    """Every reason the course's payment cards cannot be saved, as messages.

    Rules: an enabled card needs a positive price; a course shows 2 to 4
    cards, or none at all (online purchase disabled, "pricing announced
    soon"); at most one card is highlighted; card positions are unique.
    """
    errors = []
    try:
        sanitize_payment_cards(getattr(course, "payment_cards", None))
    except ValidationError as exc:
        errors.extend(validation_messages(exc))
        return errors

    switched_on = [spec for spec in CATALOG if getattr(course, spec.enabled_field, False)]
    for spec in switched_on:
        if get_plan_amount(course, spec.plan) <= 0:
            errors.append(
                f"{spec.admin_label} card: set a price above ₹0, or untick it to hide the card."
            )
    if errors:
        return errors

    count = len(switched_on)
    if count == 1:
        errors.append(
            f"Show 2 to {MAX_CARDS} payment cards, or none to turn off online purchase for this course. "
            f"Only the {switched_on[0].admin_label} card is on: switch on another card or untick it."
        )

    configs = {spec.plan: card_config(course, spec.plan) for spec in switched_on}
    highlighted = [PLANS[plan].admin_label for plan, config in configs.items() if config["highlighted"]]
    if len(highlighted) > 1:
        errors.append(
            "Only one payment card can be highlighted. Untick 'Highlight' on all but one of: "
            + ", ".join(highlighted)
            + "."
        )
    positions = {}
    for plan, config in configs.items():
        positions.setdefault(config["order"], []).append(PLANS[plan].admin_label)
    for position, labels in sorted(positions.items()):
        if len(labels) > 1:
            errors.append(
                f"Card position {position} is used by more than one card ({', '.join(labels)}). "
                "Give each shown card its own position."
            )
    return errors


def validation_messages(exc):
    if hasattr(exc, "error_dict"):
        return [message for messages in exc.message_dict.values() for message in messages]
    return list(exc.messages)
