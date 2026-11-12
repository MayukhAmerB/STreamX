"""Startup checks for weekly reports (same severity policy as apps/core/checks.py:
ERROR blocks a production start, INFO never does, WARNING is not used).

reports.E001  production without the ClamAV scanner (deploy check)
reports.E002  the largest allowed report file is bigger than clamd will scan
reports.E003  REPORTS_PRIVATE_ROOT / REPORTS_QUARANTINE_ROOT inside MEDIA_ROOT
              (nginx would serve them publicly) or the same directory
"""

from __future__ import annotations

from pathlib import Path

from django.conf import settings
from django.core.checks import Error, Tags, register

REPORTS_TAG = "reports"


def _is_production() -> bool:
    return str(getattr(settings, "APP_ENV", "") or "").strip().lower() in {"production", "prod"}


def _resolved(value) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return Path(text).resolve()
    except OSError:
        return None


def _inside(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


@register(REPORTS_TAG)
def check_report_storage_settings(app_configs=None, **kwargs):
    errors = []
    try:
        cap_bytes = int(getattr(settings, "REPORTS_MAX_FILE_SIZE_MB_CAP", 200)) * 1024 * 1024
        stream_max = int(getattr(settings, "CLAMD_STREAM_MAX_BYTES", 0))
    except (TypeError, ValueError):
        cap_bytes, stream_max = 1, 0
    if stream_max < cap_bytes:
        errors.append(
            Error(
                "CLAMD_STREAM_MAX_BYTES is smaller than REPORTS_MAX_FILE_SIZE_MB_CAP: the largest allowed "
                "report file could never be virus-scanned.",
                hint="Raise CLAMD_STREAM_MAX_BYTES (and clamd's StreamMaxLength) or lower the cap.",
                id="reports.E002",
            )
        )
    media_root = _resolved(getattr(settings, "MEDIA_ROOT", ""))
    private_root = _resolved(getattr(settings, "REPORTS_PRIVATE_ROOT", ""))
    quarantine_root = _resolved(getattr(settings, "REPORTS_QUARANTINE_ROOT", ""))
    for name, root in (("REPORTS_PRIVATE_ROOT", private_root), ("REPORTS_QUARANTINE_ROOT", quarantine_root)):
        if root is not None and media_root is not None and (_inside(root, media_root) or _inside(media_root, root)):
            errors.append(
                Error(
                    f"{name} overlaps MEDIA_ROOT; report files would be publicly served by the media container.",
                    id="reports.E003",
                )
            )
    if private_root is not None and quarantine_root is not None and private_root == quarantine_root:
        errors.append(Error("REPORTS_QUARANTINE_ROOT must differ from REPORTS_PRIVATE_ROOT.", id="reports.E003"))
    return errors


@register(REPORTS_TAG, Tags.security, deploy=True)
def check_report_antivirus_posture(app_configs=None, **kwargs):
    if not _is_production():
        return []
    scanner = str(getattr(settings, "REPORTS_ANTIVIRUS_SCANNER", "") or "").strip().lower()
    if scanner != "clamd":
        return [
            Error(
                f"REPORTS_ANTIVIRUS_SCANNER is {scanner or 'empty'!r} in production; weekly report uploads "
                "must be scanned by ClamAV.",
                hint="Set REPORTS_ANTIVIRUS_SCANNER=clamd (the default in config.settings.prod) and run the clamav service.",
                id="reports.E001",
            )
        ]
    if not str(getattr(settings, "CLAMD_HOST", "") or "").strip():
        return [Error("CLAMD_HOST is empty in production.", id="reports.E001")]
    return []
