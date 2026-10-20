"""Several objects spinning and orbiting a central sun."""
import math

import zinia_3d as scene

scene.create_scene()
scene.set_background("#05070f")
sun = scene.add_sphere(radius=1.2, color="#ffcc33", metalness=0.0, roughness=1.0)
scene.add_light("ambient", intensity=0.25)
scene.add_light("point", intensity=2.2, color="#fff3d6", position=(0, 0, 0))

planets = []
for i, (colour, kind) in enumerate([("#4cc9f0", "sphere"), ("#ff5c8a", "box"), ("#06d6a0", "cylinder"),
                                    ("#9b5de5", "sphere"), ("#ffd166", "box")]):
    distance = 2.6 + i * 1.3
    if kind == "sphere":
        obj = scene.add_sphere(radius=0.45, color=colour)
    elif kind == "box":
        obj = scene.add_box(width=0.7, height=0.7, depth=0.7, color=colour)
    else:
        obj = scene.add_cylinder(radius_top=0.0, radius_bottom=0.45, height=0.9, color=colour)
    planets.append({"obj": obj, "distance": distance, "speed": 1.4 / (1 + i * 0.5), "angle": i * 1.2})

scene.add_plane(y=-1.6, width=24, height=24, color="#111a33", wireframe=True)
scene.set_camera(position=(0, 7, 13), target=(0, 0, 0))

def update(dt):
    sun.rotate(0, dt * 0.3, 0)
    for p in planets:
        p["angle"] += p["speed"] * dt
        p["obj"].position = (math.cos(p["angle"]) * p["distance"], 0, math.sin(p["angle"]) * p["distance"])
        p["obj"].rotate(dt, dt * 1.5, 0)

scene.set_update(update)
scene.run_animation()
