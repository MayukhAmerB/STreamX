import ipaddress
import json
import re
import socket
from html import unescape
from urllib.parse import unquote_plus, urlparse


SQLI_PATTERNS = [
    re.compile(r"(?i)\bunion\b\s+\bselect\b"),
    re.compile(r"(?i)\bunion(?:\s+all)?\s+select\b"),
    re.compile(r"(?i)\b(select\s+.+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from)\b"),
    re.compile(r"(?i)\b(drop|alter|truncate)\s+table\b"),
    re.compile(r"(?i)(?:'|\")\s*(?:or|and)\s+(?:'?\d+'?\s*=\s*'?\d+'?|true|false)"),
    re.compile(r"(?i)\b(?:or|and)\b\s+(?:\d+\s*=\s*\d+|true|false)\b"),
    re.compile(r"(?i)(?:--|#|/\*|\*/|;)\s*(?:drop|select|insert|update|delete|alter|truncate)\b"),
    re.compile(r"(?i)\b(?:sleep|benchmark|pg_sleep|waitfor\s+delay|xp_cmdshell)\s*\("),
    re.compile(r"(?i)\b(?:information_schema|pg_catalog)\b"),
]

XSS_PATTERNS = [
    re.compile(r"(?i)<\s*script\b"),
    re.compile(r"(?i)<\s*iframe\b"),
    re.compile(r"(?i)javascript\s*:"),
    re.compile(r"(?i)\bon\w+\s*="),
]

PRIVATE_HOSTNAMES = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
PRIVATE_HOST_SUFFIXES = (
    ".local",
    ".localhost",
    ".localdomain",
    ".internal",
    ".intranet",
    ".lan",
    ".home",
    ".corp",
)
PUBLIC_HOSTNAME_PATTERN = re.compile(r"^[a-z0-9.-]+$")
SAFE_QUERY_PARAM_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _normalize_for_security_scan(value):
    text = str(value or "").replace("\x00", "")
    for _ in range(3):
        decoded = unquote_plus(text)
        if decoded == text:
            break
        text = decoded
    text = unescape(text)
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = text.replace("--", " ").replace("#", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def contains_suspicious_sqli(value):
    original_text = str(value or "")
    normalized_text = _normalize_for_security_scan(original_text)
    return any(pattern.search(original_text) for pattern in SQLI_PATTERNS) or any(
        pattern.search(normalized_text) for pattern in SQLI_PATTERNS
    )


def contains_suspicious_xss(value):
    text = str(value or "")
    return any(pattern.search(text) for pattern in XSS_PATTERNS)


def contains_active_content(value):
    return contains_suspicious_xss(value)


def _is_private_ip(ip_text):
    try:
        ip_obj = ipaddress.ip_address(ip_text)
    except ValueError:
        return False
    return any(
        [
            ip_obj.is_private,
            ip_obj.is_loopback,
            ip_obj.is_link_local,
            ip_obj.is_multicast,
            ip_obj.is_reserved,
            ip_obj.is_unspecified,
        ]
    )


def _normalize_hostname(hostname):
    raw = str(hostname or "").strip().rstrip(".").lower()
    if not raw:
        return ""
    try:
        return raw.encode("idna").decode("ascii")
    except UnicodeError:
        return ""


def _is_valid_public_hostname(hostname):
    if not hostname:
        return False
    if hostname.isdigit():
        return False
    if "." not in hostname:
        return False
    if ".." in hostname:
        return False
    if not PUBLIC_HOSTNAME_PATTERN.fullmatch(hostname):
        return False
    labels = hostname.split(".")
    for label in labels:
        if not label or len(label) > 63:
            return False
        if label.startswith("-") or label.endswith("-"):
            return False
    return True


def _is_safe_public_host(hostname, port):
    normalized_hostname = _normalize_hostname(hostname)
    if not normalized_hostname:
        return False
    if normalized_hostname in PRIVATE_HOSTNAMES:
        return False
    if any(normalized_hostname.endswith(suffix) for suffix in PRIVATE_HOST_SUFFIXES):
        return False
    try:
        ipaddress.ip_address(normalized_hostname)
    except ValueError:
        pass
    else:
        return not _is_private_ip(normalized_hostname)
    if not _is_valid_public_hostname(normalized_hostname):
        return False

    # Resolve upfront to prevent storing unresolved hostnames and to block DNS-mapped private IPs.
    try:
        infos = socket.getaddrinfo(normalized_hostname, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, OSError):
        return False

    resolved_ips = {item[4][0] for item in infos if item and item[4]}
    if not resolved_ips:
        return False
    return not any(_is_private_ip(ip) for ip in resolved_ips)


def is_safe_public_http_url(value):
    text = str(value or "").strip()
    if not text:
        return True

    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"}:
        return False
    if not parsed.hostname:
        return False
    if parsed.username or parsed.password:
        return False
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return False
    return _is_safe_public_host(parsed.hostname, port)


def is_safe_public_stream_url(value):
    text = str(value or "").strip()
    if not text:
        return True

    parsed = urlparse(text)
    if parsed.scheme not in {"rtmp", "rtmps"}:
        return False
    if not parsed.hostname:
        return False
    if parsed.username or parsed.password:
        return False
    try:
        port = parsed.port or (443 if parsed.scheme == "rtmps" else 1935)
    except ValueError:
        return False
    return _is_safe_public_host(parsed.hostname, port)


def find_disallowed_query_params(request, allowed_params):
    """
    Returns a sorted list of unsupported or malformed query parameter keys.
    """
    allowed = {str(item or "").strip() for item in (allowed_params or set()) if str(item or "").strip()}
    disallowed = set()
    for raw_key in request.GET.keys():
        key = str(raw_key or "").strip()
        if not key or not SAFE_QUERY_PARAM_PATTERN.fullmatch(key):
            disallowed.add(key or "<empty>")
            continue
        if key not in allowed:
            disallowed.add(key)
    return sorted(disallowed)


def iter_request_strings(request, max_body_bytes=16384):
    for key, values in request.GET.lists():
        yield f"query:{key}", key
        for value in values:
            yield f"query:{key}", value

    content_type = (request.META.get("CONTENT_TYPE") or "").lower()
    if "multipart/form-data" in content_type:
        for key, values in request.POST.lists():
            yield f"form:{key}", key
            for value in values:
                yield f"form:{key}", value
        return

    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        content_length = request.META.get("CONTENT_LENGTH")
        try:
            if content_length and int(content_length) > max_body_bytes:
                return
        except (TypeError, ValueError):
            pass

        body = request.body or b""
        if not body:
            return
        body = body[:max_body_bytes]

        if "application/json" in content_type:
            try:
                payload = json.loads(body.decode("utf-8", errors="ignore"))
            except json.JSONDecodeError:
                return
            yield from _iter_json_strings(payload)
        elif "application/x-www-form-urlencoded" in content_type:
            for key, values in request.POST.lists():
                yield f"form:{key}", key
                for value in values:
                    yield f"form:{key}", value


def _iter_json_strings(value, prefix="json"):
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(key, str):
                yield f"{prefix}:{key}", key
            yield from _iter_json_strings(item, f"{prefix}:{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _iter_json_strings(item, f"{prefix}[{index}]")
    elif isinstance(value, str):
        yield prefix, value
