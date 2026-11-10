"""Optional antivirus hook for uploaded report files (off by default).

Set ``REPORTS_ANTIVIRUS_SCANNER`` to the dotted path of a callable::

    def scan(file_obj, *, filename: str) -> ScanResult | None: ...

It receives the uploaded file (seeked to 0) before anything is stored and
either returns a ``ScanResult``/``None`` (clean) or raises ``InfectedFile``.
Any other exception is a scanner outage: the upload is refused while
``REPORTS_ANTIVIRUS_FAIL_CLOSED`` is true (default), or accepted and logged
when it is false.

``clamd_scan`` below is a ready-made scanner for a ClamAV daemon reachable
over TCP (``REPORTS_CLAMD_HOST``/``REPORTS_CLAMD_PORT``), using clamd's
INSTREAM command (stdlib sockets only, no extra dependency).
"""

from __future__ import annotations

import logging
import socket
import struct
from dataclasses import dataclass

from django.conf import settings
from django.utils.module_loading import import_string

from apps.core.errors import DomainError, ValidationFailed

logger = logging.getLogger("apps.reports.antivirus")


class InfectedFile(Exception):
    def __init__(self, signature: str = ""):
        self.signature = str(signature or "")
        super().__init__(self.signature or "infected")


class ScannerUnavailable(DomainError):
    status = 503
    code = "antivirus_unavailable"
    default_message = "Files can't be checked for viruses right now. Try again in a few minutes."


@dataclass(frozen=True)
class ScanResult:
    clean: bool = True
    signature: str = ""


def _configured_scanner():
    dotted = str(getattr(settings, "REPORTS_ANTIVIRUS_SCANNER", "") or "").strip()
    if not dotted:
        return None
    return import_string(dotted)


def scan_upload(file_obj, *, filename: str, field_name: str = "file") -> ScanResult:
    """Run the configured scanner (no-op when none is configured)."""
    scanner = _configured_scanner()
    if scanner is None:
        return ScanResult(clean=True)
    try:
        if hasattr(file_obj, "seek"):
            file_obj.seek(0)
        result = scanner(file_obj, filename=filename) or ScanResult(clean=True)
    except InfectedFile as exc:
        logger.warning("report upload rejected by antivirus: %s (%s)", filename, exc.signature)
        raise ValidationFailed(
            "This file was flagged by the virus scanner and was not uploaded.",
            code="file_infected",
            details={field_name: ["This file was flagged by the virus scanner and was not uploaded."]},
        ) from None
    except Exception:  # noqa: BLE001 - any scanner failure is an outage, never a pass
        logger.exception("antivirus scanner failed for %s", filename)
        if getattr(settings, "REPORTS_ANTIVIRUS_FAIL_CLOSED", True):
            raise ScannerUnavailable() from None
        return ScanResult(clean=True)
    finally:
        if hasattr(file_obj, "seek"):
            file_obj.seek(0)
    if not result.clean:
        raise ValidationFailed(
            "This file was flagged by the virus scanner and was not uploaded.",
            code="file_infected",
            details={field_name: ["This file was flagged by the virus scanner and was not uploaded."]},
        )
    return result


def clamd_scan(file_obj, *, filename: str) -> ScanResult:
    """Scan with clamd's INSTREAM command over TCP."""
    host = getattr(settings, "REPORTS_CLAMD_HOST", "clamav")
    port = int(getattr(settings, "REPORTS_CLAMD_PORT", 3310))
    timeout = int(getattr(settings, "REPORTS_CLAMD_TIMEOUT_SECONDS", 30))
    with socket.create_connection((host, port), timeout=timeout) as connection:
        connection.sendall(b"zINSTREAM\0")
        while True:
            chunk = file_obj.read(64 * 1024)
            if not chunk:
                break
            connection.sendall(struct.pack("!L", len(chunk)) + chunk)
        connection.sendall(struct.pack("!L", 0))
        reply = b""
        while not reply.endswith(b"\0"):
            data = connection.recv(4096)
            if not data:
                break
            reply += data
    text = reply.rstrip(b"\0").decode("utf-8", errors="replace")
    if text.endswith("OK"):
        return ScanResult(clean=True)
    if text.endswith("FOUND"):
        raise InfectedFile(text.split(":", 1)[-1].replace("FOUND", "").strip())
    raise RuntimeError(f"unexpected clamd reply: {text[:120]}")
