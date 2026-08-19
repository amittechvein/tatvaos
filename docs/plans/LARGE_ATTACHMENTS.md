# Large attachments — plan

**Problem.** A 40 MB file cannot be emailed. Today Mail refuses it. The fix is
Google's: put the file in Space and send a link. The link is the hard part.

**The blocker, confirmed.** `space.shares` can address a `core.users` row in
this tenant, or the whole tenant. Nothing else — the CHECK constraint says so
and there is no token concept anywhere in the schema. So a link mailed to
someone outside the organisation lands them on a sign-in wall for an
organisation they do not belong to.

That is worse than the problem it replaces. "Your attachment is too big" is an
inconvenience the sender can act on; a link that looks sent and does not open
is a failure the sender only learns about from an annoyed recipient. **Nothing
ships until the link works for a stranger.**

---

## The decisions, made now

These are Core's calls because an unauthenticated read of tenant data is the
riskiest thing in the platform, and because two products depend on the answers.

**1. A link is a capability, and it is treated like a credential.**
128 bits of randomness, stored as a SHA-256 hash. The plaintext token exists
once, in the response that creates it. A database leak must not yield working
links — the same reason MFA recovery codes are hashed.

**2. Expiry is required, not optional.** Default 30 days, maximum one year. A
link that never expires outlives the reason it was made, and nobody goes back
to revoke it.

**3. Files only, download only.** No folder links in v1: a folder link is a
*listing*, which is a much larger surface, and nobody needs it for an email
attachment.

**4. The response is always a download, never a rendered page.**
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`. This is
not politeness — `space.tatvaos.com` holds our own sessions, and rendering
attacker-supplied HTML from that origin is cross-site scripting against every
Space user. A file uploaded by anyone, served inline from our domain, is the
whole attack.

**5. An organisation can forbid them.** A per-tenant setting, default on. A
school that must not have documents leaving by link needs to be able to say
so, and needs to be able to say it once rather than per file.

**6. The link follows the file, not the folder.** Keyed on file id, so moving
the file does not break the link. A trashed file's link 404s; purge deletes
the row.

**7. Downloads are counted, not individually audited.** Creation and
revocation go to `core.audit_logs` with `productCode: "drive"`. Logging every
download of a widely-shared file is a firehose that buries the two rows that
matter.

**8. Password protection is v2 — but the column exists in v1.** Nullable
`password_hash` from the start, so adding it later is a feature, not a
migration plus a rewrite of the resolve path.

---

## Who builds what

### Space (backend)

1. **Contract addendum first** (v1.3), reviewed before code — the pattern that
   has worked twice.

2. **Migration** `space.public_links`:
   `id, tenant_id, file_id, token_hash, created_by_user_id, expires_at,
   max_downloads (nullable), download_count, password_hash (nullable),
   revoked_at, created_at`.

3. **Authenticated management**
   - `POST /api/space/files/{id}/link` → `{ token, url, expiresAt }` (token
     returned ONCE), requires `owner` or `edit`
   - `GET /api/space/files/{id}/links` → existing links, no tokens
   - `DELETE /api/space/files/{id}/links/{linkId}` → revoke

4. **The unauthenticated resolve** — the dangerous one.
   `GET /api/space/l/{token}` streams the bytes.
   It has **no session**, so `app.tenant_id` is unset and RLS cannot help. It
   must resolve through a `SECURITY DEFINER` function with a pinned
   `search_path` that takes a token hash and returns file + tenant, after
   which the API sets tenant context explicitly for the byte read. Written
   carefully or not at all: this is the one endpoint on the platform where a
   mistake is readable by the internet.
   Also needs: per-IP rate limiting, constant-time token comparison, and 404
   (never 403) for expired, revoked, over-limit, trashed and unknown alike —
   one answer, no oracle.

5. **`EnsureFolderAsync` on `SpaceContentGateway`** — so Mail never inserts
   `space.folders` rows itself. Their own gateway comment argues this; Mail is
   right to refuse to duplicate ownership rules.

### Mail (backend)

1. **`POST /api/mail/attachments/to-space`** — takes the oversize file,
   ensures the person's *Email attachments* folder via the gateway, saves
   through `SaveAsync`, returns id/name/size. One file path, one quota gate.

2. **Compose-time pre-check.** The upload spends the sender's personal
   allowance, which since the storage change is shared with their mail and
   files. Over the limit must say the true thing — "this would put you over
   your 30 GB" — not a generic failure, and it must be said at attach time,
   not at send time.

3. **On send**: create the link with the chosen expiry and insert it into the
   body as a named block, not a bare URL.

### Core — mine

1. **The public landing page** `space.tatvaos.com/l/{token}`: file name, size,
   who shared it, a download button. No app shell, no session, no navigation
   into Space. It is a doorstep, not a door.

2. **Share dialog gains "Anyone with the link"** — with expiry, copy, and
   revoke, alongside the existing Restricted / Everyone-in-the-organisation.
   The dialog already has the shape; this is a third audience.

3. **Admin policy toggle** in the org console: allow or forbid public links.

4. ~~**Compose UI** (the Mail client is my lane): the over-size prompt, the
   "upload to Space instead" flow, the tray reuse, and the block that appears
   in the body.~~

   **WRONG, AND CORRECTED 19 August 2026 — this is Mail's, and it is built**
   (`feature/mail-large-attachments`).

   This item and Mail's items 2 and 3 above describe the same work. A
   compose-time pre-check that must fire "at attach time" can only exist in
   the composer, so item 2 hands Mail the file this item claims for Core.
   Both developers read the document, reached opposite conclusions, and the
   work was built twice. Neither misread it: it said both, and I wrote it.

   The boundary is now a file list rather than the sentence "the Mail client
   UI is Core's", which had no test attached and could not be followed. See
   `docs/WORKING_IN_LANES.md` §5a — `components/mail/*` is Mail's.

   What stays Core's on this feature: the landing page (1), the share-dialog
   audience (2), the admin toggle (3), and the security review (5).

5. **Security review of the unauthenticated path before it ships.** Not a
   formality — I will read that endpoint line by line.

---

## Sequence

1. Space writes the contract addendum → I review it.
2. Space builds the schema, the management endpoints and the resolve endpoint.
3. I build the landing page and the share-dialog audience, against the
   contract, in parallel.
4. Mail builds `to-space` + the pre-check once `EnsureFolderAsync` exists.
5. I build the compose flow.
6. End-to-end test that matters: **send a 40 MB file from `@tatvaos.com` to a
   Gmail address and open it in a browser with no TatvaOS session.** Nothing
   is done until that works.

## Not in v1, deliberately

Folder links; password-protected links; resumable/chunked upload for very
large files (its own addendum, when someone hits the ceiling); "download
notification to the sender"; link analytics beyond the counter.
