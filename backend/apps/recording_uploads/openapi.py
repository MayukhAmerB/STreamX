"""drf-spectacular: document the personal upload token (X-Upload-Token)."""

from drf_spectacular.extensions import OpenApiAuthenticationExtension


class RecordingUploadTokenScheme(OpenApiAuthenticationExtension):
    target_class = "apps.recording_uploads.tokens.RecordingUploadTokenAuthentication"
    name = "recordingUploadToken"

    def get_security_definition(self, auto_schema):
        return {
            "type": "apiKey",
            "in": "header",
            "name": "X-Upload-Token",
            "description": "Personal upload token (Console -> Upload recording). Upload endpoints only.",
        }
