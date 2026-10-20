"""zinia_draw - 2D graphics for ZiniaPython.

Draw on a canvas that appears in the app's Graphics panel::

    import zinia_draw as gfx

    gfx.create_canvas(800, 600)
    gfx.set_background("#101525")
    gfx.clear()
    gfx.circle(200, 150, 50, color="#00ffff")
    gfx.rectangle(300, 100, 150, 90, color="#ff00aa")
    gfx.line(0, 0, 800, 600, color="white", width=2)
    gfx.text(30, 40, "Hello ZiniaPython", color="white", size=24)
    gfx.polygon([(400, 100), (500, 250), (300, 250)], color="#00ff88")
    gfx.show()

Coordinates are canvas pixels: (0, 0) is the top-left corner, x grows to the
right and y grows downwards. The preview scales the canvas to fit the panel
(keeping its aspect ratio) and renders sharply on Retina screens.

Commands are collected and sent to the preview when you call ``show()`` (and
automatically when the program ends). They are drawn in the order you call
them. Shapes are filled by default; pass ``fill=False`` to draw only an
outline, or ``outline="white"`` to add one.

Animation::

    def update(dt):            # dt: seconds since the previous frame (float)
        gfx.clear()
        ...draw the frame...

    gfx.set_update(update)
    gfx.run_animation()        # returns when stop_animation() is called,
                               # the Stop button is pressed, or duration ends

Touch and keyboard (delivered while run_animation() runs)::

    def on_pointer(event):     # event.type: "down", "move" or "up"
        print(event.x, event.y, event.id)   # canvas coordinates; id per finger
    gfx.on_pointer(on_pointer)

    def on_key(event):         # event.type: "down" or "up"; event.key: e.g. "ArrowLeft", "a", " "
        ...
    gfx.on_key(on_key)
"""

from __future__ import annotations

from zinia import graphics as _g

__all__ = [
    "create_canvas", "set_background", "clear", "circle", "ellipse", "rectangle", "line", "polyline",
    "polygon", "text", "show", "size", "set_update", "run_animation", "stop_animation", "on_pointer",
    "on_key", "pointer", "frame_rate",
]

_MAX_CANVAS = 4096
_surface = _g.Surface("2d")


class _State:
    width = 800
    height = 600
    created = False
    pointer_handler = None
    key_handler = None
    pointer = (0.0, 0.0, False)


def _dispatch(event: dict) -> None:
    kind = event.get("type")
    if kind in ("down", "move", "up"):
        x = float(event.get("x", 0))
        y = float(event.get("y", 0))
        down = kind != "up" and (kind == "down" or bool(event.get("buttons", _State.pointer[2])))
        _State.pointer = (x, y, down)
        if _State.pointer_handler is not None:
            _State.pointer_handler(_g.make_event({**event, "x": x, "y": y}))
    elif kind in ("keydown", "keyup") and _State.key_handler is not None:
        _State.key_handler(_g.make_event({**event, "type": kind[3:]}))


_animation = _g.Animation(_surface, _dispatch)


def _reset() -> None:
    _surface.discard()
    _animation.reset()
    _State.width, _State.height = 800, 600
    _State.created = False
    _State.pointer_handler = None
    _State.key_handler = None
    _State.pointer = (0.0, 0.0, False)


def _ensure_canvas() -> None:
    if not _State.created:
        create_canvas(_State.width, _State.height)


_g.register(_reset, lambda: _surface.flush())


# ---------------------------------------------------------------------------
# canvas
# ---------------------------------------------------------------------------

def create_canvas(width: int = 800, height: int = 600) -> None:
    """Create (or recreate) the canvas. Everything drawn before is removed."""
    w = _g.positive(width, "width")
    h = _g.positive(height, "height")
    if w > _MAX_CANVAS or h > _MAX_CANVAS:
        raise ValueError(f"The canvas can be at most {_MAX_CANVAS} x {_MAX_CANVAS} pixels")
    _State.width, _State.height = int(round(w)), int(round(h))
    _State.created = True
    _surface.discard()
    _surface.add(["canvas", _State.width, _State.height])


def size() -> tuple[int, int]:
    """The canvas size as (width, height)."""
    return (_State.width, _State.height)


def set_background(color) -> None:
    """Fill the canvas with this colour; clear() uses it from now on."""
    _ensure_canvas()
    _surface.add(["bg", _g.color(color)])


def clear() -> None:
    """Fill the whole canvas with the background colour."""
    _ensure_canvas()
    _surface.add(["clear"])


def _paint(color, fill, outline, line_width):
    fill_color = _g.color(color) if fill else None
    stroke = _g.color(outline, "outline") if outline is not None else (None if fill else _g.color(color))
    return fill_color, stroke, _g.non_negative(line_width, "line_width")


# ---------------------------------------------------------------------------
# shapes
# ---------------------------------------------------------------------------

def circle(x, y, radius, color="white", fill=True, outline=None, line_width=1) -> None:
    """Circle centred at (x, y)."""
    _ensure_canvas()
    f, s, w = _paint(color, fill, outline, line_width)
    _surface.add(["circle", _g.number(x, "x"), _g.number(y, "y"), _g.non_negative(radius, "radius"), f, s, w])


def ellipse(x, y, radius_x, radius_y, color="white", fill=True, outline=None, line_width=1, rotation=0) -> None:
    """Ellipse centred at (x, y); rotation in radians."""
    _ensure_canvas()
    f, s, w = _paint(color, fill, outline, line_width)
    _surface.add(["ellipse", _g.number(x, "x"), _g.number(y, "y"), _g.non_negative(radius_x, "radius_x"),
                  _g.non_negative(radius_y, "radius_y"), _g.number(rotation, "rotation"), f, s, w])


def rectangle(x, y, width, height, color="white", fill=True, outline=None, line_width=1, corner_radius=0) -> None:
    """Rectangle with its top-left corner at (x, y)."""
    _ensure_canvas()
    f, s, w = _paint(color, fill, outline, line_width)
    _surface.add(["rect", _g.number(x, "x"), _g.number(y, "y"), _g.number(width, "width"),
                  _g.number(height, "height"), f, s, w, _g.non_negative(corner_radius, "corner_radius")])


def line(x1, y1, x2, y2, color="white", width=1) -> None:
    """Straight line from (x1, y1) to (x2, y2); width is the line thickness."""
    _ensure_canvas()
    _surface.add(["line", _g.number(x1, "x1"), _g.number(y1, "y1"), _g.number(x2, "x2"), _g.number(y2, "y2"),
                  _g.color(color), _g.positive(width, "width")])


def polyline(points, color="white", width=1, closed=False) -> None:
    """Connected line segments through [(x, y), ...]."""
    _ensure_canvas()
    _surface.add(["poly", _g.points(points), bool(closed), None, _g.color(color), _g.positive(width, "width")])


def polygon(points, color="white", fill=True, outline=None, line_width=1) -> None:
    """Closed shape through [(x, y), ...] (at least 3 points)."""
    _ensure_canvas()
    f, s, w = _paint(color, fill, outline, line_width)
    _surface.add(["poly", _g.points(points, minimum=3), True, f, s, w])


_ALIGN = {"left", "center", "right"}
_BASELINE = {"top", "middle", "bottom", "alphabetic"}


def text(x, y, text, color="white", size=16, align="left", baseline="top", bold=False, font="sans-serif") -> None:
    """Draw text. By default (x, y) is the top-left corner of the text."""
    _ensure_canvas()
    if not isinstance(text, str):
        text = str(text)
    if align not in _ALIGN:
        raise ValueError(f"align must be one of {sorted(_ALIGN)}")
    if baseline not in _BASELINE:
        raise ValueError(f"baseline must be one of {sorted(_BASELINE)}")
    if font not in ("sans-serif", "serif", "monospace"):
        raise ValueError("font must be 'sans-serif', 'serif' or 'monospace'")
    _surface.add(["text", _g.number(x, "x"), _g.number(y, "y"), text[:2000], _g.color(color),
                  _g.positive(size, "size"), align, baseline, bool(bold), font])


def show() -> None:
    """Send everything drawn so far to the Graphics panel."""
    _ensure_canvas()
    _surface.flush(force=True)


# ---------------------------------------------------------------------------
# animation and input
# ---------------------------------------------------------------------------

def set_update(function) -> None:
    """Register update(dt) - called once per frame by run_animation()."""
    if function is not None and not callable(function):
        raise TypeError("set_update() needs a function that takes one argument: dt (seconds)")
    _animation.update = function


def run_animation(fps: float = 60, duration: float | None = None) -> None:
    """Call the update function every frame until stop_animation(), Stop, or `duration` seconds."""
    _ensure_canvas()
    _animation.run(fps=fps, duration=duration)


def stop_animation() -> None:
    """Make run_animation() return after the current frame."""
    _animation.stop()


def on_pointer(function) -> None:
    """Register on_pointer(event) for touches and mouse input (see module docs)."""
    if function is not None and not callable(function):
        raise TypeError("on_pointer() needs a function that takes one argument: event")
    _State.pointer_handler = function


def on_key(function) -> None:
    """Register on_key(event) for hardware keyboard input (see module docs)."""
    if function is not None and not callable(function):
        raise TypeError("on_key() needs a function that takes one argument: event")
    _State.key_handler = function


def pointer() -> tuple[float, float, bool]:
    """Last known pointer position and whether it is pressed: (x, y, down)."""
    return _State.pointer


def frame_rate() -> float:
    """Frames per second actually achieved by the running animation."""
    return round(_animation.measured_fps, 1)
