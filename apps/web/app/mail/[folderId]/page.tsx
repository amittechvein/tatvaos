'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import type { Attachment, Folder, Message } from '@tatvaos/types';
import { useAuth } from '@/lib/auth';
import { mailApi, resolveFolder, type MailBootstrap } from '@/lib/mail';
import { Sidebar } from '@/components/mail/Sidebar';
import { MessageList } from '@/components/mail/MessageList';
import { MessageView } from '@/components/mail/MessageView';
import { Composer } from '@/components/mail/Composer';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';

const PAGE_SIZE = 50;

/**
 * The Gmail-shaped shell: brand + search in a top bar, nav on the left, and
 * one full-width list that the reading view replaces. List rows are
 * summaries; the full body is fetched when a message is opened.
 *
 * The route segment is a slug for special folders (/mail/inbox) and a GUID
 * for custom ones.
 */
export default function MailPage({ params }: { params: Promise<{ folderId: string }> }) {
  const { folderId: folderParam } = use(params);
  const router = useRouter();
  const { authedFetch, user } = useAuth();

  const [boot, setBoot] = useState<MailBootstrap | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Message | null>(null);
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

  const loadMessages = useCallback(
    async (folderId: string, skipTo: number) => {
      setListError(null);
      try {
        const page = await mailApi.messages(authedFetch, folderId, {
          skip: skipTo,
          take: PAGE_SIZE,
        });
        setMessages(page.messages);
        setTotal(page.total);
        setSkip(skipTo);
        setSelectedIds(new Set());
      } catch (e) {
        setListError(e instanceof Error ? e.message : 'Could not load messages.');
      }
    },
    [authedFetch],
  );

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
    setOpen(null);
    void loadMessages(folder.id, 0);
  }, [folder, loadMessages]);

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

  // ---- Local state helpers --------------------------------------------
  const patchMessage = useCallback((id: string, patch: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    setOpen((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
  }, []);

  const bumpUnread = useCallback(
    (folderId: string, delta: number) => {
      setBoot((prev) =>
        prev
          ? {
              ...prev,
              folders: prev.folders.map((f) =>
                f.id === folderId
                  ? { ...f, unreadCount: Math.max(0, f.unreadCount + delta) }
                  : f,
              ),
            }
          : prev,
      );
    },
    [],
  );

  // ---- Actions --------------------------------------------------------
  async function handleOpen(id: string) {
    const row = messages.find((m) => m.id === id);
    if (!row) return;

    if (!row.isRead) {
      patchMessage(id, { isRead: true });
      if (folder) bumpUnread(folder.id, -1);
      void mailApi.setRead(authedFetch, id, true);
    }

    setOpen({ ...row, isRead: true });
    setOpenLoading(true);
    try {
      const full = await mailApi.message(authedFetch, id);
      setOpen((prev) => (prev && prev.id === id ? { ...full, isRead: true } : prev));
    } catch {
      /* the summary stays on screen; body shows the snippet */
    } finally {
      setOpenLoading(false);
    }
  }

  function handleSetRead(id: string, isRead: boolean) {
    const target = messages.find((m) => m.id === id);
    if (!target || target.isRead === isRead) return;
    patchMessage(id, { isRead });
    if (folder) bumpUnread(folder.id, isRead ? -1 : 1);
    void mailApi.setRead(authedFetch, id, isRead);
  }

  function handleToggleFlag(id: string) {
    const target = messages.find((m) => m.id === id) ?? (open?.id === id ? open : null);
    if (!target) return;
    const next = !target.isFlagged;
    patchMessage(id, { isFlagged: next });
    void mailApi.setFlag(authedFetch, id, next);
  }

  async function handleDelete(id: string) {
    try {
      await mailApi.delete(authedFetch, id);
      const wasUnread = messages.find((m) => m.id === id)?.isRead === false;
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setOpen((prev) => (prev && prev.id === id ? null : prev));
      if (wasUnread && folder) bumpUnread(folder.id, -1);
      void refreshFolders();
    } catch {
      /* the message stays visible — an unexplained disappearance is worse */
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) =>
      prev.size === filtered.length && filtered.length > 0
        ? new Set()
        : new Set(filtered.map((m) => m.id)),
    );
  }

  async function bulkDelete() {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    await Promise.allSettled(ids.map((id) => mailApi.delete(authedFetch, id)));
    if (folder) await loadMessages(folder.id, skip);
    void refreshFolders();
  }

  async function bulkSetRead(isRead: boolean) {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    ids.forEach((id) => {
      const m = messages.find((x) => x.id === id);
      if (m && m.isRead !== isRead) {
        patchMessage(id, { isRead });
        if (folder) bumpUnread(folder.id, isRead ? -1 : 1);
      }
    });
    await Promise.allSettled(ids.map((id) => mailApi.setRead(authedFetch, id, isRead)));
  }

  const downloadAttachment = (messageId: string, attachmentId: string, filename: string) =>
    void mailApi
      .downloadAttachment(authedFetch, messageId, attachmentId, filename)
      .catch(() => {/* download failure shows as no file; retry is a click */});

  // ---- Render ---------------------------------------------------------
  if (loading || !boot) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-faint">Loading…</div>
    );
  }

  if (boot.mailbox === null) {
    // A real state, not an error: admins without the mail product, and
    // Payroll-only users, land here. Never redirect — a bounce-loop between
    // here and a home page is how the console once locked people out.
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

  const mailbox = boot.mailbox;
  const rangeStart = total === 0 ? 0 : skip + 1;
  const rangeEnd = Math.min(skip + messages.length, total);
  const allSelected = selectedIds.size > 0 && selectedIds.size === filtered.length;

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* ---- Top bar ---- */}
      <header className="flex h-16 shrink-0 items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          className="rounded-full p-2 text-ink-muted hover:bg-surface lg:hidden"
        >
          <Icon name="menu" className="h-5 w-5" />
        </button>

        <div className="flex w-60 items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            T
          </div>
          <span className="hidden text-lg text-ink sm:block">
            TatvaOS <span className="text-ink-muted">Mail</span>
          </span>
        </div>

        <div className="flex min-w-0 max-w-2xl flex-1 items-center gap-3 rounded-full bg-surface px-4 py-2.5 shadow-card">
          <Icon name="search" className="h-4.5 w-4.5 shrink-0 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mail"
            className="w-full border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="shrink-0 text-ink-faint hover:text-ink"
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 pl-2">
          <Link href="/account" title="Your account" className="rounded-full transition hover:opacity-80">
            <Avatar
              address={{ name: user?.displayName, email: user?.email ?? mailbox.address }}
              size={34}
            />
          </Link>
        </div>
      </header>

      {/* ---- Body: nav + list ---- */}
      <div className="flex min-h-0 flex-1">
        <div
          className={`fixed inset-y-0 left-0 z-40 transition-transform lg:static lg:translate-x-0 ${
            navOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <Sidebar
            folders={boot.folders}
            mailbox={mailbox}
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

        <main className="flex min-w-0 flex-1 flex-col pb-0 pr-0 lg:pb-4 lg:pr-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface shadow-card lg:rounded-2xl">
            {open ? (
              <MessageView
                message={open}
                bodyLoading={openLoading}
                onBack={() => setOpen(null)}
                onReply={(m) => {
                  setReplyTo(m);
                  setComposing(true);
                }}
                onDelete={(m) => void handleDelete(m.id)}
                onToggleFlag={(m) => handleToggleFlag(m.id)}
                onSetUnread={(m) => {
                  handleSetRead(m.id, false);
                  setOpen(null);
                }}
                onDownloadAttachment={(m, a: Attachment) => downloadAttachment(m.id, a.id, a.filename)}
              />
            ) : (
              <>
                {/* List toolbar */}
                <div className="flex items-center gap-1 border-b border-line px-4 py-1.5">
                  <label className="flex h-8 w-8 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                      className="h-4 w-4 cursor-pointer accent-brand-600"
                    />
                  </label>

                  {selectedIds.size > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void bulkDelete()}
                        title="Delete selected"
                        className="rounded-full p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
                      >
                        <Icon name="trash" className="h-4.5 w-4.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void bulkSetRead(true)}
                        title="Mark as read"
                        className="rounded-full p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
                      >
                        <Icon name="envelope-open" className="h-4.5 w-4.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void bulkSetRead(false)}
                        title="Mark as unread"
                        className="rounded-full p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
                      >
                        <Icon name="envelope" className="h-4.5 w-4.5" />
                      </button>
                      <span className="ml-1 text-sm text-ink-muted">{selectedIds.size} selected</span>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => folder && void loadMessages(folder.id, skip)}
                      title="Refresh"
                      className="rounded-full p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
                    >
                      <Icon name="refresh" className="h-4.5 w-4.5" />
                    </button>
                  )}

                  <div className="ml-auto flex items-center gap-1 text-xs text-ink-muted">
                    {query ? (
                      <span>{filtered.length} match{filtered.length === 1 ? '' : 'es'}</span>
                    ) : (
                      <>
                        <span>
                          {rangeStart}&ndash;{rangeEnd} of {total}
                        </span>
                        <button
                          type="button"
                          onClick={() => folder && void loadMessages(folder.id, Math.max(0, skip - PAGE_SIZE))}
                          disabled={skip === 0}
                          aria-label="Newer"
                          className="rounded-full p-1.5 transition enabled:hover:bg-canvas enabled:hover:text-ink disabled:opacity-40"
                        >
                          <Icon name="chevron-left" className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => folder && void loadMessages(folder.id, skip + PAGE_SIZE)}
                          disabled={skip + PAGE_SIZE >= total}
                          aria-label="Older"
                          className="rounded-full p-1.5 transition enabled:hover:bg-canvas enabled:hover:text-ink disabled:opacity-40"
                        >
                          <Icon name="chevron-right" className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="min-h-0 flex-1">
                  {listError ? (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-muted">
                      {listError}
                    </div>
                  ) : (
                    <MessageList
                      messages={filtered}
                      selectedIds={selectedIds}
                      onToggleSelect={toggleSelect}
                      onOpen={(id) => void handleOpen(id)}
                      onToggleFlag={handleToggleFlag}
                      onDelete={(id) => void handleDelete(id)}
                      onSetRead={handleSetRead}
                      onDownloadAttachment={(m, attachmentId, filename) =>
                        downloadAttachment(m.id, attachmentId, filename)
                      }
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      {composing && (
        <Composer
          replyTo={replyTo}
          fromAddress={mailbox.address}
          onClose={() => setComposing(false)}
          onSend={async (draft) => {
            await mailApi.send(authedFetch, {
              ...draft,
              inReplyToId: replyTo?.id,
            });
            void refreshFolders();
            if (folder?.slug === 'sent') void loadMessages(folder.id, 0);
          }}
        />
      )}
    </div>
  );
}
