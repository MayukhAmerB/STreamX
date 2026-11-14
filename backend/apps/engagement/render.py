"""Achievement renderings, kept for callers of the first engagement release.

Every achievement now has a ``Certificate`` and there is one design for it
(``certificate_render``): the share card is the certificate's 1200 x 630
preview and the certificate PDF is the A4-landscape certificate. ``verify_url``
is ignored: the printed address is always the certificate's own page.
"""

from __future__ import annotations

from . import certificate_render, certificates


def share_card_png(achievement, verify_url: str = "") -> bytes:
    return certificate_render.og_png(certificates.ensure_for_achievement(achievement))


def certificate_pdf(achievement, verify_url: str = "") -> bytes:
    return certificate_render.certificate_pdf(certificates.ensure_for_achievement(achievement))
