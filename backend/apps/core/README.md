# `apps.core` — shared reliability foundation (Phase 0)

Building blocks every app can use so failures are handled the same way
everywhere. `apps.core` imports **no other app** (enforced by
`tests/test_architecture.py`); apps depend on core, never the reverse.

| Module | What it is for |
| --- | --- |
| `errors.py` + `exception_handler.py` | One error contract for every raised API error |
| `http.py` + `circuit.py` | Outbound HTTP with mandatory timeouts, safe retries, shared circuit breakers |
| `idempotency.py` (+ `IdempotencyKey`) | `Idempotency-Key` support for unsafe API calls |
| `outbox.py` (+ `OutboxEvent`, `worker.py`) | Transactional outbox for side effects (push, email, webhooks) |
| `health.py` | Liveness / readiness probes behind `/health/live`, `/health/ready` |
| `checks.py` | Startup configuration guard (Django system checks) |
| `concurrency.py` | Distributed lock, single-flight cache fill, per-request memo |

Tests: `tests/test_core_*.py`, `tests/test_architecture.py`; factories for
new tests live in `tests/factories.py`.

---

## 1. Error contract

`REST_FRAMEWORK["EXCEPTION_HANDLER"] = "apps.core.exception_handler.api_exception_handler"`.
Every **raised** error (DRF's own, `Http404`, Django `ValidationError`,
`DomainError`, unhandled exceptions) leaves as:

```json
{
  "success": false,
  "message": "Human sentence safe to show",
  "data": null,
  "errors": { "detail": "Human sentence", "...": "...", "code": "not_found" },
  "code": "not_found",
  "detail": "Human sentence"
}
```

* `errors` keeps `detail` (or the first field error) **first** and `code`
  **last**, because `frontend/src/utils/api.js::apiMessage` shows the first
  value of `errors`.
* Validation errors: field errors are the `errors` keys (`{"email": ["..."]}`),
  `message` is `"Email: <first message>"`.
* Backward compatibility: every top-level key DRF used to emit (`detail`,
  field names, `code`/`terms_version`/`messages` from dict details) is still
  mirrored at the top level unless it collides with an envelope key. Existing
  clients (`data.detail`, `data.errors.detail`, `data.message`,
  `errors.code === "session_replaced"`) keep working; the mobile app's
  `payload.message` now has text for 401/403/404/429 too.
* `429` always has `Retry-After` (header) and `errors.retry_after`.
* `5xx` adds `errors.request_id` (same as the `X-Request-ID` header), is
  logged on `apps.core.errors` with the request id, and **never** contains
  the exception text, SQL or a traceback. Unhandled exceptions still emit
  Django's `got_request_exception` (Sentry capture; test client re-raises).
  With `DEBUG=True` unhandled errors keep Django's technical 500 page.
* A Django `ValidationError` escaping a view is now a `400`, not a `500`.

Stable codes: `validation_failed`, `parse_error`, `not_authenticated`,
`authentication_failed`, `permission_denied`, `csrf_failed`, `not_found`,
`method_not_allowed`, `not_acceptable`, `unsupported_media_type`,
`rate_limited`, `conflict`, `unprocessable`, `upstream_unavailable`,
`upstream_timeout`, `upstream_unreachable`, `upstream_error`,
`upstream_bad_response`, `circuit_open`, `internal_error`,
`idempotency_key_required`, `idempotency_key_invalid`,
`idempotency_in_progress`, `idempotency_key_reused`, plus any explicit code
passed in a dict detail (`terms_acceptance_required`, `token_not_valid`, ...).

Views that already return `api_response(success=False, ...)` are untouched.
New code should **raise** instead:

```python
from apps.core.errors import Conflict, NotFound, ValidationFailed

raise NotFound("Course not found.", code="course_not_found")
raise Conflict("This order was already captured.", code="order_already_captured",
               details={"order_id": order.pk})
raise ValidationFailed(details={"plan": ["Monthly plan is not available for this course."]})
```

## 2. Outbound HTTP (`http.py`, `circuit.py`)

stdlib `urllib` only (no new dependency). Mandatory timeout (0 < t ≤ 120s),
total deadline, retries with exponential backoff + **full jitter** only for
idempotent methods (or `idempotent=True`), per-upstream circuit breaker
stored in the Django cache (shared by all gunicorn workers/replicas; the
half-open probe is single-flight via `cache.add`). Breakers fail open if
Redis is down. Prometheus: `streamx_upstream_requests_total`,
`streamx_upstream_request_latency_seconds`,
`streamx_circuit_breaker_transitions_total`.

```python
from apps.core.http import HttpClient

owncast = HttpClient("owncast", base_url=settings.OWNCAST_ADMIN_API_BASE_URL,
                     timeout=settings.REALTIME_OWNCAST_STATUS_TIMEOUT_SECONDS)
status = owncast.get("/api/status").json()          # retried, breaker-protected

razorpay = HttpClient("razorpay", base_url="https://api.razorpay.com/v1",
                      timeout=settings.RAZORPAY_HTTP_TIMEOUT_SECONDS,
                      auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET))
order = razorpay.post("/orders", json=payload).json()  # POST: never retried
```

Errors are `UpstreamUnavailable` subclasses → a view that lets them
propagate answers `503` + `Retry-After` in the envelope. Tune per upstream in
`settings.CIRCUIT_BREAKERS` (`failure_threshold`, `failure_window_seconds`,
`open_seconds`, `probe_timeout_seconds`). For a non-HTTP dependency (LiveKit
SDK, SMTP) wrap the call: `get_breaker("livekit").call(fn, ...)`.

## 3. Idempotency keys (`idempotency.py`)

Client sends `Idempotency-Key: <uuid>` (CORS already allows it). Stored per
(scope, user-or-client-IP, key) for `IDEMPOTENCY_KEY_TTL_SECONDS` (24h):
replay of the stored response (`Idempotent-Replayed: true`); `409
idempotency_in_progress` + `Retry-After` while the first request runs; `422
idempotency_key_reused` for the same key with a different body; 5xx /
exceptions / 401/403/409/429 release the key so a retry runs again; a
crashed request's lease (`IDEMPOTENCY_LEASE_SECONDS`) is taken over and its
lease token fences the old worker. Atomic via unique constraint +
`select_for_update` + savepointed insert. Expired keys are pruned by the
worker.

```python
from apps.core.idempotency import IdempotencyMixin, idempotent

class CreateOrderView(IdempotencyMixin, APIView):     # mixin FIRST
    idempotency_scope = "payments.create_order"
    idempotency_required = True                        # 400 without the header

class VerifyPaymentView(APIView):
    @idempotent(scope="payments.verify")
    def post(self, request): ...
```

`apps/payments/idempotency.py` is an earlier, payment-specific version of the
same idea (with a checkout row lock); Phase 2 can move `create_order` onto
the mixin and keep only the checkout lock there.

## 4. Transactional outbox (`outbox.py`)

```python
from apps.core.outbox import publish

with transaction.atomic():
    payment.save(update_fields=["status"])
    publish("payments.receipt_email", {"payment_id": payment.pk},
            dedupe_key=f"receipt:{payment.pk}")
```

```python
# apps/<app>/outbox_handlers.py — autodiscovered by CoreConfig.ready()
from apps.core.outbox import PermanentFailure, outbox_handler

@outbox_handler("payments.receipt_email", max_attempts=6)
def send_receipt(event):
    payment = Payment.objects.filter(pk=event.payload["payment_id"]).first()
    if payment is None:
        raise PermanentFailure("payment deleted")
    if payment.receipt_sent_at:                       # idempotent: effect once
        return
    send_receipt_email(payment)
    Payment.objects.filter(pk=payment.pk, receipt_sent_at__isnull=True)...
```

* Delivered by the existing worker containers: `process_async_jobs` now calls
  `apps.core.worker.run_worker_tick` every loop (also `manage.py drain_outbox`).
* `SELECT … FOR UPDATE SKIP LOCKED` claims (two worker replicas never deliver
  the same row); attempts are burnt at claim time; stale claims are reclaimed
  after `OUTBOX_LOCK_TIMEOUT_SECONDS`; failures back off exponentially
  (`OUTBOX_BACKOFF_BASE_SECONDS` … `OUTBOX_MAX_BACKOFF_SECONDS`, equal
  jitter); `max_attempts` → `dead`. Dead letters are visible in Django admin
  (**Platform reliability → Outbox events**) with a *Retry selected events
  now* action (needs `core.change_outboxevent`). Delivered rows are pruned
  after `OUTBOX_RETENTION_DAYS`.
* **Exactly-once effect** = at-least-once delivery + idempotent handler: check
  a marker (column, unique row, upstream Idempotency-Key) before the effect
  and record it after. Keep handlers short; don't hold a DB transaction open
  across the network call.
* **Reference adoption:** `apps/notifications` web push. When web push and
  `ASYNC_JOBS_ENABLED` are on, `create_notification` publishes
  `notifications.web_push` inside the notification's transaction (replacing
  the post-commit `AsyncJob` enqueue); `apps/notifications/outbox_handlers.py`
  skips recipients whose `pushed_at` is already set. With async jobs off the
  push stays synchronous exactly as before.

## 5. Health and readiness (`health.py`)

Paths and payload keys are unchanged (`/health/live`, `/healthz`,
`/health/ready`, `/readyz`; `status`, `checks`, `failures`).

* Liveness: no I/O (Docker healthchecks and the gateway pool use it).
* Readiness, hard (any failure → 503): database, cache (when `REDIS_URL`),
  storage listing, **migrations applied** (re-verified every 5 min once OK),
  **free disk on MEDIA_ROOT** ≥ `HEALTH_MEDIA_MIN_FREE_BYTES` (512 MiB).
* Readiness, soft (reported in `warnings`, never 503): disk below
  `HEALTH_MEDIA_WARN_FREE_BYTES` (5 GiB) and circuit-breaker state of every
  upstream in `upstreams` (read from cache), plus the `HEALTH_SOFT_PROBES`
  (dotted callables returning `(state, details)`, merged into
  `upstreams[<name>]` with `probe`; a state other than `ok`/`off` adds
  `warnings[<name>]`). The only probe today is
  `apps.reports.antivirus.readiness_probe`: a 1 s clamd PING memoised for
  15 s, so a clamd restart is a warning while report uploads alone fail closed.
* Periodic worker hooks: `worker.register_periodic(name, interval_seconds,
  func)` (from an app's `ready()`) runs `func` on a `process_async_jobs` tick
  at most once per interval across all workers. Hooks must be cheap, e.g.
  publish one deduplicated outbox event (the reports re-scan does this).
* Memoised per process for `HEALTH_READINESS_CACHE_SECONDS` (3s) behind a
  lock; `cached: true` marks a memoised answer. Failure texts are exception
  class names in production (no hosts/SQL), full text with `DEBUG`.

## 6. Startup configuration guard (`checks.py`)

`entrypoint.sh` runs `check --deploy --fail-level WARNING` in production, so
a WARNING blocks startup there. Policy: **ERROR** = known-broken, **INFO** =
advisory, no WARNINGs. Deploy checks only fire when `APP_ENV=production`.
Verified: `check --deploy --fail-level WARNING` exits 0 against the
production env file (one INFO, `core.I002`).

| ID | When | Severity |
| --- | --- | --- |
| core.E001 | SECRET_KEY empty/placeholder | Error (deploy) |
| core.E002 | DEBUG on in production | Error (deploy) |
| core.E003 | ALLOWED_HOSTS empty or `*` | Error (deploy) |
| core.E004 | default cache is not Redis | Error (deploy) |
| core.E005 | direct payments on, Razorpay key/secret/webhook secret missing | Error (deploy) |
| core.E006 | TRUST_X_FORWARDED_FOR off in production | Error (deploy) |
| core.E007 | MEDIA_ROOT exists but is not writable | Error (deploy) |
| core.I001 | Razorpay `rzp_test_` key in production | Info (deploy) |
| core.I002 | METRICS_AUTH_TOKEN empty | Info (deploy) |
| core.I003 | console/locmem/dummy EMAIL_BACKEND | Info (deploy) |
| core.I004 | MEDIA_ROOT does not exist yet | Info (deploy) |
| core.E010–E013 | STREAM_RECORDER_* invalid (source URL, absolute work dir, positive limits, space factor ≥ 1) when enabled | Error (always) |
| core.E014 | PROMETHEUS_URL set but not an http(s) URL | Error (always) |
| core.E015 / I015 | TRUSTED_PROXY_COUNT outside 1..5 / above 2 | Error / Info (always) |
| core.E016–E018 | idempotency TTL/lease, outbox attempts, CIRCUIT_BREAKERS options | Error (always) |

## 7. Concurrency helpers (`concurrency.py`)

* `DistributedLock(name, ttl, blocking_timeout)` — with Django's `RedisCache`
  it uses redis-py's `Lock` (SET NX PX + atomic compare-and-delete release;
  the same lock django-redis exposes — django-redis itself is not installed).
  Other backends fall back to `cache.add` + compare/delete (per-process safe).
* `get_or_compute(key, ttl, fn, stale_ttl=…)` — single-flight fill with
  stale-while-revalidate and serve-stale-on-error.
* `@per_request_memo` / `memo_get_or_set` — memo scoped to one request
  (`RequestContextMiddleware` opens the scope; no-op elsewhere).

Ad-hoc versions to migrate later (not edited in Phase 0):
`apps/realtime/services.py` Owncast `/api/status` single-flight
(`OWNCAST_STATUS_LOCK_KEY` + `cache.add`) → `get_or_compute("owncast:status",
ttl, fetch, stale_ttl=…)` with `HttpClient("owncast")`; the many `urlopen`
calls in `apps/realtime/services.py`, `apps/insights/prometheus.py`,
`apps/courses/request_notifications.py` → `HttpClient`; and
`apps/users/refresh_rotation.py` (row locks — keep them; only the
grace-window caching could use `get_or_compute`).

---

## Adoption cheat-sheet for later phases

```python
# payments/views.py — create order
class CreateOrderView(IdempotencyMixin, APIView):
    idempotency_scope = "payments.create_order"
    idempotency_required = True

# payments — Razorpay calls
razorpay = HttpClient("razorpay", base_url=RAZORPAY_API, timeout=settings.RAZORPAY_HTTP_TIMEOUT_SECONDS,
                      auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET))
# provisioning side effects (credentials email, receipts) → publish(...) in the
# same transaction as the paid transition, handlers in payments/outbox_handlers.py

# realtime — Owncast/LiveKit
status = get_or_compute("owncast:status", ttl=3, stale_ttl=30,
                        compute=lambda: HttpClient("owncast", ...).get("/api/status").json())
with DistributedLock(f"egress:{session.pk}", ttl=60, blocking_timeout=0): ...

# courses — raise domain errors instead of api_response(success=False, ...)
raise PermissionDenied("Only the course instructor can edit this course.", code="not_course_instructor")
```

## Roadmap

* **Phase 1 (now possible):** adopt `HttpClient` in `apps/insights/prometheus.py`
  and `apps/courses/request_notifications.py` (WhatsApp webhook → outbox
  event); move remaining `urlopen` callers.
* **Phase 2 — payments:** an explicit `Payment` state machine (created → paid →
  refunded/failed with allowed transitions in one module), plan rules
  (`plans.py`, batch pass, bundles) as the single source used by views,
  admin and provisioning; create-order/verify on `IdempotencyMixin`; Razorpay
  via `HttpClient("razorpay")`; provisioning emails/credentials via the outbox;
  shrink `BULK_UPDATE_ALLOWLIST` (`apps/payments/credentials.py`).
* **Phase 3 — realtime:** split `apps/realtime/services.py` into adapters
  behind small interfaces — `owncast` (status, chat, stream key), `livekit`
  (tokens, rooms), `egress` (start/stop/status), `recording` (recorder,
  publisher) — each with its own `HttpClient`/breaker, `get_or_compute`
  replacing the ad-hoc single-flight and `DistributedLock` for egress/session
  transitions; fakes for tests.
* **Phase 4 — enrollments:** one `grant_enrollment` / `revoke_enrollment`
  service that every path (payment provisioning, batch pass, admin bulk
  actions, refunds) calls, publishing outbox events for notifications and
  cache invalidation, so admin bulk actions trigger the same side effects as
  the API; then drop `Enrollment.objects…update()` outside it.
* **Phase 5 — settings drift:** consolidate `prod.py`'s import-time
  `ImproperlyConfigured` list into `checks.py`, typed settings helpers (floats
  via `env_float`), remove dead settings, document every env var in
  `.env.example`, and add a drift test comparing `.env.example` keys with
  settings reads.
