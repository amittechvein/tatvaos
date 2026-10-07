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

**Mr. Singh, on the gate's first run: copy and search of Indian-script text.** In the first run, the PDF's text layer split and repeated shaped clusters (कृपया came out as "कृ पया"), so copying or searching that text from the PDF is imperfect. What the page *shows* is checked glyph by glyph against the stored text.

1. **Acceptable for the Hindi and Marathi launch, with two conditions.**
   - The gate reports the number of affected words on every run and **fails if it grows** (`TEXT_LAYER_BROKEN_MAX`, with the Typst-and-font combination named in the output).
   - The PDF email's one-line footer says plainly: **"Text in Indian scripts may not copy or search correctly from this PDF."**
2. **The fix is tracked as its own item, not blocking.** The likely cause is how the text layer records shaped glyphs (ActualText / ToUnicode). Try a newer Typst (0.15.1 is in Alpine edge) and the serif face (Noto Serif Devanagari). The gate's part 5b reports the serif face's count.
3. **A person who reads Hindi still checks a sample PDF before switch-on.** The tool proves the glyphs; the reader proves the result reads naturally.

## 9. Scripts checked by a reader

The record Amit asked for. A script is switched on in `CHECKED_SCRIPTS` (`apps/render/src/render-pdf.mjs`) only in the same change that adds its row here.

| Script | Languages | Checked by | Date | Sample PDF |
|---|---|---|---|---|
| Latin | English | (always on) | | |
| Devanagari | Hindi, Marathi | *pending: the gate's sample goes to a reader* | | |

## 10. Before switch-on: what PDFs and spreadsheets do to Docs saves in the same container

**Mr. Singh, 6–7 Oct 2026.** No live risk today: Sheets is off and nothing calls `/render/pdf`. It's a **switch-on condition for both Sheets and PDF**, not a blocker on anything merging.

*First written 6 Oct as a worker-pool question. Corrected 7 Oct by Mr. Singh (reading the 370/390 resolution): the PDF path is the constraint, not the pool. Then a third finding from him: one request is enough.*

**The facts, read from the code and compose on 7 Oct:**
- **Render workers:** 2 by default (`RENDER_WORKERS ?? 2`, capped at 4), one FIFO queue, no priority, a 10 s limit per job. The API waits 12 s for any render (`DocsRenderClient.Timeout`).
- **A PDF holds a worker only for its render phase.** The worker goes back to the pool (`server.mjs`, `idle.push(w)`) *before* Typst starts. Typst then runs as a child process of the server, and **nothing limits how many run at once.**
- **Each PDF job writes its document and pictures into a folder under `/tmp`** (`render-pdf.mjs`, `mkdtemp`). In the container `/tmp` is a **16 MB tmpfs**, which counts against memory.
- **The request body limit is 48 MB** (`MAX_BODY`). That's about **36 MB of pictures** once decoded, **more than twice what `/tmp` holds**, in one request the service accepts as valid. The picture cap is **500 pictures of any size**, which bounds nothing that matters.
- **A failed picture write throws a plain `ENOSPC`, not a `PdfFailed`.** So the server answers the generic `500 pdf_failed`, and the person reads only "The PDF could not be built".
- **The container's limits:** 512 MB of memory, **one CPU**, 64 processes and threads (`pids_limit`). The two render workers were never really parallel, and every Typst process competes for the same CPU. The 10 s deadline covers render **and** Typst together.

**The exposure, in order of harm:**
1. **Out of memory:** many Typst processes, fonts in each, pictures in `/tmp`, inside 512 MB. If the container is killed for memory, **it takes Techvein's Docs saves down with it.** One CPU mitigates this: ten Typst processes make slow progress rather than all allocating at once.
2. **The process cap: silent and persistent** (the worst kind). If Typst's threads exhaust the 64, a render worker killed at the 10 s limit may not be replaceable. **The pool shrinks and stays shrunk until a restart**, degrading Techvein's saves long after the burst is gone. Nobody would connect the two. *A hypothesis, to prove or disprove first among the concurrent cases.*
3. **`/tmp` full, from ONE request:** a newsletter with a few dozen photographs fills 16 MB. No burst is needed.
4. **Timeouts:** with one CPU, a PDF built while two renders run has about a third of a CPU and 10 s for render and Typst together. Timeouts will show up long before memory does.
5. **Queueing:** long spreadsheet builds and PDF renders hold both workers, and a document save waits past the API's 12 s.

**Measured, not reasoned, in the hardened container** (`tests/docs-render/container-test.sh`'s compose, its real limits), **in this order:**
0. **ONE PDF request with many pictures.** Real-sized photographs: how many before `/tmp` is full, the peak memory, and what the request is told. *If one request can do it, the concurrent numbers measure the wrong thing first.*
1. **The process-cap hypothesis:** Typst processes running, a render worker killed at the 10 s limit. Does its replacement start, and is the pool still two afterwards?
2. **Concurrent PDF builds, 2, 5 and 10 at once, with pictures:** peak memory, peak `/tmp`, peak process/thread count, and every request's answer, timeouts included.
3. **A Docs save sent during 2:** its time to answer and its result.
4. **Both workers busy with the longest jobs** (a 20,000-cell sheet, a PDF render), then a Docs save, at `RENDER_WORKERS` 2, 3 and 4.

**Then fix the inconsistency, not just measure it:**
- **The limits.** Bring the PDF route's body limit under what `/tmp` holds, give `/tmp` room for the body limit, or cap pictures by **total size** instead of count. Mr. Singh prefers a total-size cap plus a smaller PDF-route body limit; the measured sizes decide.
- **What limits concurrent Typst processes**, and what a request gets at that limit: a clear "busy, try again", never a dead container. Mr. Singh's instinct is a small semaphore and a queue in `buildPdf`. Measure before building it.
- **Fix regardless of the numbers: the refusal a person can act on.** A full `/tmp` (`ENOSPC` while writing pictures) gets **its own reason code and sentence**, e.g. *"This document has too many pictures, or pictures too large, to make a PDF. Remove some and try again."*, instead of the generic `pdf_failed`. A refusal a person can act on is worth more than a correct 500. **Proven in the hardened container**, whose `/tmp` really is 16 MB.
  - **Built 7 Oct 2026** (branch `docs/pdf-no-room-reason`). `ENOSPC` while making the job folder, writing into it, or Typst writing `out.pdf` ("os error 28") becomes:
    - **`413 {reason: "pictures_too_large", error: <the sentence above>}`** when the job had pictures;
    - **`no_room`** in the log when it had none, so the room went to other jobs at the same moment. That is still the generic 500 to the person, because "remove some pictures" would be wrong advice for a document with none.
  - The log line names the stage, the picture count and the bytes; never content.
  - `container-test.sh` §8 proves it in the real container. 2 pictures of about 3 MB fit and are built (200, the calibration). 7 don't fit: 413 with the sentence, no job folder left in `/tmp`, two log lines at `stage=write`, and the next document save still 200.
  - **Owed by whoever wires PDF by email:** show the 413's `error` to the person as written. Don't fold it back into "The PDF could not be built".
  - **Not changed:** the limits (body limit vs `/tmp`, total-size cap). The measurements still decide those.
  - **Corrected the same day** (branch `docs/pdf-no-room-own-bytes`), after measuring several PDFs at once (cases 2 and 3, PR 402):
    - **The bug:** the first version chose `pictures_too_large` whenever the job *had* pictures. So when other jobs had filled `/tmp`, single-photo documents were told to remove pictures. That was wrong advice; trying again would have worked.
    - **The fix:** the reason is now the job's **own** need against what `/tmp` holds at all (`statfs`). The need is 2 × the pictures, because case 0 showed the PDF is as big as its JPEGs and sits beside them. Over → `pictures_too_large`; otherwise → `no_room` (the generic 500).
    - **Owed:** a "busy, try again" sentence for `no_room` (Mr. Singh), to replace the generic one.
    - **Proof:**
      - `apps/render/test/no-room.test.mjs` checks the rule at case 0's sizes.
      - `container-test.sh` §8 now sends ten one-picture PDFs at once and requires that **none** gets the 413. Its calibration requires at least one `no_room` in the log, i.e. `/tmp` really did fill.

Rulings: Mr. Singh. Anything needing more capacity (cost): Amit. It sits on the switch-on checklist beside the AI-lists line and the personal-table audit.

*(Mr. Singh, on the container itself: non-root, read-only, no capabilities, no-new-privileges, its own network, and CPU, memory and process caps. Every exposure above exists because the boundaries are drawn tightly; a container without limits would have worse problems, found later and by a customer.)*
