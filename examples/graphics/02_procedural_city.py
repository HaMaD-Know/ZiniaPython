"""A procedural city skyline at night. Change SEED for a different city."""
import random

import zinia_draw as gfx

SEED = 7
WIDTH, HEIGHT = 900, 600
random.seed(SEED)

gfx.create_canvas(WIDTH, HEIGHT)
gfx.set_background("#0b1026")

# Sky gradient made of thin bands
for i in range(40):
    shade = 16 + i * 2
    gfx.rectangle(0, i * 10, WIDTH, 10, color=(shade // 2, shade // 2, shade + 20))

# Stars and the moon
for _ in range(120):
    gfx.circle(random.uniform(0, WIDTH), random.uniform(0, 330), random.uniform(0.5, 1.6), color="white")
gfx.circle(760, 90, 42, color="#f6f1d5")
gfx.circle(745, 80, 42, color=(30, 30, 62))  # a crescent

def building(x, width, height, base_colour):
    top = HEIGHT - 40 - height
    gfx.rectangle(x, top, width, height, color=base_colour)
    # windows
    for wy in range(int(top) + 10, HEIGHT - 50, 18):
        for wx in range(int(x) + 6, int(x + width) - 10, 14):
            if random.random() < 0.45:
                gfx.rectangle(wx, wy, 7, 10, color=random.choice(["#ffd27a", "#ffe9a8", "#9fd3ff"]))
    if random.random() < 0.3:  # antenna
        gfx.line(x + width / 2, top, x + width / 2, top - 30, color="#8b95b1", width=2)
        gfx.circle(x + width / 2, top - 30, 3, color="red")

# Two layers: far (dark) then near (lighter)
for layer, colour, max_h in ((0, "#1b2140", 330), (1, "#252d55", 260)):
    x = -20
    while x < WIDTH:
        width = random.randint(45, 110)
        building(x, width, random.randint(80, max_h), colour)
        x += width + random.randint(2, 12)

gfx.rectangle(0, HEIGHT - 40, WIDTH, 40, color="#11152b")
gfx.text(16, HEIGHT - 30, f"Procedural city (seed {SEED})", color="#8b95b1", size=16)
gfx.show()
