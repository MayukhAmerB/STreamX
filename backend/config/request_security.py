import ipaddress
import json
import re
import socket
from urllib.parse import urlparse


SQLI_PATTERNS = [
    re.compile(r"(?i)\bunion\b\s+\bselect\b"),
    re.compile(r"(?i)\b(select|update|delete|insert|drop)\b.+\b(from|into|table)\b"),
    re.compile(r"(?i)(?:'|%27)\s*(?:or|and)\s+(?:'?\d+'?\s*=\s*'?\d+'?|true|false)"),
    re.compile(r"(?i)--|/\*|\*/|;\s*(drop|select|insert|update|delete)\b"),
    re.compile(r"(?i)\b(sleep|benchmark)\s*\("),
]

XSS_PATTERNS = [
    re.compile(r"(?i)<\s*script\b"),
    re.compile(r"(?i)<\s*iframe\b"),
    re.compile(r"(?i)javascript\s*:"),
    re.compile(r"(?i)\bon\w+\s*="),
]

PRIVATE_HOSTNAMES = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def contains_suspicious_sqli(value):
    text = str(value or "")
    return any(pattern.search(text) for pattern in SQLI_PATTERNS)


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

    hostname = parsed.hostname.lower()
    if hostname in PRIVATE_HOSTNAMES or hostname.endswith(".local"):
        return False
    if _is_private_ip(hostname):
        return False

    # Best-effort DNS resolution to block obvious SSRF to private ranges.
    try:
        infos = socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        resolved_ips = {item[4][0] for item in infos if item and item[4]}
        if any(_is_private_ip(ip) for ip in resolved_ips):
            return False
    except socket.gaierror:
        # If DNS resolution fails, don't hard-fail valid-looking public URLs.
        pass
    except OSError:
        pass

    return True


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
