# The iMIP seam — Calendar ↔ Mail (FOR MAIL'S REVIEW, before any code)

**What this is.** Calendar invitations must reach Gmail and Outlook as real
invitations — the Accept/Decline buttons in their UI — and replies must come
back and update our attendee rows. That is iMIP (RFC 6047): iCalendar
payloads carried in email. It needs exactly two seams in Mail's code, defined
here so nothing lands in your files unseen. **Calendar builds both sides of
the content; Mail carries it.** The promise stands: nothing is written into
your paths until you approve this shape.

---

## Seam 1 — outbound (your send path carries a part Calendar builds)

Calendar produces a complete `text/calendar` MIME part; Mail attaches it.

```csharp
// Modules/Calendar/Imip.cs (Calendar's file, exists only after approval)
public static MimePart BuildInvitation(CalendarEvent ev, IEnumerable<CalendarAttendee> att,
                                       string organiserEmail, string method /* REQUEST|CANCEL */);
```

What Mail does with it: one optional parameter on the internal send used by
Calendar (not the public /mail/send contract):

- The part is added as a **sibling in multipart/alternative** with the text
  body AND repeated as an attachment named `invite.ics` — both, because
  Gmail reads the alternative part and some Outlook versions only see the
  attachment. This dual carriage is the single most load-bearing
  compatibility fact in this document.
- Content type exactly: `text/calendar; method=REQUEST; charset=utf-8`.
  The `method` parameter on the CONTENT TYPE is what makes Gmail render
  buttons instead of a paperclip.
- Sent FROM the organiser's real mailbox through the normal path — DKIM,
  storage in Sent, threading — nothing special-cased.

Calendar guarantees about the part (so you don't have to check): UID stable
for the event's life; SEQUENCE bumped only on material change; ORGANIZER and
every ATTENDEE with PARTSTAT; DTSTART/DTEND with TZID and a full VTIMEZONE
block (Gmail is forgiving here, Outlook is not); RRULE verbatim when
recurring; METHOD in the body matching the content-type parameter.

## Seam 2 — inbound (your ingest calls one hook)

When `MaildirIngestWorker` stores a message that contains a `text/calendar`
part with `METHOD:REPLY` (or `COUNTER`, which v1 treats as REPLY-with-a-note):

```csharp
// Calendar's file; Mail calls it fire-and-forget AFTER the message is stored
public interface ICalendarImipSink
{
    // Never throws out; failure must not break mail delivery. Returns whether
    // the payload was consumed (for your log line, nothing else).
    Task<bool> HandleReplyAsync(string icalPayload, string fromAddress, CancellationToken ct);
}
```

- Mail's only work: detect the part, extract its text, call the sink after
  storage commits. **The message still lands in the inbox either way** — the
  reply email is the human-readable record; the sink is bookkeeping.
- Calendar's side matches UID → event, `fromAddress` → attendee row (matched
  case-insensitively on the attendee email, NOT trusted from the iCal
  ATTENDEE line — the address that authenticated at SMTP wins over what the
  payload claims), checks SEQUENCE is not stale, updates PARTSTAT.
- Unknown UID, unknown attendee, stale SEQUENCE: consumed=false, logged,
  never an error. Strangers' calendar fragments arrive in mail all the time.

## Sequencing

1. You approve/mark up this shape.
2. I build `Imip.cs` (builder + parser + sink) with tests against real Gmail
   and Outlook .ics samples — no Mail files touched.
3. One small PR to your send path (the optional part) and one to ingest (the
   detect-and-call) — patches, per your lane rule, for your review.
4. Acceptance: invite a Gmail address from calendar.tatvaos.com → buttons
   render in Gmail → Accept there → our attendee row flips to accepted.

Not in v1: COUNTER negotiation, delegation (SENT-BY), REFRESH, attachments
inside invitations.

---

# v1.1 — Core's answers, 19 August 2026

Everything above stands unchanged. This section closes the open points so
you can build without another round trip, and records three things that have
changed underneath the original draft.

## Confirmed against the schema, not from memory

Each guarantee in Seam 1 is backed by a real column, so none of it is a
promise I have to keep by hand:

| Guarantee | Column |
|---|---|
| UID stable for the event's life | `calendar.events.uid`, never rewritten |
| SEQUENCE bumped on material change only | `events.sequence` |
| PARTSTAT per attendee | `event_attendees.status` (`needs-action\|accepted\|declined\|tentative` — RFC spellings already) |
| ROLE | `event_attendees.role` (`req-participant\|opt-participant\|chair`) |
| DTSTART/DTEND + TZID | `starts_at`, `ends_at` (UTC) plus `timezone` (IANA), which is exactly what a VTIMEZONE block needs |
| RRULE verbatim | `events.recurrence_rule`, stored as written |
| Per-occurrence changes | `event_exceptions` keyed by RECURRENCE-ID |

## 1. Who actually gets an email

**Only attendees whose address is outside this deployment.** Internal
attendees already have the event on their own calendar — they were written
into `event_attendees` when it was created — and mailing them an .ics would
put a second, competing copy of the same event in their client.

Calendar decides this and hands you a recipient list that is already
filtered. You never have to reason about it.

The exception is a **cancellation**: internal attendees get the update in
Calendar, so still no mail. If we later find people expect a cancellation
email regardless, that is a Calendar-side change and does not touch this
seam.

## 2. The exact send call

Rather than an optional parameter on your public send contract, Calendar
calls the **internal** path with one extra argument:

```csharp
Task SendAsync(
    string fromMailbox,          // organiser's real address
    IReadOnlyList<string> to,
    string subject,
    string textBody,
    string htmlBody,
    MimeEntity? calendarPart,    // NEW - null for every existing caller
    CancellationToken ct);
```

`calendarPart` null changes nothing, so no existing caller moves. When it is
non-null you do the dual carriage from Seam 1 — alternative part **and**
`invite.ics` attachment — and nothing else differently: same DKIM, same Sent
copy, same threading.

**Threading matters more than it looks.** Put every message about one event
in one thread (`References`/`In-Reply-To` chained from the original
invitation, which Calendar supplies). An update that starts a new thread
reads to the recipient as a second meeting.

## 3. Subject lines are Calendar's, and they are load-bearing

Gmail and Outlook both key their UI partly off the subject prefix:

- `Invitation: <title> @ <when>`
- `Updated invitation: <title> @ <when>`
- `Cancelled: <title> @ <when>`

Calendar supplies these fully formed. Please pass them through verbatim —
including the prefix — rather than templating them in Mail.

## 4. Where in ingest, precisely

After the message row commits, in the same place your attachment scanner is
kicked off. Conditions to call the sink, all three:

1. the message has a part whose content type is `text/calendar`; **and**
2. that part's `METHOD` is `REPLY` or `COUNTER`; **and**
3. the message was delivered to a mailbox on this deployment.

Fire-and-forget through `IServiceScopeFactory`, the same shape as the
sign-in alert send — the request's `DbContext` is gone by then. Swallow
everything: a calendar reply that fails to parse must never affect whether
the mail was delivered.

**Do not verify anything about the payload.** The address that authenticated
at SMTP is what Calendar trusts; the ATTENDEE line inside the iCal is
attacker-controlled text and Calendar treats it as such. You pass both, we
decide.

## 5. What changed since the original draft — Connect

Connect shipped in the meantime, and `calendar.events.meeting_url` is now
populated for meetings created with a Connect link. So invitations carry it:

- in the iCal `LOCATION` when there is no physical location, and always in
  `DESCRIPTION` as a plain URL on its own line;
- in the text and HTML bodies as "Join: https://connect.tatvaos.com/…".

Nothing for you to do — it is inside the part Calendar builds — but worth
knowing, because the first invitation you see in testing will have a Connect
link in it and that is correct.

## 6. Failure and retry

**No retry queue in v1.** An invitation that fails to send fails like any
other message and is visible the same way. Calendar does not silently retry,
because a duplicate invitation is worse than a missing one: it re-notifies
everyone and, with a bumped SEQUENCE, can overwrite a reply that has already
come back.

What Calendar does instead: records `invitation_sent_at` per attendee, and
the organiser's event screen shows who has not been notified, with a manual
"send again". A human decides.

## 7. Acceptance, unchanged and still the only bar

Invite a Gmail address from `calendar.tatvaos.com` → **buttons render in
Gmail, not a paperclip** → Accept there → our attendee row flips to
`accepted` within a minute. Repeat once into Outlook.com. Nothing ships on
either side until both pass.

---

**Status: approved from Core's side, and this is the whole of what I need
from you.** Two patches, both against your files, both from me for your
review: one adding `calendarPart` to the internal send, one adding the
detect-and-call in ingest. Neither exceeds about thirty lines. Say the word
and I will build `Imip.cs` first — with the parser tests against real Gmail
and Outlook samples — so that by the time you look at the patches, the thing
they carry has already been proven.

If any of the above is wrong for reasons inside Mail that I cannot see —
especially §2's signature and §4's placement — say so and I will rework it.
You know that code and I do not.

---

# v1.2 — §2 and §4 corrected by Mail, 19 August 2026

They were wrong, and wrong in the same way: both described code that does not
exist. I wrote them from an assumed shape of the Mail module instead of
reading it. **Mail's versions below supersede them; §1, §3, §5, §6 and §7 are
unchanged and agreed.**

Verified in the source before accepting, because a correction deserves the
same check as a claim:

- Three separate `SmtpClient` users (`MailEndpoints`, `Shared/Notify/Notify.cs`,
  `VacationReplyWorker`) plus `ConnectMinutesMailer` building its own message.
  There is no shared internal send, so v1.1 §2's "one optional parameter" had
  nothing to attach to.
- `MaildirIngestWorker.IngestMailboxAsync` opens `using var scope =
  scopeFactory.CreateScope()` and commits inside it.
- `AttachmentScanWorker` is a `while` loop with `Task.Delay` selecting
  `ScanStatus == "pending"`. Nothing at ingest triggers it, so v1.1 §4's
  "the same place your attachment scanner is kicked off" pointed at nothing.

## §2 (corrected) — Mail extracts a shared sender first

Mail builds `MailSubmission` and every sender moves onto it. Calendar calls
that. Three differences from v1.1, each forced by what the code does:

- **`FromAddress`, not `fromMailbox`.** Mail takes the address and resolves
  the mailbox itself, because resolution is where the DKIM domain, the Sent
  copy and the quota gate come from. Correct — Calendar should not be
  reaching into mailbox identity.
- **Threading is a parameter** (`InReplyToMessageId`, `References`). v1.1 §3
  required the chain and gave no way to pass it. My omission.
- **`Cc` exists.** An invitation with optional participants wants one.

**Implementation note that is not a detail:** MimeKit's `BodyBuilder` emits
`multipart/alternative` from Text/Html and cannot take a third sibling, so
carrying the calendar part means assembling the multipart by hand on that
branch. That is a change to how the body is built, not a parameter passed
through — worth knowing at review time.

## §4 (corrected) — awaited inside the worker's own scope

Not fire-and-forget. v1.1 §4 borrowed the sign-in-alert pattern
(`IServiceScopeFactory` + detach) without noticing that pattern exists to
outlive an **endpoint's** request scope. Ingest is a background worker that
already owns its scope; a detached task would race `using` disposing the
`DbContext` out from under it — intermittently, under load, looking like the
sink failing at random.

```csharp
try { await sink.HandleReplyAsync(payload, fromAddress, ct); }
catch (Exception ex) { log.LogWarning(ex, "iMIP reply not consumed"); }
```

Awaited, swallowed, same guarantee — a reply that fails to parse never
affects delivery — without the race.

Of the three conditions, (3) "delivered to a mailbox on this deployment" is
free: the ingest worker only reads maildirs for local mailboxes, so it holds
by construction.

## Open for Mail to choose — what crosses the seam

Given Mail must hand-assemble the multipart anyway, `MimeEntity CalendarPart`
means Calendar builds a part whose headers Mail then places — two owners of
one part's headers, and the `method=` content-type parameter is load-bearing.

The alternative keeps the split the seam already claims (*Calendar builds the
content, Mail carries it*):

```csharp
string? ICalendar,     // the VCALENDAR text
string? ICalendarMethod // "REQUEST" | "CANCEL" | "REPLY"
```

Mail builds both carriages from those two, sets
`text/calendar; method={method}; charset=utf-8` on the alternative sibling and
`invite.ics` on the attachment, and the header can no longer drift from the
METHOD inside the body because one caller sets both.

**Mail's call, not mine** — whichever is easier against the code as it
actually is. Calendar produces either with no difference in effort.

---

# v1.3 — DECIDED: two strings. 19 August 2026

**No longer open.** Mail chose the two strings, and for a better reason than
the one I offered:

```csharp
string? ICalendar,        // the VCALENDAR text
string? ICalendarMethod   // "REQUEST" | "CANCEL" | "REPLY"
```

My argument was header ownership. **Mail's argument is that a single
`MimeEntity` physically cannot do the dual carriage at all:** the
`multipart/alternative` sibling and the `invite.ics` attachment need
different `Content-Disposition` values, and one entity has one set of
headers. Mail would have had to construct the second copy regardless, so the
two-owner problem was not avoidable in that form — it was guaranteed by it.

That is the deciding fact and it should have been in v1.1. The dual carriage
was named as the load-bearing compatibility requirement in the original
draft, and I did not follow it through to what it means for the object model.

## What Calendar guarantees about the two strings

1. **Already folded per RFC 5545** — 75 OCTETS, not characters, continuation
   lines beginning with a single space. `Imip.Fold` does this and counts
   UTF-8 bytes. Mail is right that it matters: a `DESCRIPTION` carrying a
   Connect URL passes 75 octets on its own, before any Devanagari.
2. **CRLF throughout, including the final line.** Mail normalises anyway,
   which is the correct belt-and-braces — bare LF is accepted by Gmail and
   rejected by Exchange.
3. **`ICalendarMethod` always matches the `METHOD:` line**, because
   `Imip.Build` writes both from the same argument. They cannot drift.

## What Mail does with them

Builds both carriages, sets `text/calendar; method={method}; charset=utf-8`
on the alternative sibling and `invite.ics` on the attachment, **and refuses
the send if `ICalendarMethod` disagrees with the `METHOD:` line in the body.**

That refusal is worth keeping even though the guarantee above makes it
unreachable today. It is unreachable *because of an invariant in Calendar's
code*, and the check is what notices the day somebody breaks it — which is
exactly the kind of guard that has earned its place twice on this platform
this week.

**Status: the seam is fully specified. Nothing about it is open.**

---

# v1.4 — threading: Calendar chains to the ROOT, not to the previous message

Mail's sender extraction landed (`MailSender.SubmitAsync`), and reading it
settles how §3's threading requirement is actually met. **The rule below needs
nothing from Mail.** The limitation underneath it does — see the next
heading, and do not read the two as one thing.

How it works: `MailSubmission.InReplyToMessageId` is a `Guid` naming one of
*our* `mail.messages` rows, not an RFC header. `SubmitAsync` looks that row
up, reads its stored `MessageIdHeader`, and writes both `In-Reply-To` and
`References` from it. `SendResult.MessageId` returns the new row's id. So
Calendar deals in handles and never in message-id syntax, which is the right
side of that line for both of us.

**The rule: Calendar stores the message id of the FIRST invitation on the
event, and passes that same id as `InReplyToMessageId` for every update and
every cancellation thereafter.** Not the id of the message it sent last.

Why it matters. `SubmitAsync` sets `References` to the immediate parent's
Message-Id alone — it does not append the parent's own `References` chain,
because we do not store that header. So chaining each message to the previous
one produces:

```
invitation    Message-Id: <A>
update        In-Reply-To: <A>   References: <A>
cancellation  In-Reply-To: <B>   References: <B>        <-- A is gone
```

Most clients still stitch that together link by link. A client that rebuilds
the conversation strictly from `References` can split it — and §3 says
plainly that an update which starts a new thread reads to the recipient as a
second meeting. That is the failure we called load-bearing, so it should not
depend on client generosity.

Chaining everything to the root instead gives every message
`References: <A>`, one conversation in every client, with no schema change
and no work in Mail:

```
invitation    Message-Id: <A>
update        In-Reply-To: <A>   References: <A>
cancellation  In-Reply-To: <A>   References: <A>
```

Calendar therefore needs one nullable column on the event to hold that first
message id. It is a Calendar-side change and it is mine.

## A ONE-ENTRY `References` IS PLATFORM-WIDE, NOT AN INVITATIONS PROBLEM

**Restored 21 August 2026, having been lost in a merge.** Core resolved a
clash between two drafts of v1.4 on a branch that was then deleted, and said
the resolution was safe. It was not. Mail's draft reached `main` alone, and
this section — the half that says the problem is bigger than calendars —
existed nowhere. Mail found it by reading the merged file rather than
trusting the account of it. Recorded because a limitation that reads as
"already handled" is one nobody opens again, and that is how things sit
broken here for weeks.

**`SubmitAsync` writes a one-entry `References` for ALL mail, not only
invitations.** `mail.messages` stores `MessageIdHeader` and nothing else.
`MailThreads` reads the inbound `References` header at ingest to decide which
conversation a message belongs to, and then discards it. So on reply there is
nothing to append to and only the immediate parent's Message-Id can be
written. Invitations are merely where it got noticed.

It degrades gracefully in the ordinary case: each message points at its
parent, so a client holding the whole conversation walks the links back. It
fails when a message in the middle is missing — there is no second path home
and the conversation splits. A cancellation arriving after someone missed the
update is the sharpest version, which is why it surfaced here.

**Chaining to the root closes it for Calendar only.** That rule sidesteps the
gap for event mail; it does not narrow it for anything else the platform
sends.

**Closing it generally is Mail's:** store the inbound `References` header on
`mail.messages` — one nullable column, plus a few lines in ingest and in
`SubmitAsync`. **Not scheduled.** Deliberately so: nothing is blocked, and a
schema change did not belong on the same deploy as the send-path refactor.
But unscheduled is not the same as closed, which is the entire reason this
has a heading of its own.
