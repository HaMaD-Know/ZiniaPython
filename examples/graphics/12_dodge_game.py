"""Dodge: a small 3D game.

Steer the ship left and right to dodge the incoming blocks. Touch the left or
right half of the preview (or use the arrow keys) to steer. The camera is
fixed for this game, so touches only steer.
"""
import random

import zinia_3d as scene

LANE_WIDTH = 6.0
scene.create_scene()
scene.set_background("#070b18")
scene.set_controls(orbit=False)
scene.add_light("ambient", intensity=0.5)
scene.add_light("directional", intensity=1.2, position=(3, 10, 6))
scene.add_plane(y=-0.5, width=LANE_WIDTH * 2 + 2, height=80, z=-30, color="#141d3a")
ship = scene.add_cylinder(radius_top=0, radius_bottom=0.5, height=1.2, color="#4cc9f0", rotation=(-1.5708, 0, 0))
scene.set_camera(position=(0, 3.5, 7), target=(0, 0, -6), fov=55)

state = {"x": 0.0, "steer": 0, "touch": 0, "time": 0.0, "spawn": 0.0, "over": False, "best": 0.0}
blocks = []
keys = set()

def on_pointer(event):
    if event.type == "down" and state["over"]:
        restart()
    if event.type in ("down", "move"):
        state["touch"] = -1 if event.x < 0 else 1
    elif event.type == "up":
        state["touch"] = 0

def on_key(event):
    (keys.add if event.type == "down" else keys.discard)(event.key)

def restart():
    for block in blocks:
        block.remove()
    blocks.clear()
    ship.color = "#4cc9f0"
    state.update(x=0.0, time=0.0, spawn=0.0, over=False)
    print("New game")

def update(dt):
    if state["over"]:
        return
    steer = state["touch"] or (("ArrowRight" in keys) - ("ArrowLeft" in keys))
    state["x"] = max(-LANE_WIDTH, min(LANE_WIDTH, state["x"] + steer * 9 * dt))
    ship.position = (state["x"], 0, 0)
    ship.rotation = (-1.5708, 0, -steer * 0.35)
    state["time"] += dt
    speed = 14 + state["time"] * 0.6
    state["spawn"] -= dt
    if state["spawn"] <= 0:
        state["spawn"] = max(0.18, 0.6 - state["time"] * 0.01)
        colour = random.choice(["#ff5c8a", "#ffd166", "#9b5de5"])
        blocks.append(scene.add_box(x=random.uniform(-LANE_WIDTH, LANE_WIDTH), y=0, z=-60,
                                    width=1.2, height=1.2, depth=1.2, color=colour))
    for block in blocks[:]:
        x, y, z = block.position
        z += speed * dt
        if z > 8:
            block.remove()
            blocks.remove(block)
            continue
        block.position = (x, y, z)
        if abs(z) < 0.9 and abs(x - state["x"]) < 0.95:
            state["over"] = True
            state["best"] = max(state["best"], state["time"])
            ship.color = "#ff4d6d"
            print(f"Crashed after {state['time']:.1f} s (best {state['best']:.1f} s). Tap to play again.")

scene.on_pointer(on_pointer)
scene.on_key(on_key)
scene.set_update(update)
scene.run_animation()
