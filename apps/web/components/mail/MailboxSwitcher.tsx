'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { mailApi, type MailboxChoice } from '@/lib/mail';
import { Icon } from '@/components/ui/Icon';

// ============================================================================
//  Which mailbox am I looking at?
// ============================================================================
//
//  Lives in a context because the switcher renders in the SHELL (the layout's
//  rail) and the selection is consumed by the PAGE beneath it — there is no
//  prop path between them.
//
//  The selection is NOT in the URL. Folder ids differ per mailbox, so a URL
//  carrying both would be a pair that can disagree; /mail/inbox resolves by
//  slug and stays correct whichever mailbox is open. It also avoids
//  useSearchParams, which needs a Suspense boundary and fails only in a
//  production build.
//
//  It resets to your own mailbox on reload, deliberately. Someone who opened
//  a colleague's queue yesterday should not find themselves reading it by
//  accident tomorrow — and answering from the wrong address is worse.
// ============================================================================

interface MailboxState {
  /** Every mailbox this person may open. Own first; empty while loading. */
  mailboxes: MailboxChoice[];
  /** The open one. Null until the list loads, then always set. */
  current: MailboxChoice | null;
  /** Undefined for your own mailbox — the API's "no mailboxId" default. */
  mailboxId: string | undefined;
  /** True when reading somebody else's queue. Gates destructive actions. */
  isShared: boolean;
  /** Grants held on the open mailbox: does it allow answering? */
  canSend: boolean;
  /**
   * False until the mailbox list has come back and a selection has been made.
   *
   * ── WHY ANYONE NEEDS THIS (Amit, 23 September 2026) ───────────────────
   *
   *  "Same signature taking in shared mailbox." Opening Mail straight into a
   *  shared queue showed the SHARED address in From and the PERSONAL
   *  signature in the body.
   *
   *  Nothing was wrong with either of them. The list above is fetched, so for
   *  the first moments `current` is null and `mailboxId` is undefined — which
   *  means "my own mailbox" to every call. The page bootstrapped with that,
   *  got the personal signature, and a composer opening in that instant
   *  seeded from it. The mailbox then resolved and everything ELSE corrected
   *  itself, because folders and messages re-fetch; the signature did not,
   *  because a composer seeds once on purpose, so that a re-render cannot
   *  overwrite what you have typed.
   *
   *  So the fix is not in the composer. It is to stop asking questions about
   *  "the open mailbox" before there is one. Consumers wait on this.
   */
  ready: boolean;
  select: (id: string) => void;
}

const Ctx = createContext<MailboxState>({
  mailboxes: [], current: null, mailboxId: undefined,
  // ready TRUE with no provider above: there is no list on its way, so there
  // is nothing to wait for, and a consumer rendered outside MailboxProvider
  // must not sit forever waiting for a load that will never happen.
  isShared: false, canSend: true, ready: true, select: () => {},
});

export const useMailbox = () => useContext(Ctx);

/**
 * The mailbox this browser last had open.
 *
 * ── WHY IT IS REMEMBERED (Amit, 23 September 2026) ──────────────────────
 *
 *  "If we are in the shared inbox and doing browser refresh it's back to the
 *  main account instead of old account." The selection lived in React state
 *  only, and the loader always chose the OWN mailbox, so every reload — and
 *  every link followed from outside Mail — threw somebody working a shared
 *  queue back into their own inbox, usually without them noticing which
 *  mailbox they were then answering from.
 *
 *  Per browser rather than on the account: which queue you are working is a
 *  property of the window you are sitting at, and somebody with the shared
 *  box open on a desk machine should not have their phone follow it.
 *
 *  The stored id is NOT trusted. It is matched against the list the server
 *  just returned, so a mailbox that has been taken away, deleted or renamed
 *  out of your access falls back to your own — access is decided by that
 *  list, never by this value.
 */
const LAST_MAILBOX_KEY = 'tatvaos.mail.lastMailbox';

export function MailboxProvider({ children }: { children: React.ReactNode }) {
  const { authedFetch } = useAuth();
  const [mailboxes, setMailboxes] = useState<MailboxChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    mailApi.mailboxes(authedFetch)
      .then((list) => {
        if (!alive) return;
        setMailboxes(list);

        let remembered: string | null = null;
        try { remembered = window.localStorage.getItem(LAST_MAILBOX_KEY); } catch { /* fine */ }
        const stillThere = remembered !== null && list.some((m) => m.id === remembered);

        setSelectedId(stillThere
          ? remembered
          : list.find((m) => m.isOwn)?.id ?? list[0]?.id ?? null);
        setReady(true);
      })
      // An account with no mailbox, or an older API: Mail still works, there
      // is simply nothing to switch between.
      // Ready either way. A failed list means "no mailbox to switch to",
      // which is an answer; leaving ready false would hold Mail on a loading
      // state for a feature that is only a convenience.
      .catch(() => { if (alive) { setMailboxes([]); setReady(true); } });
    return () => { alive = false; };
  }, [authedFetch]);

  const value = useMemo<MailboxState>(() => {
    const current = mailboxes.find((m) => m.id === selectedId) ?? null;
    const isShared = current !== null && !current.isOwn;
    return {
      mailboxes,
      current,
      // Own mailbox sends no parameter at all — identical to every request
      // made before this feature existed.
      mailboxId: isShared ? current.id : undefined,
      isShared,
      canSend: !isShared
        || current.permissions.includes('send_as')
        || current.permissions.includes('full'),
      ready,
      // Remembered on the way through, so the next load opens the same
      // queue. Storage failures are ignored: a private window that refuses
      // to remember should still be able to switch.
      select: (id: string | null) => {
        try {
          if (id === null) window.localStorage.removeItem(LAST_MAILBOX_KEY);
          else window.localStorage.setItem(LAST_MAILBOX_KEY, id);
        } catch { /* fine */ }
        setSelectedId(id);
      },
    };
  }, [mailboxes, selectedId, ready]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The switcher itself, for the rail.
 *
 * Always names the open mailbox; only offers a menu when there is somewhere
 * to switch to. Naming it is not furniture — "which mailbox am I answering
 * from" is the question this whole feature exists to keep answerable.
 */
export function MailboxSwitcher() {
  const { mailboxes, current, isShared, select } = useMailbox();
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // Renders from ONE mailbox, not two.
  //
  // The original rule was "hide unless there is something to switch to",
  // which is right in principle and wrong in practice: when the switcher did
  // not appear there was no way to tell whether the component was broken,
  // the layout was wrong, or the API had simply returned one mailbox. A
  // control that renders nothing is indistinguishable from a control that is
  // not there. Showing "My mailbox" costs one quiet line and makes the state
  // legible — and it is where people will look for the mailbox they are in.
  if (!current) return null;
  const soleMailbox = mailboxes.length < 2;

  return (
    <div className="relative" style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => { if (!soleMailbox) setOpen((v) => !v); }}
        disabled={soleMailbox}
        className="flex items-center gap-2 w-full rounded"
        style={{
          // TOKENS, not white-alpha. This carried rgba(255,255,255,0.08) with
          // color:'inherit', which reads as a subtle chip on a near-black rail
          // and is INVISIBLE on a light one — white text on white, measured at
          // a contrast ratio of 1.0 the day the rail went light (5 Sept 2026).
          // --rail-soft, --line and --ink all flip with the theme, so this
          // survives either. The shared-mailbox amber stays as it is: it warns
          // you that you are reading someone else's mail and must not blend in.
          background: isShared ? 'rgba(255,169,9,0.18)' : 'rgb(var(--rail-soft))',
          border: isShared ? '1px solid rgba(255,169,9,0.55)' : '1px solid rgb(var(--line))',
          color: 'rgb(var(--ink))', padding: '7px 10px', textAlign: 'left',
        }}
        title={current.address}
      >
        <Icon name={isShared ? 'reply-all' : 'envelope'} className="h-4 w-4 shrink-0" />
        <span className="flex-auto truncate" style={{ fontSize: 12 }}>
          {current.isOwn ? 'My mailbox' : current.localPart}
        </span>
        {!soleMailbox && <Icon name="chevron-down" className="h-3 w-3 shrink-0" />}
      </button>

      {open && !soleMailbox && (
        <>
          {/* Click-away, below the menu and above the page. */}
          <div className="fixed" style={{ inset: 0, zIndex: 1390 }}
               onClick={close} aria-hidden="true" />
          {/* bg-surface / text-ink, NOT the '#fff'/'#1f2937' literals this
              carried: those were mixed for a light page, and in dark mode
              this menu was the one glaring white rectangle on the screen.
              Tokens follow the theme; hex values follow nothing. */}
          <div
            className="absolute overflow-hidden rounded border border-line bg-surface text-ink shadow"
            style={{ zIndex: 1400, left: 0, right: 0, top: '100%', marginTop: 4 }}
          >
            {mailboxes.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { select(m.id); close(); }}
                className="block w-full text-start border-0 bg-transparent"
                style={{ padding: '8px 12px', fontSize: 12 }}
              >
                <span className="block font-semibold truncate">
                  {m.isOwn ? 'My mailbox' : m.localPart}
                </span>
                <span className="block truncate" style={{ fontSize: 11, opacity: 0.65 }}>
                  {m.address}
                  {/* Say what they may do here, because 'read' and 'send_as'
                      are different jobs and the toolbar will differ. */}
                  {!m.isOwn && ` · ${m.permissions.join(', ')}`}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
