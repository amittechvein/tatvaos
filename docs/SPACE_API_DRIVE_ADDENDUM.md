# Space API — Drive-view addendum (v1.2 draft, FOR REVIEW)

**Status: CONTRACT DRAFT.** Additions to `SPACE_API.md` v1.1 for the
Drive-shaped UI: Recent/Home, Starred, owner + location columns, and the
sharing directory. Folds into SPACE_API.md as v1.2 once approved; code
follows approval, not the other way round. All v1.1 conventions hold:
camelCase, `{ "error": "sentence." }`, invisible = 404, batched decoration —
never a walk per row.

Schema work: **migration 27** (`space.file_activity`, `space.stars`).
Activity and stars are strictly per-user: their RLS is
`tenant + user_id = me`, nothing else changes, and no existing policy is
touched.

---

## 1. Activity / Recent  (P1)

### Storage

`space.file_activity` — one row per (user, file), UPSERTED, so the table is
bounded by users × files-they-touched, not by event count. Not an audit
trail (core.audit_logs is that); this is "what did I touch last".

| column | notes |
|---|---|
| `tenant_id` | RLS + FK |
| `user_id` | PK part, FK core.users ON DELETE CASCADE |
| `file_id` | PK part, FK space.files ON DELETE CASCADE |
| `action` | `opened` \| `created` \| `modified` — the LATEST action wins |
| `occurred_at` | timestamptz, updated on every upsert |

Written as one extra upsert on paths that already exist — no new write path:

- download (`GET /files/{id}/content`) → `opened`
- upload (`POST /files`) → `created`
- overwrite (`PUT /files/{id}/content`) → `modified`

Rename/move/share deliberately do NOT record — "recent" answers "what was I
working in", not "what did I administer". Say so if the UI disagrees.

### `GET /api/space/recent?page=1&pageSize=50`

```jsonc
// 200 — files only (folders have no content to open), live only, ordered by
// MY latest activity, newest first
{
  "files": [
    {
      ...FileDto,                       // incl. the new fields in §3
      "activity": { "action": "modified", "occurredAt": "iso" }
    }
  ],
  "page": 1, "pageSize": 50, "total": 23
}
```

`pageSize` max 200. A file trashed after I touched it drops out (live only);
a file I can no longer see drops out the same way (RLS does this for free).

**Home = this endpoint.** "Suggested files" is recent, ranked by
`occurredAt`; the suggestion reason string is derived client-side from
`action` + date ("You modified · yesterday"). No ML, no second endpoint.

---

## 2. Starred  (P1)

### Storage

`space.stars` — (user, one object), same XOR discipline as shares:

| column | notes |
|---|---|
| `tenant_id` | RLS + FK |
| `user_id` | FK core.users ON DELETE CASCADE |
| `file_id` / `folder_id` | exactly one set — `CHECK (num_nonnulls(...) = 1)`; FK CASCADE |
| `created_at` | for "starred recently" ordering |

Unique per (user, object) via partial indexes, shares-style. A star is
personal: my star is invisible to colleagues, enforced by RLS
(`user_id = me`), so no `WITH CHECK` can write a star as someone else.

### Endpoints

| call | result |
|---|---|
| `PUT /api/space/files/{id}/star` · `PUT /api/space/folders/{id}/star` | `204`. Idempotent — starring a starred item is a no-op, not a 409. `404` invisible. |
| `DELETE /api/space/files/{id}/star` · `DELETE /api/space/folders/{id}/star` | `204`. Idempotent — unstarring an unstarred item is fine. |
| `GET /api/space/starred` | below |

```jsonc
// 200 — starred first by most recently starred
{ "folders": [ FolderDto ], "files": [ FileDto ] }   // incl. §3 fields
```

A starred item that gets trashed stays starred but leaves `/starred`
(live-only, like every listing); restore brings it back. Purge cascades the
star row away.

### `isStarred` on every DTO

`FileDto` and `FolderDto` gain `"isStarred": bool` in EVERY response that
returns them — list, shared, trash, search, recent, starred, and the
single-item responses from PATCH/restore/ownership. Batched: one query for
the page's ids against `space.stars`, same pattern as the shares batch.

---

## 3. Names on DTOs  (P1)

Both DTOs gain:

```jsonc
"ownerDisplayName": "Abhishek Sharma" | null
```

Null when the item is organisational (no owner) and when the owner's
account was deleted (retained row — the UI can render "—" or "removed
user"). "me" is a client-side render of `ownerUserId == my id`, not a
server string. Batched: one `core.users` lookup for the page's distinct
owner ids.

The CROSS-FOLDER views only — `/recent`, `/starred`, `/shared`,
`/search` — additionally gain, per row:

```jsonc
"parentName": "Projects"        // the containing folder's name,
                                 // or "My Space" / "Organisation" at a root
```

`/list` does not carry it — the breadcrumb already answers location there.
One batched lookup of the page's distinct `folderId`s. For an item whose
containing folder is invisible to me (I see the file via a direct share),
`parentName` is null — naming a folder I cannot see would leak its name.

---

## 4. Directory for sharing  (P1)

### `GET /api/space/directory?q=abh`

Any signed-in user, own tenant only (the tenant filter + RLS make anything
else impossible). Mirrors Mail's `/mail/directory` shape but INCLUDES the
id, because `PUT /shares` needs it.

```jsonc
// 200
{
  "people": [
    { "id": "uuid", "displayName": "Abhishek Sharma", "email": "abhishek@acme.in" }
  ]
}
```

- `q` optional; matches name OR email, case-insensitive substring; without
  it, the first `20` by name (the share dialog's initial state).
- Cap 20 rows, no paging — it is a picker, not a report.
- Active people only. Pending users (created, never signed in) ARE included
  — a person with an address can be shared with, the same lesson as
  `EvaluateAcceptAsync`'s pending-mailbox trap.
- The caller themself is included (the UI may grey them out).

This unblocks person-by-person sharing for non-admins, whose only current
source of user ids is org-admin-gated.

---

## 5. Thumbnails  (P2 — spec only, build AFTER 1–4 merge)

`GET /api/space/files/{id}/thumbnail` — image mime types only.

- `200` image bytes (downscaled, longest edge ~256px), long-lived cache
  headers + ETag on the blob key (a new blob key on overwrite invalidates
  for free).
- `404` invisible file, non-image mime, or undecodable image — one answer,
  no oracle for "exists but is not an image".
- Generated on demand, cached on the blob volume beside the original at a
  derived path; the purge deletes the thumbnail with the blob.

Open question for review: which image library — ImageSharp is the obvious
.NET choice but adds a dependency; decide before P2 starts, not during.

---

## Out of scope, so nobody builds them by accident

Computers/sync clients; in-file content answers ("get answers from Drive"
is an AI feature, not this quarter); Spam (files don't have one). The
"Projects" item in the reference screenshot is an ordinary folder.

---

## Sequencing once approved

1. Migration 27 (`file_activity` + `stars`, RLS, grants) — one migration,
   both tables.
2. DTO fields (`isStarred`, `ownerDisplayName`, `parentName`) + the three
   activity upserts on existing paths.
3. `/recent`, `/starred`, star PUT/DELETE, `/directory`.
4. Thumbnails, later, as its own branch.

Branch: `feature/space-drive`. The `SpaceContentGateway` /
attach-from-Space work already in flight is untouched by any of this.
