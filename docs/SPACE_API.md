# TatvaOS Space — API reference

**Status: LIVE.** This describes what is running in production, verified
against the registered routes rather than written from memory. It supersedes
`SPACE_API_DRIVE_ADDENDUM.md` (v1.2) and `SPACE_API_PUBLIC_LINKS_ADDENDUM.md`
(v1.3); both remain in `docs/` as the record of what was reviewed and why, and
the reasoning in them is still worth reading. Where they disagree with this
file, this file is right.

Related: `STORAGE_MODEL.md` (whose bytes these are), `SPACE_ATTACH.md`
(what other products call), `SPACE_FAULT_MATRIX.md` (what has never been
tested).

---

## Conventions

Everything is under `/api/space`, JSON, camelCase. Every error is
`{ "error": "a sentence." }` — the console prints it verbatim, so it is
written for a person.

**Auth.** All routes require a signed-in user except the two public-link
routes, which are deliberately anonymous. `PUT /settings` additionally
requires OrgAdmin.

**404, not 403, for anything invisible.** An item the caller cannot see is
indistinguishable from one that does not exist — confirming existence is
itself a disclosure. 403 means "you can see it, but not do that to it".

**Permissions.** `view < comment < edit < owner`. Effective permission is the
highest grant on the item or any ancestor folder; the owner has `owner`;
anyone in the tenant has `edit` on organisational items. RLS decides
visibility; the application decides level.

**Roots are not rows.** A root is `folderId: null` plus
`scope: "personal" | "organisational"`. Anywhere a root can be addressed,
`scope` carries it.

**Decoration is batched, never per row.** Listings resolve folder access once
and fetch stars, owner names and parent names in one query each per page. A
recursive walk per row is a bug, not a slow path.

---

## DTOs

```jsonc
// FileDto
{
  "id": "uuid",
  "name": "Q3 report.pdf",          // display only; duplicates allowed in a folder
  "mimeType": "application/pdf",
  "sizeBytes": 1048576,
  "folderId": "uuid | null",         // null = in a root
  "ownershipType": "personal | organisational",
  "ownerUserId": "uuid | null",      // null on organisational, and on retained rows
  "createdByUserId": "uuid | null",
  "myPermission": "view | comment | edit | owner",
  "isShared": true,
  "isStarred": false,
  "ownerDisplayName": "Abhishek Sharma | null",
  "parentName": "Projects | null",   // cross-folder views only; null if that folder is invisible
  "activity": { "action": "opened|created|modified", "occurredAt": "iso" }, // /recent only
  "deletedAt": "iso | null",
  "createdAt": "iso",
  "updatedAt": "iso"
}

// FolderDto — as above minus mimeType/sizeBytes/activity, plus:
{ "parentFolderId": "uuid | null", "childFolderCount": 3, "fileCount": 12 }

// ShareDto
{ "id", "userId", "userDisplayName", "orgWide", "permission",
  "sharedByUserId", "createdAt" }
```

`ownerDisplayName` is null for organisational items and for retained rows
whose owner was deleted. "me" is a client-side comparison against the
caller's id, never a server string. `parentName` is null when the containing
folder is invisible to the caller — naming a folder someone cannot see would
leak it.

---

## Every route

### Browsing

| route | notes |
|---|---|
| `GET /list?folderId=` or `?scope=` | breadcrumb resolved server-side; folders unpaged, files paged (`page`, `pageSize` ≤ 500) |
| `GET /shared` | items shared **to** me, top level only |
| `GET /trash` | items whose own `deletedAt` is set; also `retentionDays` and `trashBytes` |
| `GET /search?q=` | file names (tsvector), live only, `pageSize` ≤ 200 |
| `GET /recent` | files by my latest activity, `pageSize` ≤ 200 — powers Recent **and** Home |
| `GET /starred` | my starred folders and files, most recently starred first |
| `GET /directory?q=` | people picker for sharing: `{ people: [{ id, displayName, email }] }`, capped at 20 |

`/list` omits `parentName` — its breadcrumb already answers location. The
cross-folder views (`/shared`, `/search`, `/recent`, `/starred`) carry it.

`/directory` includes **pending** users deliberately: an admin-created person
stays pending until first sign-in, and a person with an address can be shared
with. It is readable by any signed-in user — person-by-person sharing is not
an admin feature.

### Files

| route | notes |
|---|---|
| `POST /files` | multipart upload — see below |
| `PUT /files/{id}/content` | overwrite: **new blob, repoint, then drop the old**; quota on the delta |
| `GET /files/{id}/content` | download; range supported; works on trashed files |
| `GET /files/{id}/thumbnail` | image types only, ~256 px webp — see below |
| `PATCH /files/{id}` | `{ name }` and/or `{ folderId }` / `{ folderId: null, scope }` |
| `PUT /files/{id}/ownership` | `{ ownershipType }` — personal ↔ organisational |
| `DELETE /files/{id}` | to trash (`204`) |
| `POST /files/{id}/restore` | from trash; lands at the nearest live ancestor |
| `DELETE /files/{id}/permanent` | blob first, then row |

Moving never changes ownership — that is `PUT /ownership`, an explicit act,
audited. Share rows **survive** ownership flips in both directions; deleting
them silently is how access disappears on the flip back.

### Folders

`POST /folders` · `PATCH /folders/{id}` · `DELETE /folders/{id}` ·
`POST /folders/{id}/restore` · `DELETE /folders/{id}/permanent`

Depth is capped at **32**. A move is refused with `409` if the destination is
a descendant of the folder being moved (a cycle would hang every recursive
query afterwards) or if the subtree would exceed the cap. Trashing a folder
stamps **that row only**; its contents follow their ancestor, so restore is a
single un-stamp.

### Sharing

`GET|PUT|DELETE /files/{id}/shares[/{shareId}]` and the same for `/folders`.

`PUT` is an upsert — one grant per (item, audience), so re-sharing changes the
level rather than stacking rows. The audience is a named user **xor** the
whole organisation. **Changing** shares needs `owner` on personal items,
`edit` on organisational ones.

**Reading the list is a separate question with a stricter answer.** The share
list is personal data about the people on it — a file shared with thirty
parents carries, in its list, the addresses of twenty-nine other families
(Amit's ruling, 30 Aug 2026). So `GET`:

| Caller | Sees |
|---|---|
| the uploader; an organisation admin on an organisational item | every grant, and `canSeeEveryone: true` |
| anyone else with access | their own grant, plus any organisation-wide grant, and `canSeeEveryone: false` |
| no access | `403` |

`canSeeEveryone` exists because a short list is indistinguishable from a
complete one, and showing a partial list as if it were whole is the defect —
worse than omitting it. **There is deliberately no count of the others:** how
many people also have a file is itself a fact about them.

An organisation-wide grant is shown to everyone. It names a group rather than
a person, and no membership is stored that could be expanded into one. Space
has no other group audience today; when folder- or department-level sharing
arrives it inherits this rule rather than re-deciding it.

Folder shares reach contents **at query time** by walking ancestors. Grants
are never copied down, so "why can this person see this?" always has a
one-row answer.

### Stars

`PUT|DELETE /files/{id}/star`, `PUT|DELETE /folders/{id}/star` — `204`, and
**idempotent in both directions**. Stars are per-user and invisible to
colleagues, enforced by RLS rather than by application code.

### Organisation policy

| route | auth |
|---|---|
| `GET /settings` | any signed-in user |
| `PUT /settings` | OrgAdmin, audited |

`{ "allowPublicLinks": bool }`. The read is open because the mail composer has
to know whether links are allowed *before* spending someone's bytes on a 40 MB
upload it cannot then link. Turning it off closes the **tap, not the handle**:
the anonymous resolve predicate reads the flag, so existing links stop working
immediately — and reversibly, because the rows survive.

---

## Upload

`multipart/form-data`, fields **in this order**:

| field | notes |
|---|---|
| `folderId` **or** `scope` | destination |
| `sizeBytes` | declared size — the quota gate runs on it |
| `file` | **last**; streamed to the volume, never buffered |

The order is load-bearing: the gate runs the moment the file part appears, so
a doomed upload is refused before a byte is read. A `file` part arriving
before `sizeBytes` is a `400`. The stored `sizeBytes` is what actually
landed — the declared size is a claim.

Content inherits the destination's ownership. A file uploaded into a
colleague's shared personal folder belongs to that colleague, as in Drive, and
is charged to their allowance.

### Refusals — always `413`, never a 5xx

```jsonc
{ "error": "You have used all 30 GB of your storage…", "reason": "full" }
```

| reason | meaning |
|---|---|
| `full` | the person or the organisation is out of room — the sentence says which |
| `suspended` | the organisation is suspended |
| `no_allocation` | no allowance is set, or the destination folder's owner was removed |
| `file_too_large` | over the per-file cap |

A 5xx here would be wrong twice: clients and proxies retry 5xx, so a quota
refusal would re-stream a 2 GB upload, and it would land in error dashboards
as a platform fault rather than a customer condition.

**Whose bytes.** Personal content is charged to the person who will own the
file, read from `core.user_storage()` — the single definition of "how full is
this person" (`STORAGE_MODEL.md`). Organisational content draws on the org
pool and is never charged to a human. **Never compute this with a `SUM` in
application code**: two implementations of "is there room" eventually
disagree, and the one that refuses is the one the customer notices.

Trashed files still count until purged. The bytes are on the disk; a meter
that pretended otherwise would make "I deleted everything and I'm still full"
an unanswerable support ticket.

---

## Public links

A link is a **capability, treated as a credential**: 128 bits of randomness,
stored only as a SHA-256 hash. The plaintext exists once, in the response that
creates it. A database leak yields no working links.

| route | auth |
|---|---|
| `POST /files/{id}/link` | owner (personal) / edit (organisational) |
| `GET /files/{id}/links` | same — never returns tokens, only hashes exist |
| `DELETE /files/{id}/links/{linkId}` | same; revocation is a stamp, idempotent |
| `GET /api/space/l/{token}` | **anonymous** — the bytes |
| `GET /api/space/l/{token}/meta` | **anonymous** — the landing page's data, counts nothing |

Create takes `{ expiresInDays, maxDownloads }`. **Expiry is required** —
default 30 days, maximum 365 — because a link that never expires outlives the
reason it was made and nobody goes back to revoke it. The response is the only
place the token ever appears, and its `url` is the landing page, not the raw
API route.

### The anonymous path

There is no session, so `app.tenant_id` is unset and RLS cannot protect
anything. Every database access on this path goes through two
`SECURITY DEFINER` functions with a pinned `search_path` and **nothing else**:
`space.peek_public_link` (reads, counts nothing) and
`space.consume_public_link` (the atomic `UPDATE` **is** the check — the count
increments in the same statement that validates every condition, so
`max_downloads` cannot be raced past). Their gating predicates are textually
identical, comment for comment, so a reviewer can diff them.

**One failure answer.** Unknown, expired, revoked, over-limit, trashed file,
suspended tenant, and policy-disabled all return the same 404 and the same
sentence. The authenticated routes say "turned off for your organisation";
that sentence on this path would be an oracle.

**Always a download, never a rendered page.** `Content-Disposition:
attachment` and `X-Content-Type-Options: nosniff` on every byte response —
this origin holds sessions, and rendering a stranger's HTML from it would be
cross-site scripting against every Space user. No range processing: one GET is
one download is one count.

**A blob we lost does not cost the recipient a download.** If consume succeeds
and the bytes are then missing, the count is refunded and a **warning** is
logged naming `fileId`, `linkId` and `blobKey` — the file is gone, not the
link, and without that line the loss would be silent.

Per-IP rate limited (60/minute). The client is the **last**
`X-Forwarded-For` entry, which is the one Caddy appends; everything earlier is
client-supplied and spoofable.

---

## Thumbnails

`GET /files/{id}/thumbnail` — image mime types, longest edge ~256 px, webp.

Rendered with **SkiaSharp**, chosen on attack surface: thumbnails decode files
uploaded by strangers. Three layered defences, in order: a source byte cap,
then **pixel-dimension caps read from the image header before any pixel is
decoded** (a 200 KB PNG can decompress to gigabytes, so a byte cap alone is
theatre), then a decode timeout as the backstop.

`404` is the single answer for invisible, non-image, oversized and
undecodable alike. Cached beside the blob; the ETag hashes the blob key, so an
overwrite — which always writes a new key — invalidates it structurally rather
than by convention. Purging a file deletes its thumbnail with it.

This is a **machine read**: it never records activity, and neither does the
cross-product gateway. A composer listing your files must not fill Recent with
files you never opened.

---

## What other products call

`SpaceContentGateway`, injected — never HTTP, and never a second file store.
Full contract in `SPACE_ATTACH.md`.

| method | purpose |
|---|---|
| `DescribeAsync(ids)` | validate a batch before any bytes move |
| `OpenReadAsync(id)` | stream one file, as the signed-in user |
| `SaveAsync(...)` | store a stream — same quota gate, same reason codes |
| `EnsureFolderAsync(name, scope)` | find-or-create a root folder, oldest wins |

Everything runs on the caller's `TenantContext`, so a file the sender cannot
see behaves exactly as one that does not exist.

---

## The storage meter

There is no Space usage endpoint. The meter reads `GET /api/org/storage`,
which already reports per-product allocations — one product, one quota system,
one place to read it. The Space-specific figure the org endpoint cannot give,
reclaimable trash bytes, rides on `GET /trash`.

---

## Deliberately absent

Folder links; password-protected links (the column exists, unused); resumable
or presigned uploads; range requests on public downloads; virus scanning;
file version history (new-blob-on-overwrite means the history is recoverable
when it arrives); sync clients; in-file content search.

**Known gaps are catalogued in `SPACE_FAULT_MATRIX.md`** — paths whose
handling code has never executed. The honest summary of that document: the one
fault we built detection for is the only one that announces itself, and that
was not judgement, it was the one someone asked about.
