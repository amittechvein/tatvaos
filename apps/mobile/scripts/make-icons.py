"""Draw the TatvaOS mark (apps/web/public/brand/tatvaos-mark.svg) as app icons.

The SVG is 48x48: a rounded hexagon built from lines and quadratic curves,
filled with a three-stop linear gradient, and a white T made of two rounded
rectangles. It is redrawn here from those exact numbers at 4x supersampling,
so every size is sharp and matches the brand file, not a blown-up 108 px PNG.

Usage: python make_icons.py <out_dir>
"""
import os, sys
import numpy as np
from PIL import Image, ImageDraw

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

STOPS = [(0.0, (0x1E, 0x52, 0xD9)), (0.55, (0x2A, 0x7B, 0xEE)), (1.0, (0x3B, 0xA9, 0xF7))]
G0, G1 = np.array([6.0, 4.0]), np.array([42.0, 44.0])

# The path, as segments: ('L', x, y) or ('Q', cx, cy, x, y), from the start point.
START = (17.94, 3.5)
SEGS = [('Q', 24, 0, 30.06, 3.5), ('L', 38.72, 8.5), ('Q', 44.78, 12, 44.78, 19), ('L', 44.78, 29),
        ('Q', 44.78, 36, 38.72, 39.5), ('L', 30.06, 44.5), ('Q', 24, 48, 17.94, 44.5), ('L', 9.28, 39.5),
        ('Q', 3.22, 36, 3.22, 29), ('L', 3.22, 19), ('Q', 3.22, 12, 9.28, 8.5), ('L', 17.94, 3.5)]

def outline(steps=48):
    pts = [START]
    x0, y0 = START
    for s in SEGS:
        if s[0] == 'L':
            x0, y0 = s[1], s[2]; pts.append((x0, y0))
        else:
            _, cx, cy, x, y = s
            for i in range(1, steps + 1):
                t = i / steps
                pts.append(((1-t)**2*x0 + 2*(1-t)*t*cx + t*t*x, (1-t)**2*y0 + 2*(1-t)*t*cy + t*t*y))
            x0, y0 = x, y
    return pts

def gradient(n, scale, ox, oy):
    """RGB image n x n; pixel (i,j) maps to mark coordinates ((j-ox)/scale, (i-oy)/scale)."""
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float64)
    ux, uy = (xs + 0.5 - ox) / scale, (ys + 0.5 - oy) / scale
    d = G1 - G0
    t = np.clip(((ux - G0[0]) * d[0] + (uy - G0[1]) * d[1]) / (d @ d), 0, 1)
    rgb = np.zeros((n, n, 3))
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        m = (t >= a) & (t <= b)
        k = ((t - a) / (b - a))[m][:, None]
        rgb[m] = np.array(ca) * (1 - k) + np.array(cb) * k
    return Image.fromarray(rgb.round().astype(np.uint8), 'RGB')

def mark(size, fraction, background=None, shape='square'):
    """The mark `fraction` of `size` wide, centred, on a background (None = transparent)."""
    ss = 4
    n = size * ss
    canvas = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    if background:
        bg = Image.new('RGBA', (n, n), (0, 0, 0, 0))
        d = ImageDraw.Draw(bg)
        if shape == 'circle':
            d.ellipse((0, 0, n - 1, n - 1), fill=background)
        else:
            d.rectangle((0, 0, n, n), fill=background)
        canvas = bg
    scale = n * fraction / 48.0
    off = (n - 48.0 * scale) / 2
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).polygon([(off + x * scale, off + y * scale) for x, y in outline()], fill=255)
    canvas.paste(gradient(n, scale, off, off), (0, 0), mask)
    d = ImageDraw.Draw(canvas)
    for (x, y, w, h) in [(13, 13, 22, 6.5), (20.75, 13, 6.5, 23)]:
        d.rounded_rectangle((off + x * scale, off + y * scale, off + (x + w) * scale, off + (y + h) * scale),
                            radius=2 * scale, fill=(255, 255, 255, 255))
    return canvas.resize((size, size), Image.LANCZOS)

WHITE = (255, 255, 255, 255)

# Play Store listing icon: 512 x 512, full square, opaque. Google applies its own rounded mask.
mark(512, 0.78, WHITE).convert('RGB').save(os.path.join(OUT, 'play-store-icon-512.png'))
# Expo's source images, kept in the repo so a future prebuild makes the same thing.
mark(1024, 0.80, None).save(os.path.join(OUT, 'icon.png'))
# Adaptive foreground: 108dp canvas, launchers mask to a shape inside the middle 66dp.
# At 62% the hexagon's farthest point sits at 0.93 x 0.62 = 58% of the half-width,
# inside the 61% safe circle (33dp of 54dp), so no launcher shape clips it.
mark(1024, 0.62, None).save(os.path.join(OUT, 'adaptive-icon.png'))

# The Android resources, per density.
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, k in DENS.items():
    d = os.path.join(OUT, 'res', f'mipmap-{name}')
    os.makedirs(d, exist_ok=True)
    legacy = round(48 * k)
    mark(legacy, 0.84, None).save(os.path.join(d, 'ic_launcher.webp'), 'WEBP', lossless=True)
    mark(legacy, 0.70, WHITE, 'circle').save(os.path.join(d, 'ic_launcher_round.webp'), 'WEBP', lossless=True)
    mark(round(108 * k), 0.62, None).save(os.path.join(d, 'ic_launcher_foreground.webp'), 'WEBP', lossless=True)

any26 = os.path.join(OUT, 'res', 'mipmap-anydpi-v26')
os.makedirs(any26, exist_ok=True)
xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
       '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
       '    <background android:drawable="@color/iconBackground"/>\n'
       '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
       '</adaptive-icon>\n')
for f in ('ic_launcher.xml', 'ic_launcher_round.xml'):
    open(os.path.join(any26, f), 'w', newline='\n').write(xml)

# A preview sheet for a human to look at before anything is built.
sheet = Image.new('RGB', (1400, 520), (240, 238, 234))
sheet.paste(Image.open(os.path.join(OUT, 'play-store-icon-512.png')).resize((400, 400)), (40, 60))
fg = Image.open(os.path.join(OUT, 'adaptive-icon.png')).resize((400, 400))
circ = Image.new('RGBA', (400, 400), (0, 0, 0, 0)); ImageDraw.Draw(circ).ellipse((0, 0, 399, 399), fill=WHITE)
circ.alpha_composite(fg); m = Image.new('L', (400, 400), 0); ImageDraw.Draw(m).ellipse((0, 0, 399, 399), fill=255)
sheet.paste(circ, (500, 60), m)
sq = Image.new('RGBA', (400, 400), (0, 0, 0, 0)); ImageDraw.Draw(sq).rounded_rectangle((0, 0, 399, 399), radius=110, fill=WHITE)
sq.alpha_composite(fg); m2 = Image.new('L', (400, 400), 0); ImageDraw.Draw(m2).rounded_rectangle((0, 0, 399, 399), radius=110, fill=255)
sheet.paste(sq, (960, 60), m2)
sheet.save(os.path.join(OUT, 'preview.png'))
print('icons written to', OUT)
