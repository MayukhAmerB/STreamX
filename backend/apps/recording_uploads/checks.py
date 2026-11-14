"""System checks for the recording upload staging area."""

from django.conf import settings
from django.core.checks import Error, Warning, register

from . import config

CLOUDFLARE_BODY_LIMIT_BYTES = 100 * 1000 * 1000


@register()
def check_recording_upload_settings(app_configs, **kwargs):
    problems = []
    root = config.staging_root()
    if config.is_inside(root, settings.MEDIA_ROOT):
        problems.append(
            Error(
                "RECORDING_UPLOAD_STAGING_ROOT must not be inside MEDIA_ROOT (MEDIA_ROOT is served publicly).",
                id="recording_uploads.E001",
            )
        )
    if config.chunk_bytes() >= CLOUDFLARE_BODY_LIMIT_BYTES:
        problems.append(
            Warning(
                "RECORDING_UPLOAD_CHUNK_BYTES is not below Cloudflare's 100 MB request-body limit; "
                "chunks would be rejected behind the orange cloud.",
                id="recording_uploads.W001",
            )
        )
    if config.chunk_bytes() > 64 * config.MIB:
        problems.append(
            Warning(
                "RECORDING_UPLOAD_CHUNK_BYTES exceeds the 64m client_max_body_size of the nginx chunk location.",
                id="recording_uploads.W002",
            )
        )
    return problems
