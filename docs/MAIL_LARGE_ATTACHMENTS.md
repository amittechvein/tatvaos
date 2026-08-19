# Large attachments — park in Space, link in the message

Mail lane. Built on `lane/mail` against `main` at `6a85cea`, once Space's
public links landed and removed the blocker this feature sat behind.

---

## What changed for the person writing the message

Before, the 25 MB ceiling was a **dead end**: the composer refused the whole
selection and said so, which left somebody holding a 40 MB video with nothing
to do but find another way to send it.

Now:

1. Files are taken in order, each measured against what is left. A 30 MB file
   and a 1 MB file attaches the small one rather than refusing both.
2. Anything that does not fit is **offered** as a link.
3. Accepting uploads it to the sender's own Space, into `Email attachments`,
   and puts a public link on the message.
4. The links are appended to **both** body halves at send.

Nothing about messages under 25 MB changed.

---

## The pre-check, which is the part worth arguing about

The allowance is read **when the file is picked**, before a byte moves.

Since Core's storage change one allowance covers a person's mail *and* their
files, so somebody nowhere near full on email can still have no room for a 2 GB
video. Finding that out after the upload — four minutes of progress bar ending
in a refusal — is the bad version.

A storage read that **fails** is not a refusal. The offer is made anyway and
the server gets to be the judge: it refuses correctly, and guessing "no" here
would block somebody with plenty of room because one unrelated call had a bad
moment.

---

## Two calls, and the gap between them

`POST /api/mail/attachments/to-space` then `POST /api/space/files/{id}/link`.

Once the upload returns, **the file exists in their Space whether or not the
link succeeds.** Any failure after that point says where the file went. It is
not lost — it is in `Email attachments` — but only if we say so.

The likeliest link failure is an administrator having turned public links off
for the organisation. Space says so in its message, and that sentence is shown
rather than swallowed: otherwise somebody retries a thing that is not going to
start working.

---

## Decisions

**The upload goes through `authedUpload`, not `authedFetch`.** This is the one
call in the mail client that can be carrying half a gigabyte. `fetch()` gives
no progress, so the composer would show a button that does nothing for four
minutes — indistinguishable from broken, and the second click is the one that
makes it worse. XHR also survives an access token expiring mid-upload, which at
these sizes is a real event, and can be cancelled.

**Refusals are data, not exceptions.** Somebody out of storage is not an error
condition. The `reason` codes are Core's, shared verbatim with the Space upload
path, so the two surfaces cannot drift into two vocabularies for one refusal.
Cancellation is the exception to the exception: an `AbortError` is rethrown,
because a person stopping their own upload must not be told they failed.

**Thirty days, stated explicitly, not Space's default.** The message body tells
the recipient a date. If Space changed its default tomorrow, every promise
already sitting in an inbox would quietly become wrong, and nobody would find
out until a link died early. Thirty days is chosen for mail specifically:
people open attachments late, and a link that expires before the recipient
reaches it is the same failure as never sending one.

**The expiry sentence names the EARLIEST link's date.** One sentence covering
several links has to be true of all of them.

**Both body halves get the links.** Outgoing mail is `multipart/alternative`; a
link in only one part means half the recipients see a message that mentions an
attachment and does not have one — the exact bug the signature had.

**The block is appended at send, not inserted as you attach.** It cannot be
half-deleted by an editing cursor and cannot drift out of step with the chips.
What the chips show is what goes out.

**Removing a link chip does not delete the file.** It comes off *this message*.
Deleting somebody's upload to undo a compose-window decision is not a trade we
get to make.

**No `mailboxId` is sent.** The file lands in the signed-in person's own Space
whichever mailbox they are composing from. Resolving one would refuse somebody
writing from a shared queue because the queue's owner is full, which is not
their problem to fix.

---

## Not done

- **Resuming an interrupted upload.** A cancelled or dropped 500 MB upload
  starts again from zero. Chunked upload is Space's to build, not Mail's.
- **Links on a saved draft.** The draft warning now says files sent as links
  *do* survive, because they are already in Space — but the link itself is not
  restored into a reopened draft. It needs a place to persist per draft.
- **Revoking from Mail.** Links are managed in Space. A sent message has no
  "unshare" button.
