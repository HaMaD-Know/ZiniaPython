"""Particle fountain. Tap or drag on the canvas to make bursts."""
import math
import random

import zinia_draw as gfx

WIDTH, HEIGHT = 800, 600
GRAVITY = 380
gfx.create_canvas(WIDTH, HEIGHT)
gfx.set_background("#0a0d1a")

particles = []  # [x, y, vx, vy, life, hue]

def burst(x, y, count=40):
    hue = random.randint(0, 360)
    for _ in range(count):
        angle = random.uniform(0, 2 * math.pi)
        speed = random.uniform(60, 320)
        particles.append([x, y, math.cos(angle) * speed, math.sin(angle) * speed - 120,
                          random.uniform(0.8, 1.8), hue + random.randint(-20, 20)])

def on_pointer(event):
    if event.type in ("down", "move"):
        burst(event.x, event.y, 40 if event.type == "down" else 6)

def update(dt):
    # the fountain
    burst(WIDTH / 2, HEIGHT - 30, 3)
    gfx.clear()
    alive = []
    for p in particles:
        p[4] -= dt
        if p[4] <= 0:
            continue
        p[3] += GRAVITY * dt
        p[0] += p[2] * dt
        p[1] += p[3] * dt
        if p[1] > HEIGHT - 6:  # bounce on the floor
            p[1], p[3] = HEIGHT - 6, -p[3] * 0.45
        alive.append(p)
        gfx.circle(p[0], p[1], 2 + p[4] * 2, color=f"hsl({p[5] % 360}, 90%, {40 + int(p[4] * 25)}%)")
    particles[:] = alive[-1500:]
    gfx.text(12, 12, f"{len(particles)} particles - tap to add more", color="#8b95b1", size=14)

gfx.on_pointer(on_pointer)
gfx.set_update(update)
gfx.run_animation(fps=60)
