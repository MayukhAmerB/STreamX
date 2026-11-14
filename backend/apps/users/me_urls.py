"""``/api/me/``: things about the signed-in viewer. OWNER: WS-F (created by WS-0)."""

from django.urls import path

from . import identity_views, me_views

urlpatterns = [
    path("capabilities/", me_views.CapabilitiesView.as_view(), name="me-capabilities"),
    # Student identity block (roll number, real name, handle, stats). OWNER: identity-exam.
    path("identity/", identity_views.MeIdentityView.as_view(), name="me-identity"),
]
