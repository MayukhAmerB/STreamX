"""Input sanitisation for profile content. No raw HTML, ever.

Three layers, each enough on its own:

1. ``clean_text``: every user string is Unicode-normalised, stripped of
   control, bidirectional-override and invisible characters, length-limited,
   and refused when it contains markup (``<tag``, ``javascript:``, event
   handlers: ``config.request_security.contains_active_content``).
2. ``clean_url``: links must be absolute ``https://`` URLs to a public host
   name (no credentials, no IP literals of private ranges, no other port, no
   ``javascript:`` / ``data:`` / ``vbscript:`` / ``file:`` in any spelling).
3. ``sanitize_html``: an allowlist HTML sanitiser (stdlib ``html.parser``,
   bleach/nh3 style) applied to the server-side HTML rendering of rich text
   (``richtext.render_html``), used by the admin moderation preview. The
   public page never receives HTML: the frontend renders the JSON document
   with React elements.
"""

from __future__ import annotations

import ipaddress
import re
import unicodedata
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlunsplit

from apps.core.errors import ValidationFailed

from .pii.normalize import BIDI_CONTROLS, INVISIBLE_CHARS

MAX_URL_LENGTH = 2048
LINK_REL = "nofollow ugc noopener noreferrer"

# "<" followed by a letter, "/", "!" or "?" starts markup; "a < b" and "<3" do not.
_MARKUP = re.compile(r"<[a-zA-Z!/?]|&#|&[a-zA-Z]+;")  # "< script" is caught by _ACTIVE below
_ACTIVE = re.compile(
    r"(?i)(?:java|vb|live)\s*script\s*:|data\s*:\s*(?:text/html|image/svg|application/(?:x-)?(?:javascript|xhtml))|"
    r"\bon[a-z]{3,}\s*=|<\s*/?\s*(?:script|iframe|object|embed|svg|math|style|link|meta|base|form|img|video|audio|source|template)"
)
_DANGEROUS_SCHEMES = re.compile(r"(?i)^(?:java|vb|live)script:|^data:|^file:|^about:|^blob:|^filesystem:|^view-source:|^jar:")


def _field_error(field: str, message: str) -> ValidationFailed:
    return ValidationFailed(message, details={field: [message]})


def strip_controls(value: str, *, multiline: bool) -> str:
    """Remove C0/C1 controls (keeping newlines when ``multiline``), bidi
    overrides and invisible characters."""
    out = []
    for char in value:
        if char == "\n" and multiline:
            out.append(char)
            continue
        if char == "\t":
            out.append(" ")
            continue
        if char in INVISIBLE_CHARS or char in BIDI_CONTROLS:
            continue
        category = unicodedata.category(char)
        if category in {"Cc", "Cs", "Co", "Cn"}:
            continue
        if category == "Cf":
            # Format characters are invisible; ZWJ/ZWNJ are kept out too
            # (a public handle-based profile does not need them).
            continue
        out.append(char)
    return "".join(out)


def contains_markup(value: str) -> bool:
    text = str(value or "")
    if _MARKUP.search(text) or _ACTIVE.search(text):
        return True
    try:
        from config.request_security import contains_active_content

        return bool(contains_active_content(text))
    except Exception:  # noqa: BLE001 - our own patterns above are the floor
        return False


def clean_text(
    value,
    *,
    field: str,
    max_length: int,
    multiline: bool = False,
    required: bool = False,
    allow_markup_chars: bool = False,
) -> str:
    """A safe plain-text value, or ``ValidationFailed`` with a field message."""
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise _field_error(field, "Enter text.")
    text = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
    text = strip_controls(text, multiline=multiline)
    if multiline:
        text = "\n".join(line.rstrip() for line in text.split("\n"))
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
    else:
        text = " ".join(text.split())
    if required and not text:
        raise _field_error(field, "This can't be empty.")
    if len(text) > max_length:
        raise _field_error(field, f"Keep this under {max_length} characters (it has {len(text)}).")
    if not allow_markup_chars and contains_markup(text):
        raise _field_error(field, "HTML and scripts aren't allowed. Use the formatting buttons instead.")
    return text


def _public_host(host: str) -> bool:
    if not host or len(host) > 253:
        return False
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        address = None
    if address is not None:
        return not (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        )
    labels = host.split(".")
    if len(labels) < 2 or not labels[-1].isalpha() or len(labels[-1]) < 2:
        return False
    if host in {"localhost"} or host.endswith((".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".test", ".invalid")):
        return False
    return all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)


def clean_url(value, *, field: str) -> str:
    """An absolute, public ``https://`` URL (normalised), or ``ValidationFailed``."""
    if not isinstance(value, str):
        raise _field_error(field, "Enter a link that starts with https://")
    raw = unicodedata.normalize("NFKC", value)
    if any(unicodedata.category(char) in {"Cc", "Cf", "Zl", "Zp"} or char in INVISIBLE_CHARS for char in raw):
        raise _field_error(field, "This link contains hidden characters. Paste it again.")
    text = raw.strip()
    if not text:
        raise _field_error(field, "Enter a link that starts with https://")
    if len(text) > MAX_URL_LENGTH:
        raise _field_error(field, "This link is too long.")
    if any(char.isspace() for char in text) or "\\" in text or '"' in text or "'" in text or "<" in text or ">" in text or "`" in text:
        raise _field_error(field, "This link contains characters that aren't allowed in a web address.")
    compact = re.sub(r"[\s\x00-\x1f]", "", text)
    if _DANGEROUS_SCHEMES.match(compact) or "&#" in compact or "%0" in compact.lower()[:12]:
        raise _field_error(field, "Only https:// links are allowed.")
    try:
        parts = urlsplit(text)
    except ValueError:
        raise _field_error(field, "This isn't a valid web address.") from None
    if parts.scheme.lower() != "https" or not text.lower().startswith("https://"):
        raise _field_error(field, "Only https:// links are allowed.")
    if parts.username or parts.password or "@" in parts.netloc:
        raise _field_error(field, "Links can't contain a user name or password.")
    try:
        port = parts.port
    except ValueError:
        raise _field_error(field, "This isn't a valid web address.") from None
    if port not in (None, 443):
        raise _field_error(field, "Links must use the standard https port.")
    host = (parts.hostname or "").rstrip(".")
    try:
        host = host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise _field_error(field, "This isn't a valid web address.") from None
    if not _public_host(host):
        raise _field_error(field, "Links must point to a public website.")
    return urlunsplit(("https", host, parts.path or "", parts.query, parts.fragment))


def link_host(url: str) -> str:
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


# ---------------------------------------------------------------------------
# Allowlist HTML sanitiser (defence in depth for server-rendered previews)
# ---------------------------------------------------------------------------
ALLOWED_TAGS = frozenset({"p", "br", "strong", "em", "code", "a", "ul", "li", "h3", "blockquote"})
ALLOWED_ATTRIBUTES = {"a": frozenset({"href", "title"})}
# Their text content is dropped as well as the tags.
DROP_CONTENT_TAGS = frozenset({"script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math", "textarea", "xmp", "noembed", "noframes", "title"})
VOID_TAGS = frozenset({"br"})


class _AllowlistParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.drop_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_CONTENT_TAGS:
            self.drop_depth += 1
            return
        if self.drop_depth or tag not in ALLOWED_TAGS:
            return
        rendered = []
        allowed = ALLOWED_ATTRIBUTES.get(tag, frozenset())
        for name, value in attrs:
            name = (name or "").lower()
            if name not in allowed or value is None:
                continue
            if name == "href":
                try:
                    value = clean_url(value, field="href")
                except ValidationFailed:
                    continue
            rendered.append(f' {name}="{escape(value, quote=True)}"')
        if tag == "a":
            if not any(part.startswith(" href=") for part in rendered):
                return
            rendered.append(f' rel="{LINK_REL}" target="_blank"')
        self.out.append(f"<{tag}{''.join(rendered)}>")
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() in self.stack and tag.lower() not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in DROP_CONTENT_TAGS:
            self.drop_depth = max(0, self.drop_depth - 1)
            return
        if self.drop_depth or tag not in self.stack:
            return
        while self.stack:
            open_tag = self.stack.pop()
            self.out.append(f"</{open_tag}>")
            if open_tag == tag:
                break

    def handle_data(self, data):
        if not self.drop_depth:
            self.out.append(escape(data, quote=False))

    def handle_comment(self, data):
        return  # comments are dropped (conditional comments, mXSS tricks)

    def handle_decl(self, decl):
        return

    def handle_pi(self, data):
        return

    def unknown_decl(self, data):
        return

    def close_all(self) -> str:
        self.close()
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def sanitize_html(html: str) -> str:
    """Keep only ``ALLOWED_TAGS`` / ``ALLOWED_ATTRIBUTES`` (https links get
    ``rel="nofollow ugc noopener noreferrer"``); escape all text."""
    parser = _AllowlistParser()
    parser.feed(str(html or ""))
    return parser.close_all()
