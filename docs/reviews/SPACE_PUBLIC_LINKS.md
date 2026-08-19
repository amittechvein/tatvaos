# Security review — Space's public-link anonymous path

**Reviewed by Core, 19 August 2026.**
`apps/api/Modules/Space/Endpoints/SpaceLinkEndpoints.cs` from the ANONYMOUS
PAIR banner down, `local/postgres/init/20260816-space-public-links.sql`, and
the `space-public-links` rate-limiter policy.

`docs/plans/LARGE_ATTACHMENTS.md` made this review a hard gate before the path
shipped. **It shipped first** — `feature/space-public-links` was already merged
to main when I came to review it, exactly as Connect's guest path was. Recorded
here, and raised with Amit as a pattern rather than as this lane's fault.

## Verdict

**Pass, two findings, neither a reason to change anything today.**

This is the most carefully built endpoint on the platform, and the one that
most needed to be. Every property the plan asked for is present and provable.

## What I verified

1. **The twin predicates are identical, and I diffed them mechanically rather
   than by eye.** `peek_public_link` and `consume_public_link` gate on the same
   seven conditions, in the same order, with the same comments:

   ```
   token_hash matches
   AND revoked_at IS NULL
   AND expires_at > now()
   AND (max_downloads IS NULL OR download_count < max_downloads)
   AND file deleted_at IS NULL
   AND tenant status IN ('active','trial')
   AND COALESCE(allow_public_links, true)
   ```

   The only textual difference is `f.id = l.file_id`, which is the join
   expressed in the `UPDATE ... FROM` form where `peek` uses an explicit JOIN.
   Designing these to be diffable was the right call and it works: a divergence
   would be visible in seconds.

2. **`t.status IN ('active','trial')`** — trial tenants are live customers. The
   mail edge learned this the hard way when trials got "relay access denied".
   Consistent here.

3. **Both functions are `SECURITY DEFINER` with `SET search_path = space, core,
   pg_temp`.** Mandatory and present. `peek` is `STABLE` (no side effects, so
   the landing page counts nothing); `consume` is volatile because it writes.

4. **The consume is one `UPDATE`, and the UPDATE is the check.** The count
   cannot be raced past `max_downloads` by parallel requests, because there is
   no read-then-write window to race.

5. **One failure answer.** `LinkNotFound()` for revoked, expired, over-limit,
   trashed, unknown, wrong shape, policy-disabled, suspended tenant, and a
   missing blob. No oracle.

6. **Shape check before spend** — `TokenShape()` runs before any hash or query.

7. **Always a download, never a page.** `X-Content-Type-Options: nosniff`, and
   `Results.File(..., fileDownloadName)` forces `Content-Disposition:
   attachment`. This is the property that matters most: `space.tatvaos.com`
   holds live sessions, and rendering a stranger's HTML from that origin would
   be cross-site scripting against every Space user.

8. **Rate limited** at the group, 60/minute, partitioned on the **last**
   `X-Forwarded-For` entry — the real peer behind Caddy, not the spoofable
   client-supplied ones.

9. **The tap, not the handle.** `allow_public_links = false` is evaluated in
   the resolve predicate, so existing links stop working immediately and
   reversibly. That is the school scenario from the plan, implemented as
   specified.

## Findings

### F1 — a server-side fault charges the recipient a download

`DownloadAsync` consumes first, then opens the blob. If the blob is missing,
the count is already spent. The code says so plainly rather than hiding it,
which I respect — but on a link with `max_downloads = 1`, a fault on our side
costs the recipient their only download, and the one answer they get is "this
link does not work."

**Recommended:** on a missing blob, refund the count — a decrement in the same
definer style. A missing blob is our failure, not a use of the link. The
ordering itself is right: consuming after streaming would reintroduce the race
that the atomic UPDATE exists to remove.

### F2 — no range requests, on the feature built for large files

`Results.File` on a fresh stream with no range processing, deliberately, so
that one GET is one download is one count. Sound reasoning — but this feature
exists so that a 40 MB attachment can be mailed, and a 40 MB download over an
Indian mobile connection is exactly the download that fails at 80% and cannot
resume. Where `max_downloads` is set, a failed attempt has also burned a count.

Default `max_downloads` is NULL, so most links are only inconvenienced. Worth
revisiting if the acceptance test's 40 MB file turns out to fail often in the
field. Not a change to make speculatively.

## Not findings

- `sharedByDisplayName` is returned to the anonymous internet. Conscious, and
  argued in the v1.3 addendum: the landing page's job is to look legitimate to
  someone deciding whether to trust a download, and the recipient already knows
  who sent it. With 128-bit tokens there is nothing to enumerate. Agreed.
- `peek` reveals the file's name and size to a token holder. That is what the
  doorstep page is for.
