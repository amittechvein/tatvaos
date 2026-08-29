# Minutes for everyone who joins

**Decided by Amit, 26 August 2026.** Every person in a meeting is part of the
minutes — colleagues, guests, whatever they joined on. Not "most people". Not
"everyone we can reach for free".

This is now a requirement, not a nice-to-have, and it answers the question Core
asked on the guest-captions card: **yes, it blocks customers.** A meeting with a
parent, a patient or an external client currently records only our own staff's
half of the conversation, into a document that reads as a complete account.

---

## First, a correction to a number I gave

When Amit was choosing between options I said the paid backstop would cost
"roughly ₹2–5 a meeting". **That is only true if one specific thing is built,
and I should have said so at the time.**

The measured figure is ₹16.6 to transcribe a 31-minute meeting, so about **₹0.54
per minute of audio**. Transcription is billed per minute of *audio*, not per
minute of *meeting*. So two uncovered people in a 31-minute meeting is 62
audio-minutes — about **₹33**, which is twice what transcribing the whole room
used to cost, not a fifth of it.

The ₹2–5 figure holds only if we **cut the silence out first**. An uncovered
person typically speaks for a fraction of a meeting; sending only the parts
where they actually spoke turns 31 minutes of their audio into perhaps 6, and
₹33 into about ₹3.

**So voice-activity detection is not an optimisation here. It is the thing that
makes the whole approach affordable, and it has to be part of the build.** It
runs on our own server for nothing; only what survives it is sent to a paid
service.

---

## Why guests are excluded today — and why the stated reason is wrong

`useCaptions.ts` says:

> Signed-in participants only, for now. A guest's token expires every ten
> minutes, so guest captions need a signed ticket that does not exist yet.

The conclusion is right and the reason is not, and the difference makes the fix
smaller.

The ten minutes is `LiveKitOptions.TokenMinutes`, and its own comment says what
it is: *"A JOIN WINDOW, not a session limit: LiveKit keeps an established
session alive past expiry."* A guest who is in the meeting stays in it. Nothing
expires out from under them.

The real reason is simpler. `ConnectCaptionEndpoints.PostAsync` starts:

```csharp
if (tenant.UserId is not Guid uid) return Results.Unauthorized();
```

and then finds the participant row by `p.UserId == uid`. **A guest has no
`UserId` and never had one.** It is not that a credential expires — it is that
no credential was ever issued. The guest's browser hears the words perfectly
well. It has nowhere to send them that the server will accept.

---

## Half A — the free half. Guests on Chrome and Edge.

**Owner: Core.** This is the "Guest captions" card he is already building; the
note below is to save a wrong turn, not to take the work.

### Do not build a relay

The obvious shortcut is to copy the guest-chat relay: the guest broadcasts its
caption lines on the data channel and one elected signed-in participant stores
them. It would work, and I think it is the wrong thing to build here.

Chat is a message. **Minutes are a record.** The relay lets one participant's
browser tell the server "this guest said X", and a modified client could
therefore put words into a named person's mouth in a document the business
later relies on. That risk is tolerable for a chat line and is not tolerable
for a record — and it would have to be unpicked again the moment the proper fix
lands.

### Build the ticket instead

`ConnectDownloadTicket` already is this pattern, proven, in production: a
short-lived signed permission that names a subject and a tenant, where the
server re-checks everything behind it. A captions ticket is the same shape with
a different payload:

| | |
|---|---|
| minted | at admit, in the same response that hands a guest their LiveKit token |
| names | meeting id, participant id — signed, so the guest cannot edit them |
| life | the meeting, not five minutes. A caption ticket is not a download; re-minting it mid-sentence is what a ten-minute life would cost |
| verified by | `ConnectCaptionEndpoints.PostAsync`, as an alternative to `tenant.UserId` |
| grants | posting caption lines attributed to **that one participant id**, and nothing else |

The endpoint's own comment says the current query is doing two jobs at once —
proving membership and establishing attribution — *"so there is no way to pass
the membership check and miss the attribution."* A signed ticket keeps that
property exactly: the participant id is inside the signature, so there is still
one fact, and it still cannot be separated from the permission.

The guest cannot forge it, and no other participant can attribute anything to
them. `useCaptions` gains a ticket option beside `authedFetch`; nothing else in
it changes.

---

## Half B — the paid half. Everyone the browser cannot reach.

**Owner: Connect (me).** Core's ticket does not cover this and never will —
these are browsers with no speech recognition at all.

Who is left after Half A:

- **Every iPhone and iPad.** Safari has no `SpeechRecognition` for web pages.
  Not a gap we can close; Apple does not offer it.
- **Firefox**, on any platform. No support at all.
- **Chrome on Android**, unreliably — it exists but does not hold up over a long
  meeting.

For an external-facing product in India, that is not a rounding error. It is
most people joining from a phone.

### How it works

1. **Record each person separately, not the room.** LiveKit has participant
   egress; `LiveKitEgressClient` currently only calls
   `StartRoomCompositeEgress`, and adding `StartParticipantEgress` is one more
   method on the same twirp client.

   This is the part that preserves the whole point of the current design. A
   room-composite recording is one mixed stream, so the best possible
   transcript says *"somebody will send the pricing sheet"*. One file per
   person says *"Rahul will send the pricing sheet"*, and attribution is the
   entire value of minutes.

   Audio only, and only for the people who need it.

2. **Know who was covered.** Each browser that is captioning already reports
   lines. A participant with zero caption lines at the end of a meeting, who
   was present and unmuted, is a person the browser did not reach. That is a
   query, not a guess.

3. **Cut the silence.** Voice-activity detection on our own server, on that
   person's own track. Free, and it is what makes the bill ₹3 instead of ₹33.

4. **Transcribe only what is left**, attributed to that participant, and merge
   it into the same caption table the free half writes to. Downstream —
   minutes, notes, the whole record — nothing changes, because it is the same
   rows.

5. **Delete the per-person audio** once transcribed, on the same retention rules
   as everything else. It is working material, and keeping a separate audio file
   of each individual is a bigger promise than the product currently makes.

### What it costs

Only the gap. A meeting where everybody is on Chrome costs exactly what it costs
today — ₹0.40 — because step 1 never runs. The bill scales with how many people
the browsers missed and how much those people actually said, not with the length
of the meeting.

---

## The thing that has to be said out loud before any of this ships

Turning this on means **a guest's microphone audio is sent to Google**, and a
guest has agreed to nothing.

For staff this was already true and Amit ruled on it: one switch for the host,
no queue of twenty consent prompts, disclosure where the switch is. That
reasoning holds for colleagues. It is weaker for a guest, who has no
relationship with us, did not choose our product, and in a hospital or a school
may be a patient or a parent.

This is exactly the case Core parked the consent branch for. **I am not
reopening the decision** — it is Amit's and it was made — but "guests are
minuted too" materially widens who it applies to, and the branch was kept for
precisely this moment. It should be looked at before the first hospital
customer, not after.

At minimum, and cheaply: the door a guest comes through should say that the
meeting is being minuted and what that involves, in the same plain words the
room already uses. A guest who is told at the door has been given a choice,
which is most of what the consent sheet was for and costs nobody a queue.

---

## Order of work

1. **Core**: guest captions ticket (Half A). Small, and it covers most guests.
2. **Connect**: the door disclosure for guests. Small, and it should not wait
   for Half B.
3. **Connect**: participant egress, coverage detection, silence-cutting,
   transcription of the gap (Half B).

Half B is a real build, not a patch, and it should not start until Half A has
shipped — Half A shrinks the problem to its genuinely hard part, and it would
be silly to build the expensive path for people the free path was about to
cover.
