"""PII guard: blocks publishing when profile text or image metadata contains
personal identifiers (see ``engine`` for the API, ``detectors`` for the rules)."""

from . import detectors  # noqa: F401  (registers the built-in detectors)
from .engine import Detector, Finding, ScanContext, register, scan_fields, scan_text, summary, unregister

__all__ = ["Detector", "Finding", "ScanContext", "register", "scan_fields", "scan_text", "summary", "unregister"]
