"""2D shapes and colours: every zinia_draw drawing function once."""
import zinia_draw as gfx

gfx.create_canvas(800, 600)
gfx.set_background("#101525")

gfx.text(30, 24, "Shapes and colours", color="white", size=30, bold=True)

# Filled shapes
gfx.rectangle(40, 90, 160, 110, color="#ff5c8a")
gfx.rectangle(230, 90, 160, 110, color="#4cc9f0", corner_radius=18)
gfx.circle(500, 145, 58, color="#ffd166")
gfx.ellipse(680, 145, 80, 45, color="#06d6a0", rotation=0.4)

# Outlines only
gfx.rectangle(40, 240, 160, 110, color="#ff5c8a", fill=False, line_width=4)
gfx.circle(310, 295, 55, color="#4cc9f0", fill=False, line_width=6)
gfx.polygon([(440, 350), (500, 240), (560, 350)], color="#ffd166", fill=False, line_width=4)
gfx.ellipse(680, 295, 80, 45, color="#06d6a0", fill=False, line_width=3)

# Fill plus a different outline colour
gfx.polygon([(70, 520), (120, 400), (170, 520), (120, 480)], color="#9b5de5", outline="white", line_width=3)
gfx.circle(300, 460, 50, color="hsl(30, 90%, 60%)", outline="rgb(255,255,255)", line_width=3)

# Lines and a polyline
for i in range(10):
    gfx.line(400 + i * 12, 400, 400 + i * 12, 520, color=(25 * i, 120, 255 - 20 * i), width=1 + i * 0.6)
gfx.polyline([(560, 520), (600, 420), (640, 500), (680, 410), (720, 480), (760, 400)], color="orange", width=5)

gfx.text(400, 575, "Colours: names, #hex, rgb(), hsl() or (r, g, b) tuples", color="#8b95b1", size=16,
         align="center", baseline="bottom")
gfx.show()
print("Drew the shapes. Canvas size:", gfx.size())
