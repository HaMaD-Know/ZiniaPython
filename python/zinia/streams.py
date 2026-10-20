"""Standard stream routing.

The iOS host has no console: by default CPython sends ``sys.stdout`` and
``sys.stderr`` to the system log. ZiniaPython replaces them (once, at start-up)
with :class:`OutputRouter` objects that deliver text to whichever execution is
currently active. Output written while nothing is running (for example by a
background thread a script left behind) is delivered with an empty execution
id, and the IDE shows it as background output.

``sys.stdin`` becomes an :class:`InputReader`. ``input()`` first consumes any
text supplied up-front with the run request, then asks the IDE for a line,
blocking the Python thread (with the GIL released) until the user answers or
stops the run.
"""

from __future__ import annotations

import io
import sys
import threading
from collections import deque
from contextlib import contextmanager

from . import native

DEFAULT_OUTPUT_LIMIT = 2_000_000  # characters per run that are forwarded to the UI


class ExecutionSink:
    """Destination for the output and input of one execution."""

    def __init__(self, execution_id: str, *, capture: bool = False,
                 output_limit: int = DEFAULT_OUTPUT_LIMIT, stdin: str | None = None):
        self.execution_id = execution_id
        self.capture = capture
        self.output_limit = max(1000, int(output_limit))
        self.chars = 0
        self.dropped = 0
        self.truncated = False
        self.events: list[tuple[int, str]] = []
        self._lock = threading.Lock()
        self._stdin_lines: deque[str] = deque()
        if stdin:
            self._stdin_lines.extend(stdin.splitlines(keepends=True))

    # -- output -----------------------------------------------------------
    def write(self, stream: int, text: str) -> None:
        if not text:
            return
        notice = None
        with self._lock:
            if self.truncated:
                self.dropped += len(text)
                return
            remaining = self.output_limit - self.chars
            if len(text) > remaining:
                self.dropped += len(text) - remaining
                text = text[:remaining]
                self.truncated = True
                notice = (f"\n[ZiniaPython] Output limit of {self.output_limit:,} characters reached; "
                          "further output from this run is discarded (the script keeps running).\n")
            self.chars += len(text)
            if self.capture:
                self.events.append((stream, text))
        if text:
            native.emit_output(self.execution_id, stream, text)
        if notice:
            if self.capture:
                self.events.append((native.STREAM_SYSTEM, notice))
            native.emit_output(self.execution_id, native.STREAM_SYSTEM, notice)

    def text(self, stream: int | None = None) -> str:
        return "".join(t for s, t in self.events if stream is None or s == stream)

    # -- input ------------------------------------------------------------
    def readline(self) -> str:
        with self._lock:
            if self._stdin_lines:
                line = self._stdin_lines.popleft()
                return line if line.endswith("\n") else line + "\n"
        reply = native.read_input(self.execution_id)
        if reply is None:
            return ""  # EOF -> input() raises EOFError
        return reply + "\n"


class _BackgroundSink(ExecutionSink):
    """Receives output written while no execution is active."""

    def __init__(self):
        super().__init__("", capture=False, output_limit=10**12)

    def readline(self) -> str:  # nothing can answer input outside a run
        return ""


_background = _BackgroundSink()
_current: ExecutionSink | None = None
_current_lock = threading.Lock()


def current_sink() -> ExecutionSink:
    sink = _current
    return sink if sink is not None else _background


@contextmanager
def activate(sink: ExecutionSink):
    """Make ``sink`` the destination for stdout/stderr/stdin during the block."""
    global _current
    with _current_lock:
        previous = _current
        _current = sink
    try:
        yield sink
    finally:
        with _current_lock:
            _current = previous


class _BytesAdapter:
    """Minimal ``sys.stdout.buffer`` replacement for code that writes bytes."""

    def __init__(self, router: "OutputRouter"):
        self._router = router

    def write(self, data) -> int:
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError(f"a bytes-like object is required, not '{type(data).__name__}'")
        self._router.write(bytes(data).decode("utf-8", "replace"))
        return len(data)

    def flush(self) -> None:
        pass


class OutputRouter(io.TextIOBase):
    """Text stream that forwards writes to the active :class:`ExecutionSink`."""

    def __init__(self, stream: int, name: str):
        super().__init__()
        self._stream = stream
        self._name = name
        self.buffer = _BytesAdapter(self)

    @property
    def name(self) -> str:  # type: ignore[override]
        return self._name

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return "utf-8"

    @property
    def errors(self) -> str:  # type: ignore[override]
        return "strict"

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        raise io.UnsupportedOperation("ZiniaPython's console stream has no file descriptor")

    def write(self, text) -> int:  # type: ignore[override]
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        current_sink().write(self._stream, text)
        return len(text)

    def flush(self) -> None:
        pass  # the native host batches and flushes output itself


class InputReader(io.TextIOBase):
    """``sys.stdin`` replacement backed by the IDE console."""

    @property
    def name(self) -> str:  # type: ignore[override]
        return "<stdin>"

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return "utf-8"

    def readable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        raise io.UnsupportedOperation("ZiniaPython's console stream has no file descriptor")

    def readline(self, size: int | None = -1) -> str:  # type: ignore[override]
        line = current_sink().readline()
        if size is not None and size >= 0:
            return line[:size]
        return line

    def read(self, size: int | None = -1) -> str:  # type: ignore[override]
        chunks = []
        total = 0
        while size is None or size < 0 or total < size:
            line = self.readline()
            if not line:
                break
            chunks.append(line)
            total += len(line)
        data = "".join(chunks)
        return data if size is None or size < 0 else data[:size]

    def readlines(self, hint: int = -1) -> list[str]:  # type: ignore[override]
        return self.read().splitlines(keepends=True)


stdout_router = OutputRouter(native.STREAM_STDOUT, "<stdout>")
stderr_router = OutputRouter(native.STREAM_STDERR, "<stderr>")
stdin_reader = InputReader()


_installed = False


def install() -> None:
    """Install the routers as the interpreter's standard streams."""
    global _installed
    _installed = True
    sys.stdout = stdout_router
    sys.stderr = stderr_router
    sys.stdin = stdin_reader
    sys.__stdout__ = stdout_router  # type: ignore[misc]
    sys.__stderr__ = stderr_router  # type: ignore[misc]
    sys.__stdin__ = stdin_reader  # type: ignore[misc]


def ensure_installed() -> None:
    """Re-install the routers if a script replaced ``sys.stdout`` and friends."""
    if not _installed:
        return
    if sys.stdout is not stdout_router:
        sys.stdout = stdout_router
    if sys.stderr is not stderr_router:
        sys.stderr = stderr_router
    if sys.stdin is not stdin_reader:
        sys.stdin = stdin_reader


@contextmanager
def redirected():
    """Temporarily route the standard streams through the routers.

    Used by the desktop test-suite, where the process-wide streams must be put
    back afterwards. Inside the app the routers are installed permanently.
    """
    saved = (sys.stdout, sys.stderr, sys.stdin)
    sys.stdout, sys.stderr, sys.stdin = stdout_router, stderr_router, stdin_reader
    try:
        yield
    finally:
        sys.stdout, sys.stderr, sys.stdin = saved
