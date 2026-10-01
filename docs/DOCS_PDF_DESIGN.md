# Docs by email as PDF — engine design (decision 0011, condition 2)

**Status: proposal, 1 October 2026. Nothing built.** For Mr. Singh's ruling
before any build, as condition 1 had (`docs/DOCS_SERVER_RENDER_DESIGN.md`).

## 1. What condition 2 asks

A document sent by email goes as a **PDF, not HTML**, built **on the server,
from the same source as condition 1**: the stored Yjs state plus every stored
update, merged by the render service. A PDF made in a browser does not meet
it. Proof (0011): the mismatch test, run against the mail attachment; the PDF
matches the stored content, not the client's copy. The `.html` download from
Space stays as it is.

## 2. What any engine must do

1. **Read only what the server stored.** Input is the render service's own
   document (the JSON it already makes from the merged Yjs), never the
   browser's HTML.
2. **Indian scripts, shaped correctly.** The editor offers "Noto Sans (Indian
   scripts)", and customers will type Hindi, Tamil, Bengali and others. Those
   scripts need *shaping*: conjuncts, vowel signs placed and reordered. An engine
   that draws Devanagari letter by letter produces a PDF a Hindi reader sees as
   wrong. This is the requirement that decides between cheap engines.
3. **Every node and mark the schema has**: headings, lists (nested), tables
   with merged cells, bold/italic/underline/strike, colour, highlight, links,
   and pictures. Pictures come only from our own store (the 1 Oct picture rule).
4. **No network, inside the hardened render container**, under the same
   limits as today: no internet, no database, read-only, non-root, 512 MB,
   1 CPU, a 10 s cap per job.
5. **Fonts we are allowed to ship.** The editor's menu offers Arial, Georgia,
   Times New Roman, Verdana, Trebuchet MS and Courier New. Those are Microsoft
   fonts and cannot go in our image. The PDF uses open equivalents:
   - Liberation Sans, Serif and Mono match Arial, Times and Courier **metrically** (same widths, so line breaks match);
   - Georgia, Verdana and Trebuchet map to the nearest open face, and those **will look slightly different**;
   - Noto is used for every Indian script.

## 3. The options, measured

Sizes were read on 1 Oct 2026 from the public registries: Alpine 3.22
"installed size", npm "unpacked", GitHub release assets, Docker Hub.
"Added" means what the render image grows by. Fonts are separate (§4).

| | Engine | Input | Indian-script shaping | Added to the image | Runs as |
|---|---|---|---|---|---|
| **A** | **Typst** 0.15.1 (Apache-2.0) | our JSON, read as **data** by a fixed Typst template | HarfBuzz-grade (rustybuzz) | **25.5 MiB** (one static binary; 17.5 MB download) | a child process per job, in the render container |
| B | WeasyPrint 70.0 (BSD) | our server-built HTML + print CSS | HarfBuzz (via Pango) | Python 22.9 MiB + Pango 0.6 + HarfBuzz 1.3 + Pillow, fonttools and others, **est. 50–80 MiB** (not packaged in Alpine 3.22, so pip from a lockfile) | a Python process, in the render container or a second one |
| C | pdfkit 0.20.2 (MIT) | our JSON, laid out by our own code | fontkit's own shaper: **unproven for Indian scripts** | **10.5 MB** (npm) | inside the existing Node workers, same limit |
| D | QuestPDF 2026.9.1 (.NET) | our JSON, laid out in C# | HarfBuzz (SkiaSharp is already in the API) | ~0 in the render image | **inside the API process**, outside the sandbox |
| E | headless Chromium / Gotenberg 8 | our HTML | correct | Chromium **263 MiB** (package alone) / Gotenberg **703 MB** compressed | a browser engine on customer content |

**Ruled out by default:**
- **E** (the ruling: no headless Chromium by default). It's the largest by far, and it runs a whole browser engine over customer content.
- **D.** It renders inside the API, undoing the isolation condition 1 just built. Its licence is free only below a revenue threshold, which is a business question.

**C** is the smallest and stays in one runtime. But we would write all layout by hand (tables with merged cells, list numbering, page breaks), and its Indian-script shaping is the one thing we can't vouch for. It's only worth having if it passes the script fixture in §5, unchanged.

**B** renders the HTML we already build, so it needs the least new mapping code. The cost is a second language runtime in the image, CSS-for-print gaps to find, and a pip install where the rest of the image comes from lockfiles.

## 4. Fonts (any option)

Alpine packages, installed size:

| Package | Size |
|---|---|
| `font-noto-devanagari` | 26.3 MiB |
| `font-noto-bengali` | 13.2 MiB |
| `font-noto-tamil` | 10.5 MiB |
| `font-noto` (Latin) | 9.0 MiB |
| `font-liberation` | 4.2 MiB |

The script packages carry many families and weights. We would ship **Regular and Bold for each script the product supports**, a small fraction of those sizes; the exact figure is measured in the spike. Which scripts are "supported" is Amit's call. Proposed list: Devanagari, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Gurmukhi, Odia, and Latin.

## 5. Recommendation: A (Typst), with B as fallback, behind a gate

**Why Typst:**
- Shaping is HarfBuzz-grade.
- It's one 25.5 MiB static binary with no runtime.
- It has real page layout: tables with merged cells, lists, page breaks, running page numbers.
- Most important for security: **customer text never becomes Typst code.** The document goes in as a JSON *data* file, and one fixed template, written by us and reviewed once, walks it. Generating Typst *markup* from customer text would be an injection risk, because `#` starts code in Typst. Reading it as data removes that whole class of risk.

**The gate, the same discipline as condition 1** (nothing past it is built if it fails; it comes back to you):

1. **The same document, as text.** Text extracted from the PDF (`pdftotext`) equals the render service's text for the same stored state, for every fixture. This is 0011's mismatch proof. Calibrated: a planted changed word is caught.
2. **Indian scripts.** A new fixture (Hindi, Tamil and Bengali, mixed with English, rich in conjuncts) checked two ways:
   - the shaped glyph runs in the PDF match HarfBuzz's own answer (`hb-shape`) for each line;
   - a person who reads the script looks at the page.
3. **Every node and mark** in the existing six fixtures appears: fonts in the PDF's font list, colours, the table's merged cells, links.
4. **Inside the limits**: the largest fixture within the 10 s cap and 512 MB; no network attempted (the container test's egress check, red first, applies unchanged).

**B is tried only if A fails the gate. C is measured on check 2 only**, because if its shaping passes it is the cheapest of the three.

## 6. Where it runs

- **Render service:** a new route `POST /render/pdf`. Same body as `/render/doc`, same pool, same 10 s cap. It returns the PDF bytes plus the dropped-items list (condition 4).
- **Typst in the image:** the binary is pinned by version and sha256 in the Dockerfile, the same discipline as the base-image digest.
- **API:** the mail-send path builds the attachment **at send time** from the stored document, through this route. A failed build refuses the send and says so; it never falls back to HTML. The stale-build rule from condition 1 does not apply, because each send builds its own copy.

## 7. Decisions needed

**For Amit:**
1. **Fonts.** A document set in Georgia, Verdana or Trebuchet will look slightly different in the PDF than on screen, because those fonts can't be shipped. Arial, Times and Courier will match closely. Acceptable?
2. **Which Indian scripts** must be supported on day one (proposed list in §4).
3. **Page:** A4, with page numbers at the foot? Proposed: yes to both.

**For Mr. Singh:**

4. **The engine:** A, with the gate above.
5. **A second binary in the render image**, pinned by version and sha256.
6. **The spike's downloads:** the Typst release tarball (17.5 MB, from GitHub, checked against its sha256) and the Alpine font packages, both into the throwaway test image only. That needs Amit's go too.

## 8. Rulings (1 October 2026)

**Mr. Singh: Typst approved, with four conditions.**

1. **Customer text is data, never markup, by construction.** The document goes to Typst as a JSON file, `doc.json`, read by one fixed template (`apps/render/pdf/main.typ`). Nothing from a document is ever concatenated into Typst source. Red first: a document whose text is `#read("/etc/passwd")`, a raw `#include`, or a `#import "@preview/…"` must print each as literal text, with no file read and no fetch.
2. **A locked file root.** Typst runs with `--root` set to an empty per-job folder that holds only the template, `doc.json` and the pictures the service wrote. There is no package path, no cache and no network. A picture comes from the stored document's own bytes, never a path.
3. **Downloads: Alpine's own package first.** If Alpine lacks it, use the GitHub release with its SHA-256 written in the Dockerfile and checked at build time. Fonts are handled the same way (Noto, OFL). Our pinned base image is **Alpine 3.24**, whose signed repository has **Typst 0.14.2-r0** and every font needed, so nothing comes from GitHub.
4. **Inside the container's limits.** The PDF is built in the same locked-down render container, under the same deadline as the render (one deadline for both). A PDF that can't be built in time fails the send with a clear message.

**Amit:**

1. **Fonts:** open substitutes are fine. Use metric-compatible ones where they exist (Liberation for Arial, Times and Courier) and close matches for Georgia, Verdana and Trebuchet.
2. **Scripts:** day one is **English and Devanagari** (Hindi and Marathi), verified by a person who reads them. Every other script on the §4 list is built in and tool-checked from day one, but is switched on only once a reader has checked a sample PDF. A document containing a script nobody has checked yet is refused with `script_not_checked`, naming the script; it never goes out unchecked.
3. **Page:** A4, with page numbers at the foot.

**Then:** build the gate first, and bring its results before the email side is wired up.

## 9. Scripts checked by a reader

The record Amit asked for. A script is switched on in `CHECKED_SCRIPTS` (`apps/render/src/render-pdf.mjs`) only in the same change that adds its row here.

| Script | Languages | Checked by | Date | Sample PDF |
|---|---|---|---|---|
| Latin | English | (always on) | | |
| Devanagari | Hindi, Marathi | *pending: the gate's sample goes to a reader* | | |
