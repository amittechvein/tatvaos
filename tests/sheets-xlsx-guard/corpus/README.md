# Workbooks made by other people

Mr. Singh, 1 October 2026 (PR 342): the workbook guard's cases were the ones
its author thought of. These are not.

**These are test files from two open-source projects, made for testing
software that reads Excel files. They are not viruses collected from the
wild.** Some hold macros, embedded objects and links to other files — that
is what they are for. Downloaded 1 October 2026 with Amit's approval.

## Do not open them in Excel

Every file here ends in `.sample` so that a double-click does nothing. The
test reads their bytes; nothing here is ever opened or run. If you need to
look inside one, it is a zip.

Antivirus software may flag or lock some of them. That is expected. Leave
such a file alone rather than working around the antivirus.

## Where they came from

| Prefix | From | Commit | Licence |
|---|---|---|---|
| `oletools--` | github.com/decalage2/oletools, `tests/test-data/` | `ec102609` | BSD 2-clause |
| `poi--` | github.com/apache/poi, `test-data/spreadsheet/` | `942d95d8` | Apache 2.0 |

Byte for byte as downloaded. Only the names changed: the prefix, and
`.sample` added.

45 files: 25 hostile, 20 plain.

## The labels, and who decided them

`manifest.tsv` names each file, what must happen to it, and why. **The
"why" was read from each file by a separate program**, in another language,
with a real XML parser and no code shared with the guard. The guard's own
answer was not used to label anything — a test that asks the guard what the
right answer is would always pass.

| Label | Meaning |
|---|---|
| `refuse` | holds something that attacks whoever opens it |
| `permit` | a plain workbook |
| `strict` | plain by Excel's standards, refused anyway: it has a printer-settings part (`.bin`), or a web link stored as a relationship. Sheets' own writer produces neither, and only its files reach the guard. |

## What was left out

Four files from oletools were locked by the laptop's antivirus as they
arrived (`dde-test.xlsx`, `dde-test.xlsm`, `excel4_sample_macro.xlsm`, and
one encrypted copy). Their `.xlsb` and `.xltm` siblings, holding the same
content in another container, are here.

## What this corpus found

Run for the first time, it found that the guard **permitted an Excel 4
macro sheet** added to an otherwise ordinary `.xlsx`. The corpus files
themselves were all refused — for being macro-enabled or binary — which is
how the gap had hidden: the test adds one hostile thing at a time to a
workbook of our own, and that is what showed it. Following the same
thought found that a sheet saved as UTF-16 was unreadable to every check.
Both are fixed in `XlsxGuard.cs`, which says so where it does it.
