# Space API — public links addendum (v1.3 draft, FOR REVIEW)

> **SUPERSEDED by `SPACE_API.md`.** This shipped, and the live reference is
> now the single API document. Kept because the reasoning — and Core's
> review decisions recorded in it — are still the best account of *why*
> these endpoints are shaped the way they are. Where the two disagree,
> `SPACE_API.md` is right.

**Status: CONTRACT DRAFT.** Additions to SPACE_API.md for public download
links, per `docs/plans/LARGE_ATTACHMENTS.md`. Nothing is built before Core
has read this — his review of the unauthenticated path is line-by-line and
that is the right amount of paranoia. All eight of Core's decisions are
accepted as written; the two places this draft goes BEYOND the plan are
marked **[ADDITION]** so they cannot slip through unexamined.

Migration: `20260816-space-public-links.sql` (date-prefixed per the new
convention).

---

## Schema — `space.public_links`

| column | notes |
|---|---|
| `id` | uuid PK |
| `tenant_id` | FK core.tenants CASCADE; RLS |
| `file_id` | FK space.files CASCADE — the link follows the FILE; purge deletes the row |
| `token_hash` | text, SHA-256 hex of the token, UNIQUE. The plaintext exists once, in the create response — a database leak yields no working links (the MFA recovery-code rule) |
| `created_by_user_id` | FK core.users SET NULL |
| `expires_at` | timestamptz NOT NULL — expiry is REQUIRED |
| `max_downloads` | int nullable — null = unlimited |
| `download_count` | int NOT NULL default 0 |
| `password_hash` | text nullable, UNUSED in v1 — reserved so password protection is a feature later, not a migration |
| `revoked_at` | timestamptz nullable — revocation is a stamp, not a row delete: the count and the audit story survive |
| `created_at` | timestamptz |

RLS: ENABLE + FORCE, tenant-scoped policy for the authenticated management
endpoints. The anonymous path never touches the table under RLS — see below.

**The org kill-switch:** `core.tenants.allow_public_links boolean NOT NULL
DEFAULT true`, in the same migration (Core: shout if you want it living
somewhere else — the admin toggle UI is yours either way).

**[ADDITION] Kill-switch semantics: OFF kills EXISTING links, not just
creation.** The resolve predicate checks the flag, so flipping it off makes
every outstanding link 404 immediately — reversibly, since rows are kept. A
school that must stop documents leaving needs the tap closed, not just the
faucet handle removed. Flipping it back on revives unexpired links. If Core
wants off-means-only-no-new-links instead, say so now — it is one predicate
line, but it is a policy statement.

---

## Token

16 bytes from the CSPRNG (128 bits), base64url — 22 characters, no padding.
Stored only as SHA-256 hex. Lookup is by unique index on the hash (an
attacker must produce a preimage, not win a timing race); the comparison the
database does is still effectively constant-time, and no application code
ever compares token strings directly.

---

## Authenticated management

Level rule for all three: same as shares — `owner` on personal files,
`edit` on organisational. Trashed file → `409`. Tenant flag off →
`403 { "error": "Public links are turned off for your organisation." }`.

### `POST /api/space/files/{id}/link`

```jsonc
{ "expiresInDays": 30, "maxDownloads": null }   // both optional
// expiresInDays: default 30, min 1, max 365 — a link with no expiry
// outlives the reason it was made
```
```jsonc
// 201 — the ONLY time the token or url exists in a response
{
  "id": "uuid",
  "token": "u5cKq...22chars",
  "url": "https://space.tatvaos.com/l/u5cKq...",   // the LANDING page (Core's doorstep), not the raw API
  "expiresAt": "iso",
  "maxDownloads": null
}
```
Audited: `space.link.created`, productCode `drive`, target the file id.

### `GET /api/space/files/{id}/links`

```jsonc
// 200 — no tokens, ever; there is nothing to show, only hashes exist
{ "links": [ { "id", "createdByUserId", "createdByDisplayName",
               "expiresAt", "maxDownloads", "downloadCount",
               "revokedAt", "createdAt" } ] }
```

### `DELETE /api/space/files/{id}/links/{linkId}`

`204`. Sets `revoked_at`; idempotent on an already-revoked link.
Audited: `space.link.revoked`.

---

## The unauthenticated path — the dangerous one

Two endpoints, both `AllowAnonymous`, both rate-limited per IP (ASP.NET
rate limiter, fixed window, 60 requests/min/IP on this route group), both
with exactly ONE failure answer:

**`404 { "error": "This link does not exist or has expired." }`** — for
unknown, expired, revoked, over-limit, trashed file, suspended or deleted
tenant, and org-flag-off alike. No oracle. Never 403, never a distinct
message.

No session exists, `app.tenant_id` is unset, RLS cannot protect anything —
so the ONLY database access on this path is through two `SECURITY DEFINER`
functions with pinned `search_path`, and the API never issues another query:

```sql
-- Metadata, NO count increment. The shared predicate, SELECT-only.
space.peek_public_link(p_token_hash text)
  RETURNS TABLE (file_id uuid, name text, mime_type text, size_bytes bigint,
                 shared_by text, expires_at timestamptz)

-- Download: the atomic UPDATE IS the check — increments download_count
-- WHERE every condition of the SAME predicate holds, RETURNING the blob
-- key and metadata. No row returned = 404. No separate check-then-count
-- race; max_downloads cannot be overshot.
space.consume_public_link(p_token_hash text)
  RETURNS TABLE (blob_key text, name text, mime_type text, size_bytes bigint)
```

The predicate, verbatim in both (stated so review can diff them):
not revoked, not expired, `download_count < max_downloads` (or null),
file live (`deleted_at IS NULL`), tenant status in ('active','trial'),
tenant `allow_public_links`. Both functions take a HASH — the plaintext
token is hashed in the API and never reaches SQL as itself.

### `GET /api/space/l/{token}` — the bytes

- `consume_public_link` → stream from the blob store.
- **Every response**: `Content-Disposition: attachment` (the stored
  filename) and `X-Content-Type-Options: nosniff`. Non-negotiable —
  space.tatvaos.com holds sessions, and inline rendering of a stranger's
  HTML from this origin is XSS against every Space user.
- No range processing in v1 — a ranged download would multiply count
  increments; one GET = one download = one count.
- Blob missing after a successful consume (crash-window rarity): the count
  is already spent; answer is still 404. Stated, not hidden.
- Downloads are counted, not audited — per decision 7.

### **[ADDITION]** `GET /api/space/l/{token}/meta` — the doorstep's data

Core's landing page shows name, size, sharer, and a download button — it
needs those WITHOUT spending a download. `peek_public_link` (no increment)
returns:

```jsonc
// 200
{ "name": "Q3 deck.pptx", "sizeBytes": 41943040, "mimeType": "...",
  "sharedByDisplayName": "Amit Dadhich", "expiresAt": "iso" }
```

Same 404, same rate limit. `sharedByDisplayName` is exposed to the anonymous
internet — the plan's landing page says "who shared it", so this is
deliberate, but it is a name-disclosure decision and Core should confirm it
consciously. (Null if the creator's account is gone.)

---

## `SpaceContentGateway.EnsureFolderAsync` — for Mail

```csharp
Task<Guid> EnsureFolderAsync(string name, string scope = "personal", CancellationToken ct);
```

Root-level only in v1. Personal scope: finds the caller's live root folder
with exactly that name (oldest wins if duplicates exist — Drive allows
them); creates it with the standard ownership rules if absent. Idempotent
and safe under race: a concurrent double-create yields two folders only in
the same way two humans clicking simultaneously would, and the next call
settles on the oldest. Mail calls `EnsureFolderAsync("Email attachments")`
and never touches `space.folders` — the ownership rules stay in one place.

---

## Sequencing once approved

1. Migration (`public_links` + tenants flag + both definer functions).
2. Management endpoints + audit writes.
3. The anonymous pair, rate-limited — then STOP for Core's line-by-line
   review before it is ever deployed.
4. `EnsureFolderAsync` on the gateway (unblocks Mail's `to-space` in
   parallel with 3).

Branch: `feature/space-public-links`.

## Not in v1 (restating the plan so nobody builds them by accident)

Folder links; passwords (column only); resumable upload; download
notifications; per-download logging; range/resume on the public endpoint.
