"""Renders the ZiniaPython app icon and launch image (requires numpy).

    python scripts/generate-app-icons.py

Writes ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
(1024x1024, opaque as Apple requires) and the three Splash.imageset images
(2732x2732). The artwork matches public/icons/icon.svg.
"""

import os
import struct
import zlib

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "ios", "App", "App", "Assets.xcassets")

INK = np.array([0x0E, 0x12, 0x20], dtype=np.float64)
PANEL = np.array([0x13, 0x1A, 0x2B], dtype=np.float64)
BLUE = np.array([0x7A, 0xA5, 0xFF], dtype=np.float64)
VIOLET = np.array([0xA6, 0x8B, 0xFF], dtype=np.float64)
GOLD = np.array([0xF2, 0xCD, 0x7A], dtype=np.float64)


def write_png(path, rgb):
    height, width, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(height))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def rounded_rect_mask(xx, yy, x0, y0, x1, y1, r):
    cx = np.clip(xx, x0 + r, x1 - r)
    cy = np.clip(yy, y0 + r, y1 - r)
    return ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) & (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1)


def segment_distance(xx, yy, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = np.clip(((xx - ax) * dx + (yy - ay) * dy) / (dx * dx + dy * dy), 0, 1)
    return np.hypot(xx - (ax + t * dx), yy - (ay + t * dy))


def render_mark(size, scale=2, full_bleed=True):
    """The icon artwork in a 1024-unit design space, supersampled."""
    n = size * scale
    coords = (np.arange(n) + 0.5) / n * 1024.0
    xx, yy = np.meshgrid(coords, coords)
    img = np.empty((n, n, 3))
    img[:] = INK
    inner = rounded_rect_mask(xx, yy, 64, 64, 960, 960, 184)
    img[inner] = PANEL
    points = [(300, 330), (700, 330), (330, 694), (724, 694)]
    dist = np.full(xx.shape, np.inf)
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        dist = np.minimum(dist, segment_distance(xx, yy, ax, ay, bx, by))
    stroke = dist <= 46
    t = np.clip(((xx - 300) + (yy - 330)) / ((724 - 300) + (694 - 330)), 0, 1)[..., None]
    img[stroke] = (BLUE * (1 - t) + VIOLET * t)[stroke]
    dot = np.hypot(xx - 724, yy - 330) <= 46
    img[dot] = GOLD
    if not full_bleed:
        outer = rounded_rect_mask(xx, yy, 0, 0, 1024, 1024, 224)
        img[~outer] = INK
    small = img.reshape(size, scale, size, scale, 3).mean(axis=(1, 3))
    return np.clip(np.rint(small), 0, 255).astype(np.uint8)


def main():
    icon = render_mark(1024)
    write_png(os.path.join(ASSETS, "AppIcon.appiconset", "AppIcon-512@2x.png"), icon)
    splash = np.empty((2732, 2732, 3), dtype=np.uint8)
    splash[:] = INK.astype(np.uint8)
    mark = render_mark(360, scale=2)
    offset = (2732 - 360) // 2
    splash[offset:offset + 360, offset:offset + 360] = mark
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        write_png(os.path.join(ASSETS, "Splash.imageset", name), splash)
    print("App icon and launch images written.")


if __name__ == "__main__":
    main()
