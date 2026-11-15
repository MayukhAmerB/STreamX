import ast
import copy
import json

from django import forms
from django.conf import settings
from django.contrib import admin, messages
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Count
from django.urls import reverse
from django.utils.html import format_html, format_html_join
from django.utils.translation import ngettext

from apps.payments.batch_pass import (
    active_pass_holder_count,
    grant_course_to_pass_holders,
    revoke_course_from_pass_holders,
)
from apps.payments.plans import (
    CARD_KEYS,
    CARD_TEXT_LIMITS,
    CATALOG,
    MAX_CARD_FEATURES,
    MAX_CARDS,
    card_config,
    clean_card_value,
    default_card,
    enabled_plan_ids,
    payment_cards_per_row,
    resolve_course_plans,
    validation_messages,
)
from config.audit import log_security_event

from .cache_utils import bump_course_list_cache_version
from .engagement.admin import LectureEngagementAdminMixin, annotate_engagement_counts
from .experience_models import CourseReview, PentestingApplication
from .models import (
    Course,
    Enrollment,
    EnrollmentRequestNotification,
    GuideVideo,
    Lecture,
    LectureQuestion,
    LectureResource,
    LiveClass,
    LiveClassEnrollment,
    PublicEnrollmentLead,
    Section,
    default_course_card_features,
    sanitize_course_card_features,
    sanitize_public_curriculum,
)
from .services import VideoTranscodeError, transcode_lecture_to_hls


@admin.register(CourseReview)
class CourseReviewAdmin(admin.ModelAdmin):
    list_display = ("id", "course", "student", "rating", "status", "edit_allowed", "created_at", "updated_at")
    list_display_links = ("id", "course")
    list_filter = ("status", "rating", "course")
    search_fields = ("student__email", "student__full_name", "text", "course__title")
    readonly_fields = ("course", "student", "rating", "text", "created_at", "updated_at")
    actions = ("allow_review_edits",)
    list_per_page = 50

    def has_add_permission(self, request):
        return False

    @admin.action(description="Allow students to edit selected reviews")
    def allow_review_edits(self, request, queryset):
        updated = queryset.update(edit_allowed=True)
        self.message_user(request, f"Enabled editing for {updated} review(s).")


@admin.register(PentestingApplication)
class PentestingApplicationAdmin(admin.ModelAdmin):
    list_display = ("full_name", "course", "email", "is_student", "status", "payment_status", "created_at")
    list_filter = ("status", "is_student", "course")
    search_fields = ("full_name", "email", "phone", "institution")
    readonly_fields = ("reference", "student", "status", "payment_status", "consent_at", "created_at", "updated_at")

    def has_add_permission(self, request):
        return False

def _parse_admin_list_field(value):
    raw = str(value or "").strip()
    if not raw:
        return []

    parsed_items = None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        try:
            parsed = ast.literal_eval(raw)
        except (SyntaxError, ValueError):
            parsed = None

    if isinstance(parsed, list):
        parsed_items = parsed
    elif isinstance(parsed, str):
        parsed_items = [parsed]

    if parsed_items is None:
        if "\n" in raw:
            parsed_items = raw.splitlines()
        elif "," in raw:
            parsed_items = raw.split(",")
        else:
            parsed_items = [raw]

    cleaned = []
    for item in parsed_items:
        text = str(item or "").strip()
        text = text.lstrip("-* ").strip()
        if text:
            cleaned.append(text)
    return cleaned


def _format_course_card_features(value):
    return "\n".join(
        f"{item.get('icon', 'check')} | {item.get('title', '')} | {item.get('description', '')}"
        for item in (value or default_course_card_features())
    )


def _parse_course_card_features(value):
    raw = str(value or "").strip()
    if not raw:
        return default_course_card_features()

    features = []
    for line_number, line in enumerate(raw.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split("|", 2)]
        if len(parts) != 3:
            raise forms.ValidationError(
                f"Line {line_number}: use icon | title | description."
            )
        icon, title, description = parts
        features.append({"icon": icon, "title": title, "description": description})

    try:
        return sanitize_course_card_features(features)
    except Exception as exc:
        messages = getattr(exc, "messages", None)
        raise forms.ValidationError(messages or str(exc)) from exc


def _format_public_curriculum(value):
    return "\n".join(
        " | ".join(
            (
                str(item.get("title") or "").strip(),
                str(item.get("description") or "").strip(),
                "; ".join(str(topic).strip() for topic in item.get("topics", []) if str(topic).strip()),
            )
        )
        for item in (value or [])
    )


def _parse_public_curriculum(value):
    raw = str(value or "").strip()
    if not raw:
        return []

    modules = []
    for line_number, line in enumerate(raw.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split("|", 2)]
        if len(parts) != 3:
            raise forms.ValidationError(
                f"Line {line_number}: use module title | description | topic 1; topic 2."
            )
        title, description, topics = parts
        modules.append(
            {
                "title": title,
                "description": description,
                "topics": [topic.strip() for topic in topics.split(";") if topic.strip()],
            }
        )

    try:
        return sanitize_public_curriculum(modules)
    except Exception as exc:
        messages = getattr(exc, "messages", None)
        raise forms.ValidationError(messages or str(exc)) from exc


# ---------------------------------------------------------------------------
# Payment cards: one admin section per plan (apps.payments.plans is the rulebook)
# ---------------------------------------------------------------------------

PAYMENT_CARD_SHORT_NAMES = {
    "monthly": "Monthly",
    "full": "One-time",
    "bundle": "Bundle",
    "batch_pass": "Pass",
}
# Course fields that hold each plan's switch, price, installments and access days.
PAYMENT_CARD_MONEY_LABELS = {
    "installment_payment_enabled": ("Show the monthly (EMI) card", ""),
    "monthly_price": ("Amount per installment (₹)", "Charged on each monthly payment."),
    "installments_required": ("Number of installments", "Paying all of them unlocks lifetime access."),
    "installment_access_days": ("Access days per installment", "Each paid installment unlocks this many days."),
    "full_payment_enabled": ("Show the one-time card", ""),
    "price": ("Price (₹)", "One payment, lifetime access to this course."),
    "bundle_payment_enabled": ("Show the bundle card", ""),
    "bundle_price": ("Amount per bundle payment (₹)", "Charged on each bundle payment."),
    "bundle_installments": ("Number of bundle payments", "Paying all of them unlocks lifetime access."),
    "bundle_access_days": ("Access days per bundle payment", "Each paid bundle payment unlocks this many days."),
    "batch_pass_payment_enabled": ("Show the all-future-batches card", ""),
    "batch_pass_price": (
        "Price (₹)",
        "One payment: lifetime access to this course and every course included in the pass.",
    ),
}


def payment_card_field_name(plan, key):
    return f"card_{plan}_{key}"


def _payment_card_form_fields():
    fields = {}
    for spec in CATALOG:
        short = PAYMENT_CARD_SHORT_NAMES[spec.plan]
        name = lambda key, plan=spec.plan: payment_card_field_name(plan, key)  # noqa: E731
        fields[name("title")] = forms.CharField(
            required=False,
            max_length=CARD_TEXT_LIMITS["title"],
            label=f"{short} card title",
            help_text="Leave blank for the automatic title.",
        )
        fields[name("subtitle")] = forms.CharField(
            required=False,
            max_length=CARD_TEXT_LIMITS["subtitle"],
            label=f"{short} card subtitle",
            help_text="Short line under the title. Leave blank for the automatic text.",
        )
        fields[name("features")] = forms.CharField(
            required=False,
            label=f"{short} card features",
            help_text=(
                f"One bullet per line, at most {MAX_CARD_FEATURES}. Leave blank to use the first four "
                "Catalog Card Features of this course."
            ),
            widget=forms.Textarea(attrs={"rows": 4}),
        )
        fields[name("badge")] = forms.CharField(
            required=False,
            max_length=CARD_TEXT_LIMITS["badge"],
            label=f"{short} card badge",
            help_text='Optional ribbon such as "Most popular" or "Best value". Blank shows no badge.',
        )
        fields[name("highlighted")] = forms.BooleanField(
            required=False,
            label=f"Highlight the {short.lower()} card",
            help_text="Visually emphasize this card. Only one shown card can be highlighted.",
        )
        fields[name("order")] = forms.TypedChoiceField(
            required=False,
            coerce=int,
            empty_value=None,
            choices=[("", "Automatic")] + [(position, str(position)) for position in range(1, MAX_CARDS + 1)],
            label=f"{short} card position",
            help_text="1 is the first card. Each shown card needs its own position.",
        )
        fields[name("cta_label")] = forms.CharField(
            required=False,
            max_length=CARD_TEXT_LIMITS["cta_label"],
            label=f"{short} card button label",
            help_text='Leave blank for "Enroll Now".',
        )
    return fields


def _payment_card_fieldsets():
    money_fields = {
        "monthly": (
            "installment_payment_enabled",
            ("monthly_price", "installments_required", "installment_access_days"),
        ),
        "full": ("full_payment_enabled", "price"),
        "bundle": (
            "bundle_payment_enabled",
            ("bundle_price", "bundle_installments", "bundle_access_days"),
        ),
        "batch_pass": ("batch_pass_payment_enabled", "batch_pass_price"),
    }
    fieldsets = []
    for spec in CATALOG:
        name = lambda key, plan=spec.plan: payment_card_field_name(plan, key)  # noqa: E731
        fieldsets.append(
            (
                f"Payment card: {spec.admin_label}",
                {
                    "classes": ("payment-card-fieldset",),
                    "fields": (
                        *money_fields[spec.plan],
                        (name("title"), name("subtitle")),
                        (name("badge"), name("order"), name("highlighted")),
                        name("features"),
                        name("cta_label"),
                    ),
                },
            )
        )
    return tuple(fieldsets)


def _card_form_value(key, value):
    """Admin input to an override value; None means "use the automatic default"."""
    if key in ("title", "subtitle", "cta_label"):
        text = " ".join(str(value or "").split())
        return text or None
    if key == "features":
        lines = [" ".join(line.split()) for line in str(value or "").splitlines()]
        lines = [line for line in lines if line]
        return lines or None
    if key == "badge":
        # Blank is a real choice here: no badge.
        return " ".join(str(value or "").split())
    if key == "highlighted":
        return bool(value)
    return value  # order: int or None


class CourseAdminForm(forms.ModelForm):
    card_highlights = forms.CharField(required=False, widget=forms.Textarea(attrs={"rows": 5}), help_text="One course-card bullet per line.")

    def clean_card_highlights(self):
        return [line.strip() for line in self.cleaned_data.get("card_highlights", "").splitlines() if line.strip()]

    what_you_will_learn = forms.CharField(
        required=False,
        label="What You Will Cover",
        help_text="Enter one highlight per line. Example: Web Pentesting track",
        widget=forms.Textarea(
            attrs={
                "rows": 4,
                "placeholder": "Web Pentesting track\nBeginner level\nLaunching soon",
            }
        ),
    )
    expected_outcomes = forms.CharField(
        required=False,
        label="Expected Outcomes",
        help_text="Enter one outcome per line. These render as the outcome cards.",
        widget=forms.Textarea(
            attrs={
                "rows": 5,
                "placeholder": (
                    "Build web pentesting workflow habits.\n"
                    "Follow a beginner progression with structured modules."
                ),
            }
        ),
    )
    course_card_features = forms.CharField(
        required=False,
        label="Catalog Card Features",
        help_text=(
            "One feature per line: icon | title | description. "
            "Icons: check, certificate, support, live, chat, recording. "
            "Leave blank to restore the six default features."
        ),
        widget=forms.Textarea(
            attrs={
                "rows": 12,
                "placeholder": "live | Live Sessions | Attend interactive live classes.",
            }
        ),
    )
    public_curriculum = forms.CharField(
        required=False,
        label="Public Course Roadmap",
        help_text=(
            "One module per line: module title | description | topic 1; topic 2. "
            "This controls only the public details page and never changes lesson videos."
        ),
        widget=forms.Textarea(
            attrs={
                "rows": 16,
                "placeholder": "OSINT Foundations | Core investigation concepts | What is OSINT?; Ethics and source verification",
            }
        ),
    )

    confirm_batch_pass_change = forms.BooleanField(
        required=False,
        label="Confirm batch pass change",
        help_text=(
            "Required when 'Included in batch pass' is ticked or unticked while students hold "
            "an active pass. Unticking revokes the course from holders who did not buy it separately."
        ),
    )

    class Meta:
        model = Course
        fields = "__all__"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        instance = getattr(self, "instance", None)
        self._was_in_batch_pass = bool(
            instance and instance.pk and Course.objects.filter(pk=instance.pk, included_in_batch_pass=True).exists()
        )
        self.pass_holder_count = active_pass_holder_count()
        if "confirm_batch_pass_change" in self.fields:
            verb = "Revoke this course from" if self._was_in_batch_pass else "Grant this course to"
            self.fields["confirm_batch_pass_change"].label = f"{verb} {self.pass_holder_count} current pass holders"
        if instance and instance.pk:
            self.fields["card_highlights"].initial = "\n".join(instance.card_highlights or [])
            self.initial["card_highlights"] = self.fields["card_highlights"].initial
            self.fields["what_you_will_learn"].initial = "\n".join(instance.what_you_will_learn or [])
            self.fields["expected_outcomes"].initial = "\n".join(instance.expected_outcomes or [])
            self.fields["course_card_features"].initial = _format_course_card_features(
                instance.course_card_features
            )
            self.fields["public_curriculum"].initial = _format_public_curriculum(
                instance.public_curriculum
            )
        else:
            self.fields["course_card_features"].initial = _format_course_card_features(
                default_course_card_features()
            )
            for field_name in ("what_you_will_learn", "expected_outcomes", "public_curriculum"):
                self.fields[field_name].initial = ""
        # The model's list values sit in self.initial (model_to_dict) and win
        # over field.initial, which rendered Python reprs that the line parsers
        # then rejected on save. Show the one-per-line text instead.
        for field_name in ("what_you_will_learn", "expected_outcomes", "course_card_features", "public_curriculum"):
            if field_name in self.fields and self.fields[field_name].initial is not None:
                self.initial[field_name] = self.fields[field_name].initial
        self._init_payment_card_fields(instance if instance is not None else Course())

        textarea_rows = {
            "description": 3,
            "about_the_course": 4,
            "course_overview": 4,
            "enrollment_message": 3,
        }
        for field_name, rows in textarea_rows.items():
            field = self.fields.get(field_name)
            if field:
                field.widget.attrs.setdefault("rows", rows)
                field.widget.attrs.setdefault("placeholder", "")

        self.fields["title"].help_text = "Frontend: Hero title"
        self.fields["description"].label = "Short Description"
        self.fields["description"].help_text = "Frontend: Hero subtitle under title"
        self.fields["about_the_course"].label = "About This Course"
        self.fields["about_the_course"].help_text = (
            "Frontend container: About This Course card (left side of hero section)."
        )
        self.fields["course_overview"].label = "Course Overview"
        self.fields["course_overview"].help_text = (
            "Public course overview copy shown below the program header."
        )
        self.fields["show_course_image"].help_text = (
            "Keep disabled unless the image has a direct instructional or course-context purpose."
        )
        self.fields["hero_countdown_end_at"].label = "Homepage Countdown Deadline"
        self.fields["hero_countdown_end_at"].help_text = (
            "Set the exact date and time when enrollment closes. Leave blank to hide the red "
            "homepage countdown."
        )
        self.fields["hero_countdown_label"].label = "Homepage Countdown Label"
        self.fields["hero_countdown_label"].help_text = (
            "Short text shown before the timer, for example: Enrollment closes in."
        )
        self.fields["thumbnail_file"].help_text = (
            "Optional course-context image. It is displayed only when 'Show course image' is enabled."
        )
        self.fields["thumbnail"].help_text = (
            "Optional public image URL fallback if no uploaded thumbnail file is available."
        )
        self.fields["enrollment_message"].label = "Enrollment Note"
        self.fields["enrollment_message"].help_text = (
            "Frontend container: Enrollment panel note text (right panel)."
        )
        self.fields["snapshot_category"].label = "Snapshot Category"
        self.fields["snapshot_level"].label = "Snapshot Level"
        self.fields["snapshot_instructor"].label = "Snapshot Instructor"
        self.fields["snapshot_category"].help_text = "Frontend container: Course Snapshot > Category"
        self.fields["snapshot_level"].help_text = "Frontend container: Course Snapshot > Level"
        self.fields["snapshot_instructor"].help_text = "Frontend container: Course Snapshot > Instructor"

        self.fields["about_the_course"].widget.attrs.update(
            {
                "placeholder": (
                    "Coming soon: a beginner-friendly web application pentesting track with fundamentals, "
                    "setup, and testing mindset."
                )
            }
        )
        self.fields["course_overview"].widget.attrs.update(
            {
                "placeholder": (
                    "Coming soon: beginner-friendly web application pentesting track with fundamentals, "
                    "setup, and testing mindset."
                )
            }
        )
        self.fields["enrollment_message"].widget.attrs.update(
            {
                "placeholder": (
                    "This track is not live yet. We will open enrollment once the curriculum release is ready."
                )
            }
        )

    def _init_payment_card_fields(self, course):
        for field_name, (label, help_text) in PAYMENT_CARD_MONEY_LABELS.items():
            field = self.fields.get(field_name)
            if field is None:
                continue
            field.label = label
            if help_text:
                field.help_text = help_text
        if course.pk is None and not course.course_card_features:
            course.course_card_features = default_course_card_features()
        for spec in CATALOG:
            config = card_config(course, spec.plan)
            for key in CARD_KEYS:
                field = self.fields.get(payment_card_field_name(spec.plan, key))
                if field is None:
                    continue
                value = config[key]
                field.initial = "\n".join(value) if key == "features" else value

    def _course_facts(self, cleaned_data):
        """The course as submitted, for computing the automatic card defaults."""
        facts = copy.copy(self.instance)
        for field_name in (
            "installments_required",
            "installment_access_days",
            "bundle_installments",
            "bundle_access_days",
            "course_card_features",
        ):
            if field_name in self.fields and field_name not in self.errors:
                setattr(facts, field_name, cleaned_data.get(field_name))
        return facts

    def _clean_payment_cards(self, cleaned_data):
        """Store only the card settings that differ from the automatic defaults.

        Unchanged settings keep following the course (e.g. features follow the
        Catalog Card Features). The model's clean() then validates the whole
        configuration: 2 to 4 shown cards or none, one highlight, unique positions.
        """
        stored = self.instance.payment_cards if isinstance(self.instance.payment_cards, dict) else {}
        cards = {plan: dict(overrides) for plan, overrides in stored.items() if isinstance(overrides, dict)}
        facts = self._course_facts(cleaned_data)
        valid = True
        for spec in CATALOG:
            names = {key: payment_card_field_name(spec.plan, key) for key in CARD_KEYS}
            if not all(name in self.fields for name in names.values()):
                continue  # this form does not edit that card; keep what is stored
            defaults = default_card(facts, spec.plan)
            overrides = {}
            for key, name in names.items():
                if name in self.errors:
                    valid = False
                    continue
                value = _card_form_value(key, cleaned_data.get(name))
                if value is None:
                    continue
                try:
                    value = clean_card_value(spec.plan, key, value)
                except ValidationError as exc:
                    self.add_error(name, validation_messages(exc))
                    valid = False
                    continue
                if value != defaults[key]:
                    overrides[key] = value
            if overrides:
                cards[spec.plan] = overrides
            else:
                cards.pop(spec.plan, None)
        if valid:
            self.instance.payment_cards = cards

    def clean_what_you_will_learn(self):
        return _parse_admin_list_field(self.cleaned_data.get("what_you_will_learn"))

    def clean_expected_outcomes(self):
        return _parse_admin_list_field(self.cleaned_data.get("expected_outcomes"))

    def clean_course_card_features(self):
        return _parse_course_card_features(self.cleaned_data.get("course_card_features"))

    def clean_public_curriculum(self):
        return _parse_public_curriculum(self.cleaned_data.get("public_curriculum"))

    def clean(self):
        cleaned_data = super().clean()
        self._clean_payment_cards(cleaned_data)
        if "included_in_batch_pass" not in self.fields:
            return cleaned_data
        changes_pass = bool(cleaned_data.get("included_in_batch_pass")) != self._was_in_batch_pass
        if changes_pass and self.pass_holder_count and not cleaned_data.get("confirm_batch_pass_change"):
            self.add_error(
                "confirm_batch_pass_change",
                f"Tick '{self.fields['confirm_batch_pass_change'].label}' to confirm this batch pass change.",
            )
        return cleaned_data


# Declared after the class so each plan's card fields are generated from the
# catalog; ModelAdmin's form factory then treats them like declared fields.
for _name, _field in _payment_card_form_fields().items():
    CourseAdminForm.base_fields[_name] = _field
    CourseAdminForm.declared_fields[_name] = _field


class LectureInlineForm(forms.ModelForm):
    remove_uploaded_video = forms.BooleanField(
        required=False,
        label="Remove uploaded video",
        help_text="Clear the current video file without deleting the lecture row.",
    )

    class Meta:
        model = Lecture
        fields = "__all__"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        has_existing_file = bool(getattr(self.instance, "pk", None) and self.instance.video_file)
        if not has_existing_file:
            self.fields["remove_uploaded_video"].widget = forms.HiddenInput()

    def clean(self):
        cleaned_data = super().clean()
        remove_uploaded_video = cleaned_data.get("remove_uploaded_video", False)

        if remove_uploaded_video:
            if "video_file" in self.changed_data and cleaned_data.get("video_file"):
                self.add_error(
                    "remove_uploaded_video",
                    "Use either a new upload or remove, not both in the same save.",
                )
            # For FileField in ModelForm, False explicitly clears existing file.
            cleaned_data["video_file"] = False

        return cleaned_data

    def save(self, commit=True):
        remove_uploaded_video = self.cleaned_data.get("remove_uploaded_video", False)
        old_video_name = None
        old_video_storage = None

        if remove_uploaded_video and getattr(self.instance, "video_file", None):
            old_video_name = self.instance.video_file.name
            old_video_storage = self.instance.video_file.storage

            # Reset stream artifacts tied to uploaded file so stale stream metadata is not reused.
            self.instance.stream_manifest_key = ""
            self.instance.stream_duration_seconds = None
            self.instance.stream_error = ""

        instance = super().save(commit=commit)

        if commit and old_video_name and old_video_storage:
            try:
                old_video_storage.delete(old_video_name)
            except Exception:
                pass

        return instance


class LectureInline(admin.TabularInline):
    model = Lecture
    form = LectureInlineForm
    extra = 1
    fields = (
        "order",
        "title",
        "video_file",
        "remove_uploaded_video",
        "video_key",
        "is_preview",
        "stream_status",
    )
    readonly_fields = ("stream_status",)
    ordering = ("order", "id")
    show_change_link = True
    verbose_name = "Video Lecture"
    verbose_name_plural = "Video Lectures (upload videos here, then open a lecture to manage optional resources)"


class LectureResourceInline(admin.TabularInline):
    model = LectureResource
    extra = 1
    fields = ("order", "title", "resource_file", "resource_url")
    ordering = ("order", "id")
    verbose_name = "Resource File"
    verbose_name_plural = "Resource Files or Links (optional downloads for this lecture)"


class GuideVideoAdminForm(forms.ModelForm):
    class Meta:
        model = GuideVideo
        fields = "__all__"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["title"].help_text = "Navbar page: guide card title"
        self.fields["description"].help_text = "Optional short description shown under the guide title."
        self.fields["video_file"].help_text = "Upload MP4, M4V, MOV, or WEBM. Maximum size: 500 MB."
        self.fields["order"].help_text = "Lower numbers appear first on the Guides page."
        self.fields["description"].widget.attrs.setdefault("rows", 4)


@admin.register(GuideVideo)
class GuideVideoAdmin(admin.ModelAdmin):
    form = GuideVideoAdminForm
    list_display = ("id", "title", "order", "is_published", "updated_at")
    list_display_links = ("id", "title")
    list_editable = ("order", "is_published")
    search_fields = ("title", "description")
    list_filter = ("is_published", "created_at", "updated_at")
    ordering = ("order", "id")
    readonly_fields = ("created_at", "updated_at")
    save_on_top = True
    list_per_page = 50
    fieldsets = (
        ("Guide Video", {"fields": ("title", "description", "video_file", "order")}),
        ("Publishing", {"fields": ("is_published",)}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )


class LiveClassInline(admin.TabularInline):
    model = LiveClass
    fk_name = "linked_course"
    extra = 0
    show_change_link = True
    fields = (
        "title",
        "level",
        "month_number",
        "schedule_days",
        "class_duration_minutes",
        "is_active",
    )
    ordering = ("month_number", "id")
    verbose_name = "Included Live Class"
    verbose_name_plural = "Live Classes Included With This Course"


def _payment_cards_count_label(count):
    return ngettext("%(count)d card will show", "%(count)d cards will show", count) % {"count": count}


def _payment_cards_count_detail(count):
    if count == 0:
        return "Online purchase is off for this course."
    if count == 1:
        return f"Show 2 to {MAX_CARDS} cards, or none to turn off online purchase."
    return f"Laid out {payment_cards_per_row(count)} per row."


@admin.register(Course)
class CourseAdmin(admin.ModelAdmin):
    @admin.display(description="Confirmed students / published reviews")
    def confirmed_statistics(self, obj):
        if not obj or not obj.pk:
            return "Save the course first."
        from .experience_views import course_statistics
        stats = course_statistics(obj)
        return f"{stats['enrolled_students']} students; {stats['review_count']} reviews; average {stats['average_rating'] or '-'} / 5"

    form = CourseAdminForm
    inlines = (LiveClassInline,)
    list_display = (
        "id",
        "title",
        "category",
        "level",
        "launch_status",
        "registration_closed",
        "price",
        "purchase_readiness",
        "is_published",
        "instructor",
        "section_count",
        "lecture_count",
        "admin_actions",
        "updated_at",
    )
    list_display_links = ("id", "title")
    list_filter = (
        "category",
        "level",
        "launch_status",
        "registration_closed",
        "is_published",
        "created_at",
        "updated_at",
    )
    search_fields = ("title", "slug", "description", "instructor__email", "instructor__full_name")
    list_editable = (
        "launch_status",
        "registration_closed",
        "price",
        "is_published",
        "instructor",
    )
    readonly_fields = (
        "confirmed_statistics",
        "payment_cards_overview",
        "slug",
        "frontend_container_guide",
        "enrollment_container_source",
        "purchase_readiness",
        "thumbnail_preview",
        "instructor_admin_link",
        "section_count_display",
        "lecture_count_display",
        "module_admin_link",
        "created_at",
        "updated_at",
    )
    autocomplete_fields = ("instructor",)
    save_on_top = True
    list_per_page = 25
    actions = (
        "mark_live",
        "mark_coming_soon",
        "open_registrations",
        "close_registrations",
        "publish_courses",
        "unpublish_courses",
    )
    fieldsets = (
        (
            "Homepage card",
            {
                "description": (
                    "Controls the public program card. Keep the default information-led layout; "
                    "optional images must be course-contextual."
                ),
                "fields": (
                    "card_title",
                    "card_subtitle",
                    "card_summary",
                    "card_highlights",
                    "image_alt",
                    "show_course_image",
                ),
            },
        ),
        (
            "Homepage countdown",
            {
                "description": (
                    "Optional red enrollment countdown shown below the homepage hero. "
                    "The timer hides automatically when no future deadline is configured."
                ),
                "fields": ("hero_countdown_label", "hero_countdown_end_at"),
            },
        ),
        ("Batch and extended facts", {"fields": ("start_date", "total_hours_label", "batch_size_label")}),
        (
            "Payment cards",
            {
                "description": (
                    "The plans a student chooses from on the payment page. Each card below is one "
                    "plan: switch it on, set its price, and word the card. Show 2 to 4 cards, or none "
                    "to turn off online purchase. Prices are charged exactly as set here; a price "
                    "change only affects checkouts started after you save."
                ),
                "classes": ("payment-cards-overview",),
                "fields": ("payment_cards_overview", "purchase_readiness"),
            },
        ),
        *_payment_card_fieldsets(),
        (
            "All future batches pass: course inclusion",
            {
                "description": (
                    "Tick 'Included in batch pass' on each new batch so existing pass holders are "
                    "unlocked automatically when it is published. Selling the pass is the "
                    "'All future batches pass' payment card above."
                ),
                "fields": (
                    "included_in_batch_pass",
                    "confirm_batch_pass_change",
                ),
            },
        ),
        ("Course facts", {"fields": ("is_flagship", "batch", "duration", "schedule", "class_length", "total_classes", "total_hours", "batch_size", "confirmed_statistics")}),
        (
            "Frontend Container Map (Read First)",
            {
                "description": "Use the sections below to keep admin inputs aligned with frontend cards/containers.",
                "fields": ("frontend_container_guide",),
            },
        ),
        (
            "Container 1: Hero Header",
            {
                "fields": (
                    "category",
                    "level",
                    "launch_status",
                    "registration_closed",
                    "title",
                    "description",
                    "slug",
                )
            },
        ),
        (
            "Container 2: Hero Left Cards",
            {
                "description": "The price shown here is the One-time payment card's price (Payment cards above).",
                "fields": ("about_the_course",),
            },
        ),
        (
            "Optional course-context image",
            {
                "fields": (
                    "thumbnail",
                    "thumbnail_file",
                    "thumbnail_preview",
                    "course_overview",
                )
            },
        ),
        (
            "Container 4: What You Will Cover (Chip Row)",
            {
                "description": (
                    "Enter one item per line. Each line becomes one frontend chip."
                ),
                "fields": (
                    "what_you_will_learn",
                ),
            },
        ),
        (
            "Container 5: Expected Outcomes (Outcome Cards)",
            {
                "description": "Enter one item per line. Each line becomes one outcome card.",
                "fields": (
                    "expected_outcomes",
                ),
            },
        ),
        (
            "Catalog Card: Program Features",
            {
                "description": (
                    "Controls the feature rows shown on this course's public catalog card. "
                    "Use one row per line in icon | title | description format."
                ),
                "fields": ("course_card_features",),
            },
        ),
        (
            "Container 6: Enrollment Panel (Right Side)",
            {
                "fields": (
                    "enrollment_message",
                    "enrollment_container_source",
                ),
            },
        ),
        (
            "Container 7: Course Snapshot Card",
            {
                "fields": (
                    "snapshot_category",
                    "snapshot_level",
                    "snapshot_instructor",
                    "instructor",
                    "instructor_admin_link",
                ),
            },
        ),
        (
            "Container 8: Course Roadmap (Modules/Lectures)",
            {
                "description": (
                    "The public roadmap enriches the sales page without changing lesson modules or videos. "
                    "Student lesson content remains controlled from Modules page."
                ),
                "fields": (
                    "public_curriculum",
                    "section_count_display",
                    "lecture_count_display",
                    "module_admin_link",
                ),
            },
        ),
        ("Publishing", {"fields": ("is_published",)}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    def get_queryset(self, request):
        queryset = super().get_queryset(request)
        return queryset.select_related("instructor").annotate(
            _section_count=Count("sections", distinct=True),
            _lecture_count=Count("sections__lectures", distinct=True),
        )

    def get_changeform_initial_data(self, request):
        initial = super().get_changeform_initial_data(request)
        initial.setdefault("is_published", True)
        initial.setdefault("launch_status", Course.STATUS_LIVE)
        return initial

    @admin.display(description="Purchase Readiness")
    def purchase_readiness(self, obj):
        if not obj or not getattr(obj, "pk", None):
            return "Save the course to evaluate checkout readiness."

        blockers = []
        if not getattr(settings, "DIRECT_COURSE_PAYMENTS_ENABLED", False):
            blockers.append("direct payments disabled")
        if not getattr(settings, "RAZORPAY_KEY_ID", "") or not getattr(
            settings, "RAZORPAY_KEY_SECRET", ""
        ):
            blockers.append("Razorpay credentials missing")
        if not obj.is_published:
            blockers.append("course unpublished")
        if obj.launch_status != Course.STATUS_LIVE:
            blockers.append("course not live")
        if obj.registration_closed:
            blockers.append("registration closed")
        if not enabled_plan_ids(obj):
            blockers.append("no payment cards are switched on")

        if blockers:
            return format_html(
                '<span class="enterprise-status enterprise-status--error">'
                '<svg class="enterprise-icon" aria-hidden="true"><use href="#icon-error"></use></svg>'
                'Blocked:</span> {}',
                ", ".join(blockers),
            )

        return format_html(
            '<span class="enterprise-status enterprise-status--success">'
            '<svg class="enterprise-icon" aria-hidden="true"><use href="#icon-checkmark"></use></svg>'
            'Ready for secure purchase</span>'
        )

    @admin.display(description="Payment cards")
    def payment_cards_overview(self, obj):
        """Live card count (updated as you edit) and a preview of the saved cards."""
        live_inputs = json.dumps(
            [
                {
                    "plan": spec.plan,
                    "label": spec.admin_label,
                    "enabled": f"id_{spec.enabled_field}",
                    "price": f"id_{spec.price_field}",
                }
                for spec in CATALOG
            ]
        )
        # Re-read the row: after a rejected save, obj holds the submitted values.
        saved = Course.objects.filter(pk=obj.pk).first() if obj is not None and obj.pk else None
        saved_cards = resolve_course_plans(saved) if saved is not None else []
        count = len(saved_cards)
        live_count = format_html(
            '<div class="payment-cards-live" data-payment-cards="{}" aria-live="polite">'
            '<strong data-role="count">{}</strong> <span data-role="detail">{}</span></div>',
            live_inputs,
            _payment_cards_count_label(count),
            _payment_cards_count_detail(count),
        )
        if not saved_cards:
            preview = format_html(
                '<p class="payment-cards-preview__note">{}</p>',
                "Save the course to preview its payment cards."
                if obj is None or not obj.pk
                else "No payment cards are shown: online purchase is off and the page says pricing will be announced.",
            )
            return format_html("{}{}", live_count, preview)
        shown = {card["plan"] for card in saved_cards}
        hidden = [spec.admin_label for spec in CATALOG if spec.plan not in shown]
        rows = format_html_join(
            "",
            "<tr{}><td>{}</td><td><strong>{}</strong><br><span>{}</span></td><td>{}<br><span>{}</span></td>"
            "<td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            (
                (
                    format_html(' class="{}"', "is-highlighted") if card["highlighted"] else "",
                    card["order"],
                    card["title"],
                    card["subtitle"],
                    card["price_label"],
                    card["total_label"] or "",
                    card["access_label"],
                    card["badge"] or "-",
                    "; ".join(card["features"]),
                    card["cta_label"],
                )
                for card in saved_cards
            ),
        )
        return format_html(
            '{}<p class="payment-cards-preview__note">Saved cards as students see them, {} per row{}. '
            "The highlighted card is marked.</p>"
            '<div class="payment-cards-preview"><table><thead><tr><th>#</th><th>Card</th><th>Price</th>'
            "<th>Access</th><th>Badge</th><th>Features</th><th>Button</th></tr></thead>"
            "<tbody>{}</tbody></table></div>",
            live_count,
            payment_cards_per_row(count),
            format_html("; hidden: {}", ", ".join(hidden)) if hidden else "",
            rows,
        )

    @admin.display(ordering="_section_count", description="Modules")
    def section_count(self, obj):
        return getattr(obj, "_section_count", None) or obj.sections.count()

    @admin.display(ordering="_lecture_count", description="Lectures")
    def lecture_count(self, obj):
        return getattr(obj, "_lecture_count", None) or Lecture.objects.filter(section__course=obj).count()

    @admin.display(description="Module Count")
    def section_count_display(self, obj):
        if not obj.pk:
            return "Save the course first to view module and lecture counts."
        return self.section_count(obj)

    @admin.display(description="Lecture Count")
    def lecture_count_display(self, obj):
        if not obj.pk:
            return "Save the course first to view module and lecture counts."
        return self.lecture_count(obj)

    @admin.display(description="Thumbnail Preview")
    def thumbnail_preview(self, obj):
        if getattr(obj, "_has_accessible_thumbnail_file", None) and obj._has_accessible_thumbnail_file():
            if obj.pk:
                version = int(obj.updated_at.timestamp() * 1_000_000) if getattr(obj, "updated_at", None) else 0
                preview_url = f"{reverse('course-thumbnail', args=[obj.pk])}?v={version}"
            else:
                preview_url = obj.thumbnail_file.url
            return format_html(
                '<img class="enterprise-thumbnail-preview" src="{}" alt="{}" />',
                preview_url,
                obj.title,
            )
        if not getattr(obj, "thumbnail", ""):
            if getattr(obj, "thumbnail_file", None) and getattr(obj.thumbnail_file, "name", ""):
                return "Uploaded thumbnail file path exists in DB but file is missing on storage."
            return "No thumbnail URL"
        return format_html(
            '<img class="enterprise-thumbnail-preview" src="{}" alt="{}" />',
            obj.thumbnail,
            obj.title,
        )

    @admin.display(description="Edit Instructor Profile")
    def instructor_admin_link(self, obj):
        if not getattr(obj, "instructor_id", None):
            return "Select an instructor to edit profile details."
        url = reverse("admin:users_user_change", args=[obj.instructor_id])
        label = obj.instructor.full_name or obj.instructor.email
        return format_html('<a href="{}">Open instructor: {}</a>', url, label)

    @admin.display(description="Module Control Page")
    def module_admin_link(self, obj):
        if not obj.pk:
            return "Save the course first, then add modules from the Modules page."
        url = reverse("admin:courses_section_changelist")
        return format_html(
            '<a href="{}?course__id__exact={}">Open Modules for this course (and add module videos)</a>',
            url,
            obj.pk,
        )

    @admin.display(description="Actions")
    def admin_actions(self, obj):
        edit_url = reverse("admin:courses_course_change", args=[obj.pk])
        delete_url = reverse("admin:courses_course_delete", args=[obj.pk])
        return format_html('<a href="{}">Edit</a> | <a href="{}">Delete</a>', edit_url, delete_url)

    @admin.display(description="Frontend Container Mapping")
    def frontend_container_guide(self, obj):
        return format_html(
            """
            <div style="line-height:1.5;">
              <div><strong>1. Hero Header:</strong> category, level, launch status, title, short description</div>
              <div><strong>2. Hero Left Cards:</strong> one-time price (Payment cards) + About This Course</div>
              <div><strong>3. Optional course image:</strong> use only with an informational image and enable its display toggle</div>
              <div><strong>4. What You Will Cover:</strong> one line = one chip</div>
              <div><strong>5. Expected Outcomes:</strong> one line = one outcome card</div>
              <div><strong>6. Enrollment Panel:</strong> Enrollment note + launch/price source</div>
              <div><strong>7. Course Snapshot:</strong> snapshot category/level/instructor</div>
              <div><strong>8. Course Roadmap:</strong> modules/lectures from Modules page</div>
            </div>
            """
        )

    @admin.display(description="Enrollment Status & Price Source")
    def enrollment_container_source(self, obj):
        launch_value = getattr(obj, "launch_status", None) or "coming_soon"
        launch_label = dict(Course.LAUNCH_STATUS_CHOICES).get(launch_value, launch_value)
        price_value = getattr(obj, "price", None)
        return format_html(
            "This panel uses launch status <strong>{}</strong> (Container 1) and the one-time price "
            "<strong>{}</strong> (Payment cards).",
            launch_label,
            price_value if price_value is not None else "-",
        )

    class Media:
        css = {"all": ("admin/css/course_payment_cards.css",)}
        js = ("admin/js/course_payment_cards.js",)

    @transaction.atomic
    def save_model(self, request, obj, form, change):
        was_included = bool(change and Course.objects.filter(pk=obj.pk, included_in_batch_pass=True).exists())
        super().save_model(request, obj, form, change)
        if was_included == obj.included_in_batch_pass:
            return
        if obj.included_in_batch_pass:
            granted = grant_course_to_pass_holders(obj)
            log_security_event(
                "admin.batch_pass_course_included",
                request=request,
                course_id=obj.pk,
                pass_holders=getattr(form, "pass_holder_count", None),
                granted=granted,
                published=obj.is_published,
            )
            return
        result = revoke_course_from_pass_holders(obj)
        log_security_event(
            "admin.batch_pass_course_excluded",
            request=request,
            course_id=obj.pk,
            pass_holders=getattr(form, "pass_holder_count", None),
            **result,
        )
        if result["revoked"] or result["reduced"]:
            self.message_user(
                request,
                f"Removed from the batch pass: {result['revoked']} enrollment(s) revoked, "
                f"{result['reduced']} reduced to their own installment access.",
                level=messages.WARNING,
            )

    @admin.action(description="Mark selected courses as Live")
    def mark_live(self, request, queryset):
        queryset.update(launch_status=Course.STATUS_LIVE)
        bump_course_list_cache_version()

    @admin.action(description="Mark selected courses as Coming Soon")
    def mark_coming_soon(self, request, queryset):
        queryset.update(launch_status=Course.STATUS_COMING_SOON)
        bump_course_list_cache_version()

    @admin.action(description="Open registrations for selected courses")
    def open_registrations(self, request, queryset):
        queryset.update(registration_closed=False)
        bump_course_list_cache_version()

    @admin.action(description="Close registrations for selected courses")
    def close_registrations(self, request, queryset):
        queryset.update(registration_closed=True)
        bump_course_list_cache_version()

    @admin.action(description="Publish selected courses")
    def publish_courses(self, request, queryset):
        queryset.update(is_published=True)
        bump_course_list_cache_version()

    @admin.action(description="Unpublish selected courses")
    def unpublish_courses(self, request, queryset):
        queryset.update(is_published=False)
        bump_course_list_cache_version()


@admin.register(Section)
class ModuleAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "manage_videos_link",
        "course",
        "title",
        "order",
        "video_count",
    )
    list_display_links = ("id",)
    list_editable = ("title", "order")
    list_filter = ("course", "course__category", "course__level", "course__launch_status", "course__is_published")
    search_fields = ("title", "description", "course__title", "course__description")
    autocomplete_fields = ("course",)
    inlines = [LectureInline]
    ordering = ("course", "order", "id")
    list_per_page = 50
    save_on_top = True
    actions = ("generate_hls_streams",)
    fields = (
        "course",
        "title",
        "description",
        "topics",
        "order",
    )
    readonly_fields = ()

    class Media:
        js = ("admin/js/courses_upload_progress.js",)
        css = {"all": ("admin/css/courses_upload_progress.css",)}

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("course").annotate(
            _video_count=Count("lectures", distinct=True)
        )

    @admin.display(ordering="_video_count", description="Videos")
    def video_count(self, obj):
        return getattr(obj, "_video_count", None) or obj.lectures.count()

    @admin.display(description="Manage Videos")
    def manage_videos_link(self, obj):
        url = reverse("admin:courses_section_change", args=[obj.pk])
        return format_html('<a href="{}">Open Module</a>', url)

    @admin.action(description="Generate HLS streams for uploaded videos in selected modules")
    def generate_hls_streams(self, request, queryset):
        modules = queryset.prefetch_related("lectures", "course")
        transcoded = 0
        skipped = 0
        failed = 0

        for module in modules:
            for lecture in module.lectures.all():
                if not lecture.video_file:
                    skipped += 1
                    continue
                try:
                    transcode_lecture_to_hls(lecture)
                    transcoded += 1
                except VideoTranscodeError:
                    failed += 1

        if transcoded:
            self.message_user(
                request,
                ngettext(
                    "%d lecture was transcoded to HLS.",
                    "%d lectures were transcoded to HLS.",
                    transcoded,
                )
                % transcoded,
                level=messages.SUCCESS,
            )
        if skipped:
            self.message_user(
                request,
                ngettext(
                    "%d lecture was skipped (no uploaded video file).",
                    "%d lectures were skipped (no uploaded video file).",
                    skipped,
                )
                % skipped,
                level=messages.WARNING,
            )
        if failed:
            self.message_user(
                request,
                ngettext(
                    "%d lecture failed to transcode. Check stream status/error in the module form.",
                    "%d lectures failed to transcode. Check stream status/error in the module form.",
                    failed,
                )
                % failed,
                level=messages.ERROR,
            )


@admin.register(Lecture)
class LectureAdmin(LectureEngagementAdminMixin, admin.ModelAdmin):
    form = LectureInlineForm
    list_display = (
        "id",
        "title",
        "section",
        "course_title",
        "order",
        "is_preview",
        "is_published",
        "stream_status",
        "view_count",
        "like_count",
        "comment_count",
        "resource_count",
        "updated_at",
    )
    list_display_links = ("id", "title")
    list_filter = (
        "is_preview",
        "is_published",
        "stream_status",
        "section__course__category",
        "section__course__level",
        "section__course__launch_status",
    )
    search_fields = ("title", "description", "section__title", "section__course__title")
    autocomplete_fields = ("section",)
    ordering = ("section__course", "section", "order", "id")
    inlines = [LectureResourceInline]
    readonly_fields = (
        "stream_status",
        "stream_manifest_key",
        "stream_duration_seconds",
        "stream_error",
        "view_count",
        "like_count",
        "comment_count",
        "created_at",
        "updated_at",
    )
    save_on_top = True
    list_per_page = 50
    fields = (
        "section",
        "title",
        "description",
        "order",
        "is_preview",
        "is_published",
        "view_count",
        "like_count",
        "comment_count",
        "video_file",
        "remove_uploaded_video",
        "video_key",
        "stream_status",
        "stream_manifest_key",
        "stream_duration_seconds",
        "stream_error",
        "created_at",
        "updated_at",
    )

    class Media:
        js = ("admin/js/courses_upload_progress.js",)
        css = {"all": ("admin/css/courses_upload_progress.css",)}

    def get_queryset(self, request):
        queryset = super().get_queryset(request).select_related("section", "section__course").annotate(
            _resource_count=Count("resources", distinct=True)
        )
        return annotate_engagement_counts(queryset)

    @admin.display(description="Course")
    def course_title(self, obj):
        return getattr(getattr(obj, "section", None), "course", None)

    @admin.display(ordering="_resource_count", description="Resources")
    def resource_count(self, obj):
        return getattr(obj, "_resource_count", None) or obj.resources.count()


@admin.register(LectureQuestion)
class LectureQuestionAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "status",
        "student_name",
        "student_email",
        "course_title",
        "lecture_title",
        "question_preview",
        "created_at",
        "answered_at",
    )
    list_display_links = ("id", "question_preview")
    list_editable = ("status",)
    list_filter = ("status", "lecture__section__course", "created_at", "updated_at")
    search_fields = (
        "question",
        "admin_notes",
        "user__email",
        "user__full_name",
        "lecture__title",
        "lecture__section__course__title",
    )
    raw_id_fields = ("user", "lecture")
    readonly_fields = (
        "student_name",
        "student_email",
        "course_title",
        "lecture_title",
        "question",
        "created_at",
        "updated_at",
        "answered_at",
    )
    fields = (
        "status",
        "student_name",
        "student_email",
        "course_title",
        "lecture_title",
        "user",
        "lecture",
        "question",
        "admin_notes",
        "created_at",
        "updated_at",
        "answered_at",
    )
    ordering = ("-created_at",)
    date_hierarchy = "created_at"
    list_per_page = 50

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("user", "lecture__section__course")

    @admin.display(description="Student")
    def student_name(self, obj):
        value = obj.user.full_name or obj.user.email
        return format_html(
            '<span class="enterprise-identity-pill">{}</span>',
            value,
        )

    @admin.display(description="Email")
    def student_email(self, obj):
        return obj.user.email

    @admin.display(description="Course")
    def course_title(self, obj):
        return obj.lecture.section.course.title

    @admin.display(description="Lecture")
    def lecture_title(self, obj):
        return obj.lecture.title

    @admin.display(description="Question")
    def question_preview(self, obj):
        question = " ".join(str(obj.question or "").split())
        if len(question) > 120:
            question = f"{question[:117]}..."
        return question


@admin.register(Enrollment)
class EnrollmentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "requester_username",
        "requester_email",
        "requester_phone",
        "course",
        "payment_status",
        "access_type",
        "access_expires_at",
        "installments_paid",
        "enrolled_at",
    )
    list_filter = ("payment_status", "access_type", "course__category", "course__level")
    search_fields = ("user__email", "user__full_name", "user__phone_number", "course__title")
    list_editable = ("payment_status",)
    raw_id_fields = ("user", "course")
    readonly_fields = ("requester_username", "requester_email", "requester_phone", "enrolled_at")
    list_per_page = 50
    actions = ("approve_enrollment_requests", "reject_enrollment_requests")

    fields = (
        "requester_username",
        "requester_email",
        "requester_phone",
        "user",
        "course",
        "payment_status",
        "access_type",
        "access_expires_at",
        "installments_paid",
        "enrolled_at",
    )

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("user", "course")

    @admin.display(description="Username")
    def requester_username(self, obj):
        value = obj.user.full_name or obj.user.email
        return format_html(
            '<span class="enterprise-identity-pill">{}</span>',
            value,
        )

    @admin.display(description="Email")
    def requester_email(self, obj):
        return format_html(
            '<span class="enterprise-identity-pill">{}</span>',
            obj.user.email,
        )

    @admin.display(description="Phone")
    def requester_phone(self, obj):
        phone = obj.user.phone_number or "Not provided"
        return format_html(
            '<span class="enterprise-identity-pill">{}</span>',
            phone,
        )

    def get_model_perms(self, request):
        # Managed from Users admin via inlines to keep enrollment control centralized.
        return {}

    @admin.action(description="Approve selected enrollment requests")
    def approve_enrollment_requests(self, request, queryset):
        updated = queryset.exclude(payment_status=Enrollment.STATUS_PAID).update(
            payment_status=Enrollment.STATUS_PAID
        )
        self.message_user(
            request,
            ngettext(
                "%d enrollment request approved.",
                "%d enrollment requests approved.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    @admin.action(description="Reject selected enrollment requests")
    def reject_enrollment_requests(self, request, queryset):
        updated = queryset.exclude(payment_status=Enrollment.STATUS_FAILED).update(
            payment_status=Enrollment.STATUS_FAILED
        )
        self.message_user(
            request,
            ngettext(
                "%d enrollment request rejected.",
                "%d enrollment requests rejected.",
                updated,
            )
            % updated,
            level=messages.WARNING,
        )


@admin.register(LiveClass)
class LiveClassAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "title",
        "access_model",
        "price",
        "month_number",
        "level",
        "schedule_days",
        "class_duration_minutes",
        "is_active",
        "linked_course",
        "enrollment_count",
        "admin_actions",
    )
    list_filter = ("is_active", "level", "month_number")
    search_fields = ("title", "description", "linked_course__title")
    list_editable = ("price", "month_number", "is_active")
    autocomplete_fields = ("linked_course",)
    readonly_fields = ("slug", "enrollment_count_display", "created_at", "updated_at")
    fieldsets = (
        (
            "Student Access Model",
            {
                "description": (
                    "Link this live class to a course for the simplified workflow. "
                    "Students with paid course access receive this live class automatically. "
                    "Leave it unlinked only for legacy standalone access."
                ),
                "fields": ("linked_course",),
            },
        ),
        (
            "Live Class",
            {
                "fields": (
                    "title",
                    "slug",
                    "description",
                    "price",
                    "level",
                    "month_number",
                )
            },
        ),
        ("Schedule", {"fields": ("schedule_days", "class_duration_minutes", "is_active")}),
        ("Enrollments", {"fields": ("enrollment_count_display",)}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("linked_course").annotate(
            _enrollment_count=Count("enrollments", distinct=True)
        )

    @admin.display(ordering="_enrollment_count", description="Enrollments")
    def enrollment_count(self, obj):
        return getattr(obj, "_enrollment_count", None) or obj.enrollments.count()

    @admin.display(ordering="linked_course", description="Student Access")
    def access_model(self, obj):
        return "Included with course" if obj.linked_course_id else "Legacy standalone"

    @admin.display(description="Enrollment Count")
    def enrollment_count_display(self, obj):
        if not obj.pk:
            return "Save the live class first to view enrollments."
        return self.enrollment_count(obj)

    @admin.display(description="Actions")
    def admin_actions(self, obj):
        edit_url = reverse("admin:courses_liveclass_change", args=[obj.pk])
        delete_url = reverse("admin:courses_liveclass_delete", args=[obj.pk])
        return format_html('<a href="{}">Edit</a> | <a href="{}">Delete</a>', edit_url, delete_url)


@admin.register(LiveClassEnrollment)
class LiveClassEnrollmentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "live_class",
        "status",
        "user_full_name",
        "user_email",
        "user_phone",
        "created_at",
    )
    list_filter = ("status", "live_class", "live_class__level", "live_class__month_number", "created_at")
    search_fields = ("user__email", "user__full_name", "user__phone_number", "live_class__title")
    list_editable = ("status",)
    autocomplete_fields = ("user", "live_class")
    readonly_fields = ("user_full_name", "user_email", "user_phone", "created_at")
    actions = ("approve_enrollment_requests", "reject_enrollment_requests")
    fields = ("user_full_name", "user_email", "user_phone", "user", "live_class", "status", "created_at")

    def get_model_perms(self, request):
        # Managed from Users admin via inlines to keep enrollment control centralized.
        return {}

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("user", "live_class")

    @admin.display(description="User Name")
    def user_full_name(self, obj):
        value = obj.user.full_name or obj.user.email
        return format_html(
            '<span class="enterprise-identity-pill">{}</span>',
            value,
        )

    @admin.display(description="User Email")
    def user_email(self, obj):
        return format_html(
            '<span class="enterprise-identity-pill">{}</span>',
            obj.user.email,
        )

    @admin.display(description="User Phone")
    def user_phone(self, obj):
        phone = obj.user.phone_number or "Not provided"
        return format_html(
            '<span class="enterprise-identity-pill">{}</span>',
            phone,
        )

    @admin.action(description="Approve selected live-class enrollment requests")
    def approve_enrollment_requests(self, request, queryset):
        updated = queryset.exclude(status=LiveClassEnrollment.STATUS_APPROVED).update(
            status=LiveClassEnrollment.STATUS_APPROVED
        )
        self.message_user(
            request,
            ngettext(
                "%d live-class enrollment approved.",
                "%d live-class enrollments approved.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    @admin.action(description="Reject selected live-class enrollment requests")
    def reject_enrollment_requests(self, request, queryset):
        updated = queryset.exclude(status=LiveClassEnrollment.STATUS_REJECTED).update(
            status=LiveClassEnrollment.STATUS_REJECTED
        )
        self.message_user(
            request,
            ngettext(
                "%d live-class enrollment rejected.",
                "%d live-class enrollments rejected.",
                updated,
            )
            % updated,
            level=messages.WARNING,
        )


@admin.register(PublicEnrollmentLead)
class PublicEnrollmentLeadAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "status",
        "target_type",
        "target_name",
        "email",
        "phone_number",
        "whatsapp_number",
        "message_preview",
        "created_at",
    )
    list_display_links = ("id", "target_name", "email")
    list_editable = ("status",)
    list_filter = ("status", "created_at")
    search_fields = (
        "email",
        "phone_number",
        "whatsapp_number",
        "message",
        "course__title",
        "live_class__title",
    )
    readonly_fields = (
        "course",
        "live_class",
        "target_name",
        "email",
        "phone_number",
        "whatsapp_number",
        "message",
        "source_path",
        "created_at",
        "updated_at",
    )
    autocomplete_fields = ("course", "live_class")
    ordering = ("-created_at",)
    date_hierarchy = "created_at"
    list_per_page = 100
    fieldsets = (
        ("Enrollment Request", {"fields": ("status", "course", "live_class", "target_name")}),
        ("Contact", {"fields": ("email", "phone_number", "whatsapp_number")}),
        ("Message", {"fields": ("message", "source_path")}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    actions = ("mark_reviewed", "mark_contacted", "mark_converted")

    @admin.display(description="Target Type")
    def target_type(self, obj):
        if obj.course_id:
            return "Course"
        if obj.live_class_id:
            return "Live Class"
        return "General"

    @admin.display(description="Target")
    def target_name(self, obj):
        if obj.course_id:
            return obj.course.title
        if obj.live_class_id:
            return obj.live_class.title
        return "General enquiry"

    @admin.display(description="Message")
    def message_preview(self, obj):
        text = (obj.message or "").strip()
        if len(text) <= 80:
            return text
        return f"{text[:80]}..."

    @admin.action(description="Mark selected leads as Reviewed")
    def mark_reviewed(self, request, queryset):
        updated = queryset.exclude(status=PublicEnrollmentLead.STATUS_REVIEWED).update(
            status=PublicEnrollmentLead.STATUS_REVIEWED
        )
        self.message_user(
            request,
            ngettext(
                "%d lead marked as reviewed.",
                "%d leads marked as reviewed.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    @admin.action(description="Mark selected leads as Contacted")
    def mark_contacted(self, request, queryset):
        updated = queryset.exclude(status=PublicEnrollmentLead.STATUS_CONTACTED).update(
            status=PublicEnrollmentLead.STATUS_CONTACTED
        )
        self.message_user(
            request,
            ngettext(
                "%d lead marked as contacted.",
                "%d leads marked as contacted.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    @admin.action(description="Mark selected leads as Converted")
    def mark_converted(self, request, queryset):
        updated = queryset.exclude(status=PublicEnrollmentLead.STATUS_CONVERTED).update(
            status=PublicEnrollmentLead.STATUS_CONVERTED
        )
        self.message_user(
            request,
            ngettext(
                "%d lead marked as converted.",
                "%d leads marked as converted.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )


@admin.register(EnrollmentRequestNotification)
class EnrollmentRequestNotificationAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "channel",
        "status",
        "destination",
        "request_target",
        "attempts",
        "created_at",
        "sent_at",
    )
    list_filter = ("channel", "status", "created_at", "sent_at")
    search_fields = (
        "destination",
        "message",
        "public_lead__email",
        "public_lead__whatsapp_number",
        "enrollment__user__email",
        "live_class_enrollment__user__email",
        "enrollment__course__title",
        "live_class_enrollment__live_class__title",
    )
    readonly_fields = (
        "public_lead",
        "enrollment",
        "live_class_enrollment",
        "channel",
        "destination",
        "message",
        "status",
        "attempts",
        "provider_response",
        "last_error",
        "created_at",
        "updated_at",
        "sent_at",
    )
    ordering = ("-created_at",)
    date_hierarchy = "created_at"
    list_per_page = 100
    fieldsets = (
        ("Request Link", {"fields": ("public_lead", "enrollment", "live_class_enrollment")}),
        ("Delivery", {"fields": ("channel", "destination", "status", "attempts", "sent_at")}),
        ("Message", {"fields": ("message",)}),
        ("Provider", {"fields": ("provider_response", "last_error"), "classes": ("collapse",)}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    @admin.display(description="Target")
    def request_target(self, obj):
        if obj.public_lead_id:
            return str(obj.public_lead)
        if obj.enrollment_id:
            return f"{obj.enrollment.user.email} -> {obj.enrollment.course.title}"
        if obj.live_class_enrollment_id:
            return f"{obj.live_class_enrollment.user.email} -> {obj.live_class_enrollment.live_class.title}"
        return "-"

    def has_add_permission(self, request):
        return False


admin.site.site_header = "Al syed Initiative Admin"
admin.site.site_title = "Al syed Initiative Admin"
admin.site.index_title = "Course, Modules, and Enrollment Management"

