"""zinia_3d - interactive 3D scenes for ZiniaPython (rendered with Three.js/WebGL).

::

    import zinia_3d as scene

    scene.create_scene()
    scene.set_background("#101525")
    box = scene.add_box(x=0, y=0, z=0, width=2, height=2, depth=2, color="#00ffff")
    scene.add_sphere(x=3, y=0, z=0, radius=1, color="#ff00aa")
    scene.add_light("ambient", intensity=0.7)
    scene.add_light("directional", intensity=1.2)
    scene.set_camera(position=(6, 5, 8), target=(0, 0, 0))
    scene.show()

Units are arbitrary scene units; y points up. Angles are in radians
(``scene.deg(90)`` converts degrees). Every ``add_*`` returns an object you can
change later: ``box.position = (1, 0, 0)``, ``box.rotate(0, 0.1, 0)``,
``box.color = "red"``, ``box.remove()``.

If you add no lights, a soft default light set is used so objects are visible.
The camera can be orbited (one finger), zoomed (pinch) and panned (two
fingers) in the Graphics panel; ``set_controls(orbit=False)`` turns that off so
touches only go to your program.

Animation and input work like zinia_draw::

    def update(dt):                 # dt: seconds since the previous frame
        box.rotate(0, dt, 0)
    scene.set_update(update)
    scene.on_tap(lambda e: print(e.object, e.point))   # e.object: tapped object or None
    scene.run_animation()
"""

from __future__ import annotations

import math

from zinia import graphics as _g

__all__ = [
    "create_scene", "set_background", "add_box", "add_sphere", "add_plane", "add_cylinder", "add_light",
    "set_camera", "set_controls", "show", "objects", "deg", "set_update", "run_animation", "stop_animation",
    "on_pointer", "on_tap", "on_key", "frame_rate", "Object3D", "Light",
]

_MAX_OBJECTS = 5_000
_surface = _g.Surface("3d")


class _State:
    created = False
    next_id = 1
    objects: dict = {}
    pending_sets: dict = {}   # object id -> its "set" command in the current batch
    pointer_handler = None
    tap_handler = None
    key_handler = None


def deg(degrees) -> float:
    """Convert degrees to radians."""
    return math.radians(_g.number(degrees, "degrees"))


def _emit(command: dict) -> None:
    _surface.add(command)


def _queue_set(obj_id: int, key: str, value) -> None:
    # Several changes to one object within a frame become one "set" command.
    command = _State.pending_sets.get(obj_id)
    if command is None:
        command = {"op": "set", "id": obj_id}
        _State.pending_sets[obj_id] = command
        _emit(command)
    command[key] = value


class _Base:
    _kind = "object"

    def __init__(self, obj_id: int):
        self.id = obj_id
        self._removed = False

    def _check(self):
        if self._removed:
            raise RuntimeError(f"This {self._kind} was removed from the scene")
        _ensure_scene()

    def remove(self) -> None:
        """Remove from the scene and free its GPU resources."""
        if self._removed:
            return
        self._check()
        self._removed = True
        _State.objects.pop(self.id, None)
        _State.pending_sets.pop(self.id, None)
        _emit({"op": "remove", "id": self.id})


class Object3D(_Base):
    """A mesh in the scene (box, sphere, plane or cylinder)."""

    def __init__(self, obj_id, kind, position, rotation, scale, color):
        super().__init__(obj_id)
        self._kind = kind
        self._position = position
        self._rotation = rotation
        self._scale = scale
        self._color = color
        self._visible = True

    def __repr__(self):
        return f"<{self._kind} #{self.id} at {tuple(self._position)}>"

    @property
    def kind(self) -> str:
        return self._kind

    @property
    def position(self):
        return tuple(self._position)

    @position.setter
    def position(self, value):
        self._check()
        self._position = _g.vector(value, "position")
        _queue_set(self.id, "position", self._position)

    @property
    def rotation(self):
        return tuple(self._rotation)

    @rotation.setter
    def rotation(self, value):
        self._check()
        self._rotation = _g.vector(value, "rotation")
        _queue_set(self.id, "rotation", self._rotation)

    @property
    def scale(self):
        return tuple(self._scale)

    @scale.setter
    def scale(self, value):
        self._check()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = (value, value, value)
        self._scale = _g.vector(value, "scale")
        _queue_set(self.id, "scale", self._scale)

    @property
    def color(self):
        return self._color

    @color.setter
    def color(self, value):
        self._check()
        self._color = _g.color(value)
        _queue_set(self.id, "color", self._color)

    @property
    def visible(self) -> bool:
        return self._visible

    @visible.setter
    def visible(self, value):
        self._check()
        self._visible = bool(value)
        _queue_set(self.id, "visible", self._visible)

    def move(self, dx=0, dy=0, dz=0) -> None:
        """Move by (dx, dy, dz)."""
        x, y, z = self._position
        self.position = (x + _g.number(dx, "dx"), y + _g.number(dy, "dy"), z + _g.number(dz, "dz"))

    def rotate(self, dx=0, dy=0, dz=0) -> None:
        """Rotate by angles in radians around the x, y and z axes."""
        x, y, z = self._rotation
        self.rotation = (x + _g.number(dx, "dx"), y + _g.number(dy, "dy"), z + _g.number(dz, "dz"))


class Light(_Base):
    """A light: change intensity, color or (for directional/point) position."""

    _kind = "light"

    def __init__(self, obj_id, kind, intensity, color, position):
        super().__init__(obj_id)
        self.light_kind = kind
        self._intensity = intensity
        self._color = color
        self._position = position

    def __repr__(self):
        return f"<{self.light_kind} light #{self.id}>"

    @property
    def intensity(self) -> float:
        return self._intensity

    @intensity.setter
    def intensity(self, value):
        self._check()
        self._intensity = _g.non_negative(value, "intensity")
        _queue_set(self.id, "intensity", self._intensity)

    @property
    def color(self):
        return self._color

    @color.setter
    def color(self, value):
        self._check()
        self._color = _g.color(value)
        _queue_set(self.id, "color", self._color)

    @property
    def position(self):
        return tuple(self._position)

    @position.setter
    def position(self, value):
        self._check()
        self._position = _g.vector(value, "position")
        _queue_set(self.id, "position", self._position)


def _dispatch(event: dict) -> None:
    kind = event.get("type")
    if kind == "tap" and _State.tap_handler is not None:
        obj = _State.objects.get(event.get("object"))
        point = event.get("point")
        _State.tap_handler(_g.make_event({**event, "object": obj, "point": tuple(point) if point else None}))
    elif kind in ("down", "move", "up") and _State.pointer_handler is not None:
        _State.pointer_handler(_g.make_event(event))
    elif kind in ("keydown", "keyup") and _State.key_handler is not None:
        _State.key_handler(_g.make_event({**event, "type": kind[3:]}))


def _wants_input() -> bool:
    return any(h is not None for h in (_State.tap_handler, _State.pointer_handler, _State.key_handler))


_animation = _g.Animation(_surface, _dispatch, _wants_input)


def _reset() -> None:
    _surface.discard()
    _animation.reset()
    _State.created = False
    _State.next_id = 1
    _State.objects = {}
    _State.pending_sets = {}
    _State.pointer_handler = None
    _State.tap_handler = None
    _State.key_handler = None


_surface.on_batch_end = lambda: _State.pending_sets.clear()
_g.register(_reset, lambda: _surface.flush())


def _ensure_scene() -> None:
    if not _State.created:
        create_scene()


def _new_id() -> int:
    if len(_State.objects) >= _MAX_OBJECTS:
        raise RuntimeError(f"A scene can hold at most {_MAX_OBJECTS:,} objects. Remove objects you no longer need.")
    obj_id = _State.next_id
    _State.next_id += 1
    return obj_id


# ---------------------------------------------------------------------------
# scene
# ---------------------------------------------------------------------------

def create_scene() -> None:
    """Start a new, empty scene. Objects of a previous scene are released."""
    for obj in list(_State.objects.values()):
        obj._removed = True
    _State.objects = {}
    _State.pending_sets = {}
    _State.next_id = 1
    _State.created = True
    _surface.discard()
    _emit({"op": "reset"})


def set_background(color) -> None:
    _ensure_scene()
    _emit({"op": "background", "color": _g.color(color)})


def _material(color, wireframe, metalness, roughness, opacity):
    metalness = _g.number(metalness, "metalness")
    roughness = _g.number(roughness, "roughness")
    opacity = _g.number(opacity, "opacity")
    for name, value in (("metalness", metalness), ("roughness", roughness), ("opacity", opacity)):
        if not 0 <= value <= 1:
            raise ValueError(f"{name} must be between 0 and 1")
    return {"color": _g.color(color), "wireframe": bool(wireframe), "metalness": metalness,
            "roughness": roughness, "opacity": opacity}


def _add(kind, params, x, y, z, rotation, scale, color, wireframe, metalness, roughness, opacity) -> Object3D:
    _ensure_scene()
    material = _material(color, wireframe, metalness, roughness, opacity)
    position = [_g.number(x, "x"), _g.number(y, "y"), _g.number(z, "z")]
    rot = _g.vector(rotation, "rotation")
    if isinstance(scale, (int, float)) and not isinstance(scale, bool):
        scale = (scale, scale, scale)
    scl = _g.vector(scale, "scale")
    obj = Object3D(_new_id(), kind, position, rot, scl, material["color"])
    _State.objects[obj.id] = obj
    _emit({"op": "add", "id": obj.id, "kind": kind, "params": params, "position": position,
           "rotation": rot, "scale": scl, "material": material})
    return obj


def add_box(x=0, y=0, z=0, width=1, height=1, depth=1, color="#cccccc", rotation=(0, 0, 0), scale=1,
            wireframe=False, metalness=0.1, roughness=0.6, opacity=1.0) -> Object3D:
    """Add a box centred at (x, y, z)."""
    params = {"width": _g.positive(width, "width"), "height": _g.positive(height, "height"),
              "depth": _g.positive(depth, "depth")}
    return _add("box", params, x, y, z, rotation, scale, color, wireframe, metalness, roughness, opacity)


def add_sphere(x=0, y=0, z=0, radius=1, color="#cccccc", segments=32, rotation=(0, 0, 0), scale=1,
               wireframe=False, metalness=0.1, roughness=0.6, opacity=1.0) -> Object3D:
    """Add a sphere centred at (x, y, z)."""
    seg = int(_g.number(segments, "segments"))
    if not 3 <= seg <= 128:
        raise ValueError("segments must be between 3 and 128")
    params = {"radius": _g.positive(radius, "radius"), "segments": seg}
    return _add("sphere", params, x, y, z, rotation, scale, color, wireframe, metalness, roughness, opacity)


def add_plane(x=0, y=0, z=0, width=10, height=10, color="#556070", rotation=None, scale=1,
              wireframe=False, metalness=0.0, roughness=0.9, opacity=1.0) -> Object3D:
    """Add a flat rectangle. By default it lies horizontally (a floor)."""
    params = {"width": _g.positive(width, "width"), "height": _g.positive(height, "height")}
    if rotation is None:
        rotation = (-math.pi / 2, 0, 0)
    return _add("plane", params, x, y, z, rotation, scale, color, wireframe, metalness, roughness, opacity)


def add_cylinder(x=0, y=0, z=0, radius_top=0.5, radius_bottom=0.5, height=1, color="#cccccc", segments=32,
                 rotation=(0, 0, 0), scale=1, wireframe=False, metalness=0.1, roughness=0.6,
                 opacity=1.0) -> Object3D:
    """Add a cylinder (or cone, with radius_top=0) centred at (x, y, z)."""
    seg = int(_g.number(segments, "segments"))
    if not 3 <= seg <= 128:
        raise ValueError("segments must be between 3 and 128")
    params = {"radiusTop": _g.non_negative(radius_top, "radius_top"),
              "radiusBottom": _g.non_negative(radius_bottom, "radius_bottom"),
              "height": _g.positive(height, "height"), "segments": seg}
    if params["radiusTop"] == 0 and params["radiusBottom"] == 0:
        raise ValueError("radius_top and radius_bottom cannot both be 0")
    return _add("cylinder", params, x, y, z, rotation, scale, color, wireframe, metalness, roughness, opacity)


_LIGHT_KINDS = ("ambient", "directional", "point")


def add_light(kind="ambient", intensity=1.0, color="white", position=(5, 10, 7)) -> Light:
    """Add an "ambient", "directional" or "point" light."""
    _ensure_scene()
    if kind not in _LIGHT_KINDS:
        raise ValueError(f"kind must be one of {', '.join(_LIGHT_KINDS)}")
    light = Light(_new_id(), kind, _g.non_negative(intensity, "intensity"), _g.color(color),
                  _g.vector(position, "position"))
    _State.objects[light.id] = light
    _emit({"op": "light", "id": light.id, "kind": kind, "intensity": light._intensity,
           "color": light._color, "position": light._position})
    return light


def set_camera(position=(6, 5, 8), target=(0, 0, 0), fov=50) -> None:
    """Place the perspective camera. 'Reset camera' in the panel returns here."""
    _ensure_scene()
    fov = _g.number(fov, "fov")
    if not 10 <= fov <= 120:
        raise ValueError("fov must be between 10 and 120 degrees")
    _emit({"op": "camera", "position": _g.vector(position, "position"), "target": _g.vector(target, "target"),
           "fov": fov})


def set_controls(orbit=True) -> None:
    """Turn touch camera controls (orbit, pinch-zoom, pan) on or off."""
    _ensure_scene()
    _emit({"op": "controls", "orbit": bool(orbit)})


def objects() -> list:
    """All objects and lights currently in the scene."""
    return list(_State.objects.values())


def show() -> None:
    """Send the scene to the Graphics panel."""
    _ensure_scene()
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
    _ensure_scene()
    _animation.run(fps=fps, duration=duration)


def stop_animation() -> None:
    _animation.stop()


def on_tap(function) -> None:
    """Register on_tap(event): event.object is the tapped object (or None), event.point its (x, y, z)."""
    if function is not None and not callable(function):
        raise TypeError("on_tap() needs a function that takes one argument: event")
    _State.tap_handler = function


def on_pointer(function) -> None:
    """Register on_pointer(event): type "down"/"move"/"up"; x and y from -1 to 1 (screen, y up)."""
    if function is not None and not callable(function):
        raise TypeError("on_pointer() needs a function that takes one argument: event")
    _State.pointer_handler = function


def on_key(function) -> None:
    """Register on_key(event) for hardware keyboard input; event.type "down"/"up", event.key."""
    if function is not None and not callable(function):
        raise TypeError("on_key() needs a function that takes one argument: event")
    _State.key_handler = function


def frame_rate() -> float:
    """Frames per second actually achieved by the running animation."""
    return round(_animation.measured_fps, 1)
