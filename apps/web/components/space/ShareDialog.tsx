'use client';

// ============================================================================
//  The share dialog — one implementation for every Space item.
//
//  Moved out of app/space/[view]/page.tsx unchanged (24 Sept 2026) when Docs
//  needed the same dialog: a document is a Space file and is shared through
//  the same endpoints, so a second dialog would be a second copy of the
//  privacy rules below (partial lists, no counts) — house rule 10.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { formatDateShort } from '@/lib/dates';
import { useAuth } from '@/lib/auth';
import { spaceApi, linkApi, type PublicLink, type SpaceFile, type SpaceShare } from '@/lib/space';

/**
 * Who has access. Org-wide sharing works for anyone allowed to share; naming
 * a colleague needs their user id, which today only the org People API
 * exposes — non-admins see the note instead of a broken picker. (A Space
 * directory endpoint is the known follow-up.)
 */
export function ShareDialog({ kind, item, onClose, onChanged, publicLinks = true }: {
  kind: 'files' | 'folders';
  item: Pick<SpaceFile, 'id' | 'name' | 'ownershipType'>;
  onClose: () => void;
  onChanged: () => void;
  /** "Anyone with the link" download links. Docs turns them off: a document's
   *  link would download its HTML rendering, not open the document, and
   *  people reading "anyone with the link" expect the second. */
  publicLinks?: boolean;
}) {
  const { authedFetch } = useAuth();
  const [shares, setShares] = useState<SpaceShare[] | null>(null);
  // false => the list is deliberately PARTIAL. Not a permission error and
  // not an empty list: rows about other people were never sent. Held
  // separately because a partial list and a complete one look identical.
  //
  // Defaults to FALSE, the cautious value. Today it cannot be read before
  // the fetch sets it (both land in the same .then, and every branch is
  // guarded on shares !== null) - but a privacy control whose default
  // over-discloses is one refactor away from doing so, and the cautious
  // default costs nothing.
  const [canSeeEveryone, setCanSeeEveryone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- the chip picker ------------------------------------------------
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<{ id: string; displayName: string; email: string }[]>([]);
  const [chips, setChips] = useState<{ id: string; displayName: string }[]>([]);
  const [inviteLevel, setInviteLevel] = useState<SpaceShare['permission']>('view');

  const reload = useCallback(() => {
    spaceApi.sharesDetail(authedFetch, kind, item.id)
      .then((b) => { setShares(b.shares); setCanSeeEveryone(b.canSeeEveryone); })
      .catch((e: Error) => setErr(e.message));
  }, [authedFetch, kind, item.id]);

  useEffect(() => { reload(); }, [reload]);

  // Debounced directory search — a keystroke should not be a query.
  useEffect(() => {
    const q = term.trim();
    if (!q) { setHits([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      spaceApi.directory(authedFetch, q)
        .then((people) => { if (!cancelled) setHits(people.filter((p) => !chips.some((c) => c.id === p.id))); })
        .catch(() => { if (!cancelled) setHits([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term, authedFetch, chips]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); reload(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  }

  /** Send the invitations — every chip at the chosen level, in one go. */
  async function invite() {
    await run(async () => {
      for (const c of chips) {
        await spaceApi.share(authedFetch, kind, item.id, { userId: c.id }, inviteLevel);
      }
      setChips([]); setTerm('');
    });
  }

  // General access: the org-wide row, if any. Named audiences live below it.
  const orgShare = shares?.find((s) => s.orgWide) ?? null;
  const named = shares?.filter((s) => !s.orgWide) ?? [];

  return (
    <>
      <div className="fixed inset-0 z-[1190] bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="fixed left-1/2 top-1/2 z-[1200] w-[min(520px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-card border border-line bg-surface shadow-raised">
        <div className="px-5 pt-5">
          <h2 className="mb-3 truncate text-base font-semibold text-ink">
            Share &ldquo;{item.name}&rdquo;
          </h2>

          {err && <p className="mb-2 text-sm text-danger">{err}</p>}

          {/* ---- Invite box: chips + a level for the whole invitation ---- */}
          <div className="relative mb-1">
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line px-2 py-1.5">
              {chips.map((c) => (
                <span key={c.id}
                      className="flex items-center gap-1 rounded-full bg-canvas px-2 py-0.5 text-xs text-ink">
                  {c.displayName}
                  <button type="button" aria-label={`Remove ${c.displayName}`}
                          onClick={() => setChips((p) => p.filter((x) => x.id !== c.id))}
                          className="text-ink-faint hover:text-danger">×</button>
                </span>
              ))}
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder={chips.length === 0 ? 'Add people by name or email' : ''}
                className="min-w-[8rem] flex-1 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint"
              />
              {chips.length > 0 && (
                <select value={inviteLevel} disabled={busy}
                        onChange={(e) => setInviteLevel(e.target.value as SpaceShare['permission'])}
                        className="shrink-0 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink">
                  <option value="view">Viewer</option>
                  <option value="comment">Commenter</option>
                  <option value="edit">Editor</option>
                </select>
              )}
            </div>

            {hits.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-[1400] mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-raised">
                {hits.slice(0, 6).map((p) => (
                  <button key={p.id} type="button"
                          // mousedown, not click: click lands after blur and the
                          // list would already be gone.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setChips((c) => [...c, { id: p.id, displayName: p.displayName }]);
                            setTerm(''); setHits([]);
                          }}
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-canvas">
                    <span className="block font-medium text-ink">{p.displayName}</span>
                    <span className="block text-xs text-ink-muted">{p.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {chips.length > 0 && (
            <div className="mb-3 mt-2 flex justify-end">
              <button type="button" disabled={busy} onClick={() => void invite()}
                      className="rounded-full bg-brand-600 px-5 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Sharing…' : 'Share'}
              </button>
            </div>
          )}

          {/* ---- People with access ---- */}
          <h3 className="mb-1 mt-4 text-sm font-semibold text-ink">People with access</h3>
          <div className="max-h-40 overflow-y-auto">
            {shares === null ? (
              <p className="py-1 text-xs text-ink-faint">Loading…</p>
            ) : named.length === 0 ? (
              <p className="py-1 text-xs text-ink-faint">
                {/* "Only you" is a claim about other people, and a non-owner is
                    not shown rows about them - so only the owner may say it. */}
                {canSeeEveryone
                  ? <>Only you. {item.ownershipType === 'organisational'
                      ? 'This item belongs to the organisation, so colleagues may already reach it.'
                      : 'Nobody else can open this.'}</>
                  : 'Shared with others.'}
              </p>
            ) : named.map((s) => (
              <div key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">
                  {s.userDisplayName ?? s.userId}
                </span>
                {/* Changing the level is an upsert on the same audience, so the
                    select IS the edit — no separate save. */}
                <select
                  value={s.permission}
                  disabled={busy}
                  onChange={(e) => void run(() => spaceApi.share(
                    authedFetch, kind, item.id, { userId: s.userId! },
                    e.target.value as SpaceShare['permission']))}
                  className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                >
                  <option value="view">Viewer</option>
                  <option value="comment">Commenter</option>
                  <option value="edit">Editor</option>
                </select>
                <button type="button" disabled={busy}
                        onClick={() => void run(() => spaceApi.unshare(authedFetch, kind, item.id, s.id))}
                        className="text-xs text-danger hover:underline">
                  remove
                </button>
              </div>
            ))}
            {/* The list above is what THIS viewer may know about. Without this
                line a partial list is indistinguishable from a complete one,
                which is the whole reason canSeeEveryone is on the response.
                Deliberately no count: how many other people hold access is
                itself a fact about them. */}
            {shares !== null && !canSeeEveryone && (
              <p className="py-1 text-xs text-ink-faint">
                Shared with others. Only the person who uploaded this, and
                organisation admins, can see everyone on the list.
              </p>
            )}
          </div>

          {/* ---- General access ---- */}
          <h3 className="mb-1 mt-4 text-sm font-semibold text-ink">General access</h3>
          <div className="mb-1 flex items-center gap-2">
            <select
              value={orgShare ? 'org' : 'restricted'}
              disabled={busy}
              onChange={(e) => void run(() => e.target.value === 'org'
                ? spaceApi.share(authedFetch, kind, item.id, { orgWide: true }, orgShare?.permission ?? 'view')
                : spaceApi.unshare(authedFetch, kind, item.id, orgShare!.id))}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
            >
              <option value="restricted">Restricted</option>
              <option value="org">Everyone in the organisation</option>
            </select>

            {orgShare && (
              <select
                value={orgShare.permission}
                disabled={busy}
                onChange={(e) => void run(() => spaceApi.share(
                  authedFetch, kind, item.id, { orgWide: true },
                  e.target.value as SpaceShare['permission']))}
                className="ml-auto rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              >
                <option value="view">Viewer</option>
                <option value="comment">Commenter</option>
                <option value="edit">Editor</option>
              </select>
            )}
          </div>
          <p className="mb-4 text-xs text-ink-muted">
            {orgShare
              ? `Anyone signed in to your organisation can ${
                  orgShare.permission === 'view' ? 'view' : orgShare.permission === 'comment' ? 'comment on' : 'edit'
                } this.`
              : 'Only people added above can open this.'}
            {/* No public links, deliberately: an audience is a colleague or the
                organisation. A link anyone on the internet can open is a
                different security decision and is not in this product yet. */}
          </p>
          {/* ---- Anyone with the link (files only) ---- */}
          {kind === 'files' && publicLinks && <PublicLinkSection fileId={item.id} />}
        </div>

        <div className="flex justify-end border-t border-line px-5 py-3">
          <button type="button" onClick={onClose}
                  className="rounded-full bg-brand-600 px-6 py-1.5 text-sm font-semibold text-white">
            Done
          </button>
        </div>
      </div>
    </>
  );
}


/**
 * "Anyone with the link" — the third audience, files only.
 *
 * The URL is shown ONCE, at creation: the server stores only a hash, so it
 * cannot be re-displayed later, the same rule as MFA recovery codes. The list
 * that follows shows that links exist, when they die, and how to revoke them
 * — everything except the secret.
 *
 * Degrades to silence while the backend endpoint does not exist yet: a
 * feature that is not deployed should be absent, not broken.
 */
function PublicLinkSection({ fileId }: { fileId: string }) {
  const { authedFetch } = useAuth();
  const [links, setLinks] = useState<PublicLink[] | 'unsupported' | null>(null);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(30);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    authedFetch(`/space/files/${fileId}/links`)
      .then(async (r) => {
        if (r.status === 404) { setLinks('unsupported'); return; }
        const b = await r.json().catch(() => ({ links: [] }));
        setLinks(b.links ?? []);
      })
      .catch(() => setLinks('unsupported'));
  }, [authedFetch, fileId]);

  useEffect(() => { reload(); }, [reload]);

  if (links === 'unsupported' || links === null) return null;

  const live = links.filter((l) => !l.revokedAt);

  return (
    <>
      <h3 className="mb-1 mt-4 text-sm font-semibold text-ink">Anyone with the link</h3>

      {freshUrl ? (
        <div className="mb-2 rounded-lg border border-brand-600/40 bg-brand-50 p-2.5">
          <p className="mb-1.5 text-xs text-ink">
            Link created. <strong>Copy it now</strong> — for safety it cannot be
            shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-xs text-ink">
              {freshUrl}
            </code>
            <button type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(freshUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="shrink-0 rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-2">
          <select value={expiry} disabled={busy}
                  onChange={(e) => setExpiry(Number(e.target.value))}
                  className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
            <option value={7}>Expires in 7 days</option>
            <option value={30}>Expires in 30 days</option>
            <option value={90}>Expires in 90 days</option>
            <option value={365}>Expires in 1 year</option>
          </select>
          <button type="button" disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    linkApi.create(authedFetch, fileId, expiry)
                      .then((l) => { setFreshUrl(l.url); reload(); })
                      .catch(() => {/* the section stays; the button re-enables */})
                      .finally(() => setBusy(false));
                  }}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition hover:bg-canvas hover:text-ink disabled:opacity-50">
            {busy ? 'Creating…' : 'Create link'}
          </button>
        </div>
      )}

      {live.length > 0 && (
        <div className="mb-1">
          {live.map((l) => (
            <div key={l.id} className="flex items-center gap-2 py-1 text-xs text-ink-muted">
              <span className="min-w-0 flex-1 truncate">
                Expires {formatDateShort(l.expiresAt)}
                {l.downloadCount > 0 && ` · downloaded ${l.downloadCount}×`}
              </span>
              <button type="button" disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        linkApi.revoke(authedFetch, fileId, l.id)
                          .then(() => { if (freshUrl) setFreshUrl(null); reload(); })
                          .catch(() => {})
                          .finally(() => setBusy(false));
                      }}
                      className="shrink-0 text-danger hover:underline">
                revoke
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="mb-1 text-xs text-ink-muted">
        Anyone on the internet with the link can download this file until it
        expires or you revoke it. Nothing else in Space is reachable from it.
      </p>
    </>
  );
}
