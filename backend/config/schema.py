from drf_spectacular.views import SpectacularAPIView
from rest_framework.permissions import IsAdminUser


class AdminOpenAPISchemaView(SpectacularAPIView):
    """Expose the API contract only to authenticated administrators."""

    permission_classes = (IsAdminUser,)
