# Family API — for the frontend

Contacts for TatvaOS. Everything lives under `/api/family` on the same API the
rest of the app already talks to, so `NEXT_PUBLIC_API_URL` needs no change and
neither does `lib/auth.tsx`.

In production `family.tatvaos.com` proxies `/api/*` to the same container, so
your calls stay same-origin there too. No CORS, no preflight, and the refresh
cookie keeps working.

> Save this file to `docs/FAMILY_API.md` in the repo.

---

## Before anything else: three things that will bite you

**1. British spelling in the JSON.** The codebase uses it throughout, so the
API does too:

```
isFavourite      not isFavorite
colour           not color
"organisational" not "organizational"
```

**2. Ownership is the whole model.** Every contact is one of two things:

- `"personal"` — belongs to one person. Their colleagues cannot see it, cannot
  search it, and get a **404** if they guess the id.
- `"organisational"` — belongs to the tenant. Everyone in it sees the contact.

You never send an owner id. The server takes it from the token. A contact
created without `ownershipType` is personal.

**3. A contact you cannot see is a 404, never a 403.** Answering "403 — that
exists but is not yours" would confirm the row exists, which is itself a
disclosure. Do not write UI that distinguishes the two.

---

## Auth

Identical to Mail. Send the access token from `useAuth()`:

```ts
const res = await fetch('/api/family/contacts', {
  headers: { Authorization: `Bearer ${token}` },
});
```

A 401 means the token expired; the existing single-flight refresh in
`lib/auth.tsx` already handles it. Switching accounts changes the tenant *and*
the person, so clear any cached contact list on switch.

---

## Start here

`GET /api/family/bootstrap` gives you everything the first screen needs in one
round trip.

```json
{
  "counts": { "total": 128, "personal": 104, "organisational": 24 },
  "groups": [ { "id": "…", "name": "Suppliers", "description": null, "colour": "#c2410c" } ],
  "settings": { "autoSaveReceived": true, "autoSaveSent": false, "autoSaveReply": true }
}
```

---

## Contacts

### List

```
GET /api/family/contacts?page=1&pageSize=50
                        &ownership=personal|organisational
                        &groupId=<uuid>
                        &favourite=true
```

`pageSize` is clamped to 200 rather than rejected — ask for 5000 and you get
200, not an error.

```json
{
  "total": 128,
  "page": 1,
  "pageSize": 50,
  "items": [
    {
      "id": "8f3c…",
      "displayName": "Priya Raman",
      "jobTitle": "Head of Procurement",
      "companyName": "Sundaram Steel",
      "primaryEmail": "priya@sundaramsteel.com",
      "ownershipType": "personal",
      "source": "auto_received",
      "isFavourite": false,
      "lastContactedAt": "2026-08-04T09:12:44Z",
      "interactionCount": 6,
      "updatedAt": "2026-08-04T09:12:44Z"
    }
  ]
}
```

`items[]` is the same shape from list, search and lookup, so one row component
covers all three.

`source` tells you whether a human typed this: `manual`, `import`, `api`,
`auto_received`, `auto_sent`, `auto_reply`. Worth surfacing — "42 contacts
were saved automatically, review them?" is a good screen to have.

### One contact

```
GET /api/family/contacts/{id}
```

The summary fields plus `firstName`, `lastName`, `nickname`, `notes`,
`createdAt`, and four arrays: `emails`, `phones`, `addresses`, `groups`.
Emails and phones come primary-first.

### Create

```
POST /api/family/contacts
{
  "displayName": "Priya Raman",        // the only required field
  "firstName": "Priya",
  "lastName": "Raman",
  "jobTitle": "Head of Procurement",
  "companyName": "Sundaram Steel",
  "notes": "Met at the Chennai expo",
  "isFavourite": false,
  "ownershipType": "personal",         // or "organisational"
  "email": "priya@sundaramsteel.com",  // optional, becomes primary
  "emailType": "work",
  "phone": "+91 98765 43210",          // optional, becomes primary
  "phoneType": "mobile"
}
```

`201` with `{ "id": "…" }`.

**Handle the 409.** If the address already belongs to someone, you get:

```json
{
  "error": "duplicate_email",
  "message": "priya@sundaramsteel.com already belongs to Priya R.",
  "contactId": "8f3c…"
}
```

That `contactId` is there so you can offer "open the existing contact" instead
of showing a dead end. The server refuses rather than silently merging,
because a merge edits a row the person has not seen.

Duplicates are matched on the **normalised** address, not the literal one:
`Priya.Raman+quotes@gmail.com` and `priyaraman@gmail.com` are the same person.
Dots are folded for Gmail only; `+tags` are stripped everywhere.

### Update

```
PATCH /api/family/contacts/{id}
{ "jobTitle": "Director of Procurement", "isFavourite": true }
```

Send only what changed. `204` on success, and also `204` when nothing actually
differed — no audit row is written for a no-op edit.

Setting `"ownershipType": "organisational"` shares a personal contact with the
tenant. **This is one-way.** Going back returns `409` with an explanation: it
would have to name a new owner and the API cannot guess who. Make the button
say "Share with organisation" and confirm it.

Only the owner can share. Anyone else gets `403`.

### Delete

```
DELETE /api/family/contacts/{id}
```

`204`. Soft delete — the contact vanishes from every list and search, its
audit trail stays readable, and auto-save will not resurrect it from the next
message. That last part is deliberate: deleting is how someone says "stop
saving this person".

---

## Finding people

### Search

```
GET /api/family/contacts/search?q=priya&limit=50
```

Full text across name, company and job title, plus a prefix match on display
name and email. Returns the summary array directly — no envelope. Empty `q`
returns `[]` rather than an error, so you can bind it straight to an input.

### Autocomplete

```
GET /api/family/contacts/autocomplete?q=pri&limit=10
```

For the recipient picker. Prefix only, capped at 25, tuned for latency rather
than relevance:

```json
[ { "contactId": "8f3c…", "email": "priya@sundaramsteel.com", "displayName": "Priya Raman" } ]
```

One row per **address**, not per contact — someone with two addresses appears
twice, which is what you want in a picker.

### Lookup by address

```
GET /api/family/contacts/lookup?email=priya@sundaramsteel.com
```

`200` with one summary, or `404`. Use it to put a name against a sender in the
message view. Normalised, so any alias of the same Gmail account finds it.

Branch on the status code, not the body.

---

## Addresses and numbers

```
POST   /api/family/contacts/{id}/emails      { "email": "…", "type": "work", "isPrimary": true }
DELETE /api/family/contacts/{id}/emails/{emailId}
POST   /api/family/contacts/{id}/phones      { "phone": "…", "type": "mobile", "isPrimary": true }
DELETE /api/family/contacts/{id}/phones/{phoneId}
```

`type` is `work` | `personal` | `other` for email, `mobile` | `work` | `home` |
`other` for phone. Setting `isPrimary` demotes the previous primary.

Adding an address that is already on **this** contact returns `204` — it is a
no-op, not an error. Adding one that belongs to a **different** contact
returns the same `409` shape as create.

---

## History

```
GET  /api/family/contacts/{id}/interactions?limit=50
POST /api/family/contacts/{id}/interactions
     { "type": "call_outbound", "subject": "Quote follow-up", "notes": "…",
       "occurredAt": "2026-08-10T11:00:00Z" }
```

`type` is one of `email_received`, `email_sent`, `call_inbound`,
`call_outbound`, `meeting`, `note`, `other`. Anything else is a 400 listing
the valid values.

Logging one bumps the contact's `lastContactedAt` and `interactionCount`, so
refetch the contact after posting.

Email interactions carry `mailMessageId`, which you can link straight into the
Mail client.

```
GET /api/family/contacts/{id}/audit?limit=100
```

Who changed what, newest first. `changes` is a JSON string —
`{"jobTitle":{"old":"…","new":"…"}}` — or null for create and delete. Works
for deleted contacts too, which is the point of the soft delete.

---

## Groups (labels)

```
GET    /api/family/groups
POST   /api/family/groups                             { "name": "Suppliers", "colour": "#c2410c" }
PATCH  /api/family/groups/{groupId}                   { "name": "Vendors" }
DELETE /api/family/groups/{groupId}
PUT    /api/family/groups/{groupId}/members/{contactId}
DELETE /api/family/groups/{groupId}/members/{contactId}
```

Groups are tenant-wide and the name is unique within a tenant. Adding a member
is a `PUT` and is idempotent — calling it twice succeeds. Deleting a group does
not delete its contacts.

`GET /groups` returns a count with each one:

```json
[{ "id": "…", "name": "Suppliers", "description": null,
   "colour": "#c2410c", "count": 12 }]
```

`count` is **live contacts only** — anything in the Bin is excluded, so the
number agrees with what you see after clicking through to
`GET /api/family/contacts?groupId=…`.

`PATCH` takes any subset of `name`, `description` and `colour`. An absent field
is left alone; an empty string clears it. A name that collides is a 409 with a
readable `message`, not a constraint violation.

**Rename, never delete-and-recreate.** Every membership row points at the
group id. Recreating a label with the same name gives you a new id and an empty
label, and the contacts that were in it are simply no longer in anything.

Filter the contact list by group with `GET /api/family/contacts?groupId=…`.

### Labelling many contacts at once

```
POST /api/family/contacts/labels
```

```jsonc
// an explicit selection
{ "contactIds": ["…", "…"], "add": ["groupId"], "remove": ["groupId"] }

// or everything matching a filter — the same one the list route was showing
{ "all": true, "ownership": "personal", "groupId": "…",
  "favourite": false, "source": "auto", "add": ["groupId"] }
```

```json
{ "contacts": 1499, "added": 1451, "removed": 0 }
```

`contacts` is how many were touched; `added` and `removed` count membership
rows, so labelling 100 contacts with a label half of them already carried
reports 50. Adding a label a contact already has is a success, not a conflict.

**Do not call the single-member routes in a loop.** 1,499 round trips is not a
feature, it is a hang.

`all` re-runs the same server-side filter the list route ran — one shared
`ContactFilters.Apply` — so "select all 1,499 matching" changes exactly the
1,499 the screen was counting. It deliberately does **not** understand the
search term: full-text search runs on a different path, so the UI must hide
"select all matching" while a search is active, which it does.

Ids the caller cannot see are silently absent from the result rather than
reported, because "3 of your 5 ids were not found" confirms that two contacts
exist somewhere. Unknown label ids are dropped for the same reason a stale menu
should not fail a 1,499-contact operation. The limit is 10,000 contacts per
call; above that it is a 400 asking you to narrow the filter.

Not audited — and consistently so: the single-member routes do not write audit
rows either. A label is a view over contacts rather than a change to one.

---

## Settings

```
GET /api/family/settings
PUT /api/family/settings
    { "autoSaveReceived": true, "autoSaveSent": false, "autoSaveReply": true }
```

`PUT` replaces all three; send the full object.

What they mean, in the words the settings screen should probably use:

- **autoSaveReceived** — save people who write to me. Default **on**.
- **autoSaveSent** — save people I write to. Default **off**, because every
  one-off recipient would otherwise land in the address book.
- **autoSaveReply** — keep the "last contacted" date fresh for people I
  already have. Default **on**.

Auto-saved contacts are always personal. A message arriving in one person's
mailbox says nothing about who the organisation knows.

---

## Import and export

```
GET  /api/family/contacts/export?format=csv|vcf
     &ownership=personal|organisational  &groupId=…  &source=auto|manual  &favourite=true
POST /api/family/contacts/import?dryRun=true
     &ownership=personal|organisational  &mode=skip|update
     &createLabels=true|false  &label=Imported%202026-08-11
```

### Export

Returns the file, not JSON — `text/csv` or `text/vcard`, with a
`Content-Disposition` naming it `tatvaos-contacts-<date>.csv`.

It needs the `Authorization` header, so **it cannot be an `<a href>`**. Fetch
it, take the blob, and hand that to the browser:

```ts
const { blob, name } = await familyApi.exportFile(authedFetch, { format: 'csv' });
saveBlob(blob, name);                     // both are exported from lib/family
```

`Content-Disposition` is only readable by JavaScript when the API is
same-origin or explicitly exposes the header, so `exportFile` computes a
fallback name. Do not rely on the header.

The filters are the same ones the list route takes, so "export what I am
looking at" is the same query object. Above 20,000 rows the request is refused
with a 400 telling the caller to narrow it — that is a real answer to show, not
an error to swallow.

Deleted contacts are never exported. Photos and birthdays are not in the file
because neither is stored yet.

### Import

`multipart/form-data` with one file part, or the raw file as the body. CSV or
vCard; the format is worked out from the extension and then from the content,
not from what the browser claims. 10 MB and 5,000 rows per file.

**Always call it with `dryRun=true` first.** The response is identical apart
from `dryRun`, and nothing is written. The UI should refuse to run a real
import the person has not seen a report for — this is the single most useful
thing this screen does.

```jsonc
{
  "dryRun": true,
  "fileName": "contacts.csv",
  "format": "csv",              // or "vcard"
  "rowsRead": 512,
  "created": 470,               // would be added
  "updated": 0,                 // would be filled in — only when mode=update
  "skipped": 42,
  "warnings": ["47 birthdays were found in this file and not imported — …"],
  "problems": [
    { "row": 14, "name": "Priya Sharma", "email": "priya@acme.com",
      "outcome": "skipped", "reason": "priya@acme.com is already saved as Priya S.",
      "contactId": "…" }
  ],
  "problemsTruncated": false,   // problems is capped at 500; the counts are not
  "sample": ["Anil Kumar <anil@…>", "…"]   // first 25 that would be added
}
```

Every row that does not become a contact appears in `problems` with a reason
written for a person. Show them. An import that says "470 imported" and says
nothing about the other 42 is how somebody discovers a missing supplier three
months later with no file left to re-run.

`mode`:

- **skip** (default) — a row whose address is already in the book is left
  alone and reported.
- **update** — that contact has its blanks filled in and gains any addresses
  and numbers it lacked. Nothing already filled in is ever overwritten, and
  postal addresses are only added when the contact has none.

`label` tags everything in the file. Keep it set and keep it in the UI: it is
the only bulk undo an import has.

Duplicate detection uses the same `NormaliseEmail` rule as auto-save, so an
import cannot let in an address that mail would have folded into an existing
contact. Duplicates *within* one file are caught too, and reported pointing at
the earlier row.

### What the importer understands

Column names are matched against a table of aliases, so a Google export
(either generation), an Outlook export and an Apple one all work unedited:

| Ours | Also accepted |
|---|---|
| Name | Display Name, Full Name, Contact Name |
| First Name | Given Name |
| Last Name | Family Name, Surname |
| Organization Name | Company, Organisation, Organization 1 - Name |
| Organization Title | Job Title, Position, Role — **not** "Title", which is Mr/Ms in Outlook |
| Labels | Group Membership, Categories, Tags |
| E-mail *n* - Value | E-mail *n* - Address, E-mail Address, E-mail *n* Address |
| Phone *n* - Value | Phone *n* - Number, Mobile Phone, Home Phone, Business Phone … |
| Address *n* - Street | Home Street, Business Street, and the City/Region/Postal Code/Country siblings |

Also handled without being asked: a semicolon or tab delimiter (Excel writes
the locale's list separator), a UTF-8 or UTF-16 byte-order mark, a legacy
single-byte encoding, Google's `:::` multi-value cells, and quoted cells
containing commas and newlines.

vCard 2.1, 3.0 and 4.0 are read, including quoted-printable bodies and folded
lines. vCard 3.0 is written, because it is the one version every phone and
mail client imports without complaining.

---

## Status codes

| Code | Meaning |
|---|---|
| 200 | Body follows |
| 201 | Created — `{ "id": … }`, `Location` header set |
| 204 | Done, nothing to return. Also: nothing needed doing |
| 400 | Malformed |
| 401 | Token missing or expired — refresh and retry |
| 403 | Only on the share-a-contact route |
| 404 | Not there, or not yours. Do not distinguish |
| 409 | Duplicate address, duplicate group name, or an illegal ownership change |
| 422 | Validation — `errors` keyed by field, standard ProblemDetails |

---

## A typed client

```ts
export type Ownership = 'personal' | 'organisational';

export type ContactSummary = {
  id: string;
  displayName: string;
  jobTitle: string | null;
  companyName: string | null;
  primaryEmail: string | null;
  ownershipType: Ownership;
  source: 'manual' | 'import' | 'api' | 'auto_received' | 'auto_sent' | 'auto_reply';
  isFavourite: boolean;
  lastContactedAt: string | null;
  interactionCount: number;
  updatedAt: string;
};

const family = {
  list: (p: { page?: number; ownership?: Ownership; groupId?: string } = {}) =>
    get<{ total: number; page: number; pageSize: number; items: ContactSummary[] }>(
      `/api/family/contacts?${new URLSearchParams(p as never)}`),

  search: (q: string) =>
    get<ContactSummary[]>(`/api/family/contacts/search?q=${encodeURIComponent(q)}`),

  // 404 is a normal answer here, not a failure.
  lookup: async (email: string): Promise<ContactSummary | null> => {
    const r = await authed(`/api/family/contacts/lookup?email=${encodeURIComponent(email)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`lookup failed: ${r.status}`);
    return r.json();
  },

  // The 409 carries the id of the contact that already holds the address —
  // surface it as "open the existing contact", not as an error toast.
  create: async (body: CreateContact) => {
    const r = await authed('/api/family/contacts', { method: 'POST', body: JSON.stringify(body) });
    if (r.status === 409) {
      const { message, contactId } = await r.json();
      throw new DuplicateContact(message, contactId);
    }
    if (!r.ok) throw new Error(`create failed: ${r.status}`);
    return r.json() as Promise<{ id: string }>;
  },
};
```

---

## Screens worth building first

1. **The list** — `/bootstrap` then `/contacts`. Split personal and
   organisational; the counts are already in bootstrap.
2. **The picker** — `/autocomplete` in the Mail composer. The fastest way to
   make Family feel worth having.
3. **Sender identification** — `/lookup` in the message view. Name and company
   instead of a bare address.
4. **The auto-saved review** — filter on `source` starting `auto_`. People will
   want to prune these, and giving them the tool is what stops auto-save
   feeling like clutter.
5. **Settings** — three switches, worded as above.

---

## Known gaps

**Merge does not exist.** Duplicates are refused at creation, but two contacts
that turn out to be the same person cannot be joined. Do not build a "merge"
button yet.

**Demote is refused by design** — 409, with a reason string you can show.

**Non-Gmail dot variations still make two contacts.** `first.last@corp.com`
and `firstlast@corp.com` are treated as different people, because for most
providers they are.

**Birthdays are parsed on import and thrown away.** `family.contact_dates`
exists in SQL and has no entity behind it yet, so a file carrying birthdays
produces a warning in the report rather than dates in the database. The warning
tells the person to keep the original file, which is the honest thing to do
until the entity lands.

**Export is not audited.** `family.contact_audit_logs` needs a contact id per
row, so there is nowhere to record "somebody exported the directory". If that
matters for your compliance story it wants its own small table.
