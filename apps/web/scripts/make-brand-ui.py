#!/usr/bin/env python3
"""
make-brand-ui.py - turn the brand artwork into files the APP can draw on any
ground, light or dark.

    python apps/web/scripts/make-brand-ui.py          (from the repo root)

Needs Pillow and numpy. Reads  apps/web/public/brand/<product>-logo.png
                                apps/web/public/brand/<product>-name.png
       writes apps/web/public/brand/ui/<product>-logo.png        (any ground)
              apps/web/public/brand/ui/<product>-name.png        (light ground)
              apps/web/public/brand/ui/<product>-name-dark.png   (dark ground)

WHY THIS EXISTS
---------------
Amit, 19 Sept 2026, a screenshot of the sidebar in dark mode: two white boxes
with logos in them. Every file in brand/ is RGBA and 0% transparent - the white
is painted in (measured: 39-84% of each file is opaque white). On the light rail
nobody could tell, because the rail is nearly white. On the dark rail each logo
is a white rectangle, and the wordmark's "Tatva" is dark navy, so even with the
white removed it would be navy on near-black: gone.

WHY THE ORIGINALS ARE LEFT ALONE
--------------------------------
Nine email templates load brand/<product>-logo.png and -name.png by URL. A mail
app that forces dark mode repaints the card behind the image; today's white box
stays legible there, and a transparent navy wordmark would not. So brand/ stays
as it is, for mail, and the app reads brand/ui/. If the artwork changes, replace
the file in brand/ and re-run this.

HOW THE WHITE COMES OUT
-----------------------
Not "make white transparent": the art has pale tints (the Space cloud, the
Connect camera) and keying on whiteness turns those see-through and dim on a
dark ground. And not a flood fill from the corners: the white INSIDE the
Platform ring and between the Family figures is ground too.

So: a pixel is GROUND if it is near-white. Ground pixels become transparent.
Pixels within a couple of pixels of ground are the anti-aliased EDGE, a blend of
the art's colour and white; those are un-blended (the colour and the alpha that
would give this pixel over white are solved for), so the edge is clean on any
ground rather than haloed in white. Everything else is art and stays opaque,
pale or not.

What this deliberately does to small white details (calendar dots, the T, the
envelope's fold): they become see-through, showing the rail through them. On
the light rail that is what they always looked like; on the dark rail it reads
as a cut-out. Keeping them white would need someone to say which whites are ink.

THE DARK WORDMARK
-----------------
Same file, but ink that is dark and unsaturated (the navy "Tatva") is repainted
near-white. The blue "OS" and the cyan product name are saturated and are left
exactly as drawn.

A CHECK WITH A FAILURE MODE
---------------------------
The script ends by compositing every output over white and comparing it to its
original, and over the dark rail and counting near-white pixels. It exits 1 if
an output does not look like its original on white, or still carries a white
box on dark.
"""
import glob
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

BRAND = os.path.join('apps', 'web', 'public', 'brand')
OUT = os.path.join(BRAND, 'ui')
NEAR_WHITE = 238          # min(r,g,b) at or above this is ground
EDGE_PX = 2               # how far the anti-aliased edge reaches from ground
LIGHT_INK = np.array([244, 246, 251], dtype=np.float64)   # "Tatva" on a dark ground
DARK_RAIL = (17, 19, 28)  # close to the dark sidebar; only used by the check


def cut_out(path):
    """(rgb float HxWx3, alpha float HxW in 0..1) with the white ground removed."""
    im = Image.open(path).convert('RGB')
    rgb = np.asarray(im).astype(np.float64)
    lo = rgb.min(axis=2)

    ground = lo >= NEAR_WHITE
    g_img = Image.fromarray((ground * 255).astype(np.uint8))
    near = np.asarray(g_img.filter(ImageFilter.MaxFilter(2 * EDGE_PX + 1))) > 0
    edge = near & ~ground

    alpha = np.ones(lo.shape)
    alpha[ground] = 0.0
    # Over white: seen = a*true + (1-a)*255. Taking the darkest channel of the
    # true colour as 0 gives the LARGEST transparency consistent with the pixel,
    # which is right at an edge (mostly ground) and is why this is applied ONLY
    # at edges: inside the art it would make every pale tint see-through.
    a_edge = 1.0 - lo / 255.0
    alpha[edge] = np.clip(a_edge[edge], 0.0, 1.0)

    true = rgb.copy()
    m = edge & (alpha > 0.02)
    a = alpha[m][:, None]
    true[m] = np.clip((rgb[m] - (1.0 - a) * 255.0) / a, 0, 255)
    return true, alpha


def save(rgb, alpha, path):
    rgba = np.dstack([np.clip(rgb, 0, 255), alpha * 255.0]).round().astype(np.uint8)
    Image.fromarray(rgba, 'RGBA').save(path, optimize=True)


def lighten_dark_ink(rgb, alpha):
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    # Navy "Tatva": dark, and not strongly coloured. The blue "OS" is bright and
    # saturated; the cyan product name is brighter still.
    ink = (alpha > 0) & (mx < 120) & ~((sat > 0.75) & (mx > 95))
    out = rgb.copy()
    out[ink] = LIGHT_INK
    return out, int(ink.sum())


def over(rgb, alpha, ground):
    a = alpha[:, :, None]
    return a * rgb + (1 - a) * np.array(ground, dtype=np.float64)


def main():
    if not os.path.isdir(BRAND):
        sys.exit(f'run from the repo root: {BRAND} not found')
    os.makedirs(OUT, exist_ok=True)
    failures = 0
    for src in sorted(glob.glob(os.path.join(BRAND, '*.png'))):
        name = os.path.basename(src)
        rgb, alpha = cut_out(src)
        outputs = [(name, rgb)]
        if name.endswith('-name.png'):
            dark, repainted = lighten_dark_ink(rgb, alpha)
            if repainted == 0:
                print(f'  FAIL  {name}: no dark ink found to repaint for the dark wordmark')
                failures += 1
            outputs.append((name.replace('-name.png', '-name-dark.png'), dark))

        original = np.asarray(Image.open(src).convert('RGB')).astype(np.float64)
        for out_name, out_rgb in outputs:
            save(out_rgb, alpha, os.path.join(OUT, out_name))

            # 1. On white, the light files must still be the artwork.
            drift = None
            if not out_name.endswith('-dark.png'):
                # Over the ARTWORK only. The originals' ground is not 255 but about
                # (253,253,252), and averaged over a file that is 80% ground that
                # two-level difference alone read as "drift 2.0" and failed five
                # good files on the first run. The ground is the part we are
                # throwing away; it is the ink that must not move.
                art = alpha > 0
                drift = float(np.abs(over(out_rgb, alpha, (255, 255, 255)) - original)[art].mean())
            # 2. On the dark rail, no white box: near-white pixels may only be ink.
            on_dark = over(out_rgb, alpha, DARK_RAIL)
            white_share = float((on_dark.min(axis=2) >= NEAR_WHITE).mean())
            transparent = float((alpha == 0).mean())

            bad = (drift is not None and drift > 1.5) or transparent < 0.25 \
                or (white_share > 0.02 and not out_name.endswith('-dark.png'))
            failures += 1 if bad else 0
            print(f"  {'FAIL' if bad else ' ok '}  ui/{out_name:24s} transparent {transparent:5.1%}"
                  f"  white-on-dark {white_share:5.1%}"
                  + ('' if drift is None else f'  drift-on-white {drift:4.2f}'))
    print()
    print('  FAIL' if failures else '  PASS', f'- {failures} problem(s)' if failures else '')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
