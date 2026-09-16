'use client';

// ============================================================================
//  The account chooser
// ============================================================================
//
//  Several accounts signed in at once, switchable without a password. An IT
//  admin holding accounts in three customers, or someone running their own
//  address alongside hr@, should not have to sign out to move between them.
//
//  Two behaviours are worth keeping deliberately:
//
//  1. SIGNING OUT DOES NOT REMOVE THE ACCOUNT FROM THE LIST. It becomes a
//     "Signed out" row with Sign in / Remove. An account that vanishes on
//     sign-out reads as data loss, and the person then has to remember the
//     address to get back.
//
//  2. NOTHING HERE HOLDS A TOKEN. The list arrives from the API, assembled
//     server-side from httpOnly cookies. Switching is a server call that
//     revalidates the target slot's refresh token. This component knows names
//     and slot numbers, which is all it needs to render.
// ============================================================================

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useAuth, type AccountSlot } from '@/lib/auth';
import { useSelfPhoto } from '@/components/ui/UserPhoto';
import { AnchoredPopover } from '@/components/ui/AnchoredPopover';
import { Spinner } from '@/components/ui/Kit';

/** Stable per-address colour, so an account keeps the same tile every time. */
const TILE = ['#7367f0', '#28c76f', '#ff9f43', '#ea5455', '#00cfe8', '#a855f7'];

function tint(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return TILE[h % TILE.length] ?? '#7367f0';
}

function initials(name: string, email: string): string {
  const src = name.trim() || email;
  const parts = src.split(/[\s.@_-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[1]?.[0] ?? '' : '';
  return (a + b).toUpperCase();
}

const PILL = 'rounded-full border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-canvas disabled:opacity-50';

export function AccountMenu({ anchorEl, onClose }: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { user, accounts, signOut, switchTo, forget, refreshAccounts } = useAuth();

  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selfPhoto = useSelfPhoto();

  // The roster changes in another tab too — signing out over there should not
  // leave this menu offering an account that is gone.
  useEffect(() => { if (anchorEl) void refreshAccounts(); }, [anchorEl, refreshAccounts]);

  const others = accounts.filter((a) => a.email !== user?.email);
  const managedBy = accounts.find((a) => a.active)?.organisation;

  async function onSwitch(a: AccountSlot) {
    if (!a.signedIn) { router.push(`/login?email=${encodeURIComponent(a.email)}`); return; }
    setBusy(a.slot);
    setError(null);
    try {
      await switchTo(a.slot);
      onClose();
      // Full navigation, not router.push. Every open screen is holding data
      // for the previous tenant, and a client-side transition would leave
      // stale rows on the page while the new session loads underneath.
      window.location.assign('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch account.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <AnchoredPopover anchor={anchorEl} onClose={onClose} width={340} padded={false}>
      {/* ---- the account in use ---- */}
      <div className="px-5 pb-5 pt-4 text-center">
        <p className="truncate text-sm font-semibold text-ink">{user?.email}</p>
        {managedBy && <p className="text-xs text-ink-muted">Managed by {managedBy}</p>}

        {selfPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={selfPhoto} alt="" className="mx-auto my-4 h-[72px] w-[72px] rounded-full object-cover" />
        ) : (
          <div
            className="mx-auto my-4 grid h-[72px] w-[72px] place-items-center rounded-full text-[26px] font-semibold text-white"
            style={{ backgroundColor: tint(user?.email ?? '') }}
          >
            {initials(user?.displayName ?? '', user?.email ?? '')}
          </div>
        )}

        <p className="mb-4 text-lg font-medium text-ink">
          Hi, {(user?.displayName ?? '').split(' ')[0] || 'there'}
        </p>

        <a href="/account" onClick={onClose}
           className="inline-block rounded-full border border-brand-600 px-5 py-1.5 text-sm font-medium text-brand-600 transition hover:bg-brand-50">
          Manage your account
        </a>
      </div>

      {error && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="font-semibold">×</button>
        </div>
      )}

      {/* ---- the other accounts ---- */}
      {others.length > 0 && (
        <div className="bg-canvas">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-ink transition hover:bg-line/40"
          >
            <span>
              {expanded
                ? 'Hide more accounts'
                : `Show ${others.length} more account${others.length === 1 ? '' : 's'}`}
            </span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {expanded && others.map((a) => (
            <div key={a.slot} className="border-t border-line px-4 py-3">
              <div className="flex items-center gap-3">
                <div
                  className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full text-[13px] font-semibold ${
                    a.signedIn ? 'text-white' : 'text-ink-faint'
                  }`}
                  style={{ backgroundColor: a.signedIn ? tint(a.email) : 'rgb(var(--line))' }}
                >
                  {initials(a.displayName, a.email)}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{a.displayName}</p>
                  <p className="truncate text-xs text-ink-muted">{a.email}</p>
                </div>

                {a.signedIn ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void onSwitch(a)}
                    aria-label={`Switch to ${a.email}`}
                    className="rounded-full p-1.5 text-ink-muted transition hover:bg-surface hover:text-ink disabled:opacity-40"
                  >
                    {busy === a.slot ? (
                      <Spinner inline label="Switching" className="block text-[18px] text-brand-600" />
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    )}
                  </button>
                ) : (
                  <span className="shrink-0 rounded bg-line/60 px-2 py-0.5 text-xs text-ink-muted">
                    Signed out
                  </span>
                )}
              </div>

              {!a.signedIn && (
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => void onSwitch(a)}
                          className="flex-1 rounded-full bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700">
                    Sign in
                  </button>
                  <button type="button" onClick={() => void forget(a.slot)} className={`flex-1 ${PILL}`}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="h-px bg-line" />

      <div className="flex gap-2 p-3">
        <button type="button" className={`flex-1 ${PILL}`}
                onClick={() => { onClose(); router.push('/login?add=1'); }}>
          Add account
        </button>
        <button type="button" className={`flex-1 ${PILL}`}
                onClick={() => { onClose(); void signOut(); }}>
          Sign out
        </button>
      </div>

      {accounts.length > 1 && (
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => { onClose(); void signOut(true); }}
            className="w-full rounded-full px-3 py-1.5 text-sm font-medium text-danger transition hover:bg-danger/10"
          >
            Sign out of all accounts
          </button>
        </div>
      )}

      <div className="px-5 pb-4">
        <p className="text-xs text-ink-faint">
          Accounts stay signed in on this browser only. On a shared machine use
          &ldquo;Sign out of all accounts&rdquo;.
        </p>
      </div>
    </AnchoredPopover>
  );
}
