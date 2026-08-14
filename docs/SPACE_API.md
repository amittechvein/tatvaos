# TatvaOS Space — API contract

**Status: CONTRACT.** None of this works yet. It is the surface the frontend
builds against; disagreements found now are cheap. Shapes follow Mail:
`authedFetch`, JSON bodies, camelCase, and every error is
`{ "error": "sentence." }` — the console prints it verbatim.

Written against migration `25-space-schema.sql`, branch `feature/space-schema`.

---

## Conventions

- **Base path** `/api/space/*`, same-origin behind `space.caddy` (modeled on
  `mail.caddy`), so the refresh cookie stays first-party. Auth is the shared
  JWT — no Space login exists.
- **Visibility vs permission.** An item the caller cannot *see* (RLS) is a
  **404** — not a 403, which would confirm existence. An item the caller can
  see but lacks the level to act on is a **403**.
- **Permission levels** `view < comment < edit < owner`. Effective permission
  = the highest grant on the item or any ancestor folder, or `owner` for the
  owner, or `edit` for anyone in the tenant on organisational items. The level
  is enforced in the application; RLS answers visibility only.
- **Status codes** used: `200`, `201`, `204`; `400` validation, `403`
  insufficient level, `404` not visible / does not exist, `409` structural
  conflict (cycle, duplicate share), `413` single file over the per-file cap,
  `507` storage quota — see Upload for the `reason` field.
- **Scope.** Everyone has two roots: `personal` (mine) and `organisational`
  (the tenant's). A root is not a row — it is `folderId = null` plus a scope.
  Endpoints that can target a root take `scope` wherever `folderId` is null.

### DTOs

```jsonc
// FileDto
{
  "id": "uuid",
  "name": "Q3 report.pdf",          // display only; duplicates allowed per folder
  "mimeType": "application/pdf",
  "sizeBytes": 1048576,
  "folderId": "uuid | null",         // null = in a root
  "ownershipType": "personal | organisational",
  "ownerUserId": "uuid | null",      // null on organisational AND on retained (owner deleted)
  "createdByUserId": "uuid | null",
  "myPermission": "view | comment | edit | owner",
  "isShared": true,                  // has at least one share row (owner's badge)
  "deletedAt": "iso | null",
  "createdAt": "iso",
  "updatedAt": "iso"
}

// FolderDto — same fields minus mimeType/sizeBytes, plus:
{
  "parentFolderId": "uuid | null",
  "childFolderCount": 3,
  "fileCount": 12
}

// ShareDto
{
  "id": "uuid",
  "userId": "uuid | null",           // null when orgWide
  "userDisplayName": "HR Department | null",
  "orgWide": false,
  "permission": "view | comment | edit",
  "sharedByUserId": "uuid | null",
  "createdAt": "iso"
}
```

---

## Browsing

### `GET /api/space/list?folderId={uuid}` · `GET /api/space/list?scope=personal|organisational`

One or the other. Returns the folder's live (non-trashed) contents plus the
breadcrumb, resolved server-side with the recursive CTE — the frontend never
computes paths.

```jsonc
// 200
{
  "breadcrumb": [ { "id": null, "name": "My Space" },      // or "Organisation"
                  { "id": "uuid", "name": "Projects" } ],   // root → … → current
  "folder": FolderDto | null,                               // null at a root
  "folders": [ FolderDto ],                                 // name asc
  "files":   [ FileDto ],                                   // name asc
  "page": 1, "pageSize": 200, "totalFiles": 512             // files are paged; folders never are
}
```

Optional `page` (default 1), `pageSize` (default 200, max 500) — applies to
files only. Errors: `404` folder not visible; `400` both/neither of
`folderId`/`scope` given.

Access is resolved **once for the folder**, then trusted for its contents —
not per file row. (Core's listing-cost concern is handled here by design: a
file in a visible folder is visible unless the query says otherwise.)

### `GET /api/space/shared`

Items shared **to me** (directly or org-wide), top level only — a folder
shared to me appears once; I browse into it via `/list`.

```jsonc
// 200
{ "folders": [ FolderDto ], "files": [ FileDto ] }   // myPermission tells the UI what to allow
```

### `GET /api/space/trash`

My trash: items **I can act on** whose own `deletedAt` is set — top items
only. Trashing a folder stamps *that folder row only*; its contents follow
their ancestor and are not listed separately (restore is one un-stamp).

```jsonc
// 200
{
  "folders": [ FolderDto ],   // deletedAt set on all
  "files":   [ FileDto ],
  "retentionDays": 30         // purge deadline = deletedAt + retentionDays
}
```

### `GET /api/space/search?q=annual+report&page=1&pageSize=50`

Full-text on file names (tsvector `simple`), live items only, ranked.

```jsonc
// 200
{ "files": [ FileDto ], "page": 1, "pageSize": 50, "total": 3 }
```

`400` when `q` is empty.

---

## Files

### `POST /api/space/files` — upload

`multipart/form-data`, fields **in this order** (the server checks quota
before it will read the bytes):

| field | required | notes |
|---|---|---|
| `folderId` | one of these two | target folder |
| `scope` | | `personal` / `organisational` when uploading to a root |
| `sizeBytes` | yes | declared size — quota is pre-checked against it |
| `file` | yes, **last** | the bytes; streamed to the volume, never buffered |

Actual bytes written are counted as they stream; a declared size is a claim,
not a fact, and the stored `sizeBytes` is what actually landed. Ownership
follows the destination: personal root / personal folder → `personal` owned
by the caller; organisational → `organisational`.

```jsonc
// 201
FileDto
```

Errors:
- `404` folder not visible · `403` visible but no `edit`
- `413` file exceeds the per-file cap → `{ "error": "…" }`
- `507` quota → `{ "error": "sentence for the console.", "reason": "full" | "suspended" | "no_allocation" }`
  — `reason` is machine-readable so the UI can link the storage page on
  `full` and say something different on `suspended`. Mirrors what
  `EvaluateAcceptAsync` learned: a bare refusal makes the caller guess wrong.

### `PUT /api/space/files/{id}/content` — replace content (overwrite)

Same multipart shape (`sizeBytes` then `file`). Writes a **new** blob and
repoints — the old blob is not overwritten in place. Bumps `updatedAt`.
Requires `edit`. Quota is checked on the **delta** (new size − old size).
Errors as upload, plus `409` if the file is in trash.

### `GET /api/space/files/{id}/content` — download

`200` raw bytes, `Content-Type` from `mimeType`,
`Content-Disposition: attachment; filename="…"`, `Content-Length` set.
Works for trashed files (restore-by-download-first is a real workflow).
Requires `view`. `404` if not visible.

### `PATCH /api/space/files/{id}` — rename / move

```jsonc
{ "name": "new name.pdf" }                  // rename, or
{ "folderId": "uuid" }                      // move, or
{ "folderId": null, "scope": "personal" }   // move to a root — or both name+move
```

Requires `edit` on the file **and** `edit` on the destination for a move.
`200` FileDto. Errors: `404` file or destination not visible, `403` level,
`409` file is in trash. Moving between personal and organisational trees
does **not** change `ownershipType` — that is explicit, below.

### `PUT /api/space/files/{id}/ownership` — personal ↔ organisational

```jsonc
{ "ownershipType": "organisational" }   // hand my file to the org, or back
```

Owner (or org-admin, for reclaiming retained owner-less files) only.
`organisational → personal` sets the caller as owner. `200` FileDto.
Audited to `core.audit_logs` — this is the "whose is this" trail.

### Trash lifecycle

| call | effect | errors |
|---|---|---|
| `DELETE /api/space/files/{id}` | stamp `deletedAt` (soft) — `204` | `404`, `403` (needs `edit`), `409` already trashed |
| `POST /api/space/files/{id}/restore` | clear stamp — `200` FileDto | `404`, `409` not in trash, `409` parent folder itself trashed → restores to the nearest live ancestor or root, stated in the response |
| `DELETE /api/space/files/{id}/permanent` | blob removed **then** row deleted — `204` | `404`, `409` not in trash first |

Trashed bytes still count toward quota until purged (the bytes are on disk);
the 30-day purge runs in `StorageReconcileWorker`. The UI should say so next
to the meter.

---

## Folders

### `POST /api/space/folders`

```jsonc
{ "name": "Projects", "parentFolderId": "uuid" }          // or
{ "name": "Projects", "parentFolderId": null, "scope": "personal" }
// 201 → FolderDto
```

`400` empty name or depth would exceed **32**; `404`/`403` on the parent.

### `PATCH /api/space/folders/{id}` — rename / move

Same shape as file PATCH (`name`, `parentFolderId` + `scope`). Two extra
errors, both `409` with a verbatim-printable sentence:

- destination **is a descendant** of the folder being moved (cycle guard —
  checked on every move, no exceptions), and
- the move would push any descendant past depth 32.

### Trash lifecycle — same three calls as files

`DELETE /{id}` · `POST /{id}/restore` · `DELETE /{id}/permanent`, same codes.
Trash stamps the folder row only; contents follow it. Permanent delete of a
folder purges its entire subtree — blobs first, rows second.

---

## Sharing

Share rows live on **one** object; folder shares reach contents at query
time by ancestor walk — the API never copies grants down, so "why can this
person see this" always has a one-row answer.

### `GET /api/space/files/{id}/shares` · `GET /api/space/folders/{id}/shares`

`200 { "shares": [ ShareDto ] }` — requires `view`; owners and `edit` see the
list, `view`/`comment` callers get `403` (who-else-can-see is not theirs).

### `PUT /api/space/files/{id}/shares` · `PUT /api/space/folders/{id}/shares`

Upsert — one grant per (object, audience), re-sharing updates the level:

```jsonc
{ "userId": "uuid", "permission": "edit" }     // named colleague, or
{ "orgWide": true,  "permission": "view" }     // the whole tenant
// 200 → ShareDto (created or updated)
```

Requires `owner` (personal items) or `edit` (organisational). `400` both or
neither audience; `404` unknown user or user in another tenant (indistinguishable
on purpose); `403` level.

### `DELETE /api/space/files/{id}/shares/{shareId}` · folders alike

`204`. `404` share not visible. Same level rule as PUT.

---

## Usage

### `GET /api/space/usage`

Reads `core.storage_pools` / `core.storage_allocations` (product `drive`) —
Space owns no quota numbers. Reconciles this tenant on read, like the storage
console, so opening the meter repairs it.

```jsonc
// 200
{
  "usedBytes": 734003200,          // includes trash — bytes are still on disk
  "trashBytes": 52428800,          // the reclaimable part, for "empty trash frees X"
  "allocatedBytes": 536870912000,  // null = draw from whatever is left in the pool
  "poolTotalBytes": 2199023255552,
  "poolUsedBytes": 1651113328640   // all products, for the "of your plan" line
}
```

---

## Non-goals in this contract (deliberate)

- **No versions endpoints** — deferred; new-blob-on-overwrite keeps the door
  open.
- **No presigned upload/download URLs** — the API streams. When presigned
  arrives: quota check before issuing, content-length cap on the URL,
  reconcile actuals after.
- **No public/link sharing** — audiences are a tenant user or the tenant.
- **No cross-product attach API yet** ("attach from Space" for Mail) — it
  will be a read-only surface on top of these DTOs; nothing here blocks it.
