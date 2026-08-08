'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import type { Attachment, Folder, Message } from '@tatvaos/types';
import { useAuth } from '@/lib/auth';
import { mailApi, resolveFolder, type MailBootstrap } from '@/lib/mail';
import DOMPurify from 'dompurify';
import { MessageList } from '@/components/mail/MessageList';
import { MessageView } from '@/components/mail/MessageView';
import { Composer, type ComposeMode } from '@/components/mail/Composer';
import { Icon } from '@/components/ui/Icon';

const PAGE_SIZE = 50;

/**
 * The Yzen three-pane mail app: a left navigation rail, a message list, and a
 * reading pane that slides in over the list when a message is opened. List
 * rows are summaries; the full body is fetched on open.
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
  const [composeMode, setComposeMode] = useState<ComposeMode>('new');
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  // Compose lives in the shell rail, which cannot reach this page's state, so it
  // links to ?compose=1. Open the composer, then strip the parameter so a
  // refresh (or a back navigation) does not reopen it.
  useEffect(() => {
    if (searchParams.get('compose') === '1') {
      startCompose(null, 'new');
      router.replace(`/mail/${folderParam}`);
    }
  }, [searchParams, folderParam, router]);

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
        const page = await mailApi.messages(authedFetch, folderId, { skip: skipTo, take: PAGE_SIZE });
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

  const bumpUnread = useCallback((folderId: string, delta: number) => {
    setBoot((prev) =>
      prev
        ? {
            ...prev,
            folders: prev.folders.map((f) =>
              f.id === folderId ? { ...f, unreadCount: Math.max(0, f.unreadCount + delta) } : f,
            ),
          }
        : prev,
    );
  }, []);

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

  function handleToggleFlag(id: string) {
    const target = messages.find((m) => m.id === id) ?? (open?.id === id ? open : null);
    if (!target) return;
    const next = !target.isFlagged;
    patchMessage(id, { isFlagged: next });
    void mailApi.setFlag(authedFetch, id, next);
  }

  const removeFromList = useCallback(
    (id: string, wasUnread: boolean) => {
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
    },
    [folder, bumpUnread],
  );

  async function handleDelete(id: string) {
    const wasUnread = messages.find((m) => m.id === id)?.isRead === false;
    try {
      await mailApi.delete(authedFetch, id);
      removeFromList(id, wasUnread);
      void refreshFolders();
    } catch {
      /* keep it visible — an unexplained disappearance is worse */
    }
  }

  async function handleArchive(id: string) {
    const junk = boot?.folders.find((f) => f.slug === 'junk');
    if (!junk || junk.id === folder?.id) return;
    const wasUnread = messages.find((m) => m.id === id)?.isRead === false;
    try {
      await mailApi.move(authedFetch, id, junk.id);
      removeFromList(id, wasUnread);
      void refreshFolders();
    } catch {
      /* leave it in place on failure */
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

  function handleMarkUnread(m: Message) {
    patchMessage(m.id, { isRead: false });
    if (folder) bumpUnread(folder.id, 1);
    void mailApi.setRead(authedFetch, m.id, false);
    setOpen(null);
  }

  function handlePrint(m: Message) {
    const w = window.open('', '_blank', 'width=800,height=700');
    if (!w) return;
    // Sanitised before it reaches the print window — the body is
    // attacker-controlled and this window is outside SafeHtml's sandbox.
    const inner = m.bodyHtml
      ? DOMPurify.sanitize(m.bodyHtml)
      : `<pre style="white-space:pre-wrap;font-family:inherit">${(m.bodyText ?? m.snippet)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${(m.subject || 'Message').replace(/</g, '&lt;')}</title></head>`
      + `<body style="font-family:system-ui,sans-serif;padding:28px;color:#111">`
      + `<h2 style="margin:0 0 6px">${(m.subject || '(no subject)').replace(/</g, '&lt;')}</h2>`
      + `<div style="color:#666;font-size:13px;margin-bottom:16px">From ${(m.from.name ?? m.from.email).replace(/</g, '&lt;')} — ${new Date(m.sentAt).toLocaleString()}</div>`
      + `<hr style="border:none;border-top:1px solid #ddd;margin-bottom:16px">${inner}</body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
  }

  function startCompose(m: Message | null, m2: ComposeMode) {
    setReplyTo(m);
    setComposeMode(m2);
    setComposing(true);
  }

  const downloadAttachment = (messageId: string, attachmentId: string, filename: string) =>
    void mailApi
      .downloadAttachment(authedFetch, messageId, attachmentId, filename)
      .catch(() => {/* download failure shows as no file; retry is a click */});

  // ---- Render ---------------------------------------------------------
  if (loading || !boot) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-faint">Loading…</div>;
  }

  if (boot.mailbox === null) {
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
  const displayName = user?.displayName ?? mailbox.displayName;
  const rangeStart = total === 0 ? 0 : skip + 1;
  const rangeEnd = Math.min(skip + messages.length, total);
  const allSelected = selectedIds.size > 0 && selectedIds.size === filtered.length;

  return (
    <div className="flex h-full gap-3 bg-canvas p-3">
      {/* ---- List ---- */}
      <section
        className={`flex min-w-0 flex-col overflow-hidden rounded-card border border-line bg-surface lg:w-[420px] lg:shrink-0 ${
          open ? 'hidden lg:flex' : 'flex flex-1'
        }`}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleSelectAll}
            aria-label="Select all"
            className="hidden h-4 w-4 cursor-pointer accent-brand-600 sm:block"
          />
          <h6 className="flex-1 truncate text-sm font-semibold text-ink">{folder?.name ?? 'Mail'}</h6>

          <div className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5">
            <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Email"
              className="w-28 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint sm:w-36"
            />
          </div>
          <button
            type="button"
            onClick={() => folder && void loadMessages(folder.id, skip)}
            title="Refresh"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink-muted transition hover:bg-canvas hover:text-ink"
          >
            <Icon name="refresh" className="h-4.5 w-4.5" />
          </button>
        </header>

        {/* Sub-bar: bulk actions or paging */}
        <div className="flex items-center gap-1 border-b border-line px-4 py-1.5 text-xs text-ink-muted">
          {selectedIds.size > 0 ? (
            <>
              <button
                type="button"
                onClick={() => void bulkDelete()}
                title="Delete selected"
                className="rounded-lg p-1.5 transition hover:bg-canvas hover:text-ink"
              >
                <Icon name="trash" className="h-4.5 w-4.5" />
              </button>
              <button
                type="button"
                onClick={() => void bulkSetRead(true)}
                title="Mark read"
                className="rounded-lg p-1.5 transition hover:bg-canvas hover:text-ink"
              >
                <Icon name="envelope-open" className="h-4.5 w-4.5" />
              </button>
              <button
                type="button"
                onClick={() => void bulkSetRead(false)}
                title="Mark unread"
                className="rounded-lg p-1.5 transition hover:bg-canvas hover:text-ink"
              >
                <Icon name="envelope" className="h-4.5 w-4.5" />
              </button>
              <span className="ml-1">{selectedIds.size} selected</span>
            </>
          ) : (
            <span>
              {query ? (
                <>{filtered.length} match{filtered.length === 1 ? '' : 'es'}</>
              ) : (
                <>Showing {rangeStart}&ndash;{rangeEnd} of {total}</>
              )}
            </span>
          )}
          {!query && selectedIds.size === 0 && (
            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => folder && void loadMessages(folder.id, Math.max(0, skip - PAGE_SIZE))}
                disabled={skip === 0}
                aria-label="Newer"
                className="rounded p-1 transition enabled:hover:bg-canvas enabled:hover:text-ink disabled:opacity-40"
              >
                <Icon name="chevron-left" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => folder && void loadMessages(folder.id, skip + PAGE_SIZE)}
                disabled={skip + PAGE_SIZE >= total}
                aria-label="Older"
                className="rounded p-1 transition enabled:hover:bg-canvas enabled:hover:text-ink disabled:opacity-40"
              >
                <Icon name="chevron-right" className="h-4 w-4" />
              </button>
            </span>
          )}
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
              openId={open?.id ?? null}
              onToggleSelect={toggleSelect}
              onOpen={(id) => void handleOpen(id)}
              onToggleFlag={handleToggleFlag}
            />
          )}
        </div>
      </section>

      {/* ---- Reading pane ---- */}
      <section className={`min-w-0 flex-1 ${open ? 'flex' : 'hidden lg:flex'}`}>
        {open ? (
          <div className="w-full">
            <MessageView
              message={open}
              bodyLoading={openLoading}
              onBack={() => setOpen(null)}
              onReply={(m, replyMode) => startCompose(m, replyMode)}
              onDelete={(m) => void handleDelete(m.id)}
              onToggleFlag={(m) => handleToggleFlag(m.id)}
              onArchive={(m) => void handleArchive(m.id)}
              onMarkUnread={handleMarkUnread}
              onPrint={handlePrint}
              onDownloadAttachment={(m, a: Attachment) => downloadAttachment(m.id, a.id, a.filename)}
            />
          </div>
        ) : (
          <div className="hidden h-full w-full flex-col items-center justify-center rounded-card border border-line bg-surface text-ink-faint lg:flex">
            <Icon name="envelope" className="mb-3 h-12 w-12" />
            <p className="text-sm">Select a message to read</p>
          </div>
        )}
      </section>

      {composing && (
        <Composer
          replyTo={replyTo}
          mode={composeMode}
          selfAddress={mailbox.address}
          fromAddress={mailbox.address}
          onClose={() => setComposing(false)}
          onSend={async (draft) => {
            await mailApi.send(authedFetch, {
              ...draft,
              inReplyToId: composeMode === 'reply' || composeMode === 'replyAll' ? replyTo?.id : undefined,
            });
            void refreshFolders();
            if (folder?.slug === 'sent') void loadMessages(folder.id, 0);
          }}
        />
      )}
    </div>
  );
}
