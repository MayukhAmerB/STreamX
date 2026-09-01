from drf_spectacular.extensions import OpenApiAuthenticationExtension
from drf_spectacular.openapi import AutoSchema
from drf_spectacular.types import OpenApiTypes
from rest_framework.views import APIView

from config.cookies import ACCESS_COOKIE


class StreamXAutoSchema(AutoSchema):
    """Keep legacy APIViews visible until each receives explicit serializers."""

    def _get_serializer(self):
        view = self.view
        has_serializer_contract = any(
            (
                callable(getattr(view, "get_serializer", None)),
                callable(getattr(view, "get_serializer_class", None)),
                hasattr(view, "serializer_class"),
            )
        )
        if isinstance(view, APIView) and not has_serializer_contract:
            return OpenApiTypes.OBJECT
        return super()._get_serializer()

    def get_operation_id(self):
        operation_id = super().get_operation_id()
        if "{" in self.path:
            return f"{operation_id}_by_id"
        return operation_id


class CookieJWTAuthenticationScheme(OpenApiAuthenticationExtension):
    target_class = "config.authentication.CookieJWTAuthentication"
    name = ("cookieJWT", "bearerJWT")

    def get_security_requirement(self, auto_schema):
        return [{"cookieJWT": []}, {"bearerJWT": []}]

    def get_security_definition(self, auto_schema):
        return [
            {"type": "apiKey", "in": "cookie", "name": ACCESS_COOKIE},
            {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
        ]


def preprocess_api_endpoints(endpoints):
    """Exclude HTML/admin routes from the frontend API contract."""

    return [endpoint for endpoint in endpoints if endpoint[0].startswith("/api/")]
