"""An animated 3D-looking starfield. Touch and hold to warp faster. Press Stop to end."""
import random

import zinia_draw as gfx

WIDTH, HEIGHT = 800, 600
gfx.create_canvas(WIDTH, HEIGHT)
gfx.set_background("black")

stars = [[random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(0.05, 1)] for _ in range(260)]
speed = 0.35

def update(dt):
    x_ptr, y_ptr, pressed = gfx.pointer()
    warp = speed * (4 if pressed else 1)
    gfx.clear()
    for star in stars:
        star[2] -= warp * dt
        if star[2] <= 0.02:
            star[0], star[1], star[2] = random.uniform(-1, 1), random.uniform(-1, 1), 1.0
        sx = WIDTH / 2 + star[0] / star[2] * WIDTH / 2
        sy = HEIGHT / 2 + star[1] / star[2] * HEIGHT / 2
        size = max(0.5, (1 - star[2]) * 3.5)
        bright = int(255 * (1 - star[2]))
        gfx.circle(sx, sy, size, color=(bright, bright, 255))
    gfx.text(12, 12, f"{gfx.frame_rate():.0f} frames/s", color="#8b95b1", size=14)

gfx.set_update(update)
gfx.run_animation(fps=60)
