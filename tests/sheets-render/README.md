# Sheets server-render gate: workbooks

`make-fixtures.mjs` builds these workbooks through the editor's own model and saves each one's stored Yjs state. They're for the gate in `docs/SHEETS_SERVER_RENDER_DESIGN.md` §5.

```
node --import ./tests/sheets/register.mjs tests/sheets-render/make-fixtures.mjs [out-dir]
```

Each `fixtures/<name>.json` holds the state and the values worked out **by hand**. The generator refuses to write a workbook whose model disagrees with any of them.

**`large.json` (20,000 cells, about 0.7 MB) is not committed.** The generator rebuilds it in seconds.

With an `out-dir`, the generator also writes what the existing checks in `tests/sheets-xlsx-guard/` read:
- `ours--<name>.xlsx`, as the editor writes it;
- `ours--<name>.expected.json`, our engine's value for every cell;
- `control--cut-short.xlsx`, a sheet cut off halfway, which Excel must refuse.

Run them with:

```
OURS=<out-dir> dotnet run --project tests/sheets-xlsx-guard -c Release
```

```
pwsh tests/sheets-xlsx-guard/excel-check.ps1 <out-dir>
```

## First results (3 Oct 2026, laptop, the editor's own `.xlsx`, before any server build)

| Check | Result |
|---|---|
| Hand-worked values against the model | all matched (7 workbooks) |
| Read back through our own reader | 0 inputs lost |
| Unsafe formulas | stored as text (WEBSERVICE, a `javascript:` HYPERLINK, DDE, IMPORTXML); a safe `https` HYPERLINK stays a formula |
| XlsxGuard | 61 passed, 0 failed: all 7 permitted; the attack corpus is still refused |
| Real Excel (16.0, build 19127, macros forced off) | **29 passed, 1 failed** |

**About the Excel result:**
- The control was refused, and then a good file opened, which shows the check can fail.
- Six workbooks agree with Excel cell for cell, including all 20,013 cells of `large`.
- The one disagreement is **`XLOOKUP` showing `#NAME?`. That is not our file.** It stores `_xlfn.XLOOKUP`, exactly as Excel's format requires, and the other prefixed functions (IFS, SWITCH, TEXTJOIN, MAXIFS) calculate correctly.
- Asked directly, this laptop's Excel evaluates `IFS` and `TEXTJOIN` but returns an error for `XLOOKUP` and `XMATCH`. They arrived in Excel 2021/365, and this is an Excel 2019-class install.
- **Product note:** anyone opening a TatvaOS spreadsheet in Excel 2019 or older will see `#NAME?` where it uses XLOOKUP or XMATCH, as with any workbook that uses them.
