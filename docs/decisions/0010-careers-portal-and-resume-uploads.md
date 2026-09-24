# 0010 — The public careers portal and résumé uploads

**Status:** proposed — for Mr. Singh's ruling
**Date:** 2026-09-24
**Lane:** Hire & People

## Context

Hire R1 so far (PRs #260, #262, #264 merged; #267 open) is entirely behind
sign-in: job openings, the hiring team, candidates, applications and the
pipeline. The roadmap's R1 also includes a **careers portal**: a public page
per organisation listing its open jobs, where a stranger applies and uploads a
résumé. That is the first unauthenticated, file-accepting surface TatvaOS has
ever run (roadmap §6.2, Hire & People welcome §3.1), and it is why résumés and
the portal were deliberately left out of #267.

### Decisions already made — not reopened here

- **Our domain first** (Amit, 24 Sept). The portal lives on a TatvaOS address.
  Customer domains (`careers.<customer>.com`, on-demand certificates, the
  fail-closed `ask` endpoint, the DNS screen) come later and get their own
  record. Nothing below needs a certificate for a domain we do not own.
- **Retention** (Amit, 24 Sept): rejected and withdrawn candidates are kept
  **six months after the decision**, then **deleted automatically**. Each
  organisation may shorten this; keeping someone longer (a talent pool) needs
  that candidate's **recorded consent**. **Automatic deletion must exist before
  the portal opens** — erasure on request only was acceptable while there were
  no applicants from the public.
- **Erasure requests** (Amit, 24 Sept): handled by each organisation's
  **owner** unless they name someone else, with a **30-day** reply.
- **A lawyer confirms** the six months and the 30 days, through Mr. Singh,
  **before the portal goes public**. The notice wording candidates see (§4)
  comes to Mr. Singh before any candidate sees it.

### What exists today (read 24 Sept, main `c4abfe4`)

| | Today |
|---|---|
| File storage | `IBlobStore` → `FileSystemBlobStore` (`Modules/Space/BlobStore.cs`), root `Space:BlobRoot`, volume `spaceblobs`. Keys are `{tenant}/{yyyy}/{MM}/{guid}` — random, never the filename. Writes go to `.part` then move; the size cap is enforced on bytes actually received. Downloads are streamed by the API (`nosniff`, `Content-Disposition: attachment` on public links). **No content sniffing**: Space stores the client-declared type. No S3/object storage. |
| Virus scanning | A clamd client exists (`Modules/Mail/ClamAvScanner.cs`; verdict `clean`/`infected`/`error`, never falls back to clean) and an attachment scan worker. **No ClamAV service is deployed** — `Mail__ClamAv` is empty in compose. Nothing scans anything in production. |
| Bot protection | **None.** No CAPTCHA, Turnstile, hCaptcha or honeypot anywhere. Per-IP rate limits only (rightmost `X-Forwarded-For`, fixed one-minute windows, `Program.cs:460-643`). |
| Public tenant resolution | Always by an unguessable token through a `SECURITY DEFINER` resolver (`space.peek_public_link`, `connect.resolve_meeting_code`). **`core.tenants` has no slug** — nothing today names an organisation in a public URL. |
| Routing | One Caddy fragment per product domain (`conf.d/space.caddy` shape) plus a `product-doors.caddy` redirect. **No `hire.caddy`, no `HIRE_DOMAIN`.** Caddy has no request-body size limit. |
| Mail to strangers | `SystemMailer` can send to any address (Connect minutes already do). **Production outbound still depends on Linode lifting the SMTP block** (`Notify.cs:16`). |
| Scheduled deletion | Pattern exists: a `SECURITY DEFINER` sweep function with its window inside, called from an existing worker (`core.sweep_handoff_codes`, Connect recording retention). |

## Proposal, in eight parts — each numbered for a ruling

### 1. The address

`https://hire.tatvaos.com/careers/{site}` lists an organisation's open jobs;
`/careers/{site}/{job-slug}` is one job and its application form.

- `{site}` is a **new Hire-owned table**, `hire.careers_sites` — `tenant_id`,
  `slug` (unique across the platform, lower-case letters, digits, hyphens),
  `is_enabled` (default **false**), the organisation's display name as shown,
  the erasure contact (§6), and a retention override (§5). **Not a column on
  `core.tenants`**: a public name is a Hire decision, and a tenant without
  Hire must not have one.
- The admin chooses the slug on a Hire → Careers page and switches the site
  on. Default suggestion: the organisation's free `<org>.tatvaos.com` label,
  which is already unique and already public.
- **Resolution** by `hire.resolve_careers_site(p_slug)` — `SECURITY DEFINER`,
  pinned `search_path`, returns `tenant_id` **only when `is_enabled`**. A
  disabled or unknown site answers the same 404. The API then sets the tenant
  context exactly as the Space and Connect public paths do.
- `{job-slug}` already exists: minted at first publish, ten random
  characters, never from a draft title (#262). Only **open** jobs resolve;
  on-hold and closed jobs answer the same 404 as a job that never existed.
- **Public fields only**, from an explicit projection: title, location name,
  employment type, experience range, qualification, skills, vacancies,
  description / responsibilities / requirements (**plain text, rendered as
  text** — the standing principle from #262), closing date, and the salary
  range **only if `show_salary`**. Never the hiring manager, recruiter,
  department ids or counts of applicants.
- Caddy: a `hire.caddy` fragment and `HIRE_DOMAIN`, by analogy with
  `space.caddy`; `/careers/*` and `/api/public/careers/*` need no session.
  This touches compose and Caddy, so it is **a `deploy`-area change for your
  review in its own PR**.

**Ruling needed (1):** `hire.careers_sites` with an admin-chosen, platform-unique
slug, off by default — or something else?

### 2. Accepted files

- **PDF and DOCX only.** Not `.doc` (old binary format), not `.docm` / macro-
  enabled, not images, not archives.
- **Decided from the bytes, never the name or declared type.** PDF: `%PDF-`
  magic. DOCX: a ZIP whose `[Content_Types].xml` declares
  `wordprocessingml.document.main+xml` and **no** `vbaProject` part (a `.docx`
  renamed from `.docm` is refused). Anything else: refused with a sentence.
  This is the "sniffed from magic bytes, SVG always refused" rule already
  applied to OIDC logos (#171), extended to two formats.
- **5 MB per file, one file per application.** Enforced on bytes received
  (`FileSystemBlobStore` already does), with the endpoint's Kestrel body cap
  at 6 MB and — new — a Caddy `request_body max_size` on the apply route, so
  an oversized body is refused before it reaches the API.
- **Never converted, rendered, previewed or parsed on the server** in R1. No
  PDF thumbnailing, no text extraction for search, no "view in browser". Each
  of those is a parser handed a stranger's file; they come later, behind the
  scanner, with their own review. Recruiters **download** the file.

**Ruling needed (2):** PDF + DOCX, 5 MB, sniffed, never parsed in R1?

### 3. Where the files live, and who can fetch them

- `IBlobStore`, but a **separate root and volume, `hireblobs`**, not
  `spaceblobs`. Space's quota, trash purge and orphan sweep must never touch a
  résumé, and retention deletion (§5) must be able to delete every file of a
  candidate without reasoning about Space.
- Key: `{tenant}/{yyyy}/{MM}/{guid}` as Space, random, never the filename.
  The original filename is stored **as data**, cleaned (`Path.GetFileName`,
  control characters stripped, 200 chars), and used only in
  `Content-Disposition` on download.
- **`hire.candidate_files`** — `tenant_id`, `candidate_id`, `application_id`,
  blob key, size, detected type, SHA-256, **`scan_status`**
  (`pending` / `clean` / `infected` / `error`), timestamps. FORCE RLS,
  composite FKs, reached only through `HireAccess` (the structural gate, #264).
- **Download**: streamed by the API through
  `HireAccess.Applications(level)` — so a hiring manager fetches only résumés
  for their own jobs — with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
  'none'; sandbox`, and **only when `scan_status = clean`**. `pending` and
  `error` are not served: the Mail rule (serve `pending`) is not carried over.
- Every download writes a `candidate_file.downloaded` audit row — id only, no
  name (the #267 rule).

**Ruling needed (3):** separate `hireblobs` volume; download only when clean?

### 4. Virus scanning — the one real infrastructure change

Nothing is scanned in production today. Options:

1. **ClamAV as a compose service**, used through the existing
   `ClamAvScanner`. Files arrive as `pending`; a Hire scan worker (the
   `AttachmentScanWorker` pattern) marks them `clean`/`infected`/`error`;
   **infected files are deleted** and the application flagged for the
   recruiter; **scanner down means everything stays `pending`, i.e. not
   downloadable** — fail closed. *Cost:* clamd holds its signature database in
   memory, typically 1–1.5 GB; the production box's free memory must be
   measured first. Signature updates need `freshclam` egress.
2. **A commercial scanning API.** Better detection, no memory cost — but every
   résumé leaves our infrastructure for a third party: a DPDP processor,
   a contract, and a sentence in the candidate notice. Not for R1.
3. **No scanning, compensate elsewhere** (e.g. convert to a safe format).
   Conversion means parsing the file on our server — the thing §2 avoids.

**Proposed: option 1**, deployed as its own PR. It also makes scanning
*available* to Mail and Space, but **turning it on for them is their lanes'
call**, not this record's — `Mail__ClamAv` stays as it is.

**Ruling needed (4):** ClamAV in compose, fail-closed, after a measured memory
check on production? Who measures — this lane over SSH on Amit's go?

### 5. Stopping bots and floods

There is no bot protection anywhere in the product today. Options:

1. **No third party:** a hidden honeypot field, a minimum time between
   loading the form and submitting it, per-IP limits, and a per-job daily
   ceiling that warns the recruiter.
2. **Cloudflare Turnstile / hCaptcha:** stronger, but the candidate's
   browser talks to a third party (their IP and device signals), so it
   belongs in the notice and is a processor decision.
3. **Confirm the email address first:** the application counts only after
   the applicant clicks a link. Strong, and proves the address is theirs —
   but **it depends on outbound mail working in production**, which still
   waits on Linode's SMTP block.

**Proposed: option 1 now**, with option 3 added as soon as outbound mail
works, and option 2 kept as a switch if spam gets through. Limits (all on the
rightmost `X-Forwarded-For`, like every other limiter):

| Route | Limit |
|---|---|
| Read careers pages | 120 / min / IP |
| Submit an application | 5 / 10 min / IP, and 20 / day / IP |
| Per job | 500 applications / day, then refused with a message; the recruiter sees a warning |

**Ruling needed (5):** option 1 now, 3 when mail works, 2 in reserve?

### 6. Public applications must not rewrite anyone's profile

A careers applicant enters an email. If that email already belongs to a
candidate (#267: one profile per email), **the stranger must not be able to
change that profile** — otherwise anyone who knows someone's email can
overwrite their phone number, or learn that they are already a candidate.

- The public form **never updates** an existing candidate. It creates the
  application and stores what was submitted as a **snapshot on the
  application** (name, phone, the answers, the file). The recruiter sees
  "submitted details differ from the profile" and chooses.
- **Same answer every time.** "Thanks, your application has been received"
  whether the email is new, known, or has already applied to this job. The
  response never reveals whether someone is in the system.
- A repeat application to the same job adds the new file and details to the
  existing application's history instead of failing — so a genuine
  resubmission works, and the reply stays the same.
- Source is `careers_page`, which only this route can write (#267).

**Ruling needed (6):** snapshot on the application, profile never touched,
identical reply?

### 7. What the candidate is told (wording for your approval)

Shown on every application form, above the submit button, with a required
checkbox (unticked by default):

> **How we use your application.** {Organisation} uses TatvaOS to receive
> job applications. We use your details and résumé only to consider you for
> this role{ and similar roles if you tick the box below}. We keep your
> application for **six months after we make a decision**, then delete it.
> To see, correct or delete your data sooner, write to **{erasure contact}**;
> we reply within **30 days**.
>
> ☐ I have read this and want to apply. *(required)*
> ☐ Keep my application for up to 12 months so {Organisation} can consider
> me for other roles. *(optional — the talent-pool consent)*

- `{Organisation}` and `{erasure contact}` come from `hire.careers_sites`; the
  contact defaults to the owner's address and the site cannot be switched on
  without one.
- If an organisation shortens retention, the sentence says their period.
- The ticks are **recorded on the application** (which text version, when,
  from which IP) — consent that cannot be shown is not consent.
- **Nothing here is final until you approve it and the lawyer has confirmed
  the periods.** The site switch stays off in production until then.

**Ruling needed (7):** the wording, the second tick's 12 months, and consent
recorded with a text version.

### 8. Automatic deletion (being built now, before any of the above)

Amit's decision, and the precondition for opening the portal:

- `hire.sweep_expired_candidates()` — `SECURITY DEFINER`, window inside the
  function, returns counts. A candidate is erased when **every** application
  has been `rejected` or `withdrawn` for longer than the organisation's
  period (default 180 days), **none is active**, and there is **no unexpired
  talent-pool consent**. Erasure is the #267 erase (cascade), plus the
  candidate's files from `hireblobs` once §3 exists.
- Called daily from an existing worker (the `core.sweep_handoff_codes`
  pattern). Each run writes one audit row per organisation: *how many* were
  erased, never *who*.
- The period is on `hire.careers_sites` (or an org Hire setting if the site
  does not exist), **may only be shortened** below 180 days, never lengthened
  except through consent.
- A test proves a candidate one day past the period goes, one day short
  stays, one with an active application stays, and one with consent stays.

This part needs no ruling beyond Amit's decision; it comes to you as a
normal PR (migration + a scheduled erasure).

### 8b. Backups — what "deleted" can honestly promise (Mr. Singh, 24–25 Sept)

Mr. Singh's question: any deletion promise that ignores backups is false, so
someone must know N in "deleted from live systems at six months, and from
backups within a further N days". **Measured on the production server on
25 Sept** (read-only: one setting line and file metadata, on Mr. Singh's
approval; no file contents read):

| Copy | Where | Kept | Encrypted |
|---|---|---|---|
| Six-hourly backup, local | `/srv/backups/tatvaos/` (dir `drwx------ deploy`) | 14 days by the script's default (`BACKUP_KEEP_DAYS`; the server's value not read) | no — local disk |
| Six-hourly backup, off-box | object storage | **7 days** — `BACKUP_S3_KEEP_DAYS=7` on the server. **The runbook's 30 is wrong.** | AES-256 |
| **Pre-deploy full copy** | `/srv/tatvaos-production/backups/` | **Forever** — **323 files, 31 GB, the oldest from 4 Aug 2026** (the repository's first day) | **no** — plain `.sql` / gzip |

The pre-deploy copies are also **readable by every user on the machine**
(files `-rw-rw-r--`, directory `drwxrwxr-x`, every parent traversable). Two
accounts can log in (`root`, `deploy`; `deploy` is in `docker`, so
root-equivalent) and no container mounts that directory — so today the
practical readers are whoever holds root or the `deploy` SSH key, plus any
service account on the host that is ever compromised.

**Mr. Singh's ruling (25 Sept): the cap is by DAYS, not by count** — a count
makes the period depend on how often we deploy, which no notice can state.
Pre-deploy copies keep the same fixed window as the regular backups, so there
is one number. This moves Core's #254 ahead of the Hire queue: it is every
lane's privacy wording, not only Hire's.

**Proposed with it (for #254 or its follow-up, Core / Mr. Singh):**
1. Pre-deploy copies deleted after a fixed number of days, matching the
   regular backups.
2. Written `0600`, directory `0700` — as the regular backups already are.
3. Deleting the 323 existing copies is irreversible and removes the only
   history older than the backup window: **a decision for Amit and Mr. Singh,
   not a side effect of a deploy.**
4. Correct the runbook's off-box period from 30 to 7 days.

**For the notice**, once the window above is enforced: *"…deleted six months
after a decision. Copies in our backups are deleted within a further N days."*
— N being the longest window any copy is kept (14 if nothing changes the
local default). Restoring a backup must not resurrect erased people: after
any restore, the retention sweep runs before the system is opened to users
(idempotent, seconds) — a line for the restore runbook.

**Questions for the lawyer**, alongside the six months and the 30-day reply:
does "deleted within a further N days from backups" satisfy DPDP erasure for
backups that cannot be edited row by row; and is that N acceptable.

## Launch checklist (named items — nothing launches until each is done)

Mr. Singh, 25 Sept: "the launch change removes it" is a manual step, and a
forgotten one fails quietly. So every launch step is named here:

1. Mr. Singh's rulings on §1–§7 implemented; the lawyer has confirmed the
   six months, the 30-day reply and the backup N (§8b).
2. Pre-deploy copies capped by days (§8b) — deployed, not only merged.
3. **Remove `noindex` from `apps/web/app/careers/layout.tsx`.** Until this
   line goes, search engines are told not to list any careers page, and the
   product is never found. (The public API keeps its `X-Robots-Tag`: JSON is
   never a page to index.)
4. `hire.caddy` / `HIRE_DOMAIN` routing deployed (a deploy-area PR).
5. The notice wording (§7) signed off by Mr. Singh, with the real N.
5b. **Mr. Singh's sign-off on the data-contact warning** on Hire → Careers page
   (`apps/web/app/hire/careers/page.tsx`), exact text in PR #275's comment of
   25 Sept. Merged unsigned on his ruling because both switches are off.
6. Only then: `hire.careers_portal_enabled` set to `true` — the last step,
   and audited.

## Order of work

Each step is its own PR, and the portal is **not switched on in production**
until steps 1–5 are merged, deployed, and the lawyer has confirmed §7:

1. **Automatic deletion** (§8) — in progress.
2. `hire.careers_sites`, the Careers settings page, the public job list and
   job page — **no form yet** (§1).
3. The application form **without a file**: consent, honeypot, limits,
   snapshot, identical reply (§5, §6, §7).
4. ClamAV in compose (§4) — a `deploy`-area PR for you.
5. Résumé upload, storage, scan worker, download (§2, §3).
6. Later, separately: email confirmation (§5 option 3) once outbound mail
   works; customer domains with on-demand certificates (own record).

## Consequences

- **Easier:** Techvein can publish its own openings on a public page without
  any certificate work; every step reuses a pattern already trusted here
  (token-style resolver, `IBlobStore`, `ClamAvScanner`, the sweep function,
  the structural gate).
- **Harder:** one more container to run and keep updated (ClamAV); a new
  public surface to watch (rate-limit rejections should appear in the logs
  and be looked at).
- **Accepted:** R1 recruiters download résumés rather than preview them; no
  search inside résumés; weaker bot protection than a CAPTCHA until email
  confirmation arrives.

## Revisit when

- Spam gets through option 1 — switch on Turnstile/hCaptcha (a processor and
  notice change).
- The first customer asks for their own domain — the on-demand-certificate
  record.
- Production memory cannot hold clamd — the commercial scanner question, with
  its processor contract.
- The lawyer's answer differs from six months / 30 days — change the default
  and the notice together.
