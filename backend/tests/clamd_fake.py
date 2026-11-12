"""An in-process fake clamd (stdlib socketserver) speaking the real TCP protocol.

Commands are ``z``- (NUL-terminated) or ``n``- (newline-terminated) prefixed:
PING -> PONG, VERSION -> ClamAV version line, INSTREAM -> length-prefixed
chunks terminated by a zero-length chunk, answered like clamd does.

``mode`` picks the INSTREAM answer: "auto" (FOUND when the stream contains
the EICAR test string, else OK), "found", "error", "slow" (answer after
``delay`` seconds), "close" (hang up without answering). A stream longer than
``stream_max`` gets clamd's "INSTREAM size limit exceeded. ERROR".
"""

from __future__ import annotations

import socketserver
import struct
import threading
import time

from apps.reports.antivirus import EICAR_SIGNATURE

FAKE_VERSION = "ClamAV 1.4.3/27816/Wed Nov 11 08:15:00 2026"


class _Handler(socketserver.BaseRequestHandler):
    def _read_exact(self, size):
        data = b""
        while len(data) < size:
            chunk = self.request.recv(size - len(data))
            if not chunk:
                raise ConnectionError("client closed")
            data += chunk
        return data

    def _read_command(self):
        first = self._read_exact(1)
        terminator = b"\0" if first == b"z" else b"\n"
        command = b""
        while True:
            char = self._read_exact(1)
            if char == terminator:
                return command.decode("ascii", errors="replace"), terminator
            command += char

    def handle(self):
        server = self.server
        try:
            command, terminator = self._read_command()
        except ConnectionError:
            return
        server.commands.append(command)
        if command == "PING":
            self.request.sendall(b"PONG" + terminator)
            return
        if command == "VERSION":
            self.request.sendall(server.version.encode() + terminator)
            return
        if command != "INSTREAM":
            self.request.sendall(b"UNKNOWN COMMAND" + terminator)
            return
        received = bytearray()
        try:
            while True:
                (length,) = struct.unpack("!L", self._read_exact(4))
                if length == 0:
                    break
                if len(received) > server.stream_max:
                    self._read_exact(length)  # drain, so the reply is not lost to a TCP reset
                    continue
                received += self._read_exact(length)
            if len(received) > server.stream_max:
                self.request.sendall(b"INSTREAM size limit exceeded. ERROR" + terminator)
                return
        except ConnectionError:
            return
        server.streams.append(bytes(received))
        mode = server.mode
        if mode == "close":
            return
        if mode == "slow":
            time.sleep(server.delay)
        if mode == "error":
            reply = b"INSTREAM: Can't allocate memory ERROR"
        elif mode == "found" or EICAR_SIGNATURE in received:
            reply = b"stream: Eicar-Test-Signature FOUND"
        else:
            reply = b"stream: OK"
        try:
            self.request.sendall(reply + terminator)
        except OSError:
            pass


class FakeClamd(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, *, mode="auto", stream_max=50 * 1024 * 1024, delay=2.0, version=FAKE_VERSION):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.mode = mode
        self.stream_max = stream_max
        self.delay = delay
        self.version = version
        self.commands = []
        self.streams = []
        self._thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    @property
    def port(self):
        return self.server_address[1]

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self.shutdown()
        self.server_close()
        self._thread.join(timeout=5)
        return False


def closed_port():
    """A localhost port nothing listens on (connection refused)."""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
