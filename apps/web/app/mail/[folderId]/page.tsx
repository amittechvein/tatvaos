'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import type { Folder, Message } from '@tatvaos/types';
import { useAuth } from '@/lib/auth';
import { mailApi, resolveFolder, type MailBootstrap } from '@/lib/mail';
import { Sidebar } from '@/components/mail/Sidebar';
import { MessageList } from '@/components/mail/MessageList';
import { MessageView } from '@/components/mail/MessageView';
import { Composer } from '@/components/mail/Composer';
import { Icon } from '@/components/ui/Icon';

const PAGE_SIZE = 50;

/**
 * Three-pane on desktop, two-pane on tablet, single-pane with drill-down on
 * phones. One responsive codebase — "mobile web" is not a separate build.
 *
 * The route segment is a slug for special folders (/mail/inbox) and a GUID
 * for custom ones. List rows are summaries from the folder query; the full
 * body is fetched when a message is opened — a 50-row list must not carry 50
 * MIME bodies over the wire.
 */
export default function MailPage({ params }: { params: Promise<{ folderId: string }> }) {
  const { folderId: folderParam } = use(params);
  const router = useRouter();
  const { authedFetch, accounts } = useAuth();

  const [boot, setBoot] = useState<MailBootstrap | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Message | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const folder: Folder | undefined = useMemo(
    () => (boot ? resolveFolder(boot.folders, folderParam) : undefined),
    [boot, folderParam],
  );

  const refreshFolders = useCallback(async () => {
    try {
      const folders = await mailApi.folders(authedFetch);
      setBoot((prev) => (prev ? { ...prev, folders } : prev));
    } catch {
      /* counts refresh is best-effort; the next navigation corrects them */
    }
  }, [authedFetch]);

  // ---- Initial load: mailbox + folders --------------------------------
  useEffect(() => {
    let cancelled = false;
    mailApi
      .bootstrap(authedFetch)
      .then((b) => {
        if (cancelled) return;
        setBoot(b);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setListError('Could not reach the mail service.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authedFetch]);

  // ---- Unknown folder in the URL → the inbox --------------------------
  useEffect(() => {
    if (!boot || boot.mailbox === null) return;
    if (!folder && boot.folders.length > 0) router.replace('/mail/inbox');
  }, [boot, folder, router]);

  // ---- Messages for the current folder --------------------------------
  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    setListError(null);
    mailApi
      .messages(authedFetch, folder.id, { take: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        setTotal(page.total);
        setSelected(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setListError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [authedFetch, folder]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.snippet.toLowerCase().includes(q) ||
        m.from.email.toLowerCase().includes(q) ||
        (m.from.name ?? '').toLowerCase().includes(q),
    );
  }, [messages, query]);

  // ---- Actions --------------------------------------------------------
  async function handleSelect(id: string) {
    const row = messages.find((m) => m.id === id);
    if (!row) return;

    // Optimistic: the row un-bolds now; the server call follows.
    if (!row.isRead) {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, isRead: true } : m)));
      setBoot((prev) =>
        prev && folder
          ? {
              ...prev,
              folders: prev.folders.map((f) =>
                f.id === folder.id ? { ...f, unreadCount: Math.max(0, f.unreadCount - 1) } : f,
              ),
            }
          : prev,
      );
      void mailApi.setRead(authedFetch, id, true);
    }

    setSelected({ ...row, isRead: true });
    setOpenLoading(true);
    try {
      const full = await mailApi.message(authedFetch, id);
      setSelected({ ...full, isRead: true });
    } catch {
      /* the summary stays on screen; body shows the snippet */
    } finally {
      setOpenLoading(false);
    }
  }

  function handleToggleFlag(id: string) {
    const target = messages.find((m) => m.id === id);
    if (!target) return;
    const next = !target.isFlagged;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, isFlagged: next } : m)));
    setSelected((prev) => (prev && prev.id === id ? { ...prev, isFlagged: next } : prev));
    void mailApi.setFlag(authedFetch, id, next);
  }

  async function handleDelete(id: string) {
    try {
      await mailApi.delete(authedFetch, id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      setSelected((prev) => (prev && prev.id === id ? null : prev));
      void refreshFolders();
    } catch {
      /* the message stays visible — an unexplained disappearance is worse */
    }
  }

  async function loadMore() {
    if (!folder) return;
    const page = await mailApi.messages(authedFetch, folder.id, {
      skip: messages.length,
      take: PAGE_SIZE,
    });
    setMessages((prev) => [...prev, ...page.messages]);
    setTotal(page.total);
  }

  // ---- Render ---------------------------------------------------------
  if (loading || !boot) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-faint">Loading…</div>
    );
  }

  if (boot.mailbox === null) {
    // A real state, not an error: admins without the mail product, and
    // Payroll-only users, land here. Never redirect — RequireAuth already
    // proved who they are, and a bounce-loop between here and a home page
    // is how the console once locked people out.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon name="inbox" className="h-12 w-12 text-ink-faint" />
        <h1 className="text-lg font-semibold">No mailbox on this account</h1>
        <p className="max-w-sm text-sm text-ink-muted">
          Your sign-in works, but no mailbox is attached to it. If you are expecting one, ask your
          organisation&apos;s admin to enable Mail for you.
        </p>
        <Link href="/account" className="text-sm font-medium text-brand-600 hover:underline">
          Go to your account
        </Link>
      </div>
    );
  }

  const orgName = accounts.find((a) => a.active)?.organisation ?? '';

  return (
    <div className="flex h-full">
      {/* Sidebar — drawer below lg */}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform lg:static lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar
          folders={boot.folders}
          mailbox={boot.mailbox}
          orgName={orgName}
          onCompose={() => {
            setReplyTo(null);
            setComposing(true);
            setNavOpen(false);
          }}
          onNavigate={() => setNavOpen(false)}
        />
      </div>
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Message list */}
      <section
        className={`flex min-w-0 flex-col border-r border-line bg-surface lg:w-[380px] lg:shrink-0 ${
          selected ? 'hidden lg:flex' : 'flex flex-1'
        }`}
      >
        <header className="border-b border-line px-4 py-3">
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
              className="rounded p-1 text-ink-muted hover:bg-canvas lg:hidden"
            >
              <Icon name="menu" className="h-5 w-5" />
            </button>
            <h1 className="text-base font-semibold">{folder?.name ?? 'Mail'}</h1>
            <span className="text-sm text-ink-faint">{query ? filtered.length : total}</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-canvas px-3 py-2">
            <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search mail"
              className="w-full border-0 bg-transparent p-0 text-sm outline-none placeholder:text-ink-faint"
            />
          </div>
        </header>

        <div className="min-h-0 flex-1">
          {listError ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-muted">
              {listError}
            </div>
          ) : (
            <MessageList
              messages={filtered}
              selectedId={selected?.id ?? null}
              onSelect={handleSelect}
              onToggleFlag={handleToggleFlag}
            />
          )}
        </div>

        {!query && messages.length < total && (
          <button
            type="button"
            onClick={loadMore}
            className="border-t border-line px-4 py-2.5 text-sm font-medium text-brand-600 hover:bg-canvas"
          >
            Show more ({total - messages.length} older)
          </button>
        )}
      </section>

      {/* Reading pane */}
      <section className={`min-w-0 flex-1 ${selected ? 'flex' : 'hidden lg:flex'}`}>
        <div className="w-full">
          <MessageView
            message={selected}
            bodyLoading={openLoading}
            onBack={() => setSelected(null)}
            onReply={(m) => {
              setReplyTo(m);
              setComposing(true);
            }}
            onDelete={(m) => void handleDelete(m.id)}
            onDownloadAttachment={(m, a) =>
              void mailApi
                .downloadAttachment(authedFetch, m.id, a.id, a.filename)
                .catch(() => {/* download failure shows as no file; retry is a click */})
            }
          />
        </div>
      </section>

      {composing && (
        <Composer
          replyTo={replyTo}
          fromAddress={boot.mailbox.address}
          onClose={() => setComposing(false)}
          onSend={async (draft) => {
            await mailApi.send(authedFetch, {
              ...draft,
              inReplyToId: replyTo?.id,
            });
            void refreshFolders();
          }}
        />
      )}
    </div>
  );
}
