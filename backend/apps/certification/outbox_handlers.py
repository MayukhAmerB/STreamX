"""Registers the certification.* outbox handlers (autodiscovered by CoreConfig.ready)."""

from . import delivery, sweep  # noqa: F401
