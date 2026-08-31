# Space — scanning at the gateway

**Brief for review. No code has been written.** Space's practice is that a
feature gets a contract before it gets an implementation, because the
expensive mistakes here have all been decisions, not typing.

Amit chose this off the phase-2 list on 31 Aug 2026. What follows is what I
found before writing anything, and it changes the shape of the request enough
that the first decision is not Space's to make.

---

## 1. The finding that comes first

**There is no scanner running. Nothing on this platform has ever been
scanned.**

`ClamAvScanner` exists, in `apps/api/Modules/Mail/`. `AttachmentScanWorker`
exists. Both are careful, correct and idle, because `Mail__ClamAv` is empty
and **no `clamav` service is defined in any compose file** — the only mention
in `infra/docker/` is the comment next to that variable explaining what to set
it to. Mail's own worker says it plainly in its header: *"Every attachment on
this platform is unscanned, on a system serving schools and hospitals."*

So "wire Space to the scanner" is not the job. The job is:

1. decide whether we run a scanner at all — cost, memory, who owns it;
2. then give Space a correct relationship with it.

Doing (2) without (1) produces a Space that honestly records `pending`
forever, which is truthful and protects nobody. That is worth building only as
a deliberate step toward (1), not instead of it.

**This first decision is not mine.** It is infrastructure and money.

---

## 2. What Mail already decided, which Space should inherit rather than re-open

Reading `ClamAvScanner` and `AttachmentScanWorker`, four decisions are already
made and made well. Space should copy the reasoning, not re-litigate it:

**A verdict has three values, and `error` is one of them.** Clean, infected,
error. A scanner that is down, unreachable, or refusing on size has **not**
said a file is clean. Recording clean because nothing objected is the precise
failure the code was written to remove.

**Off means off, not optimistic.** No configuration → the worker logs once and
idles. It never falls back to marking things clean.

**Nothing is deleted or quarantined.** An infected attachment keeps its row and
its bytes, is marked infected, and the *download* refuses it. Mail's stated
reason: a false positive that blocks a download is recoverable; one that
destroys a customer's file is not. Space has more reason to hold this line, not
less — Space is where the only copy lives.

**Scanning is asynchronous.** A worker, after storage, not inline on the
request.

---

## 3. The number that decides the design

| | |
|---|---|
| Space's per-file cap | **2 GB** (`Space:MaxFileBytes`, default) |
| clamd's default `StreamMaxLength` | **25 MB** |

Those are not close. On a default clamd, **every Space file over 25 MB comes
back `error`, not `clean`** — and by section 2's rule, `error` is not
permission to serve.

This is the whole design problem, and it lands hardest on the feature we
shipped last week: Mail's oversize attachments become Space public links. Those
are *by definition* the large files. A rule of "refuse anything not clean"
turns the large-attachment feature off for exactly the files it exists for.

There is no clever way out. Either clamd is configured to scan far past its
default (memory and time cost, per file, on every upload), or large files carry
an honest `unscanned` state that the product has to represent to people. That
is a product decision with a security consequence, which is why it is a
question here and not an answer.

---

## 4. Decisions needed

### D1 — Do we run a scanner? · **Amit and Core**

A `clamav` container holds the signature database in memory. Budget roughly
**1–2 GB of RAM** plus `freshclam` pulling updates several times a day. I have
not measured the production box's spare memory and will not guess at it.

If the answer is no, or not yet, say so and I will build nothing. A `pending`
column that never moves is what we already have, and adding a second one in
Space would be theatre.

### D2 — Where does the scanner class live? · **Core**

`ClamAvScanner` is in Mail's module. Space needs the same forty lines of wire
protocol. Three options:

- **Move it to `Shared/`** — one implementation, two callers. Rule 10's
  answer. It is Core's folder and Mail's file, so it needs both to agree.
- **Space calls into `Modules/Mail`** — a product lane depending on another
  product lane. Works, and is the wrong shape.
- **Space writes its own** — two implementations of one protocol. No.

**My recommendation: move to `Shared/`.** It is not Space's call to make.

### D3 — Inline at upload, or a worker after it? · **recommend: worker**

"At the gateway" suggests inline. I think that is wrong here, for reasons that
are checkable rather than aesthetic:

- a 30-second scanner timeout on a 2 GB upload is a request that can outlive
  its own connection;
- inline scanning makes the scanner a hard dependency of *uploading*. When it
  is down, nobody can put a file in Space at all. That converts a security
  feature into an availability risk;
- Mail already scans asynchronously, and two products behaving differently is
  a thing people will have to remember.

**Proposed: store, mark `pending`, scan in a worker, gate at read.** The
gateway's job is to record honestly what is known, not to block on finding out.

### D4 — What does a `pending` or `error` file do at each exit? · **the real question**

Space has five ways bytes leave. They do not deserve the same answer:

| Exit | Proposed for `infected` | Proposed for `pending` / `error` |
|---|---|---|
| Owner downloads their own file | refuse, say why | **allow** |
| Someone it is shared with downloads | refuse, say why | allow |
| **Public link — a stranger** | refuse | **refuse — see below** |
| Thumbnail generation | skip | skip |
| Mail attaches it to a message | refuse | refuse |

The asymmetry is deliberate. **A person downloading their own file is getting
back something they already had**; refusing them protects nobody and loses
their data behind a scanner outage. **A stranger on a public link has no
copy**, and that link is reachable by anyone the mail was forwarded to. The
same bytes, a different question.

**This is the line I most want argued with**, because it is where I am least
certain, and because D3's consequence lands here: with a worker, a link created
seconds after upload will refuse for as long as the scan queue takes. That is a
real regression in the large-attachment flow, and "it is only a few seconds"
is exactly the kind of claim that is true until the queue is long.

### D5 — What do we tell people? · **Amit**

If a public link refuses a pending file, the stranger sees something. Today
every public-link failure returns one 404 string on purpose — no oracle. A
"still being scanned, try shortly" message is a *better experience* and a
worse secret: it confirms the link is real. I lean towards keeping the single
404 and accepting the poor experience, but that is a product call about
customers I do not talk to.

### D6 — Re-scanning · **recommend: yes, eventually, not in v1**

A file scanned clean on Monday is scanned against Monday's signatures. The
malware that matters is often the malware nobody had a signature for yet. A
serious answer re-scans on signature updates; a v1 answer records
`scanned_at` and the signature version so that a re-scan is *possible later*
without another migration. **v1 should record enough to make v2 cheap** — that
much I would build now.

---

## 5. What this brief does not propose

- **No quarantine, no deletion, ever.** Inherited from Mail, and Space has
  the only copy.
- **No scanning of existing files at v1.** Every file already in Space is
  unscanned and would stay `pending` until a backfill is decided separately.
  I would rather state that than have a column that quietly implies otherwise.
- **No claim that this makes Space safe.** Signature scanning catches known
  malware. It is a floor, not a guarantee, and the documentation should say so
  in those words — a security feature that oversells itself is how people stop
  taking care.

---

## 6. What would prove this brief wrong

Written down now, so it can be checked rather than argued:

- **If the production box cannot spare the memory**, D1 answers itself and
  everything else is moot. I have not measured it.
- **If clamd can be configured to scan multi-hundred-megabyte streams at
  acceptable cost**, section 3 collapses and the design gets simpler — refuse
  anything not clean, everywhere. Somebody should measure that rather than
  take my 25 MB figure as destiny; it is clamd's *default*, not its limit.
- **If Mail's scanning is about to be turned on**, Space should land at the
  same time and share the container, and this becomes one piece of work with
  the Mail lane rather than two.

---

## 7. What I need to proceed

1. **D1 from Amit and Core** — is there a scanner, and who pays for it?
2. **D2 from Core** — may `ClamAvScanner` move to `Shared/`?
3. **D4 and D5 argued** — particularly the public-link row.

With D1 answered yes and D2 settled, the rest is a migration, a worker, a
gate at four exits, and a verification script that fails when an infected
file is served. Without D1, there is nothing here worth building.
