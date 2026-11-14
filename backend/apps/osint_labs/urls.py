from django.urls import path

from .views import DirectoryProgressView, DirectoryView, LabsEntitlementView, LabsPassView, LabsPolicyView

# Mounted twice (config/urls.py): /api/labs/ and /api/ctf/labs/ (labs origin CORS scope).
urlpatterns = [
    path("directory/", DirectoryView.as_view(), name="labs-directory"),
    path("directory/<slug:slug>/progress/", DirectoryProgressView.as_view(), name="labs-directory-progress"),
    path("policy/", LabsPolicyView.as_view(), name="labs-policy"),
    path("entitlement/", LabsEntitlementView.as_view(), name="labs-entitlement"),
    path("pass/", LabsPassView.as_view(), name="labs-pass"),
]
