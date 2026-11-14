"""Outbox handlers of the CTF app (autodiscovered by ``CoreConfig.ready``).

The handlers live next to the code they drive (``scheduler.py``); importing
the module here registers them in every process.
"""

from . import scheduler  # noqa: F401  (registers the ctf.* outbox handlers)
