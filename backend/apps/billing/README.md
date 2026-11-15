# Billing (`apps.billing`)

A generic, reusable billing module: an admin-managed catalogue, server-side
quotes, Razorpay checkout through the existing `apps.payments` integration, and
time-boxed **entitlements** that every other feature checks. Billing knows
nothing about courses, labs or CTFs; those apps react to grants through signals
or ask the service API.

## Concepts

| Model | What it is |
|---|---|
| **Product** | Something we sell: "OSINT Batch IV access", "Labs membership", a future service. `key`, `name`, `description`, `is_active`, free-form `metadata`. |
| **Price** | An amount for a product: `amount` (INR), `currency`, `billing_type` (`one_time` / `recurring` with `interval` month/year and `interval_count`), `access_days` (empty = lifetime for one-time, one interval for recurring), `is_active`, `valid_from` / `valid_to`, `sort_order`, `is_highlighted`. **Versioned**: editing a commercial field of a price that already has purchases archives the old values as an inactive row (`superseded_by` = current) and moves those purchases to it. The current row keeps its id, so every plan uses the new amount on the very next checkout. |
| **Plan** | A named bundle: one price + ordered **feature lines** (display only) + **entitlement keys** (what it unlocks). `is_active` (hide), `is_highlighted`, `badge`, `sort_order`. |
| **Entitlement key** | A free-form string. Built-ins in `registry.py`: `course_access:<course id>`, `free_ctfs`, `easy_ctfs`, `side_courses`, `weekly_challenges`, `special_ctfs`, `resources`, `all_labs`. Admins add more under *Billing > Entitlement keys* (no code change). A key with `takes_argument` is a prefix (`course_access` allows `course_access:12`). |
| **Purchase** | One checkout: user, plan, price, and a **snapshot** of what was charged (amount, currency, billing type, access days, keys, plan name/features), status (`pending` / `paid` / `failed` / `refunded`), period start/end, Razorpay order/payment ids. |
| **Entitlement grant** | User X may use key K from `starts_at` to `ends_at` (empty = lifetime). From a purchase or manual (admin). A renewal starts at `max(now, current end)`, so monthly payments stack back to back. Revocation (refund or admin) sets `revoked_at` / `revoked_by` / `revoke_reason`; rows are never deleted. |

## Service API (`from apps import billing`)

Every feature uses only these:

```python
billing.list_plans(product_key=None, context=None)   # visible plans; context={"course_id": 12} | {"entitlement": "all_labs"} | {"billing_type": "recurring"}
billing.quote(plan_id_or_key, user)                  # Quote(amount, amount_paise, currency, access_days, entitlement_keys, ...) - always from the DB
billing.start_checkout(user, plan_id_or_key)         # pending Purchase + Razorpay order -> {order_id, key_id, amount_paise, ...}
billing.verify_checkout(user, order_id=, payment_id=, signature=)  # browser callback: signature check, then capture
billing.on_payment_captured(CapturedPayment(order_id, payment_id, amount_paise, currency))  # idempotent -> (purchase, changed)
billing.on_payment_refunded(purchase, amount_refunded=None)  # full refund revokes the purchase's grants
billing.has_entitlement(user, key, at=None)          # bool
billing.entitlements_for(user)                       # [{key, label, lifetime, ends_at}]
billing.entitlement_window(user, key)                # {active, lifetime, ends_at} following renewals
billing.grant_manually(user, key, ends_at=None, by=admin) / billing.revoke_grant(grant, by=admin, reason=...)
```

Errors are `billing.BillingError(code, message, status)`.

Signals (`apps.billing.signals`): `entitlement_granted(grant, user, key)`,
`entitlement_revoked(grant, user, key)`, `purchase_paid(purchase)`,
`purchase_refunded(purchase)`. They are sent inside the transaction, each
receiver in its own savepoint; a failing receiver is logged and never loses a
payment (Billing > Entitlement grants > "Re-send hooks" replays it).

## Integrating a new feature in 5 lines

```python
# 1. Admin: add an entitlement key "osint_bootcamp" (Billing > Entitlement keys) and put it on a plan.
# 2. Gate the feature:
from apps import billing
if not billing.has_entitlement(request.user, "osint_bootcamp"):
    raise PermissionDenied("Buy a plan that includes the bootcamp.")
# 3. (Optional) react to grants: @receiver(billing.signals.entitlement_granted) def on_grant(sender, user, key, **kw): ...
```

## What is wired today

* **Courses**: `apps/courses/billing_hooks.py` listens for `course_access:<id>`
  grants and creates or extends the `Enrollment` (lifetime, or time-limited to
  the end of the billing coverage). On revocation it re-derives the enrolment
  with `apps.payments.entitlements.resync_enrollment_access`, and it registers
  billing as a source in `derive_entitlement`, so refunds in either flow only
  remove access nothing else justifies.
* **Labs**: `/api/labs/entitlement/` returns `entitlements` (= `entitlements_for`);
  `all_labs` opens every labs difficulty and `easy_ctfs` the starter tier
  (source `"billing"`), including the signed labs pass.
* **CTF**: `/api/ctf/eligibility/` returns `entitlements`.
* **Payments**: `apps/payments/gateway.py` is the only payments code billing
  calls (order creation + validation, checkout signature, public key id) and a
  registry through which billing claims Razorpay webhooks for its own orders.
  The existing `/api/payment/webhook/` (signature, de-duplication, retries,
  audit) routes an event to billing only after every existing route declined
  it, so course, batch-pass, platform-plan and subscription payments are
  unchanged.

## REST API (`/api/billing/`)

| Method | Path | Auth | Body / query | Returns |
|---|---|---|---|---|
| GET | `plans/` | public | `?product=<key>&course=<id>&entitlement=<key>&billing_type=` | `{plans: [...]}` with price, features, entitlements |
| POST | `quote/` | user | `{plan_id}` (id or key) | the server-side quote |
| POST | `checkout/` | user | `{plan_id}` (any client amount is ignored) | `{purchase_id, order_id, key_id, amount, amount_paise, currency, ...}` for Razorpay Checkout |
| POST | `checkout/verify/` | user | `{order_id, payment_id, signature}` | `{purchase_id, status, entitlements}` |
| GET | `entitlements/` | user | | `{entitlements: [...]}` |

Webhooks: keep pointing Razorpay at `/api/payment/webhook/`; `payment.captured`,
`payment.failed`, `refund.processed` and `payment.refunded` for billing orders
are handled automatically.

## Admin how-to (https://api.alsyedinitiative.com/admin/ > **Billing**)

* **Change a price**: Billing > Prices (or the product's price inline), edit the
  amount, save. The very next quote/checkout uses it (no deploy, no restart, no
  cache). Past purchases keep what they were charged; the old amount appears as
  an "Archived vN" row.
* **Add a plan**: Billing > Plans > Add: pick the product and its current price,
  name, badge, feature lines (ordered), and entitlement keys. Use *Sort order*
  to reorder, untick *Is active* to hide, tick *Is highlighted* to feature it.
* **Add something new to the monthly plan**: add a feature line (what students
  see) and, if it unlocks something, an entitlement key. A brand-new key is
  registered first under Billing > Entitlement keys.
* **Schedule a price**: create a second price with `valid_from`, then point the
  plan at it when it starts (a price outside its window cannot be bought).
* **Purchases** are read-only. Action "Mark refunded (full) and revoke access"
  records an admin refund (do the money refund in Razorpay).
* **Entitlement grants**: Add = manual grant (complimentary, scholarship, fix);
  `granted_by` is recorded. Action "Revoke selected grants" records who and why.
  Grants are never deleted.

## Seeding a batch

```bash
python manage.py seed_batch_pricing --course <course id>            # dry run
python manage.py seed_batch_pricing --course <course id> --apply    # write
```

Creates product `batch-<id>` and four plans:

| Plan key | Price | Access | Unlocks |
|---|---|---|---|
| `batch-<id>-monthly-core` | ₹1,000 / month | 30 days | `course_access:<id>`, `free_ctfs`, `easy_ctfs`, `side_courses` |
| `batch-<id>-monthly-all` | ₹1,500 / month | 30 days | all of the above + `weekly_challenges`, `special_ctfs`, `resources`, `all_labs` |
| `batch-<id>-once-course` | ₹3,500 one-time | lifetime | `course_access:<id>` |
| `batch-<id>-once-all` | ₹4,500 one-time | lifetime | everything |

Idempotent: existing plans (by key) are reported and never overwritten.

## Migrations

`billing/0001_initial` creates new tables only (`billing_*`); no existing table
changes. Rolling the code back to a release without billing leaves the
`billing_*` tables unused and harmless; `python manage.py migrate billing zero`
drops them (only them) while this code is still deployed.

## Tests

`backend/tests/test_billing.py` (Razorpay mocked).
