"""Shared text normalisation (weekly-report target names, CTF answers).

Two layers:

* **Named rules** (``RULES`` / ``normalize``): a fixed whitelist of small,
  order-dependent transforms. ``apps.ctf.answers`` applies them, in the order
  an exam file lists them, to accepted answers at load time and to what the
  student typed at submission time. The rule set and behaviour are identical to
  the original CTF rules, so a stored answer digest never changes.
* **Target keys** (``target_key``): the canonical identity of an OSINT target a
  student names in a weekly report. Only true variants share a key ("Acme Pvt.
  Ltd.", "ACME private limited", "acme"; "https://www.acme.in/about" and
  "acme.in"), so the server can enforce *one report per target per week*
  without refusing a legitimately different target: different domains or
  TLDs, different profiles on one platform, handles and IP addresses all keep
  distinct keys.

Near-duplicates ("Acme Corp" vs "Acme Crop", "Acme Ltd" vs "acme.com") are
warnings the student can override (``near_duplicates``): a shared alias, a
one-character typo or trigram similarity. ``trigram_similarity`` is the
pure-Python equivalent of ``pg_trgm.similarity()`` (same padding and word
splitting); on PostgreSQL the reports app may also ask ``pg_trgm`` about plain
names (``trigram_comparable``).

Pure functions only: no Django imports, safe to use from migrations.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
import unicodedata
from collections.abc import Iterable, Sequence
from urllib.parse import parse_qsl, unquote, urlsplit

# ---------------------------------------------------------------------------
# Named rules (shared with apps.ctf.answers; do not change their behaviour)
# ---------------------------------------------------------------------------
DEFAULT_RULES: tuple[str, ...] = ("nfkc", "trim", "collapse_whitespace", "casefold")
QUOTE_CHARACTERS = "\"'`‘’“”«»"

_WHITESPACE = re.compile(r"\s+")
_URL_SCHEME = re.compile(r"^[a-z][a-z0-9+.\-]*://", re.IGNORECASE)
_WWW = re.compile(r"^www\.", re.IGNORECASE)


def strip_punctuation(text: str) -> str:
    return "".join(ch for ch in text if not unicodedata.category(ch).startswith("P"))


def strip_diacritics(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return unicodedata.normalize("NFC", "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn"))


def digits_only(text: str) -> str:
    # Any script's decimal digits (e.g. Urdu ۱۲۳) count, written as ASCII.
    digits = []
    for ch in text:
        value = unicodedata.decimal(ch, None)
        if value is not None:
            digits.append(str(value))
    return "".join(digits)


RULES = {
    "nfkc": lambda text: unicodedata.normalize("NFKC", text),
    "trim": lambda text: text.strip(),
    "collapse_whitespace": lambda text: _WHITESPACE.sub(" ", text),
    "remove_whitespace": lambda text: _WHITESPACE.sub("", text),
    "casefold": lambda text: text.casefold(),
    "strip_punctuation": strip_punctuation,
    "strip_diacritics": strip_diacritics,
    "strip_url_scheme": lambda text: _URL_SCHEME.sub("", text),
    "strip_www": lambda text: _WWW.sub("", text),
    "strip_trailing_slash": lambda text: text.rstrip("/"),
    "strip_leading_at": lambda text: text.lstrip("@"),
    "strip_quotes": lambda text: text.strip(QUOTE_CHARACTERS),
    "digits_only": digits_only,
}
RULE_NAMES = tuple(RULES)


def validate_rules(rules: Iterable[str] | None) -> list[str]:
    """Return the rule list (default when empty); raise ValueError on unknown names."""
    names = [str(name) for name in (rules or [])]
    unknown = [name for name in names if name not in RULES]
    if unknown:
        raise ValueError(f"unknown normalisation rule(s): {', '.join(unknown)}")
    if len(set(names)) != len(names):
        raise ValueError("normalisation rules must not repeat")
    return names or list(DEFAULT_RULES)


def normalize(text: str, rules: Sequence[str] | None = None) -> str:
    value = str(text or "")
    for name in validate_rules(rules):
        value = RULES[name](value)
    return value


# ---------------------------------------------------------------------------
# Display cleanup
# ---------------------------------------------------------------------------
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁠-⁤﻿]")


def clean_display(text: str, *, max_length: int = 200) -> str:
    """What we store and show: NFKC, no control / zero-width / bidi characters,
    single spaces, trimmed and capped. Case and punctuation are kept."""
    value = unicodedata.normalize("NFKC", str(text or ""))
    value = _CONTROL.sub("", _WHITESPACE.sub(" ", value))
    value = _WHITESPACE.sub(" ", value).strip()
    return value[:max_length].strip()


# ---------------------------------------------------------------------------
# Target keys
# ---------------------------------------------------------------------------
# A target key is the canonical identity of an OSINT target. Equal keys are a
# true duplicate (the server refuses a second report on it the same week);
# everything that is only *probably* the same target is left to
# ``near_duplicates``, which the student can override. So a key must never
# merge two targets that can legitimately differ. Each kind of target has its
# own key shape, and the shapes cannot collide with one another:
#
# =========  ===================================  ============================
# kind       example input                        key
# =========  ===================================  ============================
# name       "The Acme Pvt. Ltd."                 ``acme``  (words, no dots)
# domain     "https://www.Acme.co.in/about-us"    ``acme.co.in``  (host only)
# profile    "https://m.facebook.com/John/?ref=x" ``facebook.com/john``
# handle     "@Acme_HQ"                           ``@acme_hq``
# email      "mailto:John@Acme.com"               ``john@acme.com``
# ip         "http://[2001:DB8::1]:8080/"         ``2001:db8::1``
# =========  ===================================  ============================
#
# * A domain keeps its whole host, TLD included ("acme.com" and "acme.org" are
#   different targets); only ``www.``, a port, the path, query and fragment go
#   (pages of a company site are still the company).
# * On platforms where the URL path names the person, page or repository
#   (``IDENTITY_HOSTS``) the identifying part of the path is kept, so
#   facebook.com/john and facebook.com/jane differ, while tracking parameters
#   and trailing sub-pages ("/about", "/posts/123") are dropped.
# * A name drops case, accents, punctuation, a leading "the" / "M/s" and
#   trailing legal forms, so "Acme Pvt Ltd" and "acme" are the same target.

# Trailing legal-form words, removed repeatedly from the END of a name only
# (so "Company Watch" or "Limited Edition Labs" keep their meaning).
LEGAL_SUFFIXES = frozenset(
    {
        "ltd",
        "limited",
        "pvt",
        "private",
        "pte",
        "plc",
        "llc",
        "llp",
        "lllp",
        "pllc",
        "lp",
        "inc",
        "incorporated",
        "corp",
        "corporation",
        "co",
        "company",
        "gmbh",
        "ag",
        "kg",
        "sa",
        "sas",
        "sarl",
        "srl",
        "spa",
        "bv",
        "nv",
        "oy",
        "oyj",
        "ab",
        "pty",
        "kk",
        "opc",
        "bhd",
        "sdn",
        "ltda",
        "jsc",
        "pjsc",
        "ooo",
        "group",
        "holdings",
        "international",
        "intl",
    }
)
LEADING_ARTICLES = frozenset({"the"})
TARGET_KEY_MAX_LENGTH = 200

_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)
_INNER_APOSTROPHE = re.compile(r"(?<=\w)['’`ʼ](?=\w)")
_MESSRS = re.compile(r"^m\s*/\s*s\b\.?\s*", re.IGNORECASE)
_EDGE_QUOTES = "\"'`‘’“”«»<>()[]{}"
_TRAILING_SENTENCE_PUNCTUATION = ".,;:!"
_SCHEME = re.compile(r"^([a-z][a-z0-9+.\-]*):(//)?", re.IGNORECASE)
_WEB_SCHEMES = frozenset({"http", "https", "ftp", "ftps", "sftp", "ws", "wss", "hxxp", "hxxps"})
# A host name: dot-separated labels ending in an alphabetic TLD (IDNs and
# punycode included). Underscores are allowed in sub-labels (DNS records).
_HOST = re.compile(r"^(?:[\w-]+\.)+(?:[^\W\d_]{2,63}|xn--[a-z0-9-]{1,59})$", re.UNICODE | re.IGNORECASE)
_HOSTISH = re.compile(r"^[^\s/?#@]+$")
_HANDLE = re.compile(r"^@[\w.]*\w[\w.]*$", re.UNICODE)
_EMAIL = re.compile(r"^[^\s@/]+@[^\s@/]+$")
_WWW_LABEL = re.compile(r"^www\d*\.", re.IGNORECASE)

# Platforms where the path (and a few query parameters) IS the identity of the
# target: "facebook.com/john" and "facebook.com/jane" are different people,
# while "acme.com/about-us" is still the company Acme. Aliases first:
HOST_ALIASES = {
    "fb.com": "facebook.com",
    "fb.me": "facebook.com",
    "twitter.com": "x.com",
    "telegram.me": "t.me",
    "telegram.dog": "t.me",
    "youtu.be": "youtube.com",
    "instagr.am": "instagram.com",
    "discordapp.com": "discord.com",
}
IDENTITY_HOSTS = frozenset(
    {
        "facebook.com",
        "instagram.com",
        "x.com",
        "threads.net",
        "threads.com",
        "linkedin.com",
        "github.com",
        "gitlab.com",
        "bitbucket.org",
        "codeberg.org",
        "youtube.com",
        "tiktok.com",
        "reddit.com",
        "medium.com",
        "t.me",
        "pinterest.com",
        "snapchat.com",
        "vk.com",
        "ok.ru",
        "quora.com",
        "stackoverflow.com",
        "soundcloud.com",
        "twitch.tv",
        "discord.gg",
        "discord.com",
        "wa.me",
        "keybase.io",
        "about.me",
        "behance.net",
        "dribbble.com",
        "huggingface.co",
        "hackerone.com",
        "bugcrowd.com",
        "linktr.ee",
        "patreon.com",
        "kaggle.com",
        "flickr.com",
        "vimeo.com",
        "mastodon.social",
        "bsky.app",
        "tryhackme.com",
        "app.hackthebox.com",
        "sites.google.com",
        "play.google.com",
        "apps.apple.com",
        "crunchbase.com",
        "angel.co",
        "wellfound.com",
        "glassdoor.com",
        "glassdoor.co.in",
        "zaubacorp.com",
        "opencorporates.com",
    }
)
# Sub-domains that are only a mirror of the platform (mobile, language or
# country editions): "in.linkedin.com/in/x" is linkedin.com/in/x.
_MIRROR_LABEL = re.compile(r"^(?:www\d*|m|mobile|mbasic|touch|web|old|new|[a-z]{2}(?:-[a-z]{2})?)$")
# Platforms whose path is case-sensitive (YouTube video and channel ids,
# Discord invites); everywhere else the path is folded to lower case.
CASE_SENSITIVE_PATH_HOSTS = frozenset({"youtube.com", "discord.gg", "discord.com", "apps.apple.com"})
# Repository hosts name "owner/repository"; everywhere else one segment names
# the profile unless it is a namespace ("in", "company", "r", "channel", ...).
REPOSITORY_HOSTS = frozenset({"github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "huggingface.co"})
# namespace segment -> how many segments (namespace included) identify the target
PATH_NAMESPACES = {
    "in": 2,
    "company": 2,
    "school": 2,
    "showcase": 2,
    "pub": 2,
    "groups": 2,
    "group": 2,
    "pages": 3,
    "people": 3,
    "channel": 2,
    "c": 2,
    "user": 2,
    "users": 2,
    "u": 2,
    "r": 2,
    "orgs": 2,
    "org": 2,
    "organization": 2,
    "organizations": 2,
    "view": 2,
    "invite": 2,
    "profile": 2,
    "app": 3,
    "store": 3,
    "datasets": 3,
    "spaces": 3,
    "shorts": 2,
    "live": 2,
    "embed": 2,
    "playlist": 1,
    "p": 2,
    "reel": 2,
    "tv": 2,
}
# Segments that are structure, not a name, on a case-sensitive platform.
_STRUCTURAL_SEGMENTS = frozenset({"watch", "shorts", "live", "embed", "playlist", "details"})
# Platforms whose paths start with a locale ("apps.apple.com/in/app/…").
LOCALE_PREFIXED_HOSTS = frozenset({"apps.apple.com"})
_LOCALE_SEGMENT = re.compile(r"^[a-z]{2}(?:[-_][a-z]{2,4})?$")
_PAGE_FILE = re.compile(r"^(?:index|default|home|main)(?:\.[a-z0-9]{2,5})?$|^[^/]*\.(?:html?|php|aspx?|jsp|cfm)$")
# Pages of an ordinary website that are the site's owner, not a new target.
GENERIC_SITE_PAGES = frozenset(
    {
        "about",
        "about-us",
        "aboutus",
        "about_us",
        "company",
        "contact",
        "contact-us",
        "contactus",
        "contact_us",
        "home",
        "team",
        "our-team",
        "leadership",
        "management",
        "people",
        "careers",
        "career",
        "jobs",
        "join-us",
        "products",
        "product",
        "services",
        "service",
        "solutions",
        "blog",
        "news",
        "press",
        "media",
        "newsroom",
        "investors",
        "investor-relations",
        "privacy",
        "privacy-policy",
        "terms",
        "legal",
        "imprint",
        "impressum",
        "faq",
        "support",
        "help",
        "login",
        "signin",
        "sign-in",
        "signup",
        "register",
        "shop",
        "store",
        "pricing",
        "portfolio",
        "projects",
        "gallery",
        "events",
        "resources",
        "partners",
        "clients",
        "customers",
        "locations",
        "wp-content",
        "wp-admin",
        "static",
        "assets",
        "public",
        "page",
        "pages",
        "category",
        "tag",
        "search",
    }
)
# Query parameters that identify the target (facebook.com/profile.php?id=…,
# youtube.com/watch?v=…, play.google.com/…/details?id=…); all others
# (utm_*, fbclid, si, ref, t, …) are tracking or presentation and are dropped.
IDENTITY_QUERY_PARAMETERS = frozenset({"id", "v", "list", "fbid", "story_fbid"})
# Hosts whose sub-domain is the user ("john.tumblr.com"): the full host is the
# key (as for any domain) and the sub-domain is what near-duplicates compare.
SUBDOMAIN_IDENTITY_HOSTS = frozenset(
    {
        "tumblr.com",
        "medium.com",
        "substack.com",
        "blogspot.com",
        "wordpress.com",
        "github.io",
        "gitlab.io",
        "netlify.app",
        "vercel.app",
        "pages.dev",
        "herokuapp.com",
        "wixsite.com",
        "carrd.co",
        "notion.site",
    }
)
# Second-level labels under a two-letter country TLD that are a registry
# suffix rather than the organisation ("acme.co.in", "acme.com.pk").
_REGISTRY_SECOND_LEVEL = frozenset(
    {
        "co",
        "com",
        "net",
        "org",
        "gov",
        "govt",
        "edu",
        "ac",
        "nic",
        "res",
        "gen",
        "firm",
        "ind",
        "ltd",
        "plc",
        "sch",
        "mil",
        "or",
        "ne",
        "go",
        "nhs",
        "biz",
        "info",
        "web",
    }
)


def _fold(text: str) -> str:
    """Case- and accent-insensitive form of a name."""
    return strip_diacritics(text.casefold())


def _compact(text: str) -> str:
    """Only letters and digits (any script)."""
    return "".join(ch for ch in text if ch.isalnum())


def _limit(key: str) -> str:
    """Cap a key at the column width without making long keys collide: an
    over-long key keeps its start and gets a digest of the whole key."""
    if len(key) <= TARGET_KEY_MAX_LENGTH:
        return key
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return f"{key[: TARGET_KEY_MAX_LENGTH - len(digest) - 1]}~{digest}"


def _ip_key(text: str) -> str | None:
    value = text.strip("[]")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        pass
    if "/" in value:
        try:
            return str(ipaddress.ip_network(value, strict=False))
        except ValueError:
            return None
    return None


def _host_key(host: str) -> str | None:
    """Canonical host name, or None when ``host`` is not a host name."""
    host = host.strip().rstrip(".").casefold()
    if not host:
        return None
    labels = []
    for label in host.split("."):
        if label.startswith("xn--"):
            try:
                label = label.encode("ascii").decode("idna")
            except (UnicodeError, ValueError):
                pass
        labels.append(label)
    host = ".".join(labels)
    if not _HOST.match(host):
        return None
    host = _WWW_LABEL.sub("", host)
    host = HOST_ALIASES.get(host, host)
    if host not in IDENTITY_HOSTS:
        parts = host.split(".")
        for start in range(1, len(parts) - 1):
            parent = ".".join(parts[start:])
            if parent in IDENTITY_HOSTS or parent in HOST_ALIASES:
                if all(_MIRROR_LABEL.match(label) for label in parts[:start]):
                    host = HOST_ALIASES.get(parent, parent)
                break
    return host


def _site_path_segment(path: str) -> str:
    """The first path segment of an ordinary website that may name a separate
    target ("example.edu/~alice", "example.org/alice"), or "" when the path is
    only a page of the site itself ("/about-us", "/en/contact", "/index.html")."""
    for raw in path.split("/"):
        segment = unquote(raw).strip().casefold()
        if not segment or _LOCALE_SEGMENT.match(segment):
            continue
        if segment in GENERIC_SITE_PAGES or _PAGE_FILE.match(segment):
            return ""
        return segment
    return ""


def _identity_path(host: str, path: str, query: str) -> str:
    """The part of a profile-platform URL that names the target."""
    case_sensitive = host in CASE_SENSITIVE_PATH_HOSTS
    segments = [unquote(segment).strip() for segment in path.split("/")]
    segments = [segment for segment in segments if segment]
    if host in LOCALE_PREFIXED_HOSTS:
        while segments and _LOCALE_SEGMENT.match(segments[0].casefold()):
            segments.pop(0)
    if segments:
        first = segments[0].casefold()
        if first in PATH_NAMESPACES:
            depth = PATH_NAMESPACES[first]
        elif host in REPOSITORY_HOSTS:
            depth = 2
        else:
            depth = 1
        segments = segments[:depth]
    folded = []
    for segment in segments:
        lower = segment.casefold()
        structural = lower in PATH_NAMESPACES or lower in _STRUCTURAL_SEGMENTS or segment.startswith("@")
        folded.append(segment if case_sensitive and not structural else lower)
    params = []
    for name, value in parse_qsl(query):
        name = name.casefold()
        value = value.strip()
        if name in IDENTITY_QUERY_PARAMETERS and value:
            params.append((name, value if case_sensitive else value.casefold()))
    identity = "/".join(folded)
    if params:
        identity += "?" + "&".join(f"{name}={value}" for name, value in sorted(params))
    return identity


def _url_key(text: str) -> str | None:
    """Key of a URL or bare domain, or None when ``text`` is not one."""
    value = text
    scheme_match = _SCHEME.match(value)
    if scheme_match:
        if scheme_match.group(1).casefold() not in _WEB_SCHEMES or not scheme_match.group(2):
            return None
        value = value[scheme_match.end() :]
    elif not _HOSTISH.match(re.split(r"[/?#]", value, maxsplit=1)[0]):
        return None
    try:
        parts = urlsplit(f"//{value}")
        hostname = parts.hostname or ""
        path, query = parts.path, parts.query
    except ValueError:
        return None
    ip = _ip_key(hostname)
    if ip is not None:
        return ip
    host = _host_key(hostname)
    if host is None:
        return None
    if _WWW_LABEL.sub("", hostname.casefold().rstrip(".")) == "youtu.be":
        # youtu.be/<video id> is youtube.com/watch?v=<video id>
        video = next((segment for segment in path.split("/") if segment), "")
        path, query = ("/watch", f"v={video}") if video else ("", "")
    if host in IDENTITY_HOSTS:
        identity = _identity_path(host, path, query)
    elif _subdomain_platform(host):
        identity = ""  # "john.tumblr.com/post/1": the sub-domain is the user
    else:
        identity = _site_path_segment(path)
    return f"{host}/{identity}" if identity else host


def _email_key(text: str) -> str | None:
    value = re.sub(r"^mailto:", "", text, flags=re.IGNORECASE)
    if not _EMAIL.match(value):
        return None
    local, _, domain = value.rpartition("@")
    host = _host_key(domain)
    if not local or host is None:
        return None
    return f"{local.casefold()}@{host}"


def _name_key(text: str) -> str:
    value = _fold(text)
    without_messrs = _MESSRS.sub("", value)
    if _compact(without_messrs):
        value = without_messrs
    value = value.replace("&", " and ").replace("+", " and ")
    value = _INNER_APOSTROPHE.sub("", value)
    value = _NON_WORD.sub(" ", value).replace("_", " ")
    words: list[str] = []
    run: list[str] = []
    # Runs of single letters are one abbreviation: "J. P. Morgan" -> "jp morgan",
    # "Acme L.L.C." -> "acme llc".
    for word in value.split():
        if len(word) == 1 and word.isalpha():
            run.append(word)
            continue
        if run:
            words.append("".join(run) if len(run) > 1 else run[0])
            run = []
        words.append(word)
    if run:
        words.append("".join(run) if len(run) > 1 else run[0])
    if not words:
        return ""
    stripped = list(words)
    while len(stripped) > 1 and stripped[0] in LEADING_ARTICLES:
        stripped.pop(0)
    removed_suffix = False
    while len(stripped) > 1:
        if stripped[-1] in LEGAL_SUFFIXES:
            stripped.pop()
            removed_suffix = True
        elif removed_suffix and stripped[-1] == "and":  # "Acme & Co."
            stripped.pop()
        else:
            break
    if all(word in LEGAL_SUFFIXES or word in LEADING_ARTICLES or word == "and" for word in stripped):
        stripped = words
    return " ".join(stripped)


def target_key(text: str) -> str:
    """Canonical key for a report target name ("" when it has no letters or
    digits). See the table above for the key of each kind of target."""
    value = unicodedata.normalize("NFKC", str(text or ""))
    value = _CONTROL.sub("", _WHITESPACE.sub(" ", value))
    value = _WHITESPACE.sub(" ", value).strip()
    value = value.strip(_EDGE_QUOTES + " ").rstrip(_TRAILING_SENTENCE_PUNCTUATION).strip(_EDGE_QUOTES + " ")
    if not _compact(value):
        return ""
    if " " not in value:
        for kind in (_ip_key, _email_key, _url_key):
            key = kind(value)
            if key:
                return _limit(key)
        if _HANDLE.match(value):
            return _limit("@" + value[1:].casefold().rstrip("."))
    return _limit(_name_key(value).strip())


# Key kinds, read back from a stored key (the shapes above never overlap).
KIND_NAME = "name"
KIND_DOMAIN = "domain"
KIND_PROFILE = "profile"
KIND_HANDLE = "handle"
KIND_EMAIL = "email"
KIND_IP = "ip"


def target_kind(key: str) -> str:
    if not key:
        return KIND_NAME
    if key.startswith("@"):
        return KIND_HANDLE
    if _ip_key(key.split("~", 1)[0]) is not None:
        return KIND_IP
    if "/" in key:
        return KIND_PROFILE
    if "@" in key:
        return KIND_EMAIL
    if "." in key or ":" in key:
        return KIND_DOMAIN
    return KIND_NAME


def _subdomain_platform(host: str) -> str | None:
    """The platform when ``host`` is a user's sub-domain ("john.tumblr.com")."""
    return next((platform for platform in SUBDOMAIN_IDENTITY_HOSTS if host.endswith("." + platform)), None)


def _registrable_label(host: str) -> str:
    """The organisation label of a host: "acme" for shop.acme.co.in, "john"
    for john.tumblr.com."""
    labels = host.split(".")
    platform = _subdomain_platform(host)
    if platform:
        return host[: -len(platform) - 1].split(".")[-1]
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in _REGISTRY_SECOND_LEVEL:
        return labels[-3]
    return labels[-2] if len(labels) >= 2 else labels[0]


def _profile_subject(key: str) -> tuple[str, str]:
    """(host, the identifying words) of a profile key."""
    host, _, identity = key.partition("/")
    path, _, query = identity.partition("?")
    segments = [segment for segment in path.split("/") if segment]
    while segments and segments[0].casefold() in PATH_NAMESPACES:
        segments.pop(0)
    if query:
        subject = query.split("=", 1)[-1].split("&", 1)[0]
    elif segments:
        subject = segments[0]
    else:
        subject = ""
    return host, subject.lstrip("@")


def comparison_forms(key: str) -> tuple[str, frozenset[str], str]:
    """How a key takes part in near-duplicate checks: ``(scope, aliases, text)``.

    * ``aliases``: compact (letters and digits only) names of the entity
      behind the key. Two keys sharing an alias are probably the same target
      named two ways ("Acme Ltd", "acme.com", "acme.org", "@acme",
      "instagram.com/acme").
    * ``text`` is compared for spelling (trigrams, one typo) with keys in the
      same ``scope`` only: profiles on one platform, mailboxes on one domain,
      or ("" scope) names, handles and domain names. IP addresses take no part:
      two different addresses are two different hosts.
    """
    kind = target_kind(key)
    if kind == KIND_IP:
        return ("ip", frozenset(), "")
    if kind == KIND_HANDLE:
        body = key[1:]
        return ("", frozenset({_compact(body)}), re.sub(r"[._]+", " ", body).strip())
    if kind == KIND_EMAIL:
        local, _, host = key.partition("@")
        return (f"email:{host}", frozenset(), re.sub(r"[._+\-]+", " ", local).strip())
    if kind == KIND_PROFILE:
        host, subject = _profile_subject(key)
        words = _NON_WORD.sub(" ", subject).replace("_", " ").strip()
        aliases = {_compact(subject)}
        if host not in IDENTITY_HOSTS:
            # A path on an ordinary site ("acme.com/alice") is also near the
            # site itself ("acme.com", "Acme Ltd").
            aliases.add(_compact(_registrable_label(host)))
        return (f"profile:{host}", frozenset(aliases), words)
    if kind == KIND_DOMAIN:
        label = _registrable_label(key)
        return ("", frozenset({_compact(label)}), label.replace("-", " "))
    return ("", frozenset({_compact(key)}), key)


# ---------------------------------------------------------------------------
# Near-duplicates (pg_trgm compatible)
# ---------------------------------------------------------------------------
NEAR_DUPLICATE_THRESHOLD = 0.6
_TRGM_WORD = re.compile(r"[^\W_]+", re.UNICODE)


def trigrams(text: str) -> set[str]:
    """pg_trgm's trigram set: each alphanumeric word lower-cased, padded with
    two spaces in front and one behind, cut into overlapping 3-character runs."""
    grams: set[str] = set()
    for word in _TRGM_WORD.findall(str(text or "").lower()):
        padded = f"  {word} "
        for index in range(len(padded) - 2):
            grams.add(padded[index : index + 3])
    return grams


def trigram_similarity(left: str, right: str) -> float:
    """Same value as PostgreSQL ``similarity(left, right)`` from pg_trgm."""
    a, b = trigrams(left), trigrams(right)
    if not a or not b:
        return 0.0
    return len(a & b) / float(len(a | b))


def within_one_edit(left: str, right: str) -> bool:
    """True when one insertion, deletion, substitution or adjacent swap turns
    ``left`` into ``right`` (a typo: "acme crop" / "acme corp")."""
    if left == right:
        return True
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        diffs = [index for index, (a, b) in enumerate(zip(left, right, strict=True)) if a != b]
        if len(diffs) == 1:
            return True
        return (
            len(diffs) == 2
            and diffs[1] == diffs[0] + 1
            and left[diffs[0]] == right[diffs[1]]
            and left[diffs[1]] == right[diffs[0]]
        )
    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    for index in range(len(longer)):
        if longer[:index] + longer[index + 1 :] == shorter:
            return True
    return False


TYPO_MIN_LENGTH = 5


ALIAS_SCORE = 0.95
ALIAS_MIN_LENGTH = 3


def pair_score(key: str, other: str) -> float:
    """How likely two *different* keys name the same target (0 to 1).

    Same entity behind two spellings or kinds (a shared alias: "acme" /
    "acme.com" / "@acme"): 0.95; names that differ only by spaces: 0.99;
    otherwise trigram similarity, raised to 0.9 for a one-character typo
    (5+ characters). Spelling is only compared within one scope (see
    ``comparison_forms``), so two profiles on one platform or two IP
    addresses are never near each other just for sharing a host.
    """
    if not key or not other or key == other:
        return 0.0
    scope, aliases, text = comparison_forms(key)
    other_scope, other_aliases, other_text = comparison_forms(other)
    score = 0.0
    shared = {alias for alias in aliases & other_aliases if len(alias) >= ALIAS_MIN_LENGTH}
    if scope == other_scope and scope.startswith("profile:"):
        # Two paths on one site ("example.edu/~alice", "example.edu/~bob")
        # share the site; only what the paths name can make them alike.
        shared -= {_compact(_registrable_label(scope.partition(":")[2]))}
    if shared:
        score = ALIAS_SCORE
    if scope == other_scope and scope != "ip" and text and other_text:
        compact, other_compact = text.replace(" ", ""), other_text.replace(" ", "")
        if text == other_text:
            # Same words, different keys ("acme" / "acme.com", two repositories
            # of one owner): related, but not the same spelling of one key.
            score = max(score, ALIAS_SCORE)
        elif compact == other_compact:
            score = max(score, 0.99)
        else:
            if min(len(compact), len(other_compact)) >= TYPO_MIN_LENGTH and within_one_edit(compact, other_compact):
                score = max(score, 0.9)
            score = max(score, trigram_similarity(text, other_text))
    return score


def near_duplicates(key: str, candidates: Iterable[tuple[object, str]], *, threshold: float | None = None):
    """``[(item, score)]`` for candidate ``(item, candidate_key)`` pairs whose
    key differs from ``key`` but probably names the same target
    (``pair_score`` at least ``threshold``), best first. These are warnings the
    student can override; only an equal key is a duplicate."""
    threshold = NEAR_DUPLICATE_THRESHOLD if threshold is None else threshold
    found = []
    for item, other in candidates:
        score = pair_score(key, other)
        if score >= threshold:
            found.append((item, round(score, 3)))
    found.sort(key=lambda pair: -pair[1])
    return found


def trigram_comparable(key: str) -> bool:
    """True when ``similarity(key, other)`` on the raw key means the same as
    ``pair_score``'s spelling check: plain names, whose key is their text."""
    return target_kind(key) == KIND_NAME
