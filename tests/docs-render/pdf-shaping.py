#!/usr/bin/env python3
# =============================================================================
#  The PDF gate's shaping check (docs/DOCS_PDF_DESIGN.md section 5, check 2)
# =============================================================================
#
#  For each expected line: the glyphs the PDF draws in the Indian-script font,
#  compared with the glyphs HarfBuzz (hb-shape) gives for the same text with
#  the same font file. Compared by OUTLINE, not glyph number: a PDF writer
#  embeds a subset of the font and renumbers its glyphs, so equal numbers would
#  prove nothing and unequal ones would fail for nothing. Equal outlines in the
#  same order = the same shaping (conjuncts formed, vowel signs placed and
#  reordered as HarfBuzz does).
#
#    python3 pdf-shaping.py <pdf> <expected.json> <font dir>
#  expected.json: [{"text": "...", "script": "Devanagari"}, ...] — one per
#  PDF line, in order (each a paragraph short enough never to wrap).
#  Prints one JSON object: {"lines": [...], "ok": bool}.
#
#  Runs inside the gate image only (Dockerfile.pdf-gate): mutool, pdffonts,
#  hb-shape and fontTools all come from Alpine's own packages.
# =============================================================================
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

PDF, EXPECTED, FONTDIR = sys.argv[1], sys.argv[2], sys.argv[3]
expected = json.load(open(EXPECTED, encoding="utf-8"))

RANGES = {
    "Devanagari": (0x0900, 0x097F), "Bengali": (0x0980, 0x09FF), "Gurmukhi": (0x0A00, 0x0A7F),
    "Gujarati": (0x0A80, 0x0AFF), "Odia": (0x0B00, 0x0B7F), "Tamil": (0x0B80, 0x0BFF),
    "Telugu": (0x0C00, 0x0C7F), "Kannada": (0x0C80, 0x0CFF), "Malayalam": (0x0D00, 0x0D7F),
}
FONT_PREFIX = {s: "NotoSans" + ("Oriya" if s == "Odia" else s) for s in RANGES}


def run(*args, binary=False):
    r = subprocess.run(args, capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


# ---- the original font files, by PostScript name ------------------------------
originals = {}
for f in list(Path(FONTDIR).rglob("*.ttf")) + list(Path(FONTDIR).rglob("*.otf")):
    try:
        t = TTFont(str(f), lazy=True)
        ps = t["name"].getDebugName(6)
        if ps:
            originals.setdefault(ps, str(f))
    except Exception:
        pass


# ---- the fonts embedded in the PDF: BaseFont -> the embedded font program ----
def obj(num):
    return run("mutool", "show", PDF, str(num))


def ref(text, key):
    m = re.search(r"/" + key + r"\s*\[?\s*(\d+)\s+0\s+R", text)
    return int(m.group(1)) if m else None


embedded = {}  # base PostScript name (no subset tag) -> TTFont of the subset
for line in run("pdffonts", PDF).splitlines()[2:]:
    parts = line.split()
    if len(parts) < 3 or "+" not in parts[0]:
        continue
    base = parts[0].split("+", 1)[1]
    num = int(parts[-2])
    font = obj(num)
    desc_font = ref(font, "DescendantFonts")
    holder = obj(desc_font) if desc_font else font
    fd = ref(holder, "FontDescriptor")
    if not fd:
        continue
    d = obj(fd)
    ff = ref(d, "FontFile2") or ref(d, "FontFile3") or ref(d, "FontFile")
    if not ff:
        continue
    data = run("mutool", "show", "-b", PDF, str(ff), binary=True)
    try:
        embedded[base] = TTFont(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        embedded[base] = e


def outline(font, gid):
    order = font.getGlyphOrder()
    if gid >= len(order):
        return ("missing", gid)
    pen = RecordingPen()
    font.getGlyphSet()[order[gid]].draw(pen)
    return tuple((op, tuple(tuple(p) if isinstance(p, tuple) else p for p in args)) for op, args in pen.value)


# ---- the glyphs the PDF draws, line by line ------------------------------------
lines = []  # [(page, y, [(base, gid)])]
page = 0
cur_font = None
for raw in run("mutool", "trace", PDF).splitlines():
    s = raw.strip()
    if s.startswith("<page"):
        page += 1
    m = re.match(r'<span font="([^"]+)"', s)
    if m:
        cur_font = m.group(1).split("+", 1)[-1]
        continue
    m = re.match(r'<g unicode="[^"]*" glyph="([^"]+)" x="([-\d.]+)" y="([-\d.]+)"', s)
    if m and cur_font:
        gid = m.group(1)
        if not gid.isdigit():
            continue
        y = round(float(m.group(3)), 0)
        if lines and lines[-1][0] == page and abs(lines[-1][1] - y) < 2:
            lines[-1][2].append((cur_font, int(gid)))
        else:
            lines.append([page, y, [(cur_font, int(gid))]])

# The page number at each foot is a line of its own: drop the last line of each page.
by_page = {}
for ln in lines:
    by_page.setdefault(ln[0], []).append(ln)
body = []
for p in sorted(by_page):
    ls = sorted(by_page[p], key=lambda l: l[1])
    body.extend(ls[:-1])

# ---- compare --------------------------------------------------------------------
def runs(text, lo, hi):
    out, cur = [], ""
    for ch in text:
        cp = ord(ch)
        if lo <= cp <= hi or cp in (0x200C, 0x200D):
            cur += ch
        else:
            if cur:
                out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


results = []
ok_all = len(body) == len(expected)
for i, exp in enumerate(expected):
    res = {"line": i + 1, "script": exp["script"]}
    if i >= len(body):
        res.update(ok=False, why="the PDF has fewer lines than expected")
        results.append(res)
        continue
    glyphs = [g for g in body[i][2] if g[0].startswith(FONT_PREFIX[exp["script"]])]
    fonts = sorted({g[0] for g in glyphs})
    if len(fonts) != 1:
        res.update(ok=False, why=f"expected one {FONT_PREFIX[exp['script']]} font on the line, found {fonts or 'none'}")
        ok_all = False
        results.append(res)
        continue
    base = fonts[0]
    sub = embedded.get(base)
    orig_path = originals.get(base)
    if not isinstance(sub, TTFont) or not orig_path:
        res.update(ok=False, why=f"font {base}: embedded={type(sub).__name__}, original={'found' if orig_path else 'NOT FOUND'}")
        ok_all = False
        results.append(res)
        continue
    orig = TTFont(orig_path)
    lo, hi = RANGES[exp["script"]]
    ref_out = []
    # SHAPING_FEATURES: the gate's calibration only — switch shaping features
    # off in the reference, and the conjunct lines must stop matching.
    feats = [f"--features={os.environ['SHAPING_FEATURES']}"] if os.environ.get("SHAPING_FEATURES") else []
    for r in runs(exp["text"], lo, hi):
        shaped = run("hb-shape", f"--font-file={orig_path}", "--language=en", *feats, "--no-glyph-names",
                     "--no-positions", "--no-clusters", "--", r).strip().strip("[]")
        ref_out.extend(outline(orig, int(g)) for g in shaped.split("|") if g)
    pdf_out = [outline(sub, gid) for _, gid in glyphs]
    same = pdf_out == ref_out
    res.update(ok=same, font=base, pdf_glyphs=len(pdf_out), reference_glyphs=len(ref_out))
    if not same:
        n = next((k for k in range(min(len(pdf_out), len(ref_out))) if pdf_out[k] != ref_out[k]), min(len(pdf_out), len(ref_out)))
        res["first_difference_at_glyph"] = n
        ok_all = False
    results.append(res)

print(json.dumps({"ok": ok_all, "pdf_lines": len(body), "expected_lines": len(expected), "lines": results}, ensure_ascii=False))
