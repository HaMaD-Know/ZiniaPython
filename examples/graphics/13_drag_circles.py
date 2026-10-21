"""Drag the circles with your finger (or Apple Pencil, or the mouse).

Each finger picks up the top-most circle under it, so with several fingers
you can move several circles at once. Lifting the finger drops the circle.
Touching empty space does nothing; a quick tap on a circle brings it to the
front. The program keeps listening for touches until you press Stop.
"""
import zinia_draw as gfx

WIDTH, HEIGHT = 800, 600
gfx.create_canvas(WIDTH, HEIGHT)
gfx.set_background("#101525")

objects = [
    {"x": 200, "y": 200, "radius": 60, "color": "#00ffff"},
    {"x": 400, "y": 320, "radius": 60, "color": "#ff5c8a"},
    {"x": 600, "y": 220, "radius": 60, "color": "#ffd166"},
]
dragging = {}  # finger id -> (circle, offset_x, offset_y)


def hit(x, y):
    """The top-most circle under (x, y), or None."""
    for obj in reversed(objects):  # drawn last = on top
        if (x - obj["x"]) ** 2 + (y - obj["y"]) ** 2 <= obj["radius"] ** 2:
            return obj
    return None


def draw():
    gfx.clear()
    for obj in objects:
        held = any(obj is d[0] for d in dragging.values())
        gfx.circle(obj["x"], obj["y"], obj["radius"], color=obj["color"],
                   outline="white" if held else None, line_width=4)
    gfx.text(20, 20, "Drag the circles. Press Stop to finish.", color="#8b95b1", size=18)


def on_touch(event):
    if event.type == "start":
        obj = hit(event.x, event.y)
        if obj is not None and all(obj is not d[0] for d in dragging.values()):
            dragging[event.id] = (obj, event.x - obj["x"], event.y - obj["y"])
            objects.remove(obj)
            objects.append(obj)  # bring to the front
    elif event.type == "move" and event.id in dragging:
        obj, ox, oy = dragging[event.id]
        r = obj["radius"]
        obj["x"] = min(max(event.x - ox, r), WIDTH - r)  # keep it on the canvas
        obj["y"] = min(max(event.y - oy, r), HEIGHT - r)
    elif event.type == "end":
        dragging.pop(event.id, None)
    else:
        return  # taps need no redraw
    draw()


draw()
gfx.on_touch(on_touch)
print("Drag the circles in the Graphics preview. Press Stop when you are done.")
