"""Shared plumbing for the zinia_draw (2D) and zinia_3d (3D) modules.

How drawing reaches the screen
------------------------------
Python and the web UI run in different worlds: CPython runs on its own native
thread, the preview is an HTML canvas / WebGL view in the app's web view. So
the modules never touch JavaScript. They collect drawing commands in a
per-surface batch, and ``flush()`` sends the batch as one ``graphics`` event
through ``_zinia_native.emit_event`` -> Swift -> Capacitor -> the renderer. Each
batch carries the execution id and a sequence number, so the preview applies
batches in order and ignores anything from an earlier run.

The other direction (touches, keys, "frame drawn" acknowledgements) is posted
by the preview into a native queue that Python reads with
``_zinia_native.wait_ui``. The animation loop below runs on Python's own
thread and waits for each frame's acknowledgement before drawing the next one,
so a slow script slows down its own animation instead of freezing the app.

Without the iOS host (desktop tests and tools) batches are kept in
``recorded`` and events can be injected with ``inject_events``.
"""

from __future__ import annotations

import json
import math
import re
import time
from types import SimpleNamespace

from . import native, streams

MAX_COMMANDS_PER_BATCH = 50_000
ACK_TIMEOUT = 0.5          # seconds to wait for the preview to draw a frame
MAX_RECORDED = 2_000

#: Without a preview (desktop CPython, tests) run_animation stops after this
#: many frames instead of looping forever. Tests raise it as needed.
headless_frame_limit: int = 1
#: Batches sent while no native host was available (desktop tests).
recorded: list[dict] = []
_injected: list[dict] = []
_reset_hooks: list = []
_flush_hooks: list = []


# ---------------------------------------------------------------------------
# run lifecycle (called by zinia.executor)
# ---------------------------------------------------------------------------

def register(reset, flush) -> None:
    """Modules register how to reset their state and flush pending commands."""
    _reset_hooks.append(reset)
    _flush_hooks.append(flush)


def begin_run() -> None:
    """A new script run starts: forget every scene, canvas and handler."""
    _injected.clear()
    for hook in _reset_hooks:
        hook()


def end_run() -> None:
    """A script run ended: send drawing commands that were not shown yet."""
    for hook in _flush_hooks:
        try:
            hook()
        except Exception:  # noqa: BLE001 - never mask the script's own result
            pass


def execution_id() -> str:
    return streams.current_sink().execution_id


# ---------------------------------------------------------------------------
# argument validation
# ---------------------------------------------------------------------------

_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_FUNC = re.compile(r"^(?:rgba?|hsla?)\(\s*[-+0-9.%,\s/deg]+\)$", re.IGNORECASE)
_NAMED = {
    "black", "white", "red", "green", "blue", "yellow", "cyan", "magenta", "orange", "purple", "pink",
    "brown", "gray", "grey", "lightgray", "lightgrey", "darkgray", "darkgrey", "silver", "gold", "navy",
    "teal", "olive", "maroon", "lime", "aqua", "fuchsia", "indigo", "violet", "coral", "salmon", "tomato",
    "crimson", "orchid", "plum", "khaki", "beige", "ivory", "lavender", "turquoise", "skyblue", "steelblue",
    "royalblue", "dodgerblue", "deepskyblue", "midnightblue", "slategray", "slategrey", "darkslategray",
    "lightblue", "lightgreen", "darkgreen", "forestgreen", "seagreen", "springgreen", "limegreen",
    "chartreuse", "yellowgreen", "darkorange", "orangered", "hotpink", "deeppink", "firebrick", "darkred",
    "sienna", "chocolate", "tan", "wheat", "snow", "whitesmoke", "gainsboro", "transparent",
}


def color(value, name: str = "color"):
    """Normalise a colour to a CSS string, or raise a helpful error."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if _HEX.match(text) or _FUNC.match(text) or text.lower() in _NAMED:
            return text
        raise ValueError(f"{name}: unknown color {value!r}. Use '#rrggbb', a CSS color name such as "
                         "'white', or an (r, g, b) tuple with values 0-255.")
    if isinstance(value, (tuple, list)) and len(value) in (3, 4):
        parts = [number(v, f"{name} component") for v in value]
        r, g, b = (int(max(0, min(255, round(v)))) for v in parts[:3])
        if len(parts) == 4:
            a = max(0.0, min(1.0, parts[3]))
            return f"rgba({r},{g},{b},{a:g})"
        return f"rgb({r},{g},{b})"
    raise TypeError(f"{name} must be a string like '#00ffff' or an (r, g, b) tuple, "
                    f"not {type(value).__name__}")


def number(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a number, not {type(value).__name__}")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number, not {value}")
    return round(value, 4)


def positive(value, name: str) -> float:
    value = number(value, name)
    if value <= 0:
        raise ValueError(f"{name} must be greater than 0, not {value:g}")
    return value


def non_negative(value, name: str) -> float:
    value = number(value, name)
    if value < 0:
        raise ValueError(f"{name} must be 0 or more, not {value:g}")
    return value


def vector(value, name: str, length: int = 3) -> list[float]:
    if not isinstance(value, (tuple, list)) or len(value) != length:
        raise TypeError(f"{name} must be a tuple of {length} numbers, like {tuple([0] * length)}")
    return [number(v, f"{name}[{i}]") for i, v in enumerate(value)]


def points(value, name: str = "points", minimum: int = 2) -> list[float]:
    """Flatten [(x, y), ...] into [x0, y0, x1, y1, ...]."""
    try:
        items = list(value)
    except TypeError:
        raise TypeError(f"{name} must be a list of (x, y) pairs") from None
    if len(items) < minimum:
        raise ValueError(f"{name} needs at least {minimum} points, got {len(items)}")
    flat: list[float] = []
    for i, p in enumerate(items):
        if not isinstance(p, (tuple, list)) or len(p) != 2:
            raise TypeError(f"{name}[{i}] must be an (x, y) pair, not {p!r}")
        flat.append(number(p[0], f"{name}[{i}][0]"))
        flat.append(number(p[1], f"{name}[{i}][1]"))
    return flat


# ---------------------------------------------------------------------------
# command batches (Python -> preview)
# ---------------------------------------------------------------------------

class Surface:
    """Pending commands for one preview surface ("2d" or "3d")."""

    def __init__(self, name: str):
        self.name = name
        self.pending: list = []
        self.seq = 0
        self.on_batch_end = None  # called whenever the pending batch is sent or dropped

    def add(self, command) -> None:
        if len(self.pending) >= MAX_COMMANDS_PER_BATCH:
            raise RuntimeError(
                f"More than {MAX_COMMANDS_PER_BATCH:,} drawing commands are waiting. Call show() to send "
                "them, or clear() inside your update function so frames do not keep growing.")
        self.pending.append(command)

    def discard(self) -> None:
        self.pending = []
        if self.on_batch_end:
            self.on_batch_end()

    def flush(self, force: bool = False) -> int | None:
        """Send pending commands; returns the batch number, or None if nothing was sent."""
        if not self.pending and not force:
            return None
        self.seq += 1
        payload = {"executionId": execution_id(), "surface": self.name, "seq": self.seq,
                   "commands": self.pending}
        self.pending = []
        if self.on_batch_end:
            self.on_batch_end()
        data = json.dumps(payload, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
        if not native.emit_event("graphics", data):
            recorded.append(payload)
            del recorded[:-MAX_RECORDED]
        return self.seq


# ---------------------------------------------------------------------------
# UI events (preview -> Python)
# ---------------------------------------------------------------------------

def inject_events(events) -> None:
    """Desktop tests: queue events as if the preview had posted them."""
    _injected.extend(events)


def poll_events(timeout: float = 0.0) -> list[dict]:
    if not native.AVAILABLE:
        events = list(_injected)
        _injected.clear()
        return events
    events: list[dict] = []
    for batch in native.wait_ui(execution_id(), timeout):
        try:
            parsed = json.loads(batch)
        except ValueError:
            continue
        if isinstance(parsed, list):
            events.extend(e for e in parsed if isinstance(e, dict))
    return events


def make_event(raw: dict) -> SimpleNamespace:
    return SimpleNamespace(**{k: v for k, v in raw.items() if isinstance(k, str) and k.isidentifier()})


class Animation:
    """Frame loop shared by both modules. One per surface."""

    def __init__(self, surface: Surface, dispatch):
        self.surface = surface
        self.dispatch = dispatch      # callable(event dict) for pointer/key/tap events
        self.update = None
        self.running = False
        self.frames = 0
        self.measured_fps = 0.0

    def reset(self) -> None:
        self.update = None
        self.running = False
        self.frames = 0

    def stop(self) -> None:
        self.running = False

    def run(self, fps: float = 60, duration: float | None = None) -> None:
        fps = number(fps, "fps")
        if not 1 <= fps <= 120:
            raise ValueError("fps must be between 1 and 120")
        if duration is not None:
            duration = positive(duration, "duration")
        if self.update is None:
            raise RuntimeError("Call set_update(function) before run_animation().")
        interval = 1.0 / fps
        live = native.AVAILABLE
        self.running = True
        self.frames = 0
        started = last = time.perf_counter()
        awaiting = [None]  # batch number whose "frame drawn" acknowledgement is pending

        def handle(events):
            for event in events:
                if event.get("surface", self.surface.name) != self.surface.name:
                    continue  # meant for the other preview surface
                if event.get("type") == "ack":
                    if awaiting[0] is not None and event.get("seq", 0) >= awaiting[0]:
                        awaiting[0] = None
                else:
                    self.dispatch(event)

        try:
            while self.running:
                handle(poll_events(0))
                now = time.perf_counter()
                dt = now - last
                last = now
                self.update(dt)
                seq = self.surface.flush(force=True)
                self.frames += 1
                elapsed = time.perf_counter() - started
                self.measured_fps = self.frames / elapsed if elapsed > 0 else 0.0
                if not self.running:
                    break
                if not live and self.frames >= headless_frame_limit:
                    break
                if duration is not None and elapsed >= duration:
                    break
                if not live:
                    continue
                awaiting[0] = seq
                frame_due = now + interval
                ack_due = now + ACK_TIMEOUT
                while self.running:
                    t = time.perf_counter()
                    if awaiting[0] is None and t >= frame_due:
                        break
                    if t >= ack_due and t >= frame_due:
                        break  # the preview is hidden or busy: keep the requested pace
                    wait = (frame_due - t) if awaiting[0] is None else min(ack_due - t, 0.05)
                    handle(poll_events(max(0.0, wait)))
        finally:
            self.running = False
