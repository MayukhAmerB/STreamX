"""Private staging storage for upload chunks: bounded memory, no path from the client.

Layout (config.staging_root())::

    <root>/<upload uuid>/chunks/000000.chunk   one file per received chunk
    <root>/<upload uuid>/chunks/000000.*.part  a chunk being received (temp)
    <root>/<upload uuid>/assembled.<ext>       the whole file, built by the worker

Every path is built from the upload's UUID and an integer chunk index: nothing
the client sends (file name included) ever becomes part of a path.
"""

import hashlib
import os
import re
import shutil
import tempfile
import time
import unicodedata
import uuid
from pathlib import Path

from django.core.exceptions import ValidationError

from config.upload_validators import ALLOWED_OBS_RECORDING_EXTENSIONS

from . import config

PART_SUFFIX = ".part"
CHUNK_SUFFIX = ".chunk"
_UNSAFE_NAME_CHARS = re.compile(r"[^\w\-() .]+")
_SPACES = re.compile(r"\s+")


class ChunkBodyError(Exception):
    """The request body did not have the declared number of bytes."""


def _ensure_dir(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, config.staging_dir_mode())
    except OSError:
        pass
    return path


def staging_root():
    return config.staging_root()


def upload_dir(upload_id):
    # uuid.UUID() rejects anything that is not a UUID, so the name is always safe.
    return staging_root() / str(uuid.UUID(str(upload_id)))


def chunks_dir(upload_id):
    return upload_dir(upload_id) / "chunks"


def chunk_path(upload_id, index):
    index = int(index)
    if index < 0:
        raise ValueError("Chunk index must not be negative.")
    return chunks_dir(upload_id) / f"{index:06d}{CHUNK_SUFFIX}"


def assembled_path(upload_id, extension):
    extension = str(extension or "").lower()
    if extension not in ALLOWED_OBS_RECORDING_EXTENSIONS:
        raise ValueError("Unsupported extension.")
    return upload_dir(upload_id) / f"assembled.{extension}"


def prepare_upload_dir(upload_id):
    _ensure_dir(staging_root())
    _ensure_dir(upload_dir(upload_id))
    return _ensure_dir(chunks_dir(upload_id))


def remove_upload_dir(upload_id):
    shutil.rmtree(upload_dir(upload_id), ignore_errors=True)


def remove_chunks(upload_id):
    shutil.rmtree(chunks_dir(upload_id), ignore_errors=True)


def free_bytes(path=None):
    """Free space on the filesystem holding ``path`` (or the staging root)."""
    target = Path(path or staging_root())
    while not target.exists() and target != target.parent:
        target = target.parent
    try:
        return shutil.disk_usage(target).free
    except OSError:
        return 0


def tree_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
    return total


def sanitize_filename(raw):
    """``(safe display name, lowercase extension)``; raises ValidationError.

    Any directory part (``../``, ``C:\\``) is dropped, control and reserved
    characters are removed, and only the OBS recording containers are allowed.
    The name is for display only; the stored file is renamed by the server.
    """
    name = unicodedata.normalize("NFKC", str(raw or ""))
    name = re.split(r"[\\/]", name)[-1]
    name = "".join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*')
    name = _SPACES.sub(" ", name).strip(" .")
    stem, ext = os.path.splitext(name)
    ext = ext.lower().lstrip(".")
    if not stem or ext not in ALLOWED_OBS_RECORDING_EXTENSIONS:
        allowed = ", ".join(sorted(item.upper() for item in ALLOWED_OBS_RECORDING_EXTENSIONS))
        raise ValidationError({"filename": f"Choose an OBS recording ({allowed})."})
    stem = _UNSAFE_NAME_CHARS.sub("_", stem).strip(" ._")[:120] or "recording"
    # A second extension (``lecture.php.mp4``) is kept only as text.
    stem = stem.replace(".", "_")
    return f"{stem}.{ext}", ext


def receive_chunk(stream, upload_id, index, expected_bytes):
    """Copy exactly ``expected_bytes`` from ``stream`` into a temp file next to the chunk.

    Returns ``(temp path, sha256 hex)``; reads at most one block at a time.
    The temp file is removed when anything goes wrong.
    """
    directory = prepare_upload_dir(upload_id)
    fd, temp_name = tempfile.mkstemp(prefix=f"{int(index):06d}.", suffix=PART_SUFFIX, dir=directory)
    temp_path = Path(temp_name)
    digest = hashlib.sha256()
    received = 0
    try:
        with os.fdopen(fd, "wb") as handle:
            while received < expected_bytes:
                block = stream.read(min(config.IO_BLOCK_BYTES, expected_bytes - received))
                if not block:
                    break
                handle.write(block)
                digest.update(block)
                received += len(block)
            handle.flush()
        if received != expected_bytes:
            raise ChunkBodyError(f"Received {received} of {expected_bytes} bytes; the connection was interrupted.")
        return temp_path, digest.hexdigest()
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def commit_chunk(temp_path, upload_id, index):
    os.replace(temp_path, chunk_path(upload_id, index))


class AssemblyError(Exception):
    pass


def assemble(upload, output_path, *, on_chunk=None):
    """Concatenate the chunks into ``output_path``; returns ``(sha256 hex, bytes)``.

    Each chunk's size and SHA-256 are checked again against what was recorded
    when it arrived (disk corruption or a tampered staging file fails here).
    """
    output_path = Path(output_path)
    whole = hashlib.sha256()
    total = 0
    temp_output = output_path.with_name(output_path.name + PART_SUFFIX)
    try:
        with open(temp_output, "wb") as out:
            for index in range(upload.chunk_count):
                source = chunk_path(upload.pk, index)
                expected = upload.expected_chunk_size(index)
                piece = hashlib.sha256()
                size = 0
                try:
                    handle = open(source, "rb")
                except FileNotFoundError as exc:
                    raise AssemblyError(f"Chunk {index} is missing on the server.") from exc
                with handle:
                    while True:
                        block = handle.read(config.IO_BLOCK_BYTES)
                        if not block:
                            break
                        out.write(block)
                        whole.update(block)
                        piece.update(block)
                        size += len(block)
                recorded = str((upload.chunk_sha256 or {}).get(str(index)) or "")
                if size != expected or (recorded and recorded != piece.hexdigest()):
                    raise AssemblyError(f"Chunk {index} changed on the server after it was received.")
                total += size
                if on_chunk is not None:
                    on_chunk(index)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp_output, output_path)
    except BaseException:
        temp_output.unlink(missing_ok=True)
        raise
    return whole.hexdigest(), total


def stale_part_files(upload_id, older_than_seconds):
    """Temp chunk files a crashed or cut-off request left behind."""
    directory = chunks_dir(upload_id)
    if not directory.is_dir():
        return []
    cutoff = time.time() - older_than_seconds
    stale = []
    for entry in directory.iterdir():
        try:
            if entry.name.endswith(PART_SUFFIX) and entry.stat().st_mtime < cutoff:
                stale.append(entry)
        except OSError:
            continue
    return stale


def staged_upload_ids():
    """UUID names of the directories under the staging root (others are ignored)."""
    root = staging_root()
    if not root.is_dir():
        return []
    found = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        try:
            found.append((uuid.UUID(entry.name), entry))
        except ValueError:
            continue
    return found
