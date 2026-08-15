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
  select: (id: string) => void;
}

const Ctx = createContext<MailboxState>({
  mailboxes: [], current: null, mailboxId: undefined,
  isShared: false, canSend: true, select: () => {},
});

export const useMailbox = () => useContext(Ctx);

export function MailboxProvider({ children }: { children: React.ReactNode }) {
  const { authedFetch } = useAuth();
  const [mailboxes, setMailboxes] = useState<MailboxChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    mailApi.mailboxes(authedFetch)
      .then((list) => {
        if (!alive) return;
        setMailboxes(list);
        setSelectedId(list.find((m) => m.isOwn)?.id ?? list[0]?.id ?? null);
      })
      // An account with no mailbox, or an older API: Mail still works, there
      // is simply nothing to switch between.
      .catch(() => { if (alive) setMailboxes([]); });
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
      select: setSelectedId,
    };
  }, [mailboxes, selectedId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The switcher itself, for the rail.
 *
 * Renders NOTHING when there is only one mailbox, which is almost everybody.
 * A picker with one option is furniture that teaches people to ignore the
 * area it sits in.
 */
export function MailboxSwitcher() {
  const { mailboxes, current, isShared, select } = useMailbox();
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  if (mailboxes.length < 2 || !current) return null;

  return (
    <div className="position-relative" style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="d-flex align-items-center gap-2 w-100 rounded"
        style={{
          background: isShared ? 'rgba(255,169,9,0.18)' : 'rgba(255,255,255,0.08)',
          border: isShared ? '1px solid rgba(255,169,9,0.55)' : '1px solid transparent',
          color: 'inherit', padding: '7px 10px', textAlign: 'left',
        }}
        title={current.address}
      >
        <Icon name={isShared ? 'reply-all' : 'envelope'} className="h-4 w-4 shrink-0" />
        <span className="flex-fill text-truncate" style={{ fontSize: 12 }}>
          {current.isOwn ? 'My mailbox' : current.localPart}
        </span>
        <Icon name="chevron-down" className="h-3 w-3 shrink-0" />
      </button>

      {open && (
        <>
          {/* Click-away, below the menu and above the page. */}
          <div className="position-fixed" style={{ inset: 0, zIndex: 1390 }}
               onClick={close} aria-hidden="true" />
          <div
            className="position-absolute rounded shadow"
            style={{
              zIndex: 1400, left: 0, right: 0, top: '100%', marginTop: 4,
              background: '#fff', color: '#1f2937', overflow: 'hidden',
            }}
          >
            {mailboxes.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { select(m.id); close(); }}
                className="d-block w-100 text-start border-0 bg-transparent"
                style={{ padding: '8px 12px', fontSize: 12 }}
              >
                <span className="d-block fw-semibold text-truncate">
                  {m.isOwn ? 'My mailbox' : m.localPart}
                </span>
                <span className="d-block text-truncate" style={{ fontSize: 11, opacity: 0.65 }}>
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
