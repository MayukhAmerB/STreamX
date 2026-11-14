"""Django admin for the Monthly OSINT CTF (imported by ``apps/ctf/admin.py``).

* Seasons: create and edit (accepted answers are typed into a write-only
  field and stored only as peppered digests), schedule / back to draft,
  close now, a results preview (standings + every reward finalising would
  grant) and finalise. Every step is written to the season audit log.
* Entries: disqualify or reinstate with a reason (before finalisation).
* Rewards: read-only, revocable with a reason.
* Attempts and the audit log: read-only.
"""

from __future__ import annotations

from config.audit import log_security_event
from django import forms
from django.contrib import admin, messages
from django.http import Http404, HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils import timezone
from django.utils.html import format_html

from apps.core.errors import DomainError
from apps.users.identity_admin import IDENTITY_LIST_DISPLAY, StudentIdentityAdminMixin

from . import season_services as services
from .season_models import CtfSeason, CtfSeasonAttempt, CtfSeasonAudit, CtfSeasonEntry, CtfSeasonReward

RESERVED_SLUGS = {"current", "me", "cosmetics", "hall-of-fame", "certificates"}


def _error_text(exc: DomainError) -> str:
    return str(getattr(exc, "message", "") or exc)


class CtfSeasonForm(forms.ModelForm):
    accepted_answers = forms.CharField(
        required=False,
        widget=forms.Textarea(attrs={"rows": 3, "autocomplete": "off", "spellcheck": "false"}),
        help_text=(
            "One accepted answer per line. Stored only as peppered digests and never shown again. "
            "Leave empty to keep the current answers."
        ),
    )

    class Meta:
        model = CtfSeason
        fields = "__all__"

    def clean_slug(self):
        slug = self.cleaned_data.get("slug", "")
        if slug in RESERVED_SLUGS:
            raise forms.ValidationError("This id is reserved; use the month, e.g. 2026-12.")
        return slug

    def clean(self):
        cleaned = super().clean()
        has_answers = bool((self.instance and self.instance.answer_hashes) or "")
        typed = [line.strip() for line in str(cleaned.get("accepted_answers") or "").splitlines() if line.strip()]
        cleaned["accepted_answers_list"] = typed
        if not typed and not has_answers:
            self.add_error("accepted_answers", "Add at least one accepted answer.")
        return cleaned


@admin.register(CtfSeason)
class CtfSeasonAdmin(admin.ModelAdmin):
    form = CtfSeasonForm
    list_display = ("month_display", "title", "status", "opens_at", "closes_at", "entries_count", "finalised_at", "preview_link")
    list_filter = ("status", "difficulty")
    search_fields = ("title", "slug")
    ordering = ("-month",)
    actions = ("schedule_selected", "unschedule_selected", "close_now_selected", "finalise_selected")
    fieldsets = (
        ("Season", {"fields": ("slug", "month", "title", "tagline", "difficulty", "skills")}),
        ("Case file", {"fields": ("brief", "question", "flag_format", "materials_url")}),
        ("Answers", {"fields": ("accepted_answers", "answers_state", "answer_rules")}),
        ("Window", {"fields": ("opens_at", "closes_at", "auto_finalise")}),
        ("Scoring", {"fields": ("wrong_attempt_penalty_seconds", "max_attempts", "solve_xp")}),
        (
            "Lifecycle",
            {"fields": ("status", "opened_at", "closed_at", "finalised_at", "finalised_by", "created_by", "updated_at")},
        ),
    )
    LOCKED_ONCE_LIVE = ("slug", "month", "opens_at", "answer_rules", "wrong_attempt_penalty_seconds")

    def get_readonly_fields(self, request, obj=None):
        fields = ["answers_state", "status", "opened_at", "closed_at", "finalised_at", "finalised_by", "created_by", "updated_at"]
        if obj is not None and obj.status in CtfSeason.LIVE_STATUSES:
            fields += list(self.LOCKED_ONCE_LIVE)
            if obj.status != CtfSeason.STATUS_OPEN:
                fields += ["closes_at", "max_attempts", "solve_xp", "auto_finalise"]
        return fields

    def get_form(self, request, obj=None, change=False, **kwargs):
        form = super().get_form(request, obj, change=change, **kwargs)
        if obj is not None and obj.status in CtfSeason.LIVE_STATUSES and "accepted_answers" in form.base_fields:
            form.base_fields["accepted_answers"].help_text += " Changing answers of a live season is audited."
        return form

    @admin.display(description="Month", ordering="month")
    def month_display(self, obj):
        return obj.month_label

    @admin.display(description="Entries")
    def entries_count(self, obj):
        return obj.entries.count()

    @admin.display(description="Accepted answers")
    def answers_state(self, obj):
        if obj is None or not obj.pk:
            return "Not set"
        problem = services.answers_problem(obj)
        return problem or f"{len(obj.answer_hashes)} accepted answer digest(s) stored."

    @admin.display(description="Results")
    def preview_link(self, obj):
        return format_html('<a href="{}">Preview</a>', reverse("admin:ctf_ctfseason_preview", args=[obj.pk]))

    def save_model(self, request, obj, form, change):
        if not change:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)
        typed = form.cleaned_data.get("accepted_answers_list") or []
        if typed:
            try:
                services.set_answers(obj, typed, rules=obj.answer_rules or None, actor=request.user)
            except DomainError as exc:
                self.message_user(request, _error_text(exc), messages.ERROR)
        services.audit(obj, request.user, "update" if change else "create", fields=sorted(form.changed_data))

    def has_delete_permission(self, request, obj=None):
        # Seasons with entries are history (rewards point at them).
        if obj is not None and (obj.status in CtfSeason.LIVE_STATUSES or obj.entries.exists()):
            return False
        return super().has_delete_permission(request, obj)

    # --- actions ---------------------------------------------------------
    def _each(self, request, queryset, func, done_message):
        done = 0
        for season in queryset:
            try:
                func(season)
                done += 1
            except DomainError as exc:
                self.message_user(request, f"{season.slug}: {_error_text(exc)}", messages.ERROR)
        if done:
            self.message_user(request, done_message.format(count=done), messages.SUCCESS)

    @admin.action(description="Schedule (opens automatically at its time)")
    def schedule_selected(self, request, queryset):
        self._each(request, queryset, lambda season: services.schedule(season, actor=request.user), "{count} season(s) scheduled.")

    @admin.action(description="Move back to draft (not opened yet)")
    def unschedule_selected(self, request, queryset):
        self._each(request, queryset, lambda season: services.unschedule(season, actor=request.user), "{count} season(s) moved back to draft.")

    @admin.action(description="Close now (stop accepting answers)")
    def close_now_selected(self, request, queryset):
        def close(season):
            now = timezone.now()
            if season.status != CtfSeason.STATUS_OPEN:
                raise services.Conflict("Only an open season can be closed.", code="season_not_open")
            CtfSeason.objects.filter(pk=season.pk, status=CtfSeason.STATUS_OPEN).update(
                status=CtfSeason.STATUS_CLOSED, closes_at=now, closed_at=now, updated_at=now
            )
            services.audit(season, request.user, "close", manual=True)
            services._bump_leaderboard(season.pk)

        self._each(request, queryset, close, "{count} season(s) closed.")

    @admin.action(description="Finalise results and grant rewards")
    def finalise_selected(self, request, queryset):
        def run(season):
            result = services.finalise(season, actor=request.user)
            log_security_event("admin.ctf_season_finalised", request=request, season=season.slug, **result)

        self._each(request, queryset, run, "{count} season(s) finalised.")

    # --- preview ---------------------------------------------------------
    def get_urls(self):
        return [
            path(
                "<path:object_id>/preview/",
                self.admin_site.admin_view(self.preview_view),
                name="ctf_ctfseason_preview",
            )
        ] + super().get_urls()

    def preview_view(self, request, object_id):
        season = self.get_object(request, object_id)
        if season is None or not self.has_view_permission(request, season):
            raise Http404("Season not found.")
        if request.method == "POST" and request.POST.get("action") == "finalise":
            if not self.has_change_permission(request, season):
                raise Http404("Season not found.")
            try:
                result = services.finalise(season, actor=request.user)
                log_security_event("admin.ctf_season_finalised", request=request, season=season.slug, **result)
                self.message_user(
                    request,
                    f"Finalised: {result['ranked']} ranked, {result['granted']} reward(s) granted.",
                    messages.SUCCESS,
                )
            except DomainError as exc:
                self.message_user(request, _error_text(exc), messages.ERROR)
            return HttpResponseRedirect(reverse("admin:ctf_ctfseason_preview", args=[season.pk]))
        now = timezone.now()
        standings = list(services.standings_queryset(season).select_related("user")[:100])
        planned = services.planned_rewards(season, now=now) if season.status != CtfSeason.STATUS_FINALISED else []
        granted = (
            list(season.rewards.select_related("user").order_by("rank", "kind"))
            if season.status == CtfSeason.STATUS_FINALISED
            else []
        )
        users = {entry.user_id: entry.user for entry in standings}
        rows = [
            {
                "rank": index + 1,
                "name": services.public_name(entry.user, real_names=False),
                "email": entry.user.email,
                "solve_seconds": entry.solve_seconds,
                "wrong_attempts": entry.wrong_attempts,
                "score_seconds": entry.score_seconds,
                "solved_at": entry.solved_at,
            }
            for index, entry in enumerate(standings)
        ]
        reward_rows = [
            {
                "rank": reward.rank,
                "who": (users.get(reward.user_id) or reward.user).email if reward.user_id else "",
                "title": reward.title,
                "kind": reward.get_kind_display(),
                "ends_at": reward.ends_at,
                "revoked": bool(reward.revoked_at),
            }
            for reward in (granted or planned)
        ]
        context = {
            **self.admin_site.each_context(request),
            "opts": self.model._meta,
            "original": season,
            "season": season,
            "title": f"Results preview · {season}",
            "rows": rows,
            "reward_rows": reward_rows,
            "is_final": season.status == CtfSeason.STATUS_FINALISED,
            "can_finalise": season.status == CtfSeason.STATUS_CLOSED
            or (season.status == CtfSeason.STATUS_OPEN and season.closes_at <= now),
            "disqualified": season.entries.filter(disqualified=True).count(),
            "audit": list(season.audit.select_related("actor")[:20]),
            "changelist_url": reverse("admin:ctf_ctfseason_changelist"),
        }
        return TemplateResponse(request, "admin/ctf/ctfseason/preview.html", context)


class CtfSeasonEntryForm(forms.ModelForm):
    class Meta:
        model = CtfSeasonEntry
        fields = ("disqualified", "disqualified_reason")


@admin.register(CtfSeasonEntry)
class CtfSeasonEntryAdmin(StudentIdentityAdminMixin, admin.ModelAdmin):
    form = CtfSeasonEntryForm
    # Owner rule: roll number, real name, handle, stats first; then the record (staff only).
    list_display = (*IDENTITY_LIST_DISPLAY, "user", "season", "attempts", "wrong_attempts", "solved_at", "score_seconds", "final_rank", "disqualified")
    list_filter = ("season", "disqualified")
    search_fields = ("user__email", "user__full_name")
    list_select_related = ("user", "season")
    readonly_fields = (
        "student_roll_number", "student_name_snapshot", "student_handle_snapshot",
        "season", "user", "started_at", "attempts", "wrong_attempts", "solved_at", "solve_seconds", "score_seconds", "final_rank",
    )
    fields = readonly_fields + ("disqualified", "disqualified_reason")

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def save_model(self, request, obj, form, change):
        """Disqualify / reinstate through the service (audited, refuses after finalisation)."""
        before = CtfSeasonEntry.objects.get(pk=obj.pk)
        try:
            if obj.disqualified and not before.disqualified:
                services.disqualify(before, actor=request.user, reason=obj.disqualified_reason)
            elif not obj.disqualified and before.disqualified:
                services.reinstate(before, actor=request.user)
        except DomainError as exc:
            self.message_user(request, _error_text(exc), messages.ERROR)


class CtfSeasonRewardForm(forms.ModelForm):
    revoke_reason = forms.CharField(
        required=False, max_length=300, help_text="Type a reason and save to revoke this reward (audited, cannot be undone)."
    )

    class Meta:
        model = CtfSeasonReward
        fields = ()


@admin.register(CtfSeasonReward)
class CtfSeasonRewardAdmin(admin.ModelAdmin):
    form = CtfSeasonRewardForm
    list_display = ("title", "user", "kind", "rank", "starts_at", "ends_at", "delivered_at", "revoked_at")
    list_filter = ("kind", "season", "tier")
    search_fields = ("user__email", "title")
    list_select_related = ("user", "season")
    readonly_fields = (
        "season", "user", "kind", "rank", "tier", "title", "starts_at", "ends_at", "points", "metadata", "verify_slug",
        "delivered_at", "revoked_at", "revoked_reason", "created_at",
    )

    def get_fields(self, request, obj=None):
        fields = list(self.readonly_fields)
        if obj is not None and obj.revoked_at is None:
            fields.append("revoke_reason")
        return fields

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def save_model(self, request, obj, form, change):
        reason = str(form.cleaned_data.get("revoke_reason") or "").strip()
        if reason:
            try:
                services.revoke_reward(obj, actor=request.user, reason=reason)
                log_security_event("admin.ctf_season_reward_revoked", request=request, reward=obj.pk)
            except DomainError as exc:
                self.message_user(request, _error_text(exc), messages.ERROR)


@admin.register(CtfSeasonAttempt)
class CtfSeasonAttemptAdmin(admin.ModelAdmin):
    list_display = ("created_at", "season", "user", "is_correct", "normalized_answer")
    list_filter = ("season", "is_correct")
    search_fields = ("user__email",)
    list_select_related = ("user", "season")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(CtfSeasonAudit)
class CtfSeasonAuditAdmin(admin.ModelAdmin):
    list_display = ("created_at", "season", "action", "actor")
    list_filter = ("action", "season")
    list_select_related = ("season", "actor")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


def _register_nav_groups():
    """Place the screens in the Al Syed Admin sidebar without editing apps.users."""
    try:
        from apps.users.templatetags.enterprise_admin import MODEL_JOBS
    except Exception:  # noqa: BLE001
        return
    for key, value in (
        ("ctf.ctfseason", ("assessments", "Monthly CTF seasons")),
        ("ctf.ctfseasonentry", ("assessments", "Monthly CTF entries")),
        ("ctf.ctfseasonreward", ("students", "Monthly CTF rewards")),
        ("ctf.ctfseasonattempt", ("system", "Monthly CTF attempts")),
        ("ctf.ctfseasonaudit", ("system", "Monthly CTF audit log")),
    ):
        MODEL_JOBS.setdefault(key, value)


_register_nav_groups()
