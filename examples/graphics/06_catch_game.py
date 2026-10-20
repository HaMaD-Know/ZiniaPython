"""Catch the stars: a small 2D game.

Drag anywhere (or use the arrow keys on a keyboard) to move the basket.
Catch yellow stars, avoid red bombs. Three misses or one bomb ends the game.
"""
import random

import zinia_draw as gfx

WIDTH, HEIGHT = 800, 600
gfx.create_canvas(WIDTH, HEIGHT)
gfx.set_background("#0f1430")

game = {"x": WIDTH / 2, "score": 0, "misses": 0, "over": False, "spawn": 0.0, "keys": set()}
items = []  # [x, y, speed, is_bomb]

def on_pointer(event):
    if event.type in ("down", "move") and (event.type == "down" or event.buttons):
        game["x"] = event.x
    if event.type == "down" and game["over"]:
        restart()

def on_key(event):
    if event.type == "down":
        game["keys"].add(event.key)
    else:
        game["keys"].discard(event.key)

def restart():
    items.clear()
    game.update(score=0, misses=0, over=False, spawn=0.0)

def update(dt):
    if not game["over"]:
        if "ArrowLeft" in game["keys"]:
            game["x"] -= 480 * dt
        if "ArrowRight" in game["keys"]:
            game["x"] += 480 * dt
        game["x"] = max(50, min(WIDTH - 50, game["x"]))
        game["spawn"] -= dt
        if game["spawn"] <= 0:
            game["spawn"] = max(0.25, 0.9 - game["score"] * 0.02)
            items.append([random.uniform(30, WIDTH - 30), -20, random.uniform(160, 260) + game["score"] * 4,
                          random.random() < 0.2])
        for item in items[:]:
            item[1] += item[2] * dt
            caught = HEIGHT - 70 < item[1] < HEIGHT - 30 and abs(item[0] - game["x"]) < 55
            if caught:
                items.remove(item)
                if item[3]:
                    game["over"] = True
                else:
                    game["score"] += 1
            elif item[1] > HEIGHT + 20:
                items.remove(item)
                if not item[3]:
                    game["misses"] += 1
                    if game["misses"] >= 3:
                        game["over"] = True

    gfx.clear()
    for x, y, _, bomb in items:
        if bomb:
            gfx.circle(x, y, 16, color="#ff4d6d")
            gfx.line(x, y - 16, x + 6, y - 26, color="#ffd166", width=3)
        else:
            gfx.polygon([(x, y - 18), (x + 6, y - 6), (x + 18, y - 5), (x + 9, y + 4), (x + 12, y + 17),
                         (x, y + 10), (x - 12, y + 17), (x - 9, y + 4), (x - 18, y - 5), (x - 6, y - 6)],
                        color="#ffd166")
    gfx.rectangle(game["x"] - 50, HEIGHT - 50, 100, 22, color="#4cc9f0", corner_radius=8)
    gfx.text(16, 14, f"Score {game['score']}", color="white", size=22, bold=True)
    gfx.text(WIDTH - 16, 14, "Misses " + "x" * game["misses"], color="#ff8fa3", size=20, align="right")
    if game["over"]:
        gfx.rectangle(WIDTH / 2 - 210, HEIGHT / 2 - 70, 420, 140, color="#1d2340", corner_radius=16,
                      outline="#4cc9f0", line_width=2)
        gfx.text(WIDTH / 2, HEIGHT / 2 - 20, "Game over", color="white", size=36, bold=True,
                 align="center", baseline="middle")
        gfx.text(WIDTH / 2, HEIGHT / 2 + 30, "Tap to play again", color="#8b95b1", size=18,
                 align="center", baseline="middle")

gfx.on_pointer(on_pointer)
gfx.on_key(on_key)
gfx.set_update(update)
gfx.run_animation(fps=60)
print("Final score:", game["score"])
