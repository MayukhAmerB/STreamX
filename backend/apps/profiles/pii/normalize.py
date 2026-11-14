"""Text normalisation that runs before every PII detector.

People (and copy-paste) hide identifiers behind look-alike characters, so the
detectors never see the raw string. ``normalize`` returns text where:

* compatibility forms are folded (NFKC): full-width digits, mathematical
  digits and letters, ligatures, non-breaking spaces;
* every Unicode decimal digit (Devanagari, Bengali, Arabic-Indic, ...) is the
  ASCII digit with the same value;
* invisible characters are removed: zero-width spaces and joiners, soft
  hyphens, word joiners, bidirectional controls, the BOM;
* the many dash characters are "-" and every whitespace run is one space
  (newlines kept as "\n").

Offsets in findings refer to the normalised text, which is also what the
excerpt shows.
"""

from __future__ import annotations

import re
import unicodedata

INVISIBLE_CHARS = frozenset(
    [
        "­",  # soft hyphen
        "͏",  # combining grapheme joiner
        "؜",  # Arabic letter mark
        "ᅟ",
        "ᅠ",
        "឴",
        "឵",
        "᠎",  # Mongolian vowel separator
        "​",  # zero-width space
        "‌",  # zero-width non-joiner
        "‍",  # zero-width joiner
        "‎",  # LRM
        "‏",  # RLM
        "‪",
        "‫",
        "‬",
        "‭",
        "‮",  # bidi embedding / override
        "⁠",  # word joiner
        "⁡",
        "⁢",
        "⁣",
        "⁤",
        "⁦",
        "⁧",
        "⁨",
        "⁩",  # bidi isolates
        "ㅤ",
        "﻿",  # BOM / zero-width no-break space
        "ﾠ",
    ]
)
BIDI_CONTROLS = frozenset("‪‫‬‭‮⁦⁧⁨⁩‎‏؜")
_DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−﹘﹣－"), "-")
_SPACE_RUN = re.compile(r"[^\S\n]+")
_NEWLINE_RUN = re.compile(r"\s*\n\s*")


def fold_digits(text: str) -> str:
    """Replace every Unicode decimal digit by its ASCII digit."""
    out = []
    for char in text:
        if char.isdigit() and not ("0" <= char <= "9"):
            try:
                out.append(str(unicodedata.decimal(char)))
                continue
            except (TypeError, ValueError):
                pass
        out.append(char)
    return "".join(out)


def strip_invisible(text: str) -> str:
    return "".join(char for char in text if char not in INVISIBLE_CHARS and unicodedata.category(char) != "Cf")


def normalize(text: str) -> str:
    """The detector view of ``text`` (see module docstring)."""
    if not text:
        return ""
    value = unicodedata.normalize("NFKC", str(text))
    value = strip_invisible(value)
    value = fold_digits(value)
    value = value.translate(_DASHES)
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = _SPACE_RUN.sub(" ", value)
    value = _NEWLINE_RUN.sub("\n", value)
    return value.strip()


def alnum_key(text: str) -> str:
    """Lower-case letters and digits only: ``"Ravi K. Sharma"`` -> ``"ravikshrma"``-style keys."""
    return "".join(char for char in normalize(text).casefold() if char.isalnum())


def digits_only(text: str) -> str:
    return "".join(char for char in fold_digits(str(text or "")) if "0" <= char <= "9")


def mask(value: str) -> str:
    """Show the shape of a match without repeating it: ``98•••••210``."""
    text = str(value or "").strip()
    if len(text) <= 4:
        return "•" * len(text)
    keep = 2 if len(text) < 10 else 3
    middle = "".join("•" if not char.isspace() else char for char in text[keep:-keep])
    return f"{text[:keep]}{middle}{text[-keep:]}"
