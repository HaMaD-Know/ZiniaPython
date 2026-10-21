# Graphics: zinia_draw (2D) and zinia_3d (3D)

ZiniaPython has two built-in modules for drawing from Python. They run in the
real embedded CPython interpreter like any other module. What they draw
appears in the **Graphics preview** panel next to the editor (or over it on a
phone).

```python
import zinia_draw as gfx

gfx.create_canvas(800, 600)
gfx.set_background("#101525")
gfx.circle(400, 300, 80, color="#00ffff")
gfx.rectangle(100, 100, 200, 120, color="#ff00aa")
gfx.line(50, 50, 750, 550, color="white", width=4)
gfx.text(40, 40, "Hello from ZiniaPython", color="white", size=28)
gfx.show()
```

```python
import zinia_3d as scene

scene.create_scene()
scene.set_background("#101525")
box = scene.add_box(x=0, y=0, z=0, width=2, height=2, depth=2, color="#00ffff")
scene.add_sphere(x=3, y=0, z=0, radius=1, color="#ff00aa")
scene.add_light("ambient", intensity=0.7)
scene.add_light("directional", intensity=1.2)
scene.set_camera(position=(6, 5, 8), target=(0, 0, 0))
scene.show()
```

Thirteen complete example programs are bundled with the app: **⋯ › Graphics
examples** copies them into a *Graphics Examples* project (see
[examples/graphics](../examples/graphics/README.md)).

## The Graphics preview

- Opens by itself the first time a run draws something; the **shapes** button
  in the top bar (or **⋯ › Show graphics preview**) opens and closes it.
  Closing it returns to the editor; nothing is lost, and the picture is still
  there when you open it again.
- **2D / 3D** switches between the two surfaces. A run that draws switches
  to the surface it uses.
- **Run** and **Stop** do the same as the top-bar buttons. **Clear** wipes the
  preview (it doesn't stop the program). **Fullscreen** fills the screen;
  the collapse button or Escape returns.
- 3D only: **zoom out / zoom in** and **Reset camera** (back to the view set by
  `set_camera`, or the default). One finger orbits, a pinch zooms, two fingers
  pan, unless the program called `set_controls(orbit=False)`.
- The status line shows the canvas size or object count, and while a program
  animates, the frame rate *measured* in the preview.
- iPad landscape and wider screens show the editor and the preview side by
  side; on narrower screens the preview covers the editor and the console
  stays visible below it.

Every Run clears both surfaces first, so a new run never draws over an old
one. REPL statements draw onto the current picture.

## zinia_draw (2D)

Coordinates are in canvas units: (0, 0) is the top-left corner, x grows to
the right and y grows downwards. The canvas is scaled to fit the panel
(keeping its shape) and drawn at the screen's pixel density, so it stays
sharp on Retina displays.

| Function | Notes |
| --- | --- |
| `create_canvas(width=800, height=600)` | Starts a new picture. Up to 4096 × 4096. Optional: the first drawing call creates an 800 × 600 canvas. |
| `size()` | `(width, height)` |
| `set_background(color)` | Background used by `clear()`; also clears. |
| `clear()` | Fills the canvas with the background colour. |
| `circle(x, y, radius, color="white", fill=True, outline=None, line_width=1)` | |
| `ellipse(x, y, radius_x, radius_y, color="white", fill=True, outline=None, line_width=1, rotation=0)` | `rotation` in radians |
| `rectangle(x, y, width, height, color="white", fill=True, outline=None, line_width=1, corner_radius=0)` | (x, y) is the top-left corner |
| `line(x1, y1, x2, y2, color="white", width=1)` | |
| `polyline(points, color="white", width=1, closed=False)` | `points`: `[(x, y), ...]` |
| `polygon(points, color="white", fill=True, outline=None, line_width=1)` | At least 3 points |
| `text(x, y, text, color="white", size=16, align="left", baseline="top", bold=False, font="sans-serif")` | `align`: left, center, right; `baseline`: top, middle, alphabetic, bottom; `font`: sans-serif, serif, monospace |
| `show()` | Sends what has been drawn so far to the preview. Also happens automatically when the program ends. |

`fill=False` draws only the outline, in `color`. With `fill=True`,
`outline="white"` adds an outline in a second colour.

**Colours** can be names (`"red"`, `"cyan"`, ...), `"#rgb"`, `"#rrggbb"`,
`"#rrggbbaa"`, `"rgb(255, 0, 0)"`, `"rgba(255, 0, 0, 0.5)"`, `"hsl(200, 80%, 50%)"`,
or tuples `(r, g, b)` / `(r, g, b, a)` with 0–255 components (alpha 0–1).

Wrong arguments raise `TypeError` or `ValueError` with a message naming the
argument, and the traceback points at your line, for example
`ValueError: radius must be 0 or more, not -5`.

### Animation and input (2D)

```python
def update(dt):          # dt: seconds since the previous frame (float)
    gfx.clear()
    ...draw the frame...

def on_pointer(event):   # event.type: "down", "move" or "up"
    print(event.x, event.y, event.id)   # canvas coordinates; id tells fingers apart

def on_key(event):       # event.type: "down" or "up"; event.key: "ArrowLeft", "a", " ", ...
    ...

gfx.on_pointer(on_pointer)
gfx.on_key(on_key)
gfx.set_update(update)
gfx.run_animation(fps=60)   # runs until Stop, stop_animation() or `duration` seconds
```

| Function | Notes |
| --- | --- |
| `set_update(function)` | `function(dt)` is called once per frame. |
| `run_animation(fps=60, duration=None)` | Calls `update` repeatedly and sends each frame. Blocks until Stop is pressed, `stop_animation()` is called (for example from `update` or an event handler), or `duration` seconds pass. `fps` is the most frames per second to aim for (1–120). |
| `stop_animation()` | Ends `run_animation()` (after the current frame) or `listen()`; the program continues after it. |
| `on_touch(function)` | Finger, pencil and mouse events: `start`, `move`, `end`, `tap`. See *Touch* below. |
| `listen()` | Deliver touch and key events until Stop or `stop_animation()`, without an animation loop. |
| `on_pointer(function)` | Lower-level variant of `on_touch`: `down`, `move` (also mouse hover) and `up`, with `x`, `y`, `id`, `buttons`. |
| `on_key(function)` | Hardware keyboard keys while the preview has focus (tap it first). |
| `pointer()` | `(x, y, is_down)` of the most recent pointer event. |
| `frame_rate()` | Frames per second actually achieved so far. |

### Touch: dragging what you draw

```python
import zinia_draw as gfx

gfx.create_canvas(800, 600)
gfx.set_background("#101525")

objects = [
    {"x": 200, "y": 200, "radius": 45},
    {"x": 400, "y": 300, "radius": 45},
]
held = {}   # finger id -> the circle it holds

def draw():
    gfx.clear()
    for obj in objects:
        gfx.circle(obj["x"], obj["y"], obj["radius"], color="#00ffff")

def on_touch(event):
    if event.type == "start":
        for obj in objects:
            if (event.x - obj["x"]) ** 2 + (event.y - obj["y"]) ** 2 <= obj["radius"] ** 2:
                held[event.id] = obj
                break
    elif event.type == "move" and event.id in held:
        held[event.id]["x"] += event.dx
        held[event.id]["y"] += event.dy
        draw()
    elif event.type == "end":
        held.pop(event.id, None)

draw()
gfx.on_touch(on_touch)
# The script ends here, but because a touch handler is set the program keeps
# running and receiving touches until you press Stop.
```

`on_touch(function)` registers `function(event)` for fingers, Apple Pencil
and the mouse on the 2D canvas. Calling it again replaces the function (it
never adds a second listener); `on_touch(None)` removes it.

| `event.type` | When |
| --- | --- |
| `"start"` | A finger touches the canvas. |
| `"move"` | That finger moves (only while it is down). |
| `"end"` | That finger lifts, or iOS cancels the touch (`event.cancelled` is then `True`). Always follows a `"start"`. |
| `"tap"` | After the `"end"` of a touch shorter than half a second that moved less than 8 points. |

| Field | Meaning |
| --- | --- |
| `event.x`, `event.y` | Position in **canvas coordinates**, the same units as `circle()` and `rectangle()`. The preview's fit-to-panel scaling is undone, and the screen's pixel density does not matter. A finger dragged off the canvas keeps reporting (values can go below 0 or past the canvas size). |
| `event.id` | Which finger. Each finger has its own start/move/end sequence. |
| `event.dx`, `event.dy` | Movement since this finger's previous event (0 on `"start"`). |
| `event.start_x`, `event.start_y` | Where this finger first touched. |
| `event.touches` | How many fingers are on the canvas now (an ending finger no longer counts). |
| `event.cancelled` | `True` only on an `"end"` caused by a cancelled touch. |
| `event.pointer_type` | `"touch"`, `"pen"` or `"mouse"`. |

**When events arrive.** Events are delivered between frames, on Python's
own thread, so handlers can change the same variables as the rest of the
program without locks. Whatever a handler draws is sent to the preview
right after it returns.

- During `run_animation()`, every frame.
- With `listen()`, which waits for touches and keys until Stop or
  `stop_animation()`. Use it when the picture changes only in response to
  touches.
- Automatically: a program that sets `on_touch()`, `on_pointer()` or
  `on_key()` and reaches its last line without having run `run_animation()`
  or `listen()` keeps listening until Stop, like `turtle.done()`.

Several fingers at once are supported and kept apart by `event.id`; the
example above lets each finger drag a different circle. Each new Run starts
with no handlers and no fingers down, so events never go to an earlier
program. An exception in a handler ends the program with a normal traceback
pointing at the handler's line.

`examples/graphics/13_drag_circles.py` is a complete version with three
circles, grab offsets, bring-to-front and keeping circles on the canvas.

## zinia_3d (3D)

Rendered with Three.js and WebGL. Units are arbitrary; y points up; angles are
in radians (`scene.deg(90)` converts degrees).

| Function | Returns |
| --- | --- |
| `create_scene()` | Starts a new, empty scene. Optional: the first call that adds something creates one. |
| `set_background(color)` | |
| `add_box(x=0, y=0, z=0, width=1, height=1, depth=1, color="#cccccc", ...)` | `Object3D` |
| `add_sphere(x=0, y=0, z=0, radius=1, color="#cccccc", segments=32, ...)` | `Object3D` |
| `add_plane(x=0, y=0, z=0, width=10, height=10, color="#556070", rotation=None, ...)` | `Object3D`; horizontal (a floor) unless you give a rotation |
| `add_cylinder(x=0, y=0, z=0, radius_top=0.5, radius_bottom=0.5, height=1, color="#cccccc", segments=32, ...)` | `Object3D`; `radius_top=0` makes a cone |
| `add_light(kind="ambient", intensity=1.0, color="white", position=(5, 10, 7))` | `Light`; kind is `"ambient"`, `"directional"` or `"point"` |
| `set_camera(position=(6, 5, 8), target=(0, 0, 0), fov=50)` | Places the camera; Reset camera returns here. |
| `set_controls(orbit=True)` | `False` turns off touch orbit/zoom/pan so touches only go to your program. |
| `objects()` | Everything in the scene (objects and lights). |
| `show()` | Sends pending changes to the preview (automatic at the end of the program and every animation frame). |

Every `add_*` shape also accepts `rotation=(rx, ry, rz)`, `scale=` (a number
or `(sx, sy, sz)`), and material settings `wireframe=False`, `metalness`,
`roughness` (0–1) and `opacity` (0–1; below 1 makes it see-through).

`Object3D` has properties `position`, `rotation`, `scale`, `color`,
`visible` (read and assign), and methods `move(dx, dy, dz)`,
`rotate(dx, dy, dz)` and `remove()`. `Light` has `intensity`, `color` and
`position`. Several changes to one object within a frame are sent as one.

If you add no lights, a soft default light set is used so objects are
visible. Point lights do not fade with distance (intensity around 1–3 works
well).

### Animation and input (3D)

The same as 2D: `set_update(function)`, `run_animation(fps=60, duration=None)`,
`stop_animation()`, `on_key(function)` and `frame_rate()`, plus:

| Function | Event fields |
| --- | --- |
| `on_tap(function)` | `event.object`: the `Object3D` that was tapped, or `None`; `event.point`: `(x, y, z)` where it was hit, or `None`. A tap is a touch that moves less than 8 points and lasts under half a second. |
| `on_pointer(function)` | `event.type`: down, move, up; `event.x`, `event.y`: position in the preview from -1 (left/bottom) to 1 (right/top); `event.id` |

With orbit controls on, a drag both orbits the camera and sends pointer
events; use `set_controls(orbit=False)` for games that steer with touches.

## How it works

ZiniaPython runs native CPython, not Python in the browser, so drawing goes
through a message bridge:

1. Drawing calls validate their arguments and add compact commands to a
   batch in Python.
2. `show()`, each animation frame and the end of the run send the batch as
   one JSON event (`{"executionId", "surface", "seq", "commands"}`) through
   the native ZiniaPython plugin to the web view, in order.
3. The preview applies batches only from the current run (batches from a
   stopped or previous run are dropped) and draws them: an HTML canvas for 2D
   (the commands since the last `clear()` are kept, so the picture survives
   resizing and rotation), Three.js for 3D (rendered only when something
   changed).
4. Touches, keys and a "frame drawn" acknowledgement go back with
   `postGraphicsEvents`, at most once per screen refresh, into a queue in the
   native interpreter that `run_animation()` reads between frames. Each frame
   waits for the previous one to be drawn (or 0.5 s), so a program can't flood
   the preview and the app stays responsive. Stop wakes the wait and raises
   `KeyboardInterrupt`.

Three.js (MIT) is bundled into the app and loaded the first time a program
uses 3D; nothing is downloaded at run time.

Resources: one WebGL context for the app session. A new run, `create_scene()`,
`remove()` and Clear dispose the geometries and materials they replace.

## Limitations

- **Frame rate is not guaranteed.** Each frame crosses from Python to the web
  view and back. Simple scenes usually reach the display's rate; thousands of
  shapes per frame or heavy Python code in `update` will be slower. The status
  line shows the measured rate. Redraw only what changes when you can.
- **Events need a running program.** They are delivered during
  `run_animation()` or `listen()`, or after the last line when a handler is
  set. A program stopped with Stop no longer receives them. (3D orbit and
  zoom still work after it ends.)
- **Touch latency.** Each touch crosses from the web view to Python and the
  redraw comes back, so a dragged shape trails the finger by a frame or two.
- **One program at a time.** The preview shows the current run; the REPL
  draws onto it.
- **No images, sprites, textures or 3D model files (GLB/GLTF) yet.** Shapes,
  text and materials only.
- **No shadows** in 3D.
- **WebGL is required for 3D.** If the device or web view can't create a WebGL
  context, the 3D surface says so; 2D still works.
- **Background.** iOS pauses the app in the background, and the preview stops
  drawing; an animation slows to about 2 frames per second until you return.
- `tkinter` and `turtle` are not available on iOS; these modules are the
  replacement.

## Testing

- `npm run test:python` runs `python/tests/test_graphics.py`: imports, command
  ordering, argument validation, colours, animation with simulated touches,
  reset between runs, and every bundled example executed headless on desktop
  CPython.
- `npm test` covers the 2D renderer (recording context), canvas fitting,
  execution-id filtering and event batching in the controller, and the 3D
  scene model (create, update, remove, dispose) without WebGL.
- The in-app self-test includes a graphics case on the iOS runtime.
- Drawing on screen, touch and WebGL were checked in a desktop browser through
  the development bridge; see [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md)
  for what has and hasn't been run on an iPhone or iPad.
