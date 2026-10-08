# Docs and Sheets — the file is built on the server (design)

**Status:** **APPROVED by Mr. Singh**, with five rulings (§12), reached this lane 29 September 2026 (UTC; 30 September in India) through Amit. **Nothing here is built yet; step 1 is a gate.**
**Asked for:** Mr. Singh, 28 September 2026, through Amit: *"Condition 1, the
server-side render, for Docs first … Bring me the design before building: how
the renderer reads Yjs updates on the server, and what happens to the existing
uploaded copies."*
**Serves:** decision 0011, condition 1 (and condition 2 — PDF by email — and
condition 4 — dropped nodes — both ride on it).
**Written:** 29 September 2026, Docs lane, against main `6b56f41`.

---

## 1. The problem, in the code as it is

A save ("checkpoint", `DocsEndpoints.CheckpointAsync`) is a browser with edit
access sending three things, and the server keeps all three **as sent**:

| Sent by the browser | Stored as | Trusted today? |
|---|---|---|
| `state` — the whole Yjs document, "containing every update up to seq N" | `docs.documents.state` | yes — the header of the schema file says so |
| `html` — `editor.getHTML()` | the Space blob (after `DocsHtml.Clean`) and `docs.versions.html` | yes, once cleaned |
| `text` — `editor.getText()` | `docs.documents.text_content` (search, AI) | yes |

So the file Space hands out, the text AI reads and the document people edit
are three separate claims from one browser. Nothing checks that they agree. A
modified browser — or a plain bug in ours — can make the downloaded file say
₹5,000 where the document says ₹50,000. The sanitiser (condition 3, live)
makes that file *safe*; nothing makes it *true*. That is condition 1.

**What the server already has that it does not use:** every edit, as the Yjs
updates it relays (`docs.updates`, append-only, kept a day after folding). The
true document is `state ⊕ updates`. The server has never read either: *"THE
SERVER NEVER PARSES YJS"* (schema header).

## 2. The design in one paragraph

A small **render service** — Node, internal only, no database, no internet —
takes the stored Yjs bytes and returns the document's HTML and text, using
**the editor's own schema code**, the same `yjs` and `y-tiptap` the editor
runs. The API calls it after every save, builds the Space file from **its**
output, and ignores the browser's `html` and `text` entirely. The browser's
`state` stops being trusted too: the renderer merges the stored state with the
stored updates itself, so what is rendered is what the server relayed, not
what one browser claims. Existing files are re-rendered once, from their own
stored state, the first time the service is live.

## 3. How the renderer reads Yjs on the server (Mr. Singh's first question)

### 3.1 Three ways to do it; the recommendation is (A)

| | How | For | Against |
|---|---|---|---|
| **(A) Node render service** | a container running `yjs` + `@tiptap/y-tiptap` (y-prosemirror) + the editor's own extension list, and `@tiptap/html` to write HTML with no browser | **the same code as the editor** — the render cannot disagree with what people see, because it is the same schema and serialiser; Sheets reuses its own TypeScript model, formula engine and `.xlsx` writer as they are (they already run under Node: `tests/sheets` reads workbooks that way) | a new container; a second runtime on the server side; the schema list must move out of a React file into one both import |
| (B) .NET, via **YDotNet** (native bindings to `yrs`, the Rust port of Yjs) | the API decodes the state in-process and writes HTML with a C# serialiser for our schema | no new container; one language | **two serialisers for one schema** — every new node or mark must be written twice and kept in step, and a mismatch is exactly the "file differs from document" fault this exists to end; a native library inside the API; Sheets would need its formula engine ported to C# to fill cached values — months |
| (C) our own Yjs decoder in C# | read the update format directly | no dependency | Yjs's merge rules are the hard part; a subtly wrong decoder is a silent wrong file. Not proposed |

**Recommendation: (A).** The deciding argument is condition 1's own wording:
*one* source of truth. (A) makes the render a pure function of the stored
bytes using the code that defines the document. (B) makes it a second
implementation of that code.

### 3.2 What the render service is

- **Where:** `apps/render/` in this repository; one image, one container
  `render` in `docker-compose.base.yml`. **A compose change → Mr. Singh's
  (rule 7)**, and so is the `verify-live.sh` line that checks it.
- **Network:** an internal Docker network shared with `api` only. **No Caddy
  route, no internet egress, no database credentials, no secrets in its
  environment.** It receives bytes and returns bytes.
- **Interface:** `POST /render/doc` — body = the Yjs update bytes (state and
  pending updates, already merged by the caller or merged here — §3.3);
  answer = `{ html, text, schemaVersion, dropped: [names] }`. Later
  `POST /render/xlsx` (Sheets) and `POST /render/pdf` (condition 2).
- **Limits, because a hostile state is an input like any other:** request
  cap = `MaxStateBytes` (32 MB, today's limit); a 10 s wall-clock budget per
  render, then the worker is killed and replaced; memory cap on the
  container (proposed 512 MB); read-only filesystem; non-root user.
- **Shared code:** `documentExtensions()` moves out of `DocEditor.tsx` into a
  React-free module (`packages/doc-schema` or `apps/web/lib/docs/schema.ts`)
  that both the editor and the renderer import. Two things in our own
  `extensions.ts` touch the browser — the picture's node view (which loads
  the image) and `CommentHighlights` (click handling) — and neither is used
  when writing HTML; the node view stays in the editor-only layer.

### 3.3 Reading the updates, not just the state

The server stores a compacted `state` at `state_seq` plus every update with a
higher `seq`. The render input is **`Y.mergeUpdates([state, ...updates])`** —
the document exactly as the server relayed it to everyone.

This changes what a checkpoint *is*:

- **Today:** the browser's state replaces the server's. A browser can compact
  away edits it never saw (the "claim is trusted" note in the schema).
- **Proposed:** a checkpoint becomes *"please save now"*. The server merges
  `state ⊕ updates ≤ N` itself (in the renderer — the API still never parses
  Yjs), stores the merged state, renders from it, and writes the file. The
  browser's `state`, `html` and `text` fields are accepted for one release
  (old tabs) and **ignored**; then removed.

A merge never loses an edit — that is the point of a CRDT — so a malicious
checkpoint can no longer delete a colleague's typing by claiming a state that
lacks it. (It can still type deletions like any editor; versions exist for
that, unchanged.)

### 3.4 When it runs, and what happens when it fails

- **On every checkpoint**, after the updates are merged, **outside** the room
  lock: the render reads a snapshot at seq N, and the Space blob is written
  only if N is still the newest rendered seq (compare-and-set on a new
  column, `docs.documents.rendered_seq`). A slow render cannot overwrite a
  newer one.
- **Renderer down or times out:** the save still succeeds — the edits are
  already stored as updates — and the Space file stays at the **last good
  render**, marked stale (`rendered_seq < state_seq`). A background sweep
  retries stale documents every minute. **The browser's HTML is never used
  as a fallback**; a stale true file beats a fresh unverified one.
- **Visible, not silent:** a stale render older than 10 minutes is a
  `WARNING` log line naming the file id (never content), and verify-live
  gets one check: a fixed test document renders to a known HTML.

### 3.5 Versions and text

- `docs.versions.html` is also browser-sent today. A version already stores
  its `state`, so its HTML is rendered from that on save (new versions) and
  in the backfill (old ones).
- `text_content` (search, AI) comes from the same render.
- The sanitiser (`DocsHtml.Clean`) **stays**, applied to the renderer's
  output: a second layer, and the tripwire for §5.

## 4. What happens to the existing uploaded copies (the second question)

Every existing Space file for a document, and every `docs.versions.html`, was
written by a browser.

1. **Measured, 29 September 2026 (Amit approved the reads; read as a role
   that bypasses row security, so a 0 is a real 0):** Docs switched on for
   **0** organisations; **0** documents; **0** versions in production.
   **So there are no browser-written copies in production today.** If the
   render lands before anyone switches Docs on — Techvein included — none
   will ever exist there, and steps 2–5 shrink to a guard: a document with
   `rendered_seq IS NULL` is rendered before its file is served. The
   backfill below is kept for the case where Docs is switched on first
   (and for local and test databases, which do hold browser-written files).
   **DECIDED (Amit, 29 September 2026): Docs stays off for everyone,
   Techvein included, until the render lands.** So production never holds a
   browser-written file, and the build's step 5 is the guard, not a
   production backfill. Anyone switching Docs on before then is going
   against this decision; the operator route does not enforce it (§10).
2. **Additive migration:** `docs.documents.rendered_seq bigint`,
   `rendered_at timestamptz`, `renderer text` (the schema version that
   rendered it). All NULL = "a browser wrote this".
3. **Backfill, once, by the API at start-up** (a worker, not deploy.sh): for
   every document with `rendered_seq IS NULL`, merge and render, write the
   new blob, repoint, delete the old blob — the same steps a checkpoint takes
   today, so Space quotas and activity stay right. Then versions. Resumable
   (it only picks NULL rows), logged as counts.
4. **Until a document is backfilled** its old file keeps serving: it was
   already cleaned by the sanitiser, so it is safe, just unverified. Nothing
   is deleted before its replacement is written.
5. **Kept for a comparison, not for serving:** during the backfill, the old
   and new HTML's *text* are compared and the count of documents that differ
   is logged (a number, never content). A non-zero count is the measure of
   how often the browser's file was not the document — the evidence for
   0011, and a trigger to look before customers.

Rollback: the migration is additive; an older build ignores the new columns
and goes back to taking the browser's HTML. Files already re-rendered stay
correct.

## 5. Condition 4 comes free

y-prosemirror turns Yjs elements into editor nodes; an element whose type the
schema does not know is **dropped**, silently. The renderer sees both sides:
it counts element types in the Yjs fragment and nodes in the result, and
returns the names of any type that did not survive (`dropped`). The API logs
`document id + type name`, **never content** — exactly 0011's condition 4.
First job of the build: *prove* the dropping with a state that carries an
unknown element (it is believed, not verified).

## 6. Sheets, the same path

`POST /render/xlsx`: the renderer applies the stored workbook state to the
Sheets model (`lib/sheets/model.ts`), recomputes formulas with the Sheets
engine, and writes the `.xlsx` with the Sheets writer — the browser's own
code, unchanged, because it already runs under Node. `XlsxGuard` stays on
the output, as `DocsHtml.Clean` does for documents. Built **after** Docs'
render is settled, as Mr. Singh ordered.

## 7. Condition 2, PDF by email, from the same render

The renderer has the HTML; a PDF needs a layout engine. Two options, for a
later ruling, not this one:

- **headless Chromium in the render container** — faithful (it is what
  prints the page today), about 300–400 MB of image, one process per job;
- a **.NET HTML-to-PDF library** in the API — lighter, weaker CSS support
  (tables and page breaks are the risk).

Either way the PDF is made from the renderer's HTML, never the browser's.

## 8. How it is proved (Mr. Singh's proof, and the rest)

| Proof | Must fail on main today |
|---|---|
| **A checkpoint whose `html` says something the document does not** (state says "Fees 50,000", html says "Fees 5,000"): Space serves **50,000** | yes — main serves 5,000 |
| A checkpoint whose `state` lacks a colleague's stored update: the file still has the colleague's words | expected yes — main takes the browser's state and deletes folded updates after a day; **not yet measured**, the first red run will say |
| Renderer stopped: the save succeeds, the file stays at the last good render, the stale warning appears, and the sweep catches up when it is back | n/a (new behaviour) — calibrated by stopping the container |
| Parity: the real-editor fixture page, turned into a Yjs state, renders to the **same HTML the editor produced** | the build's step 1; if this fails, (A) is wrong |
| A hostile state (deep nesting, 32 MB, garbage bytes): refused or timed out, the worker replaced, the API unaffected | calibrated with the limits removed |
| The render container cannot reach the internet or the database | a connection attempt from inside it, expected to fail |
| Backfill: a browser-written document gets `rendered_seq`, a new blob, the old blob deleted, Space size right | run against a copy with NULL rows |

## 9. What would prove me wrong

1. **Parity fails.** If `@tiptap/html` in Node does not reproduce
   `editor.getHTML()` for the fixture page, "same code" is not the same
   output, and (A)'s main argument falls. Step 1 of the build, before
   anything else.
2. **Merging on the server changes what people see.** If `state ⊕ updates`
   ever differs from what a connected editor shows, the relay has a bug that
   today's trusted checkpoint hides. The proof table's second row is the
   check; a difference means stopping, not shipping.
3. **Render cost.** A checkpoint fires after idle typing; a 32 MB document
   rendered on every one could be slow. Measured on the fixture and on a
   generated large document before deciding the per-checkpoint trigger; the
   fallback is "render at most every N seconds per document".
4. **A second runtime is a real cost** for a three-person team: its image,
   its updates, its logs. If Mr. Singh judges that heavier than two
   serialisers, (B) is the alternative — with its drift risk written down.
5. **The count in §4.1** was 0 on 29 Sept. If Docs is switched on before the
   render lands, browser-written files start to exist and the backfill is real work again.

## 10. For Mr. Singh to rule

1. **(A) the Node render service**, or (B) .NET via YDotNet.
2. **Stop trusting the browser's `state` too** (§3.3) — in this piece of
   work, or a second step after the HTML.
3. **The new container** and its compose / verify-live lines (rule 7).
4. **Backfill at start-up**, or as a one-off command run by the deployer.
5. Condition 2's PDF engine can wait for its own ruling (§7).

Amit has decided Docs stays off for everyone until the render lands (§4.1);
the two production counts were 0 and 0. Open for Mr. Singh: whether the
operator route should *refuse* switching Docs on until then, rather than
rely on the decision being remembered.

## 11. Build order, once ruled

1. Parity spike: fixture → Yjs → render → compare (proves or kills (A)).
2. Move the schema to a React-free module; the editor imports it (no
   behaviour change; editor tests).
3. `apps/render` with `/render/doc`, limits, container, internal network.
4. API: checkpoint renders via the service; `rendered_seq`; stale sweep;
   warnings; verify-live check. The proof table, red on main first.
5. Backfill worker; run on a copy; then production, on the deployer's run.
6. Remove the browser's `html` / `text` / `state` fields one release later.
7. Sheets `/render/xlsx`. Then condition 2.

## 12. Rulings (Mr. Singh, reached this lane 29 September 2026, through Amit)

1. **(A), the Node render service.** Accepted *"on one condition: the parity
   spike is step 1 and it's a gate. If `@tiptap/html` in Node doesn't
   reproduce `editor.getHTML()` for the fixture page, stop and bring it back
   to me. Don't patch around it."*
2. **Stop trusting the browser's `state` in this same piece of work, not
   later.** `state ⊕ updates`, merged by the renderer, is what makes the
   file true. The old fields are accepted for one release, then removed.
3. **The container: approved in principle; the compose PR comes to him**,
   with the hardening written into it:
   - its own Docker network with `internal: true` (no egress, not only "no
     Caddy route"), shared with `api` only;
   - `read_only: true`, a non-root user, `cap_drop: [ALL]`,
     `security_opt: no-new-privileges`, a `pids_limit`, the 512 MB cap;
   - no environment secrets, no Docker socket, no volumes but a small
     `tmpfs`;
   - dependencies pinned by lockfile and installed at build time, never at
     start.
   The "cannot reach the internet or the database" proof is **red first:
   run with `internal: false` and watch the connection succeed.**
4. **The backfill is a worker at start-up**, not a deployer command. With 0
   documents and Docs held off it is really the guard: nothing with
   `rendered_seq IS NULL` is served before it is rendered. **Keep the
   text-difference count** — it is the evidence 0011 asked for.
5. **The PDF engine waits for its own ruling.**

**Render cost (§9 point 3):** measure on the fixture and on a generated
large document before choosing "every checkpoint". His default if it is
slow: **at most once every 10 seconds per document, always after the last
edit.**

Also ruled the same day: PR 358 (the switch refusal) accepted after the
fact; PR 344 (web pictures, https only) approved; Sheets (PR 342) after the
render is settled.

## 13. Second rulings, after the gate failed (Mr. Singh, reached this lane 29 September 2026, through Amit)

These **replace** the matching parts of §12 and of the design above.

1. **The gate is redefined, by him: "the same document", strictly** — not
   character for character, and no headless Chromium. *Character for
   character against `editor.getHTML()` compares with one browser's
   serialisation; Chrome, Safari and Firefox write the same document
   differently, so a Safari user's own editor would fail that gate.* Under
   condition 1 the browser writes nothing stored. The definition:
   - the same sequence of elements, the same text nodes byte for byte, the
     same SET of attribute names on each element;
   - attribute values equal byte for byte, except `style`, compared as a
     parsed set of declarations with colour values normalised to one
     notation. **No other normalisation.**
   - **Calibrate the comparison**, each must FAIL: a changed word; one colour
     one digit different (`#fff475` against `rgb(255, 244, 118)`); an
     attribute dropped; an extra attribute; two elements swapped; a style
     declaration dropped; one extension removed (kept).
   - **More than one fixture:** content pasted from Word and from Google
     Docs, nested lists, tables with merged cells, every mark combined with
     every other.
   Re-run, and bring the results **before building step 2**.
2. **(A) confirmed**; stop trusting the browser's HTML, text and state **in
   this work**.
3. **The backfill is dropped** (replaces §4 steps 2–5 and §12.4). Instead
   one guard: **switching Docs on for an organisation is refused if any of
   its files was written by a browser.** The §4.1 counts are not needed.
4. **A failed render is a failed save, shown to the person — never a
   silent fallback to the browser's HTML.** (This replaces §3.4's "the save
   still succeeds and the file stays at the last good render". The edits
   themselves are not lost either way: they are stored as live updates
   before any save.)
5. **The container PR comes to him** and must show: no internet (internal
   network only), no database access, no secrets in its environment,
   non-root, read-only filesystem, **memory and CPU limits**, reachable only
   from the API, the **10-second render timeout**. Red first on the network
   rule: a request from inside the container to the internet fails.
6. **Sheets: same service, same rules, and `XlsxGuard` checks the server's
   own `.xlsx` too.**

**Order:** the gate re-run → his read of the results → the service and its
container PR → saves from the server's file → deploy, still off → the
one-line change allowing Docs on → Amit's decision, Techvein first.

## 14. Third ruling, after the Google Docs fixture (Mr. Singh, reached this lane 30 September 2026)

1. **The gate compares the server's file with the editor reloaded from
   storage**, not the paster's first view (transient).
2. **Plus a closed list of known storage drops** (0011, condition 4): the
   first view vs the reload must differ only by listed kinds; anything else
   fails; a new entry needs his ruling; each firing writes condition 4's
   log line (document + kind, never content). Entry 1: marks on a hard
   break. Calibrated with a fabricated drop of another kind.
3. **Strip marks from hard breaks on paste**: a follow-up, not blocking.
4. **Fixtures made from real documents live only in a throwaway database**
   (rule 13), dropped at the end of the run; nothing made from a real
   customer's or Amit's document is kept unscrubbed anywhere
   (`tests/docs-render/capture-harness.sh`).

Order: the gate as ruled, re-run -> his read -> the render service and its
container PR.

