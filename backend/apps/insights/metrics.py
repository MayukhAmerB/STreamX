"""Application-data aggregations for the admin analytics dashboard.

Every figure is aggregated in the database (Count/Sum grouped by TruncHour or
TruncDay in settings.TIME_ZONE). Time buckets are zero-filled so charts never
have gaps, and deltas compare a range with the immediately preceding period of
equal length.
"""

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone as dt_timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db.models import Count, Sum
from django.db.models.functions import Coalesce, TruncDay, TruncHour
from django.utils import timezone

from apps.campaigns.models import CampaignSiteVisit, CampaignVolunteer
from apps.courses.access import active_enrollment_q
from apps.courses.models import Enrollment, LectureProgress, LiveClassEnrollment, PublicEnrollmentLead
from apps.join_requests.models import JoinApplication
from apps.payments.models import Payment
from apps.realtime.models import RealtimeSession, RealtimeSessionRecording

BUCKET_HOUR = "hour"
BUCKET_DAY = "day"
RANKED_LIMIT = 8


@dataclass(frozen=True)
class RangeSpec:
    key: str
    label: str
    period_label: str
    bucket: str
    bucket_count: int
    hours: int


RANGES = {
    "24h": RangeSpec("24h", "Last 24 hours", "vs previous 24 hours", BUCKET_HOUR, 24, 24),
    "7d": RangeSpec("7d", "Last 7 days", "vs previous 7 days", BUCKET_DAY, 7, 7 * 24),
    "30d": RangeSpec("30d", "Last 30 days", "vs previous 30 days", BUCKET_DAY, 30, 30 * 24),
}
DEFAULT_RANGE = "7d"
RANGE_CHOICES = [(spec.key, spec.label) for spec in RANGES.values()]


@dataclass(frozen=True)
class Window:
    spec: RangeSpec
    start: datetime
    end: datetime
    prev_start: datetime
    prev_end: datetime
    buckets: tuple

    @property
    def bucket(self):
        return self.spec.bucket

    @property
    def bucket_labels(self):
        return [bucket.isoformat() for bucket in self.buckets]


def local_tz():
    return ZoneInfo(settings.TIME_ZONE)


def floor_to_local_hour(moment):
    return timezone.localtime(moment, local_tz()).replace(minute=0, second=0, microsecond=0)


def hourly_starts(first, count):
    # Step in UTC so the series stays strictly hourly even across DST changes.
    first_utc = first.astimezone(dt_timezone.utc)
    tz = local_tz()
    return tuple((first_utc + timedelta(hours=index)).astimezone(tz) for index in range(count))


def build_window(range_key, now=None):
    """Bucket-aligned window ending now: the first bucket starts on a local
    hour (24h) or local midnight (7d/30d), the last bucket is the current one."""
    spec = RANGES[range_key]
    now = now or timezone.now()
    tz = local_tz()
    if spec.bucket == BUCKET_HOUR:
        last = floor_to_local_hour(now)
        buckets = hourly_starts(last - timedelta(hours=spec.bucket_count - 1), spec.bucket_count)
    else:
        today = timezone.localtime(now, tz).date()
        buckets = tuple(
            datetime.combine(today - timedelta(days=spec.bucket_count - 1 - index), time.min, tzinfo=tz)
            for index in range(spec.bucket_count)
        )
    start = buckets[0]
    length = now - start
    return Window(
        spec=spec,
        start=start,
        end=now,
        prev_start=start - length,
        prev_end=start,
        buckets=buckets,
    )


# ---------------------------------------------------------------------------
# Payload helpers shared with the Prometheus sections.
# ---------------------------------------------------------------------------


def number(value, digits=2):
    if value is None:
        return None
    if isinstance(value, Decimal):
        value = float(value)
    if isinstance(value, int):
        return value
    rounded = round(float(value), digits)
    return int(rounded) if digits == 0 else rounded


def delta_pct(current, previous):
    if current is None or previous is None:
        return None
    if previous == 0:
        return 0.0 if current == 0 else None
    return round((float(current) - float(previous)) / float(previous) * 100, 1)


def kpi(
    kpi_id,
    label,
    value,
    unit,
    *,
    delta=None,
    good_direction=None,
    period_label=None,
    trend=None,
    status=None,
    status_label=None,
    hint=None,
):
    return {
        "id": kpi_id,
        "label": label,
        "value": value,
        "unit": unit,
        "delta_pct": delta,
        "delta_good_direction": good_direction,
        "period_label": period_label,
        "trend": trend,
        "status": status,
        "status_label": status_label,
        "hint": hint,
    }


def timeseries_chart(chart_id, title, subtitle, *, mark, unit, bucket, buckets, series, empty_message):
    return {
        "id": chart_id,
        "title": title,
        "subtitle": subtitle,
        "type": "timeseries",
        "mark": mark,
        "unit": unit,
        "bucket": bucket,
        "buckets": list(buckets),
        "series": [{"key": key, "label": label, "values": list(values)} for key, label, values in series],
        "empty_message": empty_message,
    }


def fold_ranked(pairs, limit=RANKED_LIMIT, digits=2):
    """Sort (label, value) pairs descending; fold everything past limit-1 into "Other"."""
    merged = {}
    for label, value in pairs:
        if value:
            merged[label] = merged.get(label, 0) + float(value)
    ordered = sorted(merged.items(), key=lambda item: (-item[1], item[0]))
    if len(ordered) > limit:
        other = sum(value for _label, value in ordered[limit - 1:])
        ordered = ordered[: limit - 1] + [("Other", other)]
    return [{"label": label, "value": number(value, digits)} for label, value in ordered]


def ranked_chart(chart_id, title, subtitle, *, unit, items, empty_message):
    return {
        "id": chart_id,
        "title": title,
        "subtitle": subtitle,
        "type": "ranked",
        "unit": unit,
        "items": items,
        "empty_message": empty_message,
    }


def segmented_chart(chart_id, title, subtitle, *, items, empty_message):
    return {
        "id": chart_id,
        "title": title,
        "subtitle": subtitle,
        "type": "segmented",
        "unit": "count",
        "items": items,
        "empty_message": empty_message,
    }


def section(section_id, title, description, *, kpis=(), charts=(), available=True, unavailable_reason="", note=""):
    return {
        "id": section_id,
        "title": title,
        "description": description,
        "available": bool(available),
        "unavailable_reason": unavailable_reason if not available else "",
        "note": note,
        "kpis": list(kpis) if available else [],
        "charts": list(charts) if available else [],
    }


# ---------------------------------------------------------------------------
# Database aggregation primitives.
# ---------------------------------------------------------------------------


def _between(queryset, field, start, end):
    return queryset.filter(**{f"{field}__gte": start, f"{field}__lt": end})


def bucketed(queryset, field, window, aggregate, digits=2):
    trunc = TruncHour if window.bucket == BUCKET_HOUR else TruncDay
    rows = (
        _between(queryset, field, window.start, window.end)
        .annotate(insights_bucket=trunc(field, tzinfo=local_tz()))
        .values("insights_bucket")
        .annotate(insights_value=aggregate)
        .order_by()
    )
    by_bucket = {row["insights_bucket"]: row["insights_value"] for row in rows if row["insights_bucket"]}
    return [number(by_bucket.get(bucket) or 0, digits) for bucket in window.buckets]


def total(queryset, field, start, end, aggregate, digits=2):
    value = _between(queryset, field, start, end).aggregate(insights_value=aggregate)["insights_value"]
    return number(value or 0, digits)


def grouped(queryset, field, start, end, group_field, aggregate):
    rows = (
        _between(queryset, field, start, end)
        .values(group_field)
        .annotate(insights_value=aggregate)
        .order_by()
    )
    return {row[group_field]: row["insights_value"] or 0 for row in rows}


def _counted_kpi(kpi_id, label, queryset, field, window, *, unit="count", aggregate=None, digits=0, hint=None):
    """KPI summed from its own time buckets, with a previous-period delta."""
    aggregate = aggregate if aggregate is not None else Count("pk")
    trend = bucketed(queryset, field, window, aggregate, digits)
    current = number(sum(trend), digits)
    previous = total(queryset, field, window.prev_start, window.prev_end, aggregate, digits)
    return kpi(
        kpi_id,
        label,
        current,
        unit,
        delta=delta_pct(current, previous),
        good_direction="up",
        period_label=window.spec.period_label,
        trend=trend,
        hint=hint,
    )


def _choice_labels(choices):
    return {value: str(label) for value, label in choices}


def _course_label(title, batch):
    title = title or "Untitled course"
    return f"{title} ({batch})" if batch else title


def _bucket_noun(window):
    return "Per hour" if window.bucket == BUCKET_HOUR else "Per day"


# ---------------------------------------------------------------------------
# Sections.
# ---------------------------------------------------------------------------


def business_section(window):
    paid_payments = Payment.objects.filter(status=Payment.STATUS_PAID).annotate(
        insights_paid_at=Coalesce("paid_at", "created_at")
    )
    students = get_user_model().objects.filter(
        role=get_user_model().ROLE_STUDENT, is_staff=False, is_superuser=False
    )
    paid_enrollments = Enrollment.objects.filter(payment_status=Enrollment.STATUS_PAID)

    revenue = _counted_kpi(
        "revenue", "Revenue", paid_payments, "insights_paid_at", window,
        unit="inr", aggregate=Sum("amount"), digits=2, hint="Paid payments only",
    )
    paid_count = _counted_kpi("paid_payments", "Paid payments", paid_payments, "insights_paid_at", window)
    new_students = _counted_kpi("new_students", "New students", students, "created_at", window)
    new_enrollments = _counted_kpi(
        "new_enrollments", "New enrollments", paid_enrollments, "enrolled_at", window,
        hint="Paid enrollments created in this period",
    )

    plan_labels = _choice_labels(Payment.PLAN_CHOICES)
    by_plan = grouped(paid_payments, "insights_paid_at", window.start, window.end, "plan", Sum("amount"))
    revenue_by_plan = fold_ranked((plan_labels.get(plan, plan or "Unknown"), value) for plan, value in by_plan.items())

    outcome_counts = grouped(Payment.objects.all(), "created_at", window.start, window.end, "status", Count("pk"))
    outcomes = [
        {"label": "Paid", "value": outcome_counts.pop(Payment.STATUS_PAID, 0), "status": "good"},
        {"label": "Pending", "value": outcome_counts.pop(Payment.STATUS_CREATED, 0), "status": "warning"},
        {"label": "Failed", "value": outcome_counts.pop(Payment.STATUS_FAILED, 0), "status": "critical"},
    ]
    outcomes.extend(
        {"label": str(status_value or "Unknown").replace("_", " ").capitalize(), "value": count, "status": "neutral"}
        for status_value, count in sorted(outcome_counts.items(), key=lambda item: str(item[0]))
    )

    course_rows = (
        Enrollment.objects.filter(active_enrollment_q())
        .values("course_id", "course__title", "course__batch")
        .annotate(insights_value=Count("pk"))
        .order_by()
    )
    top_courses = fold_ranked(
        [(_course_label(row["course__title"], row["course__batch"]), row["insights_value"]) for row in course_rows],
        digits=0,
    )

    return section(
        "business",
        "Revenue and enrollments",
        "Payments, new students and paid enrollments.",
        kpis=[revenue, paid_count, new_students, new_enrollments],
        charts=[
            timeseries_chart(
                "revenue", "Revenue", f"{_bucket_noun(window)}, paid payments",
                mark="column", unit="inr", bucket=window.bucket, buckets=window.bucket_labels,
                series=[("revenue", "Revenue", revenue["trend"])],
                empty_message="No paid payments in this period.",
            ),
            timeseries_chart(
                "new_students", "New students", f"{_bucket_noun(window)}, accounts created",
                mark="line", unit="count", bucket=window.bucket, buckets=window.bucket_labels,
                series=[("new_students", "New students", new_students["trend"])],
                empty_message="No new students in this period.",
            ),
            ranked_chart(
                "revenue_by_plan", "Revenue by plan", "Paid payments in this period",
                unit="inr", items=revenue_by_plan,
                empty_message="No paid payments in this period.",
            ),
            segmented_chart(
                "payment_outcomes", "Payment outcomes", "Checkouts started in this period",
                items=outcomes, empty_message="No checkouts in this period.",
            ),
            ranked_chart(
                "top_courses", "Top courses", "Active enrollments right now",
                unit="count", items=top_courses,
                empty_message="No active enrollments yet.",
            ),
        ],
    )


def learning_section(window):
    active_enrollments = Enrollment.objects.filter(active_enrollment_q()).count()
    sessions = _counted_kpi(
        "live_sessions", "Live sessions held", RealtimeSession.objects.all(), "started_at", window,
    )

    progress = LectureProgress.objects.all()
    learner_trend = bucketed(progress, "updated_at", window, Count("user", distinct=True), 0)
    learners_now = total(progress, "updated_at", window.start, window.end, Count("user", distinct=True), 0)
    learners_prev = total(progress, "updated_at", window.prev_start, window.prev_end, Count("user", distinct=True), 0)
    learners = kpi(
        "active_learners",
        "Active learners",
        learners_now,
        "count",
        delta=delta_pct(learners_now, learners_prev),
        good_direction="up",
        period_label=window.spec.period_label,
        trend=learner_trend,
        hint="Based on each learner's latest lecture progress",
    )
    recordings = _counted_kpi(
        "recordings", "Recordings created", RealtimeSessionRecording.objects.all(), "created_at", window,
    )

    request_counts = grouped(
        LiveClassEnrollment.objects.all(), "created_at", window.start, window.end, "status", Count("pk")
    )
    request_items = [
        {"label": "Approved", "value": request_counts.get(LiveClassEnrollment.STATUS_APPROVED, 0), "status": "good"},
        {"label": "Pending", "value": request_counts.get(LiveClassEnrollment.STATUS_PENDING, 0), "status": "warning"},
        {"label": "Rejected", "value": request_counts.get(LiveClassEnrollment.STATUS_REJECTED, 0), "status": "neutral"},
    ]

    return section(
        "learning",
        "Learning and live classes",
        "Course access, live sessions and lecture activity.",
        kpis=[
            kpi(
                "active_enrollments", "Active enrollments", active_enrollments, "count",
                hint="Paid and not expired, right now",
            ),
            sessions,
            learners,
            recordings,
        ],
        charts=[
            timeseries_chart(
                "live_sessions", "Live sessions", f"{_bucket_noun(window)}, sessions started",
                mark="column", unit="count", bucket=window.bucket, buckets=window.bucket_labels,
                series=[("live_sessions", "Live sessions", sessions["trend"])],
                empty_message="No live sessions in this period.",
            ),
            timeseries_chart(
                "active_learners", "Active learners", f"{_bucket_noun(window)}, distinct learners",
                mark="line", unit="count", bucket=window.bucket, buckets=window.bucket_labels,
                series=[("active_learners", "Active learners", learner_trend)],
                empty_message="No lecture activity in this period.",
            ),
            segmented_chart(
                "live_class_requests", "Live class requests", "Requests made in this period",
                items=request_items, empty_message="No live class requests in this period.",
            ),
        ],
    )


def outreach_section(window):
    leads_qs = PublicEnrollmentLead.objects.all()
    leads = _counted_kpi("new_leads", "New leads", leads_qs, "created_at", window)
    applications_qs = JoinApplication.objects.all()
    applications = _counted_kpi("join_applications", "Join applications", applications_qs, "created_at", window)
    visits = _counted_kpi(
        "campaign_visitors", "Campaign site visitors", CampaignSiteVisit.objects.all(), "first_seen_at", window,
        hint="Unique visitors first seen in this period",
    )
    volunteers = _counted_kpi(
        "campaign_volunteers", "Campaign volunteers", CampaignVolunteer.objects.all(), "created_at", window,
    )

    lead_counts = grouped(leads_qs, "created_at", window.start, window.end, "status", Count("pk"))
    lead_status = {
        PublicEnrollmentLead.STATUS_NEW: "warning",
        PublicEnrollmentLead.STATUS_REVIEWED: "neutral",
        PublicEnrollmentLead.STATUS_CONTACTED: "neutral",
        PublicEnrollmentLead.STATUS_CONVERTED: "good",
    }
    lead_items = [
        {"label": str(label), "value": lead_counts.get(value, 0), "status": lead_status.get(value, "neutral")}
        for value, label in PublicEnrollmentLead.STATUS_CHOICES
    ]

    role_labels = _choice_labels(JoinApplication.ROLE_CHOICES)
    role_counts = grouped(applications_qs, "created_at", window.start, window.end, "role", Count("pk"))
    applications_by_role = fold_ranked(
        ((role_labels.get(role, role or "Unknown"), count) for role, count in role_counts.items()), digits=0
    )

    return section(
        "outreach",
        "Leads and outreach",
        "Enrollment leads, join applications and campaign activity.",
        kpis=[leads, applications, visits, volunteers],
        charts=[
            timeseries_chart(
                "leads", "New leads", f"{_bucket_noun(window)}, enrollment enquiries",
                mark="line", unit="count", bucket=window.bucket, buckets=window.bucket_labels,
                series=[("leads", "New leads", leads["trend"])],
                empty_message="No new leads in this period.",
            ),
            segmented_chart(
                "leads_by_status", "Leads by status", "Leads received in this period",
                items=lead_items, empty_message="No leads in this period.",
            ),
            ranked_chart(
                "join_applications_by_type", "Join applications by type", "Applications in this period",
                unit="count", items=applications_by_role,
                empty_message="No join applications in this period.",
            ),
            timeseries_chart(
                "campaign_visitors", "Campaign site visitors", f"{_bucket_noun(window)}, new unique visitors",
                mark="area", unit="count", bucket=window.bucket, buckets=window.bucket_labels,
                series=[("campaign_visitors", "Visitors", visits["trend"])],
                empty_message="No campaign site visitors in this period.",
            ),
        ],
    )
