# Security review — Connect's anonymous guest path

**Reviewed by Core, 19 August 2026.** `apps/api/Modules/Connect/Endpoints/ConnectGuestEndpoints.cs`
(296 lines), `ConnectCodes.cs`, the `connect-guest` rate-limiter policy, and
the definer functions it calls.

This is the review `CONNECT_BRIEF.md` §8 and the file's own header say must
happen before the path deploys. **It happened after** — the path has been live
since `0acdb39`. That is a process failure, not a code one, and it is recorded
here rather than argued about.

## Verdict

**Pass, with three findings.** None is a reason to take the path down. One
(F1) will affect real customers and should be fixed before Connect is sold to
an office.

The reasoning in this file is unusually good. Where it makes a judgment call it
says so and says why, and every one I checked was the call I would have made.

## What I verified, and what it means

1. **One failure answer.** `Gone()` is the only sentence the file says about
   any failure: unknown code, malformed code, cancelled meeting, guests off,
   tenant suspended, stolen wait token, already-claimed admission. No 403 that
   distinguishes, no varying message. The endpoint cannot be used to ask which
   organisations exist or hold meetings.
2. **Shape check before spend.** `IsWellFormed` runs before any query or hash,
   so a scanner is refused for free and the rate limiter stays meaningful.
3. **The two-step tenancy rule is obeyed.** `EnterAnonymousScope` is followed
   on the next line by `await db.SyncTenantAsync(ct)`, both times. Without the
   second line the participant INSERT is silently refused by the policy. This
   is the mistake that has cost this project the most, and it is not made here.
4. **Definer first, then ordinary RLS.** The only pre-tenant read is
   `connect.resolve_meeting_code`. Nothing else is queried until the tenant it
   returned is in `TenantContext`. The ordering is the safety argument and it
   is intact.
5. **The password is verified against the row, never against the definer's
   boolean.** The function reports only *whether* a password exists; the hash
   is read afterwards, under the policy. Correct, and the distinction matters.
6. **Codes and wait tokens are both 128 bits** from the CSPRNG. Meeting codes
   are stored in plaintext (they grant nothing alone and the host re-shares
   them); **wait tokens are stored only as SHA-256** and looked up by hash, so
   no application code ever compares token strings. This is the right split and
   it is argued correctly in `ConnectCodes.cs`.
7. **Admission is claimed atomically** — `claim_lobby_admission` is an UPDATE
   whose result is the check, so two racing polls cannot both be handed a
   token, and a replayed token answers `Gone()` rather than admitting that it
   was once valid.
8. **The waiting room defaults to parking guests.** Opting out is explicit.
   Defaulting the other way would make a leaked link a seat.
9. **Share policy is read at admission, not at the knock** — a host who
   tightens sharing while someone waits means it.
10. **Guest identity is keyed to the participant row, not the display name.**
    Two people called Ravi stay two people, and attendance aggregates.
11. **The rate limiter partitions on the LAST `X-Forwarded-For` entry.**
    Behind Caddy that is the real peer; earlier entries are client-supplied and
    spoofable. This is the documented rule and it is followed.

## Open question 3, answered

> *"A wrong password after a valid code answers 403, not 404."*

**Accepted.** It would be a leak if meeting codes were guessable — the pair
(404, 403) would then be an enumeration oracle. They are not: 128 bits from the
CSPRNG. Anyone who holds a valid code already knows the meeting exists, so the
distinct answer tells them nothing and lets a typo be corrected. Keep it.

## Findings

### F1 — the wait poll rate-limits a shared office off its own meeting

`connect-guest` is a fixed window of **60 requests per minute per IP**, and
`/wait/{waitToken}` is polled "every couple of seconds". One guest waiting is
~30 requests a minute. **Three guests behind one office NAT — or one company
firewall, or one 4G carrier CGNAT — exceed 60 and start receiving 429s while
waiting to be admitted.** They cannot collect an admission the host has already
granted, and the failure looks like the meeting is broken.

This is the most likely of the three to be met by a real customer, because
"several people from the same company join the same meeting" is the normal
case, not an edge case.

**Recommended fix:** partition `/wait/{waitToken}` on the **hash of the wait
token** rather than on the IP. The token is a bearer credential unique to one
waiting person, so it is a strictly better key: it caps the individual poller,
it cannot be shared by an office, and it cannot be inflated by a stranger who
does not hold a token. Keep the IP partition for `/{code}` and `/{code}/join`.

### F2 — a valid code lets anyone create unbounded participant rows

`GuestJoinAsync` INSERTs a `ConnectParticipant` on every accepted attempt,
before any admission decision, with no cap and no dedupe. Where the waiting
room is on, it also parks a lobby request. The rate limiter caps the *rate*,
not the *total*: 60 a minute, indefinitely.

So a leaked or forwarded meeting code lets someone fill the host's waiting room
faster than a human can deny, and pollute the attendance report — which is one
of the three USP features — with rows that never attended anything.

**Recommended fix:** a per-meeting ceiling on pending lobby requests and on
guest participants, refused with the same `Gone()` sentence. A number as blunt
as 200 would do; the point is that it is bounded.

### F3 — an admitted guest can be handed a token for a meeting that has ended

`WaitAsync` checks the lobby row's status but never re-reads the meeting's.
`GuestJoinAsync` refuses `ended`; the wait path does not. A guest parked before
the meeting ended, and admitted (or auto-admitted) after, receives a valid
LiveKit token for a room nobody is in.

Minor — the room is empty and the token expires — but it is a token minted for
a meeting the server knows is over. Add the same `status == "ended"` check that
`GuestJoinAsync` already makes.

## Not findings, recorded so they are not re-raised

- Argon2 verification is slow by design; the 403 path is not a timing oracle
  worth chasing given the code entropy above.
- `Role = "guest"` grants nothing anywhere. It is a label, and the file says so.
- A guest join with the waiting room off returns a token immediately. That is
  the host's explicit choice, and the default is the safe one.
