"""Check-digit algorithms used by the PII detectors (pure Python, no I/O).

* Verhoeff: Aadhaar numbers (12 digits) and Aadhaar Virtual IDs (16 digits)
  end with a Verhoeff check digit. Random 12-digit strings pass 1 time in 10,
  so a passing number that also has the Aadhaar shape is treated as Aadhaar.
* Luhn: payment card numbers (13-19 digits).
"""

from __future__ import annotations

_VERHOEFF_D = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)
_VERHOEFF_P = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)
_VERHOEFF_INV = (0, 4, 3, 2, 1, 5, 6, 7, 8, 9)  # reflections (5-9) are their own inverse


def verhoeff_valid(digits: str) -> bool:
    """True when ``digits`` (ASCII digits only) carries a valid Verhoeff check digit."""
    if not digits or not digits.isascii() or not digits.isdigit():
        return False
    check = 0
    for index, char in enumerate(reversed(digits)):
        check = _VERHOEFF_D[check][_VERHOEFF_P[index % 8][int(char)]]
    return check == 0


def verhoeff_check_digit(digits: str) -> str:
    """The Verhoeff digit to append to ``digits`` (used by tests to build valid numbers)."""
    if not digits or not digits.isascii() or not digits.isdigit():
        raise ValueError("digits only")
    check = 0
    for index, char in enumerate(reversed(digits)):
        check = _VERHOEFF_D[check][_VERHOEFF_P[(index + 1) % 8][int(char)]]
    return str(_VERHOEFF_INV[check])


def luhn_valid(digits: str) -> bool:
    """True when ``digits`` passes the Luhn (mod 10) check."""
    if not digits or not digits.isascii() or not digits.isdigit() or len(digits) < 2:
        return False
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def luhn_check_digit(digits: str) -> str:
    """The Luhn digit to append to ``digits``."""
    for candidate in "0123456789":
        if luhn_valid(digits + candidate):
            return candidate
    raise ValueError("digits only")  # pragma: no cover - unreachable for digit input
