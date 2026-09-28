# Attacks written by other people

Mr. Singh, 30 September 2026 (PR 273): the sanitiser's own refusal cases are
the ones its author thought of. These are not. Every entry must come out of
`DocsHtml.Clean` as something that cannot run — checked as text by
`Program.cs`, and in a real browser by `browser.mjs`.

**These files are test input. Nothing here is run, and nothing here is
ours.** Downloaded 30 September 2026 with Amit's approval, unchanged apart
from what is noted.

| File | Entries | From | Licence |
|---|---|---|---|
| `owasp-filter-evasion.blocks.txt` | 110 | OWASP Cheat Sheet Series, *XSS Filter Evasion Cheat Sheet* — github.com/OWASP/CheatSheetSeries, commit `327812ee` | CC BY-SA 4.0 |
| `payloads-jhaddix.txt` | 110 | PayloadsAllTheThings, `XSS Injection/Intruders/JHADDIX_XSS.txt` — github.com/swisskyrepo/PayloadsAllTheThings, commit `3ac27901` | MIT |
| `payloads-mario.txt` | 274 | same, `MarioXSSVectors.txt` | MIT |
| `payloads-rsnake.txt` | 73 | same, `RSNAKE_XSS.txt` | MIT |
| `payloads-polyglots.txt` | 16 | same, `XSS_Polyglots.txt` | MIT |

583 entries. Some repeat across files; the browser run loads each distinct
one once.

## What was changed

- **OWASP's file is an extract.** The cheat sheet is a document; only the
  contents of its code blocks were kept, one block per entry, separated by a
  line reading `-----8<-----`. Blocks are kept whole because several attacks
  depend on a line break inside them. As an adaptation of a CC BY-SA work,
  this one file is under CC BY-SA 4.0 too.
- **The others are byte-for-byte**, except Windows line endings made Unix.
  One entry per line.

## What was left out, and why

- `IntrudersXSS.txt` from the same collection: the laptop's antivirus locked
  the file as soon as it was written, and it was left alone rather than
  worked around.
- PortSwigger's cheat sheet, which Mr. Singh also named: it is PortSwigger's
  own material, not under a licence that lets a copy be kept here.

## A note for whoever opens these

Antivirus software may flag these files: they are lists of attack strings,
which is what it looks for. They are text, read by a test.

## Adding to it

Put a `.txt` file here (one attack a line) or a `.blocks.txt` file
(separated as above), add a row to the table, and run both tests. A new
entry that fails is a finding, not a nuisance: decision record 0011 says
what happens next.
