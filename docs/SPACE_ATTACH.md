# Attach from Space — the cross-product contract

**Status: CONTRACT.** The gateway exists and builds; nothing calls it yet.
This is what the Mail lane and the frontend build against. Space backend
owns `SpaceContentGateway`; Mail owns its send path; frontend owns the
picker. Written against `feature/space-schema` after the Space MVP shipped.

The point, restated from the backend brief: **"attach from Space" works
everywhere and no product ever builds its own file store again.** Mail is
the first caller; Family's contact photos are the second; the pattern is
the product.

---

## The gateway (what other products inject)

`TatvaOS.Api.Modules.Space.SpaceContentGateway` — registered scoped. It runs
as the signed-in user: the caller's `TenantContext`, the caller's RLS. A file
the sender cannot see behaves exactly like one that does not exist. Do not
wrap it in anything that widens that.

```csharp
// Validate a batch up front — returns only the ids that resolved.
Task<IReadOnlyList<SpaceContentInfo>> DescribeAsync(ids, ct);
// SpaceContentInfo: FileId, Name, MimeType, SizeBytes

// Open one file's bytes. Null = missing / trashed / not yours / bytes gone
// (indistinguishable, deliberately). Caller owns and disposes the Stream.
Task<SpaceContent?> OpenReadAsync(fileId, ct);

// The reverse direction — store a stream as a new Space file.
// Same quota gate as uploads; reasons match the upload endpoint's 413 set
// (full | suspended | no_allocation | file_too_large) plus no_folder /
// no_access / bad_scope / no_user.
Task<SaveOutcome> SaveAsync(stream, fileName, mimeType, declaredBytes,
                            folderId?, scope = "personal", ct);
```

---

## Mail lane — attaching on send

1. The send request gains one field alongside uploaded attachments:

```jsonc
{ ...existing send shape..., "spaceFileIds": ["uuid", "uuid"] }
```

2. Before building MIME, call `DescribeAsync(spaceFileIds)` and diff. Any id
   that did not resolve fails the whole send with a `400` and a sentence the
   console can print verbatim, naming what the CALLER knows: the position or
   id, not internals — e.g. `{ "error": "One of the attached Space files is
   no longer available. Remove it and try again." }`. Never silently send
   with fewer attachments than the person chose.

3. Size check BEFORE bytes move: `sum(SizeBytes) + uploaded attachments`
   against Mail's own message-size limit. A Space attachment becomes an
   email copy the moment it is sent — it counts against MESSAGE limits, not
   Space quota, and the bytes leaving the platform is the point.

4. Build each part with `OpenReadAsync` and STREAM it into the MIME body
   (MimeKit takes a stream). Never buffer a whole attachment — the same rule
   as Space's own upload path, for the same container-killing reason.

5. The sent copy filed in the mailbox contains the bytes, as today. The
   Space file is not referenced afterwards — deleting it later must not
   damage sent mail.

Failure mid-send: `OpenReadAsync` returning null at step 4 after passing
step 2 is a race (file trashed mid-send) — fail the send the same way as
step 2, don't skip the part.

## Mail lane — "save attachment to Space" (second step, same contract)

An endpoint on Mail's side (it owns the attachment bytes) that streams an
attachment into `SaveAsync(..., scope: "personal")` and returns the created
file's id, so the UI can link straight to it. Refusals map to the same 413 +
reason shape Space's upload uses — the frontend already branches on it.

---

## Frontend — the picker

No new API. The composer's "attach from Space" dialog is a thin reuse of:

- `GET /api/space/list?scope=...` / `?folderId=...` — browse, breadcrumb
  included, `myPermission` per row (anything visible is attachable — view is
  enough to send a copy).
- `GET /api/space/search?q=...` — name search.
- `GET /api/space/shared` — the shared-with-me tab.

Chips for chosen files show `name` + `sizeBytes` from the DTOs; the send
request carries just the ids.

---

## Deferred, deliberately

- **Link-instead-of-copy for internal TatvaOS→TatvaOS mail** — real saving,
  needs Mail-side design (what happens when the file changes or the
  recipient loses access AFTER delivery must be answered first).
- **Virus scanning at the gateway** — belongs where the Mail lane's
  ClamAV work lands, one scanner for both products, not two.
- **Shared-folder (edit-grant) destinations in `SaveAsync`** — refused for
  now with reason `no_access`; the ancestor-grant walk moves into the
  gateway when a product needs it.
