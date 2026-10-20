"""Finger painting. Draw with your finger or Apple Pencil; tap a colour to switch,
tap CLEAR to start over. Press Stop when you are done."""
import zinia_draw as gfx

WIDTH, HEIGHT = 900, 640
PALETTE = ["white", "#ff5c8a", "#ffd166", "#06d6a0", "#4cc9f0", "#9b5de5"]
SWATCH = 46

gfx.create_canvas(WIDTH, HEIGHT)
gfx.set_background("#14182b")

state = {"colour": PALETTE[0], "last": None, "dirty": True}
strokes = []  # finished segments: (x1, y1, x2, y2, colour)

def in_toolbar(y):
    return y < SWATCH + 16

def on_pointer(event):
    if event.type == "down" and in_toolbar(event.y):
        index = int((event.x - 10) // (SWATCH + 8))
        if 0 <= index < len(PALETTE):
            state["colour"] = PALETTE[index]
        elif event.x > WIDTH - 120:
            strokes.clear()
        state["last"] = None
        state["dirty"] = True
        return
    if event.type == "down":
        state["last"] = (event.x, event.y)
    elif event.type == "move" and state["last"] is not None:
        x0, y0 = state["last"]
        strokes.append((x0, y0, event.x, event.y, state["colour"]))
        state["last"] = (event.x, event.y)
        state["dirty"] = True
    elif event.type == "up":
        state["last"] = None

def draw_toolbar():
    gfx.rectangle(0, 0, WIDTH, SWATCH + 16, color="#1d2340")
    for i, colour in enumerate(PALETTE):
        x = 10 + i * (SWATCH + 8)
        gfx.rectangle(x, 8, SWATCH, SWATCH, color=colour, corner_radius=8,
                      outline="white" if colour == state["colour"] else None, line_width=3)
    gfx.rectangle(WIDTH - 110, 8, 100, SWATCH, color="#34405f", corner_radius=8)
    gfx.text(WIDTH - 60, 8 + SWATCH / 2, "CLEAR", color="white", size=16, align="center", baseline="middle", bold=True)

def update(dt):
    if not state["dirty"]:
        return  # nothing changed: do not resend the picture
    state["dirty"] = False
    gfx.clear()
    for x1, y1, x2, y2, colour in strokes:
        gfx.line(x1, y1, x2, y2, color=colour, width=6)
    draw_toolbar()

gfx.on_pointer(on_pointer)
gfx.set_update(update)
print("Draw on the canvas. Press Stop to finish.")
gfx.run_animation(fps=60)
print(f"You drew {len(strokes)} line segments.")
