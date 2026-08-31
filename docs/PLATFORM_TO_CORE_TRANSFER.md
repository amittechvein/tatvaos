# Platform lane — transferred to Core

**Decision, 31 August 2026, Amit's call:** the Platform lane closes as a separate
lane. Core takes `platform.tatvaos.com` and everything that was going to be built
on it. There is no separate Platform developer.

This note records what transfers and what is outstanding. It does **not** repeat
the lane's technical content — `docs/PLATFORM_LANE_HANDOVER.md` remains the
reference for that, and its warnings still apply. One paragraph in it is now
wrong; see "First task" below.

---

## 1. What you are inheriting, already live

Nothing was ever built in the Platform lane — `lane/platform` has no commits on
it. Everything below is work Core did before the lane existed, and it is running
in production today.

- **The door.** `infra/docker/conf.d/platform.caddy`, DNS resolving, certificate
  issued.
- **The landing page.** `apps/web/app/platform/page.tsx` — static,
  unauthenticated, server-rendered, because a client's developer reads it before
  they have an account. Anything needing a session links *into* the products.
- **The mail-client story it documents.** TLS submission and IMAPS, authenticated
  submission, app passwords. Built by Core and Mail; the page is its brochure.

So this transfer costs nothing in lost work. What it changes is who does the next
three things.

---

## 2. Outstanding — three items, none started

**a. The mail connection settings are duplicated and only Mail's copy is marked.**
Mail shipped their marker. The two copies that were Platform's — the landing page
and `docs/CLIENT_MAIL_SETUP.md` — are still unmarked, so the value-grep that is
supposed to be the check will not yet find them. Until both carry the marker, the
check is incomplete and reports nothing wrong.

The agreed rule, per rule 9: the marker carries **no count and no line numbers**.
`git grep` on the port values, scoped to real directories, is the authoritative
list; every hit either carries the marker or sits on an exceptions list with its
reason on the same line (`587.33 — audio frequency, D5 knock chime, not a port`).

Note when you write these: the same grep matches two different concepts — the
**customer-facing** port someone types into Outlook, and the **container-internal**
port the stack wires itself with. They move independently. Either use two markers,
or make sure the exception reasons say which is which; "not a port" is the wrong
reason to write beside a real internal port.

**b. `docs/PLATFORM_LANE_HANDOVER.md` contains a paragraph that is now false in
three ways.** It cites a patch file that has since been deleted, says the mail
liveness checks are "not on `main` yet" when they are, and tells the reader not to
go looking for `verify-live.sh` when it exists and `deploy.sh` refuses success on
its failure.

It was accurate when written and every clause was falsified by work going well,
inside two days, in the section of the document that teaches *documented is not
built*. Replace it with the mechanism rather than the locations — something like:
`deploy.sh` runs `verify-live.sh` and refuses success on its failure, which is
what makes "the deploy passed" mean something; its own service-count line still
only knows container state, so check what the script actually asserts rather than
trusting the green.

**c. The landing page's first small change** — the "ship one thing end to end while
the stakes are tiny" task. You do not need this; you have shipped through this
pipeline many times. Skip it.

---

## 3. The queue, and the decision that gates it

Amit's order, unchanged by the transfer:

1. **Personal access tokens** — a developer authenticating to our APIs as
   themselves.
2. **Organisation API keys** — a customer's software authenticating as the
   organisation.
3. **The public APIs' documentation** — people, then mailboxes, then meetings, as
   each ships.

Two questions are outstanding with Amit and one of them can reorder the list:

- **Which client is waiting on programmatic access, and what were they promised,
  by when?** Organisation API keys are second, not first. If that client is close,
  the order changes.
- **Do organisation API keys need scopes in v1** — limiting a key so a customer's
  software can send mail but not create users? Simpler without; harder to add
  later without breaking keys already issued.

The constraints that shape the design are in `Shared/Auth`, which you already own:
`TokenIssuer.cs` explains why access tokens live fifteen minutes and why a JWT
cannot be withdrawn once signed — a long-lived key is a different animal in
exactly that spot. `PasswordHasher.cs` is the house hashing. And before choosing
any scheme, read the `{SCHEME}` comment in the app-passwords migration: the stored
hash names its own algorithm, because a store that relied on a default verified
every hash against the wrong one for weeks.

Two rules that are not negotiable, both already encoded in
`MailAppPasswordEndpoints.cs`, which is the shape to copy:

- A credential is **shown once**, at generation, and never retrievable — only a
  hash is stored.
- Per-organisation keys must respect `core.tenants` liveness at authentication
  time: a suspended org's keys die with it.

---

## 4. What actually changes, structurally

The lane split existed for a reason worth naming before it disappears.

Platform owned the developer's experience of the APIs; Core owned the logic and
the cryptography. That meant the token design had a **required second reader** —
"pair on it, don't build it alone" was a structural check, not politeness. One
person now owns both sides, so that check is gone.

That is a real loss and it is not fixed by intending to be careful; this team has
spent a week establishing that intending to be careful is what fails. Two cheap
substitutes, either of which restores the second reader:

- The CTO reviews the token and key design **before** the migration lands, as a
  design review rather than a code review.
- Or the design goes to Mail, who has the most recent scar tissue on credential
  storage in this repo.

Pick one and say which in your open-threads page. The point is that a person who
did not write it reads it before it becomes a schema.

**Ownership that moves with the lane:**

- `apps/web/app/platform/`, `infra/docker/conf.d/platform.caddy`, and the
  developer documentation are now Core's outright.
- `docs/CLIENT_MAIL_SETUP.md` was ruled Platform's, with Mail as required reviewer
  on the connection facts — hosts, ports, security settings. **The reviewer
  requirement survives the transfer.** It exists because Mail owns whether those
  facts are true, and that has not changed.

---

## 5. Housekeeping

- `lane/platform` has no commits. The branch and the
  `C:\Users\amitd\Downloads\tatvaos-platform` worktree can be removed, or kept and
  used for Platform-facing work if you prefer the separation in your own history.
- If you remove the worktree, remove it with `git worktree remove` rather than
  deleting the folder, so the repo's worktree list stays clean.
- `docs/PLATFORM_LANE_HANDOVER.md` stays. Retitle it if you like, but its three
  warnings — the Caddy domain being a three-place edit, the `{SCHEME}` lesson, and
  the duplicated connection settings — are the expensive part and should not be
  edited out. Item 2b above is the only paragraph that needs replacing.

---

## 6. The one thing to carry over from the lane's founding document

Platform faces **programs rather than people**. An error message that works for a
person does not work for a program: return JSON with the right status code, not a
page. A customer's developer reads your documentation months after you write it,
having forgotten everything. Make it easy to use, hard to misuse, and clear about
what happens when it goes wrong.

That was true when the lane had its own owner and it is true now that it doesn't.

---

*Transfer recorded 31 August 2026.*
