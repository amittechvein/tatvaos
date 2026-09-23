"""App icons from Amit's chosen logo (the glossy TatvaOS mark), 22 Sept 2026.

Amit: "use this logo for app icon". The only copies that exist are 108 x 108
(Logo/TatvaOS_Core_Logo.png, apps/web/public/brand/ui/core-logo.png). Every
icon size above that is an ENLARGEMENT: done in steps with Lanczos and a light
sharpen, which is the best that can be done without the original artwork. A
1024 px or vector original replaces this whole script.

Usage: python make_icons_from_logo.py <logo.png> <out_dir>
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

logo = Image.open(SRC).convert('RGBA')
logo = logo.crop(logo.getbbox())            # just the mark, no transparent margin

def enlarge(img, size):
    """Up in steps of at most 2x, then down to the exact size: less ringing than one jump."""
    cur = img
    while cur.width * 2 <= size * 2 and cur.width < size:
        cur = cur.resize((cur.width * 2, cur.height * 2), Image.LANCZOS)
    cur = cur.resize((size, round(size * img.height / img.width)), Image.LANCZOS)
    if size > img.width:
        rgb, a = cur.convert('RGB'), cur.getchannel('A')
        rgb = rgb.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
        cur = Image.merge('RGBA', (*rgb.split(), a))
    return cur

def place(size, fraction, background=None, shape='square'):
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    if background:
        d = ImageDraw.Draw(canvas)
        (d.ellipse if shape == 'circle' else d.rectangle)((0, 0, size - 1, size - 1), fill=background)
    w = round(size * fraction)
    m = enlarge(logo, w)
    canvas.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return canvas

WHITE = (255, 255, 255, 255)
place(512, 0.78, WHITE).convert('RGB').save(os.path.join(OUT, 'play-store-icon-512.png'))
place(1024, 0.80).save(os.path.join(OUT, 'icon.png'))
place(1024, 0.62).save(os.path.join(OUT, 'adaptive-icon.png'))

DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, k in DENS.items():
    d = os.path.join(OUT, 'res', f'mipmap-{name}')
    os.makedirs(d, exist_ok=True)
    legacy = round(48 * k)
    place(legacy, 0.84).save(os.path.join(d, 'ic_launcher.webp'), 'WEBP', lossless=True)
    place(legacy, 0.70, WHITE, 'circle').save(os.path.join(d, 'ic_launcher_round.webp'), 'WEBP', lossless=True)
    place(round(108 * k), 0.62).save(os.path.join(d, 'ic_launcher_foreground.webp'), 'WEBP', lossless=True)

any26 = os.path.join(OUT, 'res', 'mipmap-anydpi-v26')
os.makedirs(any26, exist_ok=True)
xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
       '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
       '    <background android:drawable="@color/iconBackground"/>\n'
       '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
       '</adaptive-icon>\n')
for f in ('ic_launcher.xml', 'ic_launcher_round.xml'):
    open(os.path.join(any26, f), 'w', newline='\n').write(xml)

# Preview: the store icon, and the launcher icon at the size a Samsung home screen draws it.
sheet = Image.new('RGB', (1160, 560), (240, 238, 234))
sheet.paste(Image.open(os.path.join(OUT, 'play-store-icon-512.png')), (24, 24))
fg = Image.open(os.path.join(OUT, 'res', 'mipmap-xxxhdpi', 'ic_launcher_foreground.webp')).convert('RGBA')
sq = Image.new('RGBA', fg.size, (0, 0, 0, 0))
ImageDraw.Draw(sq).rounded_rectangle((0, 0, fg.width - 1, fg.height - 1), radius=fg.width // 4, fill=WHITE)
sq.alpha_composite(fg)
sheet.paste(sq, (600, 24), sq)
small = sq.resize((168, 168), Image.LANCZOS)
sheet.paste(small, (600, 480 - 24 - 168 + 60), small)
sheet.save(os.path.join(OUT, 'preview.png'))
print('logo icons written to', OUT, 'from', logo.size)
