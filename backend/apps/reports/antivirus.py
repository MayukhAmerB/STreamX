"""Antivirus scanning for weekly report files. Fail closed, always.

Every file a student, grader or instructor uploads is scanned *before* it is
stored (see ``intake.py``); stored files are re-scanned with fresh signatures
by ``rescan.py``. ``REPORTS_ANTIVIRUS_SCANNER`` picks the scanner:

``clamd``  ClamAV daemon over TCP (``CLAMD_HOST``/``CLAMD_PORT``), INSTREAM
           protocol, Python stdlib sockets only. Production default.
``fake``   In-process marker scanner for tests and local development: flags
           the EICAR test string and ``STREAMX-TEST-VIRUS`` markers.
``off``    No scanner: every upload is refused (still fail closed).
other      Dotted path of a scanner class (``BaseScanner`` interface).

Outcomes of ``scan_path``:

* ``ScanVerdict(clean=True)``  -> the file may be stored.
* ``ScanVerdict(clean=False)`` -> infected; never store it.
* ``ScanRefused``              -> the scanner cannot take a file this large;
                                  a retry will not help (HTTP 400).
* ``ScannerUnavailable``       -> unreachable, timeout, protocol error, open
                                  circuit, no scanner configured (HTTP 503).

Calls go through the ``clamd`` circuit breaker (``apps.core.circuit``): after
three consecutive outages uploads fail fast for 30 s instead of each one
waiting for the connect timeout.
"""

from __future__ import annotations

import logging
import socket
import struct
import threading
import time
from dataclasses import dataclass

from django.conf import settings
from django.utils.module_loading import import_string

from apps.core.circuit import CircuitOpenError, get_breaker
from apps.core.errors import UpstreamUnavailable

logger = logging.getLogger("apps.reports.antivirus")

BREAKER_NAME = "clamd"
SCANNER_UNAVAILABLE_MESSAGE = "Virus scanner is temporarily unavailable, please try again in a minute."
FILE_BLOCKED_MESSAGE = "This file was blocked by the virus scanner."
MAX_REPLY_BYTES = 8192

# Built from parts so this source file itself never contains the EICAR string
# (desktop antivirus would quarantine it).
EICAR_SIGNATURE = (
    b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
)
FAKE_MARKER = b"STREAMX-TEST-VIRUS"


class ScannerUnavailable(UpstreamUnavailable):
    status = 503
    code = "antivirus_unavailable"
    default_message = SCANNER_UNAVAILABLE_MESSAGE

    def __init__(self, message=None, **kwargs):
        kwargs.setdefault("upstream", BREAKER_NAME)
        kwargs.setdefault("retry_after", 60)
        super().__init__(message or SCANNER_UNAVAILABLE_MESSAGE, **kwargs)


class ScannerError(Exception):
    """The scanner could not give a verdict (outage, timeout, protocol error)."""


class ScanRefused(Exception):
    """The scanner will not take this file (larger than its stream limit)."""


@dataclass(frozen=True)
class ScanVerdict:
    clean: bool
    signature: str = ""
    scanner: str = ""
    signature_version: str = ""


class BaseScanner:
    """Interface: ``name``, ``version()``, ``scan(fileobj, size)``, ``ping()``."""

    name = "custom"

    def version(self) -> str:  # pragma: no cover - interface
        raise NotImplementedError

    def scan(self, fileobj, size: int | None = None) -> tuple[bool, str]:  # pragma: no cover - interface
        """Return (clean, signature). Raise ScannerError / ScanRefused."""
        raise NotImplementedError

    def ping(self) -> bool:
        try:
            self.version()
        except ScannerError:
            return False
        return True


# ---------------------------------------------------------------------------
# clamd
# ---------------------------------------------------------------------------
def parse_instream_reply(text: str) -> tuple[bool, str]:
    """Map a clamd INSTREAM reply to (clean, signature) or raise.

    ``stream: OK`` -> clean; ``stream: <Signature> FOUND`` -> infected;
    ``INSTREAM size limit exceeded. ERROR`` and ``Heuristics.Limits.Exceeded.*``
    (AlertExceedsMax) -> ScanRefused; any other text (``... ERROR``, empty,
    garbage) -> ScannerError.
    """
    reply = str(text or "").strip().strip("\0").strip()
    if reply == "stream: OK":
        return True, ""
    if reply.startswith("stream: ") and reply.endswith(" FOUND"):
        signature = reply[len("stream: ") : -len(" FOUND")].strip()
        if signature.startswith("Heuristics.Limits.Exceeded"):
            # AlertExceedsMax: clamd could not look at all of it (size, depth,
            # file count, scan time). Not a virus, but not proven clean either.
            raise ScanRefused(signature[:200])
        return False, (signature or "Unknown.Signature")[:255]
    if "size limit exceeded" in reply.lower():
        raise ScanRefused(reply[:200])
    if reply.endswith("ERROR"):
        raise ScannerError(f"clamd error: {reply[:200]}")
    raise ScannerError(f"unexpected clamd reply: {reply[:200]!r}")


class ClamdScanner(BaseScanner):
    """clamd over TCP with NUL-terminated (``z``) commands."""

    name = "clamd"

    def __init__(
        self,
        host=None,
        port=None,
        *,
        connect_timeout=None,
        timeout=None,
        chunk_bytes=None,
        max_stream_bytes=None,
    ):
        self.host = host or getattr(settings, "CLAMD_HOST", "clamav")
        self.port = int(port or getattr(settings, "CLAMD_PORT", 3310))
        self.connect_timeout = float(connect_timeout or getattr(settings, "CLAMD_CONNECT_TIMEOUT_SECONDS", 5))
        self.timeout = float(timeout or getattr(settings, "CLAMD_TIMEOUT_SECONDS", 120))
        self.chunk_bytes = int(chunk_bytes or getattr(settings, "CLAMD_CHUNK_BYTES", 256 * 1024))
        self.max_stream_bytes = int(
            max_stream_bytes or getattr(settings, "CLAMD_STREAM_MAX_BYTES", 210 * 1024 * 1024)
        )

    def _connect(self) -> socket.socket:
        try:
            connection = socket.create_connection((self.host, self.port), timeout=self.connect_timeout)
        except OSError as exc:  # refused, unresolvable, unreachable, connect timeout
            raise ScannerError(f"cannot connect to clamd: {type(exc).__name__}") from None
        connection.settimeout(self.timeout)
        return connection

    def _read_reply(self, connection: socket.socket, deadline: float) -> str:
        reply = b""
        while not reply.endswith(b"\0"):
            if time.monotonic() > deadline:
                raise ScannerError("clamd reply timed out")
            try:
                data = connection.recv(4096)
            except TimeoutError:
                raise ScannerError("clamd reply timed out") from None
            except OSError as exc:
                raise ScannerError(f"clamd connection failed: {type(exc).__name__}") from None
            if not data:
                break
            reply += data
            if len(reply) > MAX_REPLY_BYTES:
                raise ScannerError("clamd reply too long")
        if not reply:
            raise ScannerError("clamd closed the connection without a reply")
        return reply.rstrip(b"\0").decode("utf-8", errors="replace")

    def _command(self, command: str) -> str:
        deadline = time.monotonic() + self.timeout
        with self._connect() as connection:
            try:
                connection.sendall(f"z{command}\0".encode("ascii"))
            except OSError as exc:
                raise ScannerError(f"clamd connection failed: {type(exc).__name__}") from None
            return self._read_reply(connection, deadline)

    def ping(self) -> bool:
        try:
            return self._command("PING").strip() == "PONG"
        except ScannerError:
            return False

    def version(self) -> str:
        reply = self._command("VERSION").strip()
        if not reply.startswith("ClamAV "):
            raise ScannerError(f"unexpected clamd VERSION reply: {reply[:120]!r}")
        return reply[:128]

    def scan(self, fileobj, size: int | None = None) -> tuple[bool, str]:
        if size is not None and int(size) > self.max_stream_bytes:
            raise ScanRefused(f"{size} bytes is above CLAMD_STREAM_MAX_BYTES ({self.max_stream_bytes})")
        deadline = time.monotonic() + self.timeout * 4
        sent = 0
        with self._connect() as connection:
            try:
                connection.sendall(b"zINSTREAM\0")
                while True:
                    chunk = fileobj.read(self.chunk_bytes)
                    if not chunk:
                        break
                    sent += len(chunk)
                    if sent > self.max_stream_bytes:
                        raise ScanRefused(f"stream exceeded CLAMD_STREAM_MAX_BYTES ({self.max_stream_bytes})")
                    if time.monotonic() > deadline:
                        raise ScannerError("clamd stream timed out")
                    connection.sendall(struct.pack("!L", len(chunk)) + chunk)
                connection.sendall(struct.pack("!L", 0))
            except TimeoutError:
                raise ScannerError("clamd stream timed out") from None
            except OSError:
                # clamd closes the socket early when its StreamMaxLength is hit;
                # its reply (if any) says why.
                try:
                    early = self._read_reply(connection, time.monotonic() + 2)
                except ScannerError:
                    raise ScannerError("clamd connection failed while streaming") from None
                return parse_instream_reply(early)
            return parse_instream_reply(self._read_reply(connection, deadline))


# ---------------------------------------------------------------------------
# fake (tests, local development)
# ---------------------------------------------------------------------------
class FakeScanner(BaseScanner):
    """Flags the EICAR test string and ``STREAMX-TEST-VIRUS`` markers.

    It reads the whole file in chunks (with overlap so a marker split across
    chunks is still found) and never talks to the network.
    """

    name = "fake"
    VERSION = "FakeScanner 1.0/0"

    def version(self) -> str:
        return self.VERSION

    def scan(self, fileobj, size: int | None = None) -> tuple[bool, str]:
        overlap = max(len(EICAR_SIGNATURE), len(FAKE_MARKER))
        tail = b""
        while True:
            chunk = fileobj.read(1024 * 1024)
            if not chunk:
                return True, ""
            window = tail + chunk
            if EICAR_SIGNATURE in window:
                return False, "Eicar-Test-Signature"
            if FAKE_MARKER in window:
                return False, "StreamX.Test.Marker"
            tail = window[-overlap:]


# ---------------------------------------------------------------------------
# selection and the fail-closed entry points
# ---------------------------------------------------------------------------
def configured_scanner_name() -> str:
    return str(getattr(settings, "REPORTS_ANTIVIRUS_SCANNER", "") or "off").strip() or "off"


def get_scanner() -> BaseScanner | None:
    """The configured scanner, or None when scanning is off."""
    name = configured_scanner_name()
    lowered = name.lower()
    if lowered in {"off", "none", "disabled", "0", "false"}:
        return None
    if lowered == "clamd":
        return ClamdScanner()
    if lowered == "fake":
        return FakeScanner()
    scanner = import_string(name)
    return scanner() if isinstance(scanner, type) else scanner


def _call(scanner, func):
    """Run ``func`` under the circuit breaker (only for network scanners)."""
    if not isinstance(scanner, ClamdScanner):
        return func()
    try:
        permit = get_breaker(BREAKER_NAME).allow()
    except CircuitOpenError:
        raise ScannerError("clamd circuit is open") from None
    try:
        result = func()
    except ScanRefused:
        permit.release()
        raise
    except BaseException:
        permit.failure()
        raise
    permit.success()
    return result


def scan_path(path, *, size: int | None = None) -> ScanVerdict:
    """Scan one file on disk. Raises ScannerUnavailable or ScanRefused."""
    try:
        scanner = get_scanner()
    except ImportError:
        logger.exception("antivirus: REPORTS_ANTIVIRUS_SCANNER cannot be imported")
        raise ScannerUnavailable() from None
    if scanner is None:
        logger.error("antivirus: no scanner configured; refusing the upload (fail closed)")
        raise ScannerUnavailable()
    try:
        signature_version = _call(scanner, scanner.version)
        with open(path, "rb") as handle:
            clean, signature = _call(scanner, lambda: scanner.scan(handle, size))
    except ScanRefused:
        raise
    except ScannerError as exc:
        logger.warning("antivirus: scanner unavailable: %s", exc)
        raise ScannerUnavailable() from None
    except OSError as exc:
        logger.error("antivirus: could not read the file to scan: %s", type(exc).__name__)
        raise ScannerUnavailable() from None
    except Exception:  # noqa: BLE001 - any other scanner failure is an outage, never a pass
        logger.exception("antivirus: scanner failed")
        raise ScannerUnavailable() from None
    return ScanVerdict(
        clean=bool(clean),
        signature="" if clean else str(signature or "Unknown.Signature")[:255],
        scanner=str(getattr(scanner, "name", "custom"))[:64],
        signature_version=str(signature_version or "")[:128],
    )


def scanner_status() -> dict:
    """{"scanner", "state": ok|unavailable|off, "version"} -- one PING + VERSION."""
    name = configured_scanner_name()
    try:
        scanner = get_scanner()
    except ImportError:
        return {"scanner": name, "state": "unavailable", "version": ""}
    if scanner is None:
        return {"scanner": "off", "state": "off", "version": ""}
    try:
        if not scanner.ping():
            return {"scanner": scanner.name, "state": "unavailable", "version": ""}
        return {"scanner": scanner.name, "state": "ok", "version": scanner.version()}
    except (ScannerError, OSError):
        return {"scanner": scanner.name, "state": "unavailable", "version": ""}


_probe_lock = threading.Lock()
_probe_cache: tuple[float, tuple[str, dict]] | None = None
PROBE_CACHE_SECONDS = 15.0


def readiness_probe() -> tuple[str, dict]:
    """Soft readiness probe (``HEALTH_SOFT_PROBES``): never fails readiness.

    A short PING (1 s timeout), memoised for 15 s per process, so a clamd
    restart shows up as a warning while uploads alone fail closed.
    """
    global _probe_cache
    now = time.monotonic()
    cached = _probe_cache
    if cached is not None and now - cached[0] < PROBE_CACHE_SECONDS:
        return cached[1]
    with _probe_lock:
        cached = _probe_cache
        if cached is not None and time.monotonic() - cached[0] < PROBE_CACHE_SECONDS:
            return cached[1]
        name = configured_scanner_name()
        try:
            scanner = get_scanner()
        except ImportError:
            scanner = None
            name = f"{name} (not importable)"
        if scanner is None:
            result = ("off", {"scanner": name})
        else:
            if isinstance(scanner, ClamdScanner):
                scanner.connect_timeout = scanner.timeout = 1.0
            state = "ok" if scanner.ping() else "unavailable"
            result = (state, {"scanner": scanner.name})
        _probe_cache = (time.monotonic(), result)
        return result


def reset_probe_cache() -> None:
    global _probe_cache
    with _probe_lock:
        _probe_cache = None
