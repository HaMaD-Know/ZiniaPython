"""Access to the ``_zinia_native`` built-in module provided by the iOS host.

``ZPInterpreter.m`` registers ``_zinia_native`` with ``PyImport_AppendInittab``
before the interpreter starts. On desktop CPython (tests, tooling) the module
does not exist, and every helper here degrades to a documented fallback so the
rest of the package can be exercised without an iPhone.
"""

from __future__ import annotations

try:  # pragma: no cover - only importable inside the iOS app
    import _zinia_native as _native  # type: ignore[import-not-found]
except ImportError:  # desktop CPython
    _native = None

AVAILABLE = _native is not None

STREAM_STDOUT = 1
STREAM_STDERR = 2
STREAM_SYSTEM = 3


def emit_output(execution_id: str, stream: int, text: str) -> bool:
    """Forward a chunk of output to the IDE. Returns False when no host exists."""
    if _native is None:
        return False
    _native.emit_output(execution_id, stream, text)
    return True


def emit_event(name: str, payload_json: str) -> bool:
    """Send a JSON event (for example package progress) to the IDE."""
    if _native is None:
        return False
    _native.emit_event(name, payload_json)
    return True


def read_input(execution_id: str):
    """Block until the IDE supplies a line of input.

    Returns the text (without newline), or ``None`` for end-of-file. Raises
    ``KeyboardInterrupt`` if the run is stopped while waiting. Returns ``None``
    immediately when there is no host, which makes ``input()`` raise EOFError.
    """
    if _native is None:
        return None
    return _native.read_input(execution_id)


def http_get(url: str, timeout: float, max_bytes: int):
    """Fetch a URL with the platform HTTP stack.

    Inside the app this uses ``URLSession`` (system trust store, App Transport
    Security). Returns ``(status_code, body_bytes)`` or ``None`` when no host is
    available, in which case callers fall back to ``urllib``.
    """
    if _native is None:
        return None
    return _native.http_get(url, float(timeout), int(max_bytes))


def wait_ui(execution_id: str, timeout: float) -> list:
    """Event batches (JSON strings) posted by the graphics preview.

    Waits up to ``timeout`` seconds when none are queued. Returns ``[]`` when
    there is no host (desktop tests), so callers never block there.
    """
    if _native is None or not hasattr(_native, "wait_ui"):
        return []
    return _native.wait_ui(execution_id, float(timeout))
