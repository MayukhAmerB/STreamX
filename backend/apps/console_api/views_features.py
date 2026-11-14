"""Feature switches API for the Console (plan §5.5, Appendix A.3). OWNER: WS-F.

``GET  /api/admin/features/``        → list of feature cards (staff)
``POST /api/admin/features/<key>/``  → ``{enabled, expected_version, note, reason}``
                                       → 200 card | 409 ``feature_changed_meanwhile`` | 403

Both call ``apps.core.features`` (the same service as the Django
Settings › Features page). Also hosts the ``/admin/settings/features/``
alias redirect used by ``config/urls.py``.

Every change is audited by ``set_feature`` (``FeatureFlag`` row version,
``FeatureFlagChange`` history, admin ``LogEntry``) exactly like a flip on the
Django page.
"""

from __future__ import annotations

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from django.contrib.admin.views.decorators import staff_member_required
from django.shortcuts import redirect
from django.urls import NoReverseMatch, reverse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework.views import APIView

from apps.core import features
from apps.core.errors import NotFound, PermissionDenied, ValidationFailed

from .permissions import IsStaffMember, can_change_features


def feature_card(feature: features.Feature) -> dict:
    stored = features.state(feature.key)
    impact = features.impact(feature.key)
    return {
        "key": feature.key,
        "label": feature.label,
        "summary": feature.summary,
        "group": feature.group,
        "enabled": features.is_enabled(feature.key),
        "default": features.default_value(feature.key),
        "locked": features.forced_value(feature.key) is not None,
        "version": stored["version"],
        "updated_by": stored["updated_by"],
        "updated_at": stored["updated_at"],
        "impact": impact,
        "history": stored["history"],
    }


def _as_bool(value, field):
    if isinstance(value, bool):
        return value
    raise ValidationFailed(details={field: ["Must be true or false."]})


class _FeaturesView(APIView):
    permission_classes = [IsStaffMember]
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "console_read"


class FeatureListView(_FeaturesView):
    @extend_schema(operation_id="admin_features_list", responses={200: OpenApiTypes.OBJECT})
    def get(self, request):
        return api_response(data=[feature_card(item) for item in features.registered_features()])


class FeatureUpdateView(_FeaturesView):
    throttle_scope = "feature_write"

    @extend_schema(operation_id="admin_features_update", request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
    def post(self, request, key):
        if not can_change_features(request.user):
            raise PermissionDenied("Only admins with the feature permission can change switches.")
        feature = features.get_feature(key)
        if feature is None:
            raise NotFound("Unknown feature.", code="feature_not_found", details={"feature": key})
        if features.forced_value(key) is not None:
            raise PermissionDenied("Locked by server configuration.", code="feature_locked", details={"feature": key})
        body = request.data if isinstance(request.data, dict) else {}
        enabled = _as_bool(body.get("enabled"), "enabled")
        expected = body.get("expected_version")
        if expected is not None and (isinstance(expected, bool) or not isinstance(expected, int)):
            raise ValidationFailed(details={"expected_version": ["Must be a whole number."]})
        features.set_feature(
            key,
            enabled,
            by=request.user,
            note=str(body.get("note") or "")[:500],
            reason=(str(body["reason"])[:160] if body.get("reason") else None),
            expected_version=expected,
            request=request,
        )
        return api_response(data=feature_card(feature))


@staff_member_required
def features_admin_redirect(request):
    """``/admin/settings/features/`` → the Features changelist (WS-F registers
    ``core.FeatureFlag``); the admin index until it exists."""
    try:
        return redirect(reverse("admin:core_featureflag_changelist"))
    except NoReverseMatch:
        return redirect(reverse("admin:index"))
