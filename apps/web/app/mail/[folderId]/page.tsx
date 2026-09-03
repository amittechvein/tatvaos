'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Folder, Message } from '@tatvaos/types';
import { useAuth } from '@/lib/auth';
import {
  CATEGORY_COLOURS, mailApi, resolveFolder,
  type MailBootstrap, type MailCategory, type SearchHit,
} from '@/lib/mail';
import DOMPurify from 'dompurify';
import { MessageList } from '@/components/mail/MessageList';
import { MessageView } from '@/components/mail/MessageView';
import { Composer, type ComposeMode } from '@/components/mail/Composer';
import { useMailbox } from '@/components/mail/MailboxSwitcher';
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
  const { authedFetch } = useAuth();
  // Undefined for my own mailbox — every call below then behaves exactly as
  // it did before shared mailboxes existed.
  const { mailboxId, isShared, canSend, current: openMailbox } = useMailbox();

  const [boot, setBoot] = useState<MailBootstrap | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<MailCategory[]>([]);
  const [labelMenu, setLabelMenu] = useState(false);
  const [open, setOpen] = useState<Message | null>(null);
  const [openLoading, setOpenLoading] = useState(false);

  // Full-page reading: hides the list so the open message takes the whole
  // width — Gmail's "no split" mode. Sticky across messages on purpose;
  // someone who reads full-page reads full-page.
  const [wide, setWide] = useState(false);

  // The open message's conversation, fetched when it carries a threadId.
  // Null while loading or for a lone message — the strip renders nothing for
  // either, which is the honest state.
  const [thread, setThread] = useState<SearchHit[] | null>(null);
  const [threadTotal, setThreadTotal] = useState(0);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  // Open composer windows, oldest first — the first sits rightmost and new
  // ones dock to its left, Gmail-style. A list, not a boolean: a reply mid-
  // draft should not evict the draft.
  const [composers, setComposers] = useState<
    { key: number; replyTo: Message | null; mode: ComposeMode }[]
  >([]);
  const composerKey = useRef(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  // THE LATEST-HANDLERS REF. Two effects below (this one and the keyboard
  // listener) need startCompose and handleToggleFlag, and neither may list
  // them as dependencies: both are plain function declarations recreated on
  // every render, so honest arrays would re-register a window-level key
  // listener on every keystroke and re-run this effect per render. The naive
  // useCallback conversion is worse - it turns hoisted declarations into
  // consts, and this effect sits 350 lines above where startCompose is
  // defined, which is a temporal-dead-zone crash on first render.
  //
  // So: the effects read the CURRENT handlers through this ref, and their
  // dependency arrays honestly list only what they actually re-subscribe on.
  // The ref is assigned during render, which is safe here because nothing
  // reads it during render - only event handlers and effects do, and both
  // run after the assignment. (Function declarations hoist, so referencing
  // them above their definition is fine.)
  const handlers = useRef({ startCompose, handleToggleFlag });
  handlers.current = { startCompose, handleToggleFlag };

  // Compose lives in the shell rail, which cannot reach this page's state, so it
  // links to ?compose=1. Open the composer, then strip the parameter so a
  // refresh (or a back navigation) does not reopen it.
  useEffect(() => {
    if (searchParams.get('compose') === '1') {
      handlers.current.startCompose(null, 'new');
      router.replace(`/mail/${folderParam}`);
    }
  }, [searchParams, folderParam, router]);

  const folder: Folder | undefined = useMemo(
    () => (boot ? resolveFolder(boot.folders, folderParam) : undefined),
    [boot, folderParam],
  );

  const refreshFolders = useCallback(async () => {
    try {
      const folders = await mailApi.folders(authedFetch, mailboxId);
      setBoot((prev) => (prev ? { ...prev, folders } : prev));
    } catch {
      /* counts refresh is best-effort; the next navigation corrects them */
    }
  }, [authedFetch, mailboxId]);

  // Categories load once per mailbox, quietly - a failure costs the chips
  // and the Colour menu, never the list.
  useEffect(() => {
    let cancelled = false;
    void mailApi.categories(authedFetch, mailboxId)
      .then((r) => { if (!cancelled) setCategories(r.categories); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authedFetch, mailboxId]);

  const loadMessages = useCallback(
    async (folderId: string, skipTo: number) => {
      setListError(null);
      try {
        const page = await mailApi.messages(authedFetch, folderId, { skip: skipTo, take: PAGE_SIZE, mailboxId });
        setMessages(page.messages);
        setTotal(page.total);
        setSkip(skipTo);
        setSelectedIds(new Set());
      } catch (e) {
        setListError(e instanceof Error ? e.message : 'Could not load messages.');
      }
    },
    [authedFetch, mailboxId],
  );

  // ---- Initial load: mailbox + folders --------------------------------
  useEffect(() => {
    let cancelled = false;
    mailApi
      .bootstrap(authedFetch, mailboxId)
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
    // Re-boots on a mailbox switch: folders, ids and counts are all per
    // mailbox, so the whole view has to come from the new one.
  }, [authedFetch, mailboxId]);

  // ---- Unknown folder in the URL → the inbox --------------------------
  useEffect(() => {
    if (!boot || boot.mailbox === null) return;
    if (!folder && boot.folders.length > 0) router.replace('/mail/inbox');
  }, [boot, folder, router]);

  // ---- Messages for the current folder --------------------------------
  //
  //  Keyed by the folder's ID, NOT the `folder` object. The object is rebuilt
  //  every time the folders array changes — and bumpUnread rebuilds it on
  //  every unread-count change. With the object as the dependency, opening an
  //  unread message (which decrements the count) re-ran this effect, which
  //  closed the reading pane the moment it opened and reloaded the list — the
  //  "click three times to open a mail" bug. Only an actual navigation to a
  //  different folder should reset the view.
  const folderId = folder?.id;
  useEffect(() => {
    if (!folderId) return;
    setOpen(null);
    void loadMessages(folderId, 0);
  }, [folderId, loadMessages]);

  // ---- Auto-refresh ---------------------------------------------------
  //
  //  New mail should appear without anyone pressing Refresh. A silent poll,
  //  NOT loadMessages: that helper resets the selection and shows the list
  //  error state, both wrong for a background tick. This one replaces the
  //  rows and counts and touches nothing else — the open message, the
  //  selection, and the current page all survive. Skipped while a search is
  //  on screen (the poll would swap results back to the folder) and while
  //  the tab is hidden (a background tab does not need fresh mail, and
  //  thirty tabs polling is a load story).
  useEffect(() => {
    if (!folderId) return;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      if (query.trim()) return;
      try {
        const page = await mailApi.messages(authedFetch, folderId, { skip, take: PAGE_SIZE, mailboxId });
        setMessages(page.messages);
        setTotal(page.total);
      } catch { /* transient; the next tick retries */ }
      void refreshFolders();
    };
    const t = setInterval(() => void tick(), 30_000);
    return () => clearInterval(t);
  }, [folderId, skip, query, authedFetch, refreshFolders, mailboxId]);

  // ---- Search ---------------------------------------------------------
  //
  //  Server-side, across every folder, including message bodies. This used to
  //  be a filter over `messages` — the ~50 rows already on screen in the
  //  current folder — so searching for older mail returned nothing and looked
  //  identical to "no such message". Debounced: a keystroke should not be a
  //  query.
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setSearchHits(null);
      setSearchTotal(0);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      mailApi.search(authedFetch, term, { take: PAGE_SIZE, mailboxId })
        .then((page) => {
          if (cancelled) return;
          setSearchHits(page.messages);
          setSearchTotal(page.total);
        })
        .catch(() => { if (!cancelled) setSearchHits([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);

    return () => { cancelled = true; clearTimeout(t); };
  }, [query, authedFetch, mailboxId]);

  // What the list renders: search results when searching, else the folder page.
  const filtered: Message[] = searchHits ?? messages;

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
  /**
   * Block the sender, then file this message where future ones will go.
   *
   * The move is what makes blocking feel like it did something — otherwise the
   * message you just blocked is still sitting open in front of you. Blocking
   * never refuses mail at SMTP; it only changes where it lands.
   */
  async function handleBlockSender(m: Message) {
    if (isShared) { setListError(sharedBlock); return; }
    try {
      await mailApi.blockSender(authedFetch, m.from.email);
      await handleArchive(m.id);
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Could not block that sender.');
    }
  }

  async function handleOpen(id: string) {
    // `filtered`, not `messages`: while searching, the row lives in the search
    // results — which may be a message in another folder that was never in the
    // loaded folder page at all.
    // The thread strip adds a third row source: a sibling in this
    // conversation may live in Sent and appear in no loaded list.
    const row = filtered.find((m) => m.id === id) ?? thread?.find((m) => m.id === id);
    if (!row) return;

    if (!row.isRead) {
      patchMessage(id, { isRead: true });
      if (folder) bumpUnread(folder.id, -1);
      void mailApi.setRead(authedFetch, id, true, mailboxId);
    }

    setOpen({ ...row, isRead: true });
    setOpenLoading(true);

    // The conversation loads alongside the body. Kept only if the SAME thread
    // is still open when it lands; opening a sibling skips the refetch.
    if (row.threadId && !(thread && thread.some((m) => m.id === id))) {
      setThread(null);
      const tid = row.threadId;
      void mailApi.thread(authedFetch, tid, mailboxId).then(
        (page) => setOpen((prev) => {
          if (prev && prev.threadId === tid) {
            setThread(page.messages);
            setThreadTotal(page.total);
          }
          return prev;
        }),
        () => { /* no strip is a fine fallback; the message still reads */ },
      );
    } else if (!row.threadId) {
      setThread(null);
      setThreadTotal(0);
    }

    try {
      const full = await mailApi.message(authedFetch, id, mailboxId);
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
    void mailApi.setFlag(authedFetch, id, next, mailboxId);
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

  // Move and delete were deliberately excluded from the shared-mailbox API:
  // destructive actions in somebody else's queue are their own decision, and
  // the handlers still resolve to MY mailbox. Calling them while a shared
  // mailbox is open would act on the wrong mail entirely, so they are refused
  // here rather than sent and hoped about.
  const sharedBlock = 'Deleting and filing in a shared mailbox are not available yet.';

  async function handleDelete(id: string) {
    if (isShared) { setListError(sharedBlock); return; }
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
    if (isShared) { setListError(sharedBlock); return; }
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
    if (isShared) { setListError(sharedBlock); return; }
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    await Promise.allSettled(ids.map((id) => mailApi.delete(authedFetch, id)));
    if (folder) await loadMessages(folder.id, skip);
    void refreshFolders();
  }

  /**
   * Colour the whole selection in ONE request - the endpoint takes the list,
   * so forty messages is one round trip, not forty. A null category CLEARS.
   * The rows update in place rather than reloading the page: the person is
   * mid-triage, and yanking the list out from under them loses their scroll.
   */
  async function bulkSetCategory(categoryId: string | null) {
    const ids = [...selectedIds];
    setLabelMenu(false);
    try {
      await mailApi.assignCategory(authedFetch, ids, categoryId, mailboxId);
      setMessages((prev) => prev.map((m) =>
        selectedIds.has(m.id) ? { ...m, categoryId } as typeof m : m));
      setSelectedIds(new Set());
    } catch {
      setListError('The colour could not be applied. Reload and try again.');
    }
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
    await Promise.allSettled(ids.map((id) => mailApi.setRead(authedFetch, id, isRead, mailboxId)));
  }

  function handleMarkUnread(m: Message) {
    patchMessage(m.id, { isRead: false });
    if (folder) bumpUnread(folder.id, 1);
    void mailApi.setRead(authedFetch, m.id, false, mailboxId);
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
    if (isShared && !canSend) {
      setListError('You have read access to this mailbox, not permission to send from it.');
      return;
    }
    setComposers((prev) => {
      // Three is what a 1080p-wide window fits. The fourth request is
      // ignored rather than evicting someone's half-written draft.
      if (prev.length >= 3) return prev;
      composerKey.current += 1;
      return [...prev, { key: composerKey.current, replyTo: m, mode: m2 }];
    });
  }

  const downloadAttachment = (messageId: string, attachmentId: string, filename: string) =>
    void mailApi
      .downloadAttachment(authedFetch, messageId, attachmentId, filename, mailboxId)
      .catch(() => {/* download failure shows as no file; retry is a click */});

  // ---- Keyboard shortcuts ----------------------------------------------
  //
  //  ONLY KEYS THAT DO SOMETHING REAL. The brief lists A for archive; there
  //  is no Archive folder anywhere in this product, so binding it would mean
  //  inventing one or silently doing nothing. Same reason E for "mark read"
  //  is absent on a single message: the bulk bar has it, a single-message
  //  handler does not exist yet, and a key that works only sometimes is worse
  //  than a key that is not documented.
  //
  //  THE GUARD MATTERS MORE THAN THE SHORTCUTS. Without it, typing the letter
  //  s into the composer stars a message, and / swallows a slash mid-sentence.
  //  Anything with a modifier is the browser's or the operating system's, and
  //  is left alone.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const el = e.target as HTMLElement | null;
      const typing = !!el && (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      );

      // Escape is the one key that must work WHILE typing — it is how you get
      // out of the thing you are in.
      if (e.key === 'Escape') {
        if (showShortcuts) { setShowShortcuts(false); return; }
        if (!typing) setOpen(null);
        return;
      }

      if (typing) return;

      switch (e.key) {
        case 'c': e.preventDefault(); handlers.current.startCompose(null, 'new'); break;
        case '/': e.preventDefault(); searchRef.current?.focus(); break;
        case '?': e.preventDefault(); setShowShortcuts(true); break;
        case 'r': if (open) { e.preventDefault(); handlers.current.startCompose(open, 'reply'); } break;
        case 'f': if (open) { e.preventDefault(); handlers.current.startCompose(open, 'forward'); } break;
        case 's': if (open) { e.preventDefault(); handlers.current.handleToggleFlag(open.id); } break;
        default: break;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, showShortcuts]);

  /**
   * Keep a received attachment in the person's own Space.
   *
   * Returns the outcome rather than showing it: the card that was clicked is
   * the right place for the answer, and a page-level banner would make you
   * work out which of four files it was about.
   */
  const saveAttachmentToSpace = (messageId: string, attachmentId: string) =>
    mailApi
      .saveAttachmentToSpace(authedFetch, messageId, attachmentId, mailboxId)
      .then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }));

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
  const rangeStart = total === 0 ? 0 : skip + 1;
  const rangeEnd = Math.min(skip + messages.length, total);
  const allSelected = selectedIds.size > 0 && selectedIds.size === filtered.length;

  return (
    <div className="flex h-full flex-col gap-2 bg-canvas p-3">
      {/* Which queue am I in — across the WHOLE view, not inside the list
          column, because on a phone the list is hidden while a message is
          open and that is exactly when "who am I about to answer as" matters. */}
      {isShared && openMailbox && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-1.5 text-xs">
          <Icon name="reply-all" className="h-4 w-4 shrink-0 text-warn" />
          <span className="min-w-0 text-ink">
            You are reading <strong>{openMailbox.address}</strong>
            {canSend
              ? ' — replies go out as this mailbox, not as you.'
              : ' — read only. You cannot answer from this mailbox.'}
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
      {/* ---- List ---- */}
      {/* The list is NO LONGER A CARD. Pass two of the calm-premium brief:
          the enclosing white panel + ruled rows was the Gmail silhouette, so
          the panel is gone and each MESSAGE is the card, floating directly on
          the canvas. The folder name gets title typography — this column is a
          place, not a widget. */}
      <section
        className={`min-w-0 flex-col overflow-hidden lg:w-[420px] lg:shrink-0 ${
          open ? (wide ? 'hidden' : 'hidden lg:flex') : 'flex flex-1'
        }`}
      >
        <header className="flex flex-wrap items-center gap-2 px-4 pb-1 pt-2">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleSelectAll}
            aria-label="Select all"
            className="hidden h-4 w-4 cursor-pointer accent-brand-600 sm:block"
          />
          <h1 className="min-w-0 flex-1 truncate text-xl font-bold tracking-tight text-ink">
            {folder?.name ?? 'Mail'}
          </h1>

          <div className="flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-2 shadow-card">
            <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search mail"
              className="w-28 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint sm:w-36"
            />
          </div>
          <button
            type="button"
            onClick={() => folder && void loadMessages(folder.id, skip)}
            title="Refresh"
            className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface hover:text-ink hover:shadow-card"
          >
            <Icon name="refresh" className="h-4.5 w-4.5" />
          </button>
        </header>

        {/* Sub-bar: bulk actions or paging */}
        <div className="flex items-center gap-1 px-4 py-1 text-xs text-ink-muted">
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

              {/* Colour the selection. A LABELLED text button, not an icon:
                  there is no icon that says "category" without a legend, and
                  this bar has room for a word. */}
              {categories.length > 0 && (
                <span className="relative">
                  <button
                    type="button"
                    onClick={() => setLabelMenu((v) => !v)}
                    className="rounded-lg px-2 py-1.5 font-medium transition hover:bg-canvas hover:text-ink"
                  >
                    Colour
                  </button>
                  {labelMenu && (
                    <>
                      <span className="fixed inset-0 z-10" onClick={() => setLabelMenu(false)} aria-hidden="true" />
                      <span
                        role="menu"
                        className="absolute left-0 top-full z-20 mt-1 flex w-48 flex-col overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-raised"
                      >
                        {categories.map((c) => {
                          const colours = CATEGORY_COLOURS[c.colour] ?? CATEGORY_COLOURS.grey!;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              role="menuitem"
                              onClick={() => void bulkSetCategory(c.id)}
                              className="flex items-center gap-2 px-3 py-1.5 text-left text-sm text-ink transition hover:bg-canvas"
                            >
                              <span className={`h-2 w-2 shrink-0 rounded-full ${colours.dot}`} />
                              <span className="truncate">{c.name}</span>
                            </button>
                          );
                        })}
                        <span className="my-1 border-t border-line" />
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => void bulkSetCategory(null)}
                          className="px-3 py-1.5 text-left text-sm text-ink-muted transition hover:bg-canvas"
                        >
                          No colour
                        </button>
                      </span>
                    </>
                  )}
                </span>
              )}
              <span className="ml-1">{selectedIds.size} selected</span>
            </>
          ) : (
            <span>
              {query ? (
                searching ? (
                  <>Searching&hellip;</>
                ) : (
                  <>{searchTotal} result{searchTotal === 1 ? '' : 's'} in all mail</>
                )
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
              categoriesById={Object.fromEntries(categories.map((c) => [c.id, c]))}
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
              onBlockSender={(m) => void handleBlockSender(m)}
              onMarkUnread={handleMarkUnread}
              onPrint={handlePrint}
              onDownloadAttachment={(m, a: Attachment) => downloadAttachment(m.id, a.id, a.filename)}
              onSaveAttachmentToSpace={(m, a: Attachment) => saveAttachmentToSpace(m.id, a.id)}
              threadMessages={thread ?? undefined}
              threadTotal={threadTotal}
              onOpenMessage={(id) => void handleOpen(id)}
              expanded={wide}
              onToggleExpand={() => setWide((v) => !v)}
              autoLoadImages={folder?.slug !== 'junk'}
            />
          </div>
        ) : (
          <div className="hidden h-full w-full flex-col items-center justify-center rounded-card border border-dashed border-line bg-surface/40 lg:flex">
            <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-brand-500 dark:bg-brand-600/15">
              <Icon name="envelope" className="h-7 w-7" />
            </span>
            <p className="text-sm font-medium text-ink">Nothing open</p>
            <p className="mt-1 text-xs text-ink-muted">Choose a message from the list to read it here.</p>
          </div>
        )}
      </section>

      </div>

      {composers.map((c, i) => (
        <Composer
          key={c.key}
          offset={i}
          replyTo={c.replyTo}
          mode={c.mode}
          selfAddress={mailbox.address}
          fromAddress={mailbox.address}
          onClose={() => setComposers((prev) => prev.filter((x) => x.key !== c.key))}
          onSend={async (draft) => {
            await mailApi.send(authedFetch, {
              ...draft,
              // Answering from a shared queue goes out AS the mailbox.
              mailboxId,
              inReplyToId: c.mode === 'reply' || c.mode === 'replyAll' ? c.replyTo?.id : undefined,
            });
            void refreshFolders();
            if (folder?.slug === 'sent') void loadMessages(folder.id, 0);
          }}
        />
      ))}
    {/* Shortcuts. A list nobody can find is folklore, so ? opens it and the
        page says so once at the bottom of the list. */}
    {showShortcuts && (
      <div
        className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/40 p-4"
        onClick={() => setShowShortcuts(false)}
      >
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-sm rounded-card border border-line bg-surface p-5 shadow-raised"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Keyboard shortcuts</h2>
            <button
              type="button"
              onClick={() => setShowShortcuts(false)}
              className="rounded-lg p-1 text-ink-faint transition hover:bg-canvas hover:text-ink"
              aria-label="Close"
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          </div>
          <dl className="space-y-1.5 text-sm">
            {[
              ['c', 'Write a new message'],
              ['/', 'Search'],
              ['r', 'Reply to the open message'],
              ['f', 'Forward the open message'],
              ['s', 'Star or unstar the open message'],
              ['Esc', 'Close the open message'],
              ['?', 'This list'],
            ].map(([k, what]) => (
              <div key={k} className="flex items-baseline gap-3">
                <kbd className="min-w-[2.2rem] shrink-0 rounded border border-line bg-canvas px-1.5 py-0.5 text-center text-xs text-ink">
                  {k}
                </kbd>
                <dd className="m-0 text-ink-muted">{what}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-ink-faint">
            They stay out of the way while you are typing.
          </p>
        </div>
      </div>
    )}
    </div>
  );
}
