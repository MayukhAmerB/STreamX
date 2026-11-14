"""Settings › Features in the Django back office (UI overhaul plan §5.5; owner WS-F).

The ``FeatureFlag`` changelist is not a raw table: it renders one card per
registered switch (``templates/admin/core/featureflag/change_list.html``) and
accepts a plain form POST (CSRF, no JavaScript needed) that calls
``apps.core.features.set_feature``. With JavaScript the same form is posted
with ``fetch`` and the card is swapped in place (the response carries the
re-rendered card).

* view: staff with ``core.view_featureflag`` or ``core.change_featureflag``
  (superusers have both); everyone else gets the admin's 403 / login redirect;
* change: superuser or ``core.change_featureflag``;
* a stale ``expected_version`` re-renders the page with "<who> changed this
  <when>. Review and try again." and the fresh state (409);
* success redirects back (PRG) with a status line and an audited Undo.
"""

from __future__ import annotations

from django.contrib import messages
from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.http import Http404, HttpResponseRedirect, JsonResponse
from django.template.loader import render_to_string
from django.template.response import TemplateResponse
from django.urls import reverse
from django.utils import timezone

from . import features
from .errors import Conflict, DomainError, NotFound, ValidationFailed
from .models import FeatureFlag, FeatureFlagChange

CHANGELIST_TEMPLATE = "admin/core/featureflag/change_list.html"
CARD_TEMPLATE = "admin/core/featureflag/_card.html"

GROUP_LABELS = {features.GROUP_SETTINGS: "Console sections"}

# What the confirm panel lists for each direction (plan §5.5 "Flip flow").
CONFIRM_COPY = {
    "teaching": {
        True: [
            "Instructor accounts get their teaching tools back within seconds: Teach home, courses, classes, recordings, grading and exam results for the batches they teach.",
            "Students and admins notice nothing.",
        ],
        False: [
            "Instructor accounts see the Teach section greyed out with the reason below, within seconds.",
            "The server refuses their teaching actions too, including the desktop recording uploader.",
            "Students are never affected. Your own admin tools stay on.",
        ],
    },
}
SUCCESS_COPY = {
    "teaching": {
        True: "Teachers section is on. Instructors will see it within seconds.",
        False: "Teachers section is off. Instructors will see the reason within seconds.",
    },
}
UNDO_WINDOW_SECONDS = 600


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return f"{count} {singular if count == 1 else (plural or singular + 's')}"


def impact_lines(key: str, impact: dict) -> list[str]:
    lines = []
    if "instructor_accounts" in impact:
        lines.append(_plural(int(impact["instructor_accounts"] or 0), "instructor account"))
    if impact.get("live_now"):
        lines.append(_plural(int(impact["live_now"]), "class live now", "classes live now"))
    for name, value in impact.items():
        if name not in {"instructor_accounts", "live_now"}:
            lines.append(f"{name.replace('_', ' ').capitalize()}: {value}")
    return lines


def notice_pairs(text: str) -> list[tuple[str, str]]:
    """"When off: x · Students: y" -> [("When off", "x"), ("Students", "y")]."""
    pairs = []
    for part in str(text or "").split("·"):
        part = part.strip()
        if not part:
            continue
        label, sep, rest = part.partition(":")
        pairs.append((label.strip(), rest.strip()) if sep else ("", part))
    return pairs


def card_context(feature: features.Feature, *, can_change: bool, error: str = "", open_confirm: bool = False) -> dict:
    row = FeatureFlag.objects.select_related("updated_by").filter(key=feature.key).first()
    enabled = features.is_enabled(feature.key)
    locked = features.forced_value(feature.key) is not None
    impact = features.impact(feature.key)
    history = list(
        FeatureFlagChange.objects.filter(key=feature.key)
        .select_related("changed_by")
        .order_by("-changed_at", "-id")[: features.HISTORY_LIMIT]
    )
    target = not enabled
    if locked:
        disabled_reason = features.LOCKED_MESSAGE + " Change FEATURE_FORCE on the server to unlock it."
    elif not can_change:
        disabled_reason = "You can see this switch but not change it. Ask a superuser for the feature permission."
    else:
        disabled_reason = ""
    return {
        "feature": feature,
        "key": feature.key,
        "enabled": enabled,
        "default": features.default_value(feature.key),
        "locked": locked,
        "can_change": can_change and not locked,
        "disabled_reason": disabled_reason,
        "version": int(row.version) if row else 0,
        "row": row,
        "updated_by_name": features._display_name(row.updated_by) if row and row.updated_by_id else "",
        "reason": features.reason_for(feature.key),
        "custom_reason": (row.reason_override if row else "") or "",
        "notices": notice_pairs(feature.notices),
        "impact": impact,
        "impact_lines": impact_lines(feature.key, impact),
        "live_now": int(impact.get("live_now") or 0),
        "history": history,
        "history_count": features.history_count(feature.key),
        "target": target,
        "confirm_title": f"Turn {'on' if target else 'off'} the {feature.label}?",
        "confirm_label": "Turn on" if target else "Turn off",
        "confirm_lines": CONFIRM_COPY.get(feature.key, {}).get(
            target,
            [f"Everyone {'gets' if target else 'loses'} {feature.label} within seconds."],
        ),
        "error": error,
        "open_confirm": bool(open_confirm or error),
    }


def _undo_for(request, key: str):
    """The Undo offer after this admin's own recent change of ``key``."""
    change = FeatureFlagChange.objects.filter(key=key).order_by("-changed_at", "-id").first()
    row = FeatureFlag.objects.filter(key=key).first()
    if change is None or row is None or change.changed_by_id != request.user.pk:
        return None
    if (timezone.now() - change.changed_at).total_seconds() > UNDO_WINDOW_SECONDS:
        return None
    if change.from_enabled is None or features.forced_value(key) is not None:
        return None
    feature = features.get_feature(key)
    return {
        "key": key,
        "enabled": bool(change.from_enabled),
        "version": int(row.version),
        "message": SUCCESS_COPY.get(key, {}).get(
            bool(change.to_enabled),
            f"{feature.label if feature else key} is {'on' if change.to_enabled else 'off'}.",
        ),
    }


class FeaturesPageMixin:
    """ModelAdmin behaviour for ``FeatureFlag`` (mixed into ``FeatureFlagAdmin``)."""

    change_list_template = CHANGELIST_TEMPLATE

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_model_perms(self, request):
        perms = super().get_model_perms(request)
        perms["add"] = False
        perms["delete"] = False
        return perms

    def change_view(self, request, object_id, form_url="", extra_context=None):
        # One page for every switch: individual rows are not edited by hand.
        return HttpResponseRedirect(reverse("admin:core_featureflag_changelist"))

    def history_view(self, request, object_id, extra_context=None):
        return HttpResponseRedirect(reverse("admin:core_featureflagchange_changelist"))

    # -- page --------------------------------------------------------------
    def _wants_json(self, request) -> bool:
        return request.headers.get("X-Requested-With") == "fetch" or "application/json" in request.headers.get(
            "Accept", ""
        )

    def _cards(self, request, *, errors=None, open_keys=()):
        errors = errors or {}
        can_change = self.has_change_permission(request)
        groups: dict[str, dict] = {}
        for feature in features.registered_features():
            group = groups.setdefault(
                feature.group,
                {"key": feature.group, "label": GROUP_LABELS.get(feature.group, feature.group.replace("_", " ").capitalize()), "cards": []},
            )
            group["cards"].append(
                card_context(
                    feature,
                    can_change=can_change,
                    error=errors.get(feature.key, ""),
                    open_confirm=feature.key in open_keys,
                )
            )
        return list(groups.values())

    def changelist_view(self, request, extra_context=None):
        if not self.has_view_or_change_permission(request):
            raise DjangoPermissionDenied
        errors: dict[str, str] = {}
        status = 200
        open_keys: tuple[str, ...] = ()
        if request.method == "POST":
            outcome = self._handle_post(request)
            if outcome.get("redirect"):
                return outcome["redirect"]
            if outcome.get("json") is not None:
                return outcome["json"]
            errors = outcome.get("errors", {})
            status = outcome.get("status", 400)
            open_keys = tuple(errors)
        changed = str(request.GET.get("changed") or "")
        context = {
            **self.admin_site.each_context(request),
            "title": "Features",
            "subtitle": None,
            "opts": self.model._meta,
            "app_label": self.model._meta.app_label,
            "groups": self._cards(request, errors=errors, open_keys=open_keys),
            "can_change": self.has_change_permission(request),
            "undo": _undo_for(request, changed) if changed else None,
            "history_url": reverse("admin:core_featureflagchange_changelist"),
            "console_url": "/console/admin/settings/features",
            "has_view_history": request.user.has_perm("core.view_featureflagchange"),
            **(extra_context or {}),
        }
        request.current_app = self.admin_site.name
        return TemplateResponse(request, self.change_list_template, context, status=status)

    def _render_card(self, request, key: str, *, error: str = "") -> str:
        feature = features.get_feature(key)
        return render_to_string(
            CARD_TEMPLATE,
            {"card": card_context(feature, can_change=self.has_change_permission(request), error=error, open_confirm=bool(error))},
            request=request,
        )

    def _handle_post(self, request) -> dict:
        key = str(request.POST.get("key") or "")
        feature = features.get_feature(key)
        wants_json = self._wants_json(request)
        if feature is None:
            raise Http404("Unknown feature.")
        if not self.has_change_permission(request):
            raise DjangoPermissionDenied
        enabled = str(request.POST.get("enabled") or "") in {"1", "true", "on"}
        try:
            expected = int(request.POST.get("expected_version"))
        except (TypeError, ValueError):
            expected = None
        is_undo = request.POST.get("undo") == "1"
        note = str(request.POST.get("note") or "").strip() or ("Undo" if is_undo else "")
        reason = None if enabled else (str(request.POST.get("reason") or "").strip() or None)
        try:
            features.set_feature(
                key,
                enabled,
                by=request.user,
                note=note,
                reason=reason,
                expected_version=expected,
                request=request,
            )
        except (Conflict, ValidationFailed, NotFound, DomainError) as exc:
            message = exc.message
            if isinstance(exc, ValidationFailed) and exc.details:
                first = next(iter(exc.details.values()))
                message = first[0] if isinstance(first, (list, tuple)) and first else str(first)
            status = exc.status
            if wants_json:
                return {
                    "json": JsonResponse(
                        {"ok": False, "code": exc.code, "message": message, "card_html": self._render_card(request, key, error=message)},
                        status=status,
                    )
                }
            return {"errors": {key: message}, "status": status}
        undo = _undo_for(request, key)
        text = SUCCESS_COPY.get(key, {}).get(enabled, f"{feature.label} is {'on' if enabled else 'off'}.")
        if wants_json:
            return {
                "json": JsonResponse(
                    {"ok": True, "message": text, "enabled": enabled, "undo": undo, "card_html": self._render_card(request, key)}
                )
            }
        if undo is None:
            # The page shows its own status line (with Undo) when it can offer one.
            messages.success(request, text)
        return {"redirect": HttpResponseRedirect(f"{reverse('admin:core_featureflag_changelist')}?changed={key}")}
