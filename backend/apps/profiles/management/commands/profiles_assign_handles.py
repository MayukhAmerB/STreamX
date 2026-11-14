"""Older name of ``generate_missing_handles`` (kept so existing runbooks keep working)."""

from .generate_missing_handles import Command as GenerateMissingHandles


class Command(GenerateMissingHandles):
    pass
