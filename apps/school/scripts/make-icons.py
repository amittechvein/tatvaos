"""Draws the TatvaOS School app icons from the design canvas's logo mark (a navy T and a white dot
on the saffron tile of the splash screen), so the app has its own icon files, separate from the
Connect app's. Replace with the designer's final icon when it exists and rerun nothing; or adjust
the shapes here and run:  python scripts/make-icons.py   (needs Pillow)

Writes assets/icon.png (1024, full bleed, stores and iOS), assets/adaptive-icon.png (1024,
transparent, mark inside Android's safe circle; background colour comes from app.config.ts) and
assets/splash-icon.png (512, the saffron tile on transparent, shown on the navy splash).
"""
import os
from PIL import Image, ImageDraw

SAFFRON = (245, 158, 11, 255)
NAVY = (27, 35, 99, 255)
WHITE = (255, 255, 255, 255)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets")
SS = 4  # draw 4x larger, then shrink, for smooth edges


def mark(draw, x0, y0, size):
    """The logo mark in a size x size box (the design's 60 x 60 viewBox)."""
    u = size / 60
    r = lambda x, y, w, h, rad, fill: draw.rounded_rectangle([x0 + x * u, y0 + y * u, x0 + (x + w) * u, y0 + (y + h) * u], radius=rad * u, fill=fill)
    r(10, 12, 40, 9, 4.5, NAVY)       # T bar
    r(25.5, 12, 9, 34, 4.5, NAVY)     # T stem
    draw.ellipse([x0 + 39 * u, y0 + 39 * u, x0 + 49 * u, y0 + 49 * u], fill=WHITE)  # dot


def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))
    print("wrote", name)


os.makedirs(OUT, exist_ok=True)
N = 1024 * SS

icon = Image.new("RGBA", (N, N), SAFFRON)
mark(ImageDraw.Draw(icon), N * 0.15, N * 0.15, N * 0.70)
save(icon, "icon.png", 1024)

adaptive = Image.new("RGBA", (N, N), (0, 0, 0, 0))
mark(ImageDraw.Draw(adaptive), N * 0.25, N * 0.25, N * 0.50)
save(adaptive, "adaptive-icon.png", 1024)

S = 512 * SS
splash = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(splash)
d.rounded_rectangle([0, 0, S, S], radius=S * 0.30, fill=SAFFRON)
mark(d, S * 0.15, S * 0.15, S * 0.70)
save(splash, "splash-icon.png", 512)
