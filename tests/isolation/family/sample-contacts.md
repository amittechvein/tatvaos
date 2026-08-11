# sample-contacts.csv

Six rows, in Google's older column format, for checking the import screen by
hand. Upload it at `/family/import`, press **Check the file**, and the report
should say:

| | |
|---|---|
| Rows in the file | 6 |
| Would be added | 4 |
| Would be skipped | 2 |

The two skipped rows are the point of the file:

- **Row 5, Ravi Gupta.** `ravi+work@gmail.com` and row 4's `r.a.v.i@gmail.com`
  are one Gmail inbox once the dots and the `+tag` are folded. The report says
  so and names the earlier row.
- **Row 6.** No name, no company, no address. There is nothing to file it under.

The other four exercise things that quietly break importers:

- **Priya** has a quoted cell holding both a comma and a newline, and a
  `:::` multi-value label cell where one label is Google's own `* myContacts`
  bookkeeping and should not become a label here.
- **Anil** has two addresses in one cell, separated by `:::`.
- **=Danger Name** is what a spreadsheet would treat as a formula. Export the
  contacts afterwards and the name comes out as `'=Danger Name` — the leading
  apostrophe makes Excel read it as text. Our own importer strips it again, so
  a round trip is lossless.

The file is written with a UTF-8 byte-order mark, the same as Google's export,
because a BOM left on the first header cell stops `Name` matching.

**Cleaning up after a test:** everything imported carries the label you typed
into "Tag every contact with". Open it from the sidebar, delete what is in it,
then delete the label. That is the whole undo story, and testing it here is
worth more than testing the import.
