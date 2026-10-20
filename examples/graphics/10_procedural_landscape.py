"""A procedural landscape of blocks: water, sand, grass, rock and snow.

The height map is made from a few sine waves plus random noise; change SEED
or SIZE to get a different island. Drag to look around.
"""
import math
import random

import zinia_3d as scene

SEED = 3
SIZE = 22          # blocks per side (SIZE * SIZE blocks in total)
random.seed(SEED)

scene.create_scene()
scene.set_background("#9fc9ff")
scene.add_light("ambient", intensity=0.55)
scene.add_light("directional", intensity=1.1, position=(10, 20, 8))

phase = [random.uniform(0, 6.3) for _ in range(4)]

def height(x, z):
    nx, nz = x / SIZE - 0.5, z / SIZE - 0.5
    h = (math.sin(nx * 6 + phase[0]) + math.cos(nz * 5 + phase[1])) * 0.9
    h += math.sin((nx + nz) * 11 + phase[2]) * 0.35 + random.uniform(-0.15, 0.15)
    falloff = 1 - min(1, math.hypot(nx, nz) * 1.9)   # lower near the edges: an island
    return max(0.0, (h + 1.6) * falloff * 2.2)

def colour_for(h):
    if h < 0.5:
        return "#3a7bd5"   # water
    if h < 0.9:
        return "#e8d39a"   # sand
    if h < 2.6:
        return "#4caf50"   # grass
    if h < 3.6:
        return "#8d8d8d"   # rock
    return "#f4f7fb"       # snow

count = 0
for gx in range(SIZE):
    for gz in range(SIZE):
        h = max(0.3, height(gx, gz))
        x, z = gx - SIZE / 2, gz - SIZE / 2
        scene.add_box(x=x, y=h / 2, z=z, width=1, height=h, depth=1, color=colour_for(h), roughness=0.9)
        count += 1

scene.set_camera(position=(SIZE * 0.9, SIZE * 0.75, SIZE * 0.9), target=(0, 1, 0), fov=45)
scene.show()
print(f"Built {count} blocks (seed {SEED}).")
