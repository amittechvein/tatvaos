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
