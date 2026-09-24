'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Folder, Message } from '@tatvaos/types';
import { useAuth } from '@/lib/auth';
import {
  CATEGORY_COLOURS, getInboxLayout, INBOX_LAYOUT_EVENT, INBOX_LAYOUTS,
  mailApi, resolveFolder, setInboxLayout,
  type InboxLayout, type MailBootstrap, type MailCategory, type SearchHit,
  type ThreadSummary,
} from '@/lib/mail';
import DOMPurify from 'dompurify';
import { MessageList, type MailListRow } from '@/components/mail/MessageList';
import { MessageView } from '@/components/mail/MessageView';
import { Composer, type ComposeMode } from '@/components/mail/Composer';
import { dockHasRoom, layoutDock } from '@/lib/composerDock';
import { useMailbox } from '@/components/mail/MailboxSwitcher';
import { SearchChips } from '@/components/mail/SearchChips';
import { useMailSearch, useMailSearchHost } from '@/components/mail/MailSearchContext';
import { Icon } from '@/components/ui/Icon';

// ---------------------------------------------------------------------------
//  HOW MANY ROWS AT ONCE — the person's choice, remembered.
//
//  Amit, 23 September 2026, looking at a Sent folder of 1329: "showing 50 in
//  one page, give option to select 50,100,150,250,500,all".
//
//  500 is the server's ceiling for ONE request (MailEndpoints.MaxPageSize),
//  so "All" is not a bigger request — it is consecutive requests of 500 until
//  the folder runs out. That keeps the expensive shape (the attachment query
//  runs over a whole page) bounded whatever is asked for.
//
//  ALL_CEILING protects the BROWSER, not the server: every row is a React
//  element, and a folder of 40,000 would freeze the tab rather than fill it.
//  When a folder is larger than this, the list says so instead of pretending
//  it showed everything — the count on screen is the thing being trusted.
// ---------------------------------------------------------------------------
const PAGE_SIZES = [50, 100, 150, 250, 500] as const;
type PageSize = number | 'all';
const DEFAULT_PAGE_SIZE = 50;
const SERVER_MAX_TAKE = 500;
const ALL_CEILING = 5000;
const PAGE_SIZE_KEY = 'tatvaos.mail.pageSize';

function loadPageSize(): PageSize {
  if (typeof window === 'undefined') return DEFAULT_PAGE_SIZE;
  try {
    const raw = window.localStorage.getItem(PAGE_SIZE_KEY);
    if (raw === 'all') return 'all';
    const n = Number(raw);
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

// ---------------------------------------------------------------------------
//  CONVERSATIONS OR MESSAGES
//
//  Amit, 23 September 2026, with one exchange open side by side: TatvaOS
//  listed three rows where Gmail listed one conversation. Nothing was
//  duplicated — a message and its two replies are three emails — but a list
//  that shows each of them separately makes a short exchange look like a
//  pile, and it is the single most visible difference from every mail client
//  people already use.
//
//  The API has had a conversation list all along (/folders/{id}/threads, one
//  row per thread, grouped on thread_id ?? id so mail from before threading
//  still appears). The web client even had the function to call it. Nothing
//  ever did. This wires it up and makes it the default.
//
//  It is a VIEW, not a migration: the per-message list is one click away and
//  the choice is remembered, because triaging a shared support queue is a
//  genuinely different job from reading your own mail.
// ---------------------------------------------------------------------------
type ListView = 'conversations' | 'messages';
const VIEW_KEY = 'tatvaos.mail.listView';

function loadListView(): ListView {
  if (typeof window === 'undefined') return 'conversations';
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'messages' ? 'messages' : 'conversations';
  } catch {
    // Private windows and blocked site data throw on read. A remembered
    // preference is not worth a blank page.
    return 'conversations';
  }
}

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
  const { mailboxId, isShared, canSend, current: openMailbox, ready: mailboxReady } = useMailbox();

  const [boot, setBoot] = useState<MailBootstrap | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Conversation rows, when the list is in conversation view. Held beside the
  // messages rather than replacing them: a row that stands for a thread is
  // not a message, and pretending otherwise is how a renderer ends up reading
  // a field that was never really there.
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [view, setView] = useState<ListView>('conversations');
  /**
   * Which open is the current one. Incremented on every row click; a fetch
   * that lands holding an older number is from a row the person has already
   * navigated away from and writes nothing.
   */
  const openTicket = useRef(0);

  // The person's inbox layout, chosen in Mail settings and stored on this
  // device. Read in an effect (localStorage does not exist server-side), and
  // kept in step with the settings page through its event — switching layout
  // there redraws an inbox already open in another tab without a reload.
  const [inboxLayout, setInboxLayoutState] = useState<InboxLayout>('comfortable');
  // The little layout switcher in the toolbar — a quick way to change the
  // list's shape without a trip to settings. Same device preference underneath.
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  useEffect(() => {
    setInboxLayoutState(getInboxLayout());
    const sync = () => setInboxLayoutState(getInboxLayout());
    window.addEventListener(INBOX_LAYOUT_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(INBOX_LAYOUT_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  // Read on mount, not in the initialiser: localStorage does not exist while
  // Next renders this on the server.
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  useEffect(() => { setPageSize(loadPageSize()); }, []);
  // Read after mount, like the page size: localStorage does not exist during
  // the server render, and seeding state from it directly is a hydration
  // mismatch that React papers over by throwing the first paint away.
  useEffect(() => { setView(loadListView()); }, []);
  /** True while "All" is still fetching its consecutive pages. */
  const [loadingAll, setLoadingAll] = useState(false);
  /** Set when a folder is bigger than a browser should be asked to draw. */
  const [cappedAt, setCappedAt] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<MailCategory[]>([]);
  const [labelMenu, setLabelMenu] = useState(false);
  const [moveMenu, setMoveMenu] = useState(false);
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
  // The search box is in the TOP BAR, not on this page (MailSearchContext
  // says why). This claims it, hands it the mailbox's real folders for the
  // advanced form's "Search in", and gets back the query the person typed.
  const searchFolders = useMemo(
    () => (boot?.folders ?? [])
      .filter((f) => f.slug !== null)
      .map((f) => ({ label: f.name, value: f.slug! })),
    [boot],
  );
  const { query, setQuery } = useMailSearchHost(searchFolders);
  // "/" focuses the header's box; the ref is shared through the context.
  const { inputRef: searchRef } = useMailSearch();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  // Open composer windows, oldest first — the first sits rightmost and new
  // ones dock to its left, Gmail-style. A list, not a boolean: a reply mid-
  // draft should not evict the draft.
  const [composers, setComposers] = useState<
    // `min` is what the PERSON chose. Windows minimised only to make room are
    // worked out at render (layoutDock), so they reopen when room comes back.
    { key: number; replyTo: Message | null; mode: ComposeMode; min: boolean }[]
  >([]);
  const composerKey = useRef(0);
  // The window that stays open when room runs short: the last one opened or
  // restored. Everything older folds to a title strip first.
  const [dockFocus, setDockFocus] = useState<number | null>(null);
  // The browser's width in CSS px, which is NOT the screen's — Windows at 125%
  // turns a 1920px laptop into a 1536px browser. Measured, never assumed.
  const [viewportW, setViewportW] = useState(1920);
  useEffect(() => {
    const read = () => setViewportW(window.innerWidth);
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
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

  // Takes the size EXPLICITLY. setPageSize does not apply until the next
  // render, so a loader that read the state would fetch the old size on the
  // very click that changed it — the chooser would appear to lag by one.
  const loadMessagesWith = useCallback(
    async (folderId: string, skipTo: number, size: PageSize) => {
      setListError(null);
      setCappedAt(null);
      try {
        if (view === 'conversations') {
          // Conversations are grouped SERVER side, and they have to be: this
          // page holds one page of rows, and the other half of a conversation
          // may be on the next one. Grouping what happens to be loaded looks
          // right on a small folder and silently splits threads on a big one.
          //
          // "All" is not offered a second loop here — the row count is
          // conversations, not messages, so the server maximum already covers
          // far more mail than the message list's equivalent page.
          const take = size === 'all' ? SERVER_MAX_TAKE : size;
          const page = await mailApi.folderThreads(
            authedFetch, folderId, { skip: skipTo, take, mailboxId },
          );
          setThreads(page.threads);
          setMessages([]);
          setTotal(page.total);
          setSkip(skipTo);
          setSelectedIds(new Set());
          if (size === 'all' && page.total > page.threads.length) setCappedAt(page.threads.length);
          return;
        }

        if (size === 'all') {
          // Consecutive pages of the server's maximum, not one huge request.
          // The first answer carries the total, so the loop knows when to
          // stop without asking for a count first.
          setLoadingAll(true);
          const rows: Message[] = [];
          let got = 0;
          let folderTotal = 0;
          do {
            const page = await mailApi.messages(
              authedFetch, folderId, { skip: got, take: SERVER_MAX_TAKE, mailboxId },
            );
            folderTotal = page.total;
            rows.push(...page.messages);
            got += page.messages.length;
            // A page shorter than asked for means the folder ran out; without
            // this an off-by-one in the total would spin forever.
            if (page.messages.length < SERVER_MAX_TAKE) break;
          } while (got < Math.min(folderTotal, ALL_CEILING));

          setMessages(rows);
          setThreads([]);
          setTotal(folderTotal);
          setSkip(0);
          setSelectedIds(new Set());
          if (folderTotal > rows.length) setCappedAt(rows.length);
          return;
        }

        const page = await mailApi.messages(authedFetch, folderId, { skip: skipTo, take: size, mailboxId });
        setMessages(page.messages);
        setThreads([]);
        setTotal(page.total);
        setSkip(skipTo);
        setSelectedIds(new Set());
      } catch (e) {
        setListError(e instanceof Error ? e.message : 'Could not load messages.');
      } finally {
        setLoadingAll(false);
      }
    },
    [authedFetch, mailboxId, view],
  );

  const loadMessages = useCallback(
    (folderId: string, skipTo: number) => loadMessagesWith(folderId, skipTo, pageSize),
    [loadMessagesWith, pageSize],
  );

  // ---- Initial load: mailbox + folders --------------------------------
  useEffect(() => {
    // WAIT for the mailbox to be known. Before this guard, the first
    // bootstrap went out with mailboxId undefined — "my own mailbox" — while
    // the switcher was still fetching its list, and a composer opening in
    // that window seeded the PERSONAL signature onto a message being sent
    // FROM A SHARED ADDRESS (Amit, 23 September 2026). Everything else on
    // this page re-fetched and corrected itself, which is why only the
    // signature was ever reported.
    if (!mailboxReady) return;

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
  }, [authedFetch, mailboxId, mailboxReady]);

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
      // Not while "All" is on screen. A tick that fetched one page would
      // replace a list of 1329 rows with the first 500 — the poll exists to
      // keep the list fresh, not to silently shorten it.
      if (pageSize === 'all') return;
      try {
        // The tick has to fetch what the list is DRAWING. Polling messages
        // while the list shows conversations left the rows untouched and
        // still moved the total, so "Showing 1-3 of 7" appeared under three
        // rows and looked like paging had broken.
        if (view === 'conversations') {
          const page = await mailApi.folderThreads(
            authedFetch, folderId, { skip, take: pageSize, mailboxId },
          );
          setThreads(page.threads);
          setTotal(page.total);
        } else {
          const page = await mailApi.messages(authedFetch, folderId, { skip, take: pageSize, mailboxId });
          setMessages(page.messages);
          setTotal(page.total);
        }
      } catch { /* transient; the next tick retries */ }
      void refreshFolders();
    };
    // ── AND THE MOMENT THE TAB COMES BACK. ─────────────────────────────
    //
    //  Amit, 23 September 2026: "NO AUTO REFRESH the inbox."
    //
    //  The timer above is not the whole story, and on its own it produced
    //  exactly that complaint. Every tick while the tab is in the
    //  background returns immediately and does nothing — correctly, that is
    //  what stops thirty idle tabs polling — but NOTHING made up for the
    //  skipped ticks on the way back. Somebody who switches to another tab,
    //  works, and returns to their mail is looking at the list as it was
    //  when they left, for up to another thirty seconds. Browsers also
    //  throttle background timers to about once a minute, so the wait is
    //  often longer than that.
    //
    //  Measured before the fix: a message inserted while the tab was not in
    //  front was still missing 75 seconds later.
    //
    //  So: refresh on becoming visible. That is the instant somebody is
    //  actually looking, which is the only instant a refresh is worth
    //  anything.
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);

    const t = setInterval(() => void tick(), 30_000);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [folderId, skip, query, authedFetch, refreshFolders, mailboxId, pageSize, view]);

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
      mailApi.search(authedFetch, term,
        { take: pageSize === 'all' ? SERVER_MAX_TAKE : pageSize, mailboxId })
        .then((page) => {
          if (cancelled) return;
          setSearchHits(page.messages);
          setSearchTotal(page.total);
        })
        .catch(() => { if (!cancelled) setSearchHits([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);

    return () => { cancelled = true; clearTimeout(t); };
  }, [query, authedFetch, mailboxId, pageSize]);

  // What the list renders: search results when searching, else the folder page.
  // Search always lists MESSAGES, whatever the view: a hit is a specific
  // message in a specific folder, and rolling hits up into conversations
  // would hide which one actually matched.
  const inConversationView = view === 'conversations' && !searchHits;

  /** Conversation rows, in the shape the list draws. */
  const threadRows: MailListRow[] = useMemo(
    () => threads.map((t) => ({
      // The row IS the newest message as far as opening goes; `count` is what
      // tells the list it stands for more than one.
      id: t.latestMessageId,
      from: t.from,
      subject: t.subject,
      snippet: t.snippet,
      sentAt: t.sentAt,
      isRead: t.isRead,
      isFlagged: t.isFlagged,
      hasAttachments: t.hasAttachments,
      count: t.count,
    })),
    [threads],
  );

  /**
   * Row id → every message that row stands for.
   *
   * Bulk actions read this. A conversation row is one tick box, and ticking
   * it and pressing Delete must delete the conversation: acting on the newest
   * message alone leaves the rest behind, so the row comes straight back on
   * the next poll looking like the delete silently failed.
   */
  const membersOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of threads) m.set(t.latestMessageId, t.messageIds);
    return m;
  }, [threads]);

  /** One selection of rows, expanded into the messages it really means. */
  const expand = useCallback(
    (ids: Iterable<string>) => [...new Set([...ids].flatMap((id) => membersOf.get(id) ?? [id]))],
    [membersOf],
  );

  const filtered: MailListRow[] = searchHits ?? (inConversationView ? threadRows : messages);

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
    // Three row sources, and now a fourth. While searching the row lives in
    // the search results — possibly a message in another folder that was
    // never in the loaded page. The thread strip adds siblings that live in
    // Sent. And in conversation view the row is not a message at all: it
    // carries only what a list draws, so there is nothing honest to put in
    // the reading pane until the fetch below lands.
    const summary: Message | undefined =
      (searchHits ?? messages).find((m) => m.id === id) ?? thread?.find((m) => m.id === id);
    const conversation = threads.find((t) => t.latestMessageId === id);
    const row = summary ?? (conversation ? filtered.find((m) => m.id === id) : undefined);
    if (!row) return;

    // Every open gets a ticket, and only the newest ticket may write to the
    // pane. The guards this replaces compared against the message ALREADY
    // open — which is null the first time a conversation row is clicked, so
    // neither the body nor the conversation strip would ever have arrived.
    const ticket = ++openTicket.current;

    if (!row.isRead) {
      // Opening a conversation reads ALL of it. That is what every client
      // does, and what this row's own unread rule requires: it counts as
      // unread while ANY message in it is, so marking just the newest leaves
      // the row bold and makes the click look like it did nothing.
      const ids = conversation?.messageIds ?? [id];
      ids.forEach((mid) => patchMessage(mid, { isRead: true }));
      if (folder) bumpUnread(folder.id, -(conversation?.unreadCount ?? 1));
      setThreads((prev) => prev.map((t) =>
        t.latestMessageId === id ? { ...t, isRead: true, unreadCount: 0 } : t));
      void Promise.allSettled(
        ids.map((mid) => mailApi.setRead(authedFetch, mid, true, mailboxId)),
      );
    }

    if (summary) setOpen({ ...summary, isRead: true });
    setOpenLoading(true);

    // The conversation loads alongside the body.
    const rowThreadId = summary?.threadId ?? conversation?.threadId ?? null;
    if (rowThreadId && !(thread && thread.some((m) => m.id === id))) {
      setThread(null);
      void mailApi.thread(authedFetch, rowThreadId, mailboxId).then(
        (page) => {
          if (openTicket.current !== ticket) return;
          setThread(page.messages);
          setThreadTotal(page.total);
        },
        () => { /* no strip is a fine fallback; the message still reads */ },
      );
    } else if (!rowThreadId) {
      setThread(null);
      setThreadTotal(0);
    }

    try {
      const full = await mailApi.message(authedFetch, id, mailboxId);
      if (openTicket.current === ticket) setOpen({ ...full, isRead: true });
    } catch {
      /* the summary stays on screen; body shows the snippet */
    } finally {
      if (openTicket.current === ticket) setOpenLoading(false);
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

  /**
   * WHERE THIS MESSAGE MAY GO — the list behind every "Move to" menu.
   *
   * Drafts, Sent and Scheduled are left out. All three are records of what
   * THIS mailbox did rather than places to file mail, and a received message
   * dropped into Sent would read as something the person had written. The
   * open folder is left out because moving mail to where it already is does
   * nothing, and an item that does nothing is how people stop trusting a
   * menu. Everything else is offered, custom folders included — before this,
   * a folder could be created and never filed into.
   *
   * Filtered on specialUse, NOT slug: Scheduled has no slug, so a slug test
   * read it as an ordinary custom folder and offered it.
   */
  const FILED_BY_THE_SYSTEM: readonly (string | null)[] = ['\\Drafts', '\\Sent', '\\Scheduled'];
  const moveTargets = (boot?.folders ?? [])
    .filter((f) => f.id !== folder?.id && !FILED_BY_THE_SYSTEM.includes(f.specialUse))
    .map((f) => ({ id: f.id, name: f.name }));

  async function handleMove(id: string, folderId: string) {
    if (isShared) { setListError(sharedBlock); return; }
    const wasUnread = messages.find((m) => m.id === id)?.isRead === false;
    try {
      await mailApi.move(authedFetch, id, folderId);
      removeFromList(id, wasUnread);
      void refreshFolders();
    } catch {
      setListError('The message could not be moved. Reload and try again.');
    }
  }

  async function bulkMove(folderId: string) {
    if (isShared) { setListError(sharedBlock); return; }
    // expand(): a ticked conversation row means every message in it.
    const ids = expand(selectedIds);
    setMoveMenu(false);
    setSelectedIds(new Set());
    await Promise.allSettled(ids.map((id) => mailApi.move(authedFetch, id, folderId)));
    if (folder) await loadMessages(folder.id, skip);
    void refreshFolders();
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
    const ids = expand(selectedIds);
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
    const rowIds = [...selectedIds];
    const ids = expand(rowIds);
    setSelectedIds(new Set());
    // The badge moves by what actually CHANGES. In conversation view the
    // per-message read flags are not all loaded, so the conversation's own
    // unread count is the only honest number here.
    let delta = 0;
    for (const rowId of rowIds) {
      const conv = threads.find((t) => t.latestMessageId === rowId);
      if (conv) {
        delta += isRead ? -conv.unreadCount : (conv.count - conv.unreadCount);
        continue;
      }
      const m = messages.find((x) => x.id === rowId);
      if (m && m.isRead !== isRead) delta += isRead ? -1 : 1;
    }
    ids.forEach((id) => patchMessage(id, { isRead }));
    setThreads((prev) => prev.map((t) => (selectedIds.has(t.latestMessageId)
      ? { ...t, isRead, unreadCount: isRead ? 0 : t.count } : t)));
    if (folder && delta !== 0) bumpUnread(folder.id, delta);
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
      // ── ONE REPLY PER MESSAGE. ──────────────────────────────────────────
      //
      //  Amit, 23 September 2026: pressing Reply and then Reply all left TWO
      //  reply boxes stacked inside the same message, each with its own
      //  recipients and its own Send. Whichever you then typed into, the
      //  other was still there to be sent by mistake.
      //
      //  Gmail treats the second press as "change this reply", not "start
      //  another one", and that is the honest reading: there is one answer
      //  being written to one message. So an existing reply to the SAME
      //  message switches mode in place — the recipients are recomputed by
      //  the composer (see the effect on `mode`) and anything already typed
      //  survives, which is the whole reason for not remounting it.
      //  FORWARD TOO, from 24 September. It used to be excluded — "a
      //  different message, often sent while a reply is still being
      //  written" — and so Reply then Forward left two boxes in the same
      //  message, each with its own Send. Amit: "fix reply and forward both
      //  open in diff window". Gmail has one response box per message with
      //  a type switch, and that is what this is now: the composer moves the
      //  recipients, the subject (while it is still the automatic one) and
      //  the quote's heading, and keeps every word typed.
      const isResponse = (x: ComposeMode) => x === 'reply' || x === 'replyAll' || x === 'forward';
      const already = m !== null && isResponse(m2)
        ? prev.findIndex((c) => isResponse(c.mode) && c.replyTo?.id === m.id)
        : -1;
      if (already >= 0) {
        if (prev[already]!.mode === m2) return prev;
        const next = [...prev];
        next[already] = { ...next[already]!, mode: m2 };
        return next;
      }

      // A request that does not fit is ignored rather than evicting someone's
      // half-written draft. "Fits" is measured against this browser's width,
      // with the other windows minimised (see lib/composerDock.ts) — it used
      // to be a flat three, which overflowed a 1536px browser.
      // A reply to the open message sits in the conversation, not the dock,
      // so it needs no room there.
      const inline = (x: { mode: ComposeMode; replyTo: Message | null }) =>
        x.mode !== 'new' && x.replyTo !== null && open !== null && x.replyTo.id === open.id;
      if (!inline({ mode: m2, replyTo: m })
        && !dockHasRoom(prev.filter((c) => !inline(c)).length, viewportW)) return prev;
      composerKey.current += 1;
      return [...prev, { key: composerKey.current, replyTo: m, mode: m2, min: false }];
    });
    // The newest window is the one kept open; a restore elsewhere moves it.
    setDockFocus(null);
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
    // searchRef is listed because it now comes from the context rather than a
    // useRef here; it is the same stable object every render, so it never
    // re-binds the listener.
  }, [open, showShortcuts, searchRef]);

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
  // A reply belongs in the conversation ONLY while the message it answers is
  // the one on screen. Reply to something, open a different message, and the
  // draft has nothing to sit under — so it becomes a docked window rather
  // than being torn out of the page or silently hidden with typing in it.
  const inlineComposers = composers.filter(
    (c) => c.mode !== 'new' && c.replyTo !== null && open !== null && c.replyTo.id === open.id,
  );
  const dockedComposers = composers.filter((c) => !inlineComposers.includes(c));
  // Kept open: the restored window if it is still docked, else the newest one
  // the person has not minimised themselves.
  const keepIdx = (() => {
    const f = dockedComposers.findIndex((c) => c.key === dockFocus && !c.min);
    if (f >= 0) return f;
    for (let i = dockedComposers.length - 1; i >= 0; i--) if (!dockedComposers[i]!.min) return i;
    return -1;
  })();
  const dock = layoutDock(dockedComposers.map((c) => c.min), keepIdx, viewportW);

  const rangeStart = total === 0 ? 0 : skip + 1;
  // `filtered`, not `messages`: in conversation view the rows are threads and
  // the total counts threads, so measuring the range against the message
  // array would read "Showing 1-0 of 3" on a folder that is drawing rows.
  const rangeEnd = Math.min(skip + filtered.length, total);
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
        className={`min-w-0 flex-col overflow-hidden lg:shrink-0 ${inboxLayout === 'slim' ? 'lg:w-[340px]' : 'lg:w-[420px]'} ${
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

          {/* Layout switcher — the same four choices as Mail settings, one
              tap away. The backdrop button closes the menu on any outside
              click without a global listener. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setLayoutMenuOpen((v) => !v)}
              title="Change layout"
              aria-haspopup="menu"
              aria-expanded={layoutMenuOpen}
              className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface hover:text-ink hover:shadow-card"
            >
              <Icon name="list-ul" className="h-4.5 w-4.5" />
            </button>
            {layoutMenuOpen && (
              <>
                <button
                  type="button"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={() => setLayoutMenuOpen(false)}
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-card border border-line bg-surface py-1 shadow-raised"
                >
                  {INBOX_LAYOUTS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={inboxLayout === o.id}
                      onClick={() => {
                        setInboxLayout(o.id);
                        setInboxLayoutState(o.id);
                        setLayoutMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink transition hover:bg-canvas"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-brand-600">
                        {inboxLayout === o.id && (
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                               stroke="currentColor" strokeWidth={2.4}
                               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </span>
                      {o.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {/* Conversations or single messages. Deliberately a toolbar button
              and not a settings page: it is the kind of thing people flip
              while looking at a list, and hiding it two screens away is how a
              view nobody could find got built and then never called. */}
          <button
            type="button"
            onClick={() => {
              const next: ListView = view === 'conversations' ? 'messages' : 'conversations';
              setView(next);
              try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* fine */ }
            }}
            title={view === 'conversations'
              ? 'Grouped into conversations — switch to one row per message'
              : 'One row per message — switch to conversations'}
            aria-pressed={view === 'conversations'}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-surface hover:text-ink hover:shadow-card ${
              view === 'conversations' ? 'text-brand-600' : 'text-ink-muted'
            }`}
          >
            <Icon name="reply-all" className="h-4.5 w-4.5" />
          </button>
          <button
            type="button"
            onClick={() => folder && void loadMessages(folder.id, skip)}
            title="Refresh"
            className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface hover:text-ink hover:shadow-card"
          >
            <Icon name="refresh" className="h-4.5 w-4.5" />
          </button>
        </header>

        {/* What the search was understood as. In the flow, under the header,
            so it moves the list down instead of covering it — and absent
            entirely for a search that is only words. */}
        <SearchChips value={query} onChange={setQuery} />

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

              {/* File the selection somewhere else. Labelled, beside Colour,
                  for the same reason: no icon says "which folder". */}
              {moveTargets.length > 0 && (
                <span className="relative">
                  <button
                    type="button"
                    onClick={() => setMoveMenu((v) => !v)}
                    className="rounded-lg px-2 py-1.5 font-medium transition hover:bg-canvas hover:text-ink"
                  >
                    Move to
                  </button>
                  {moveMenu && (
                    <>
                      <span className="fixed inset-0 z-10" onClick={() => setMoveMenu(false)} aria-hidden="true" />
                      <span
                        role="menu"
                        className="absolute left-0 top-full z-20 mt-1 flex w-48 flex-col overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-raised"
                      >
                        {moveTargets.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="menuitem"
                            onClick={() => void bulkMove(t.id)}
                            className="truncate px-3 py-1.5 text-left text-sm text-ink transition hover:bg-canvas"
                          >
                            {t.name}
                          </button>
                        ))}
                      </span>
                    </>
                  )}
                </span>
              )}

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
              ) : loadingAll ? (
                <>Loading all {total}&hellip;</>
              ) : (
                <>
                  Showing {rangeStart}&ndash;{rangeEnd} of {total}
                  {/* Said, not hidden: the number on screen is the thing
                      being trusted, so a folder too big to draw in one go
                      must not look like it was shown in full. */}
                  {cappedAt !== null && (
                    <span className="ml-1 text-ink-muted">
                      &mdash; the first {cappedAt} of them, which is as many as
                      one page can hold
                    </span>
                  )}
                </>
              )}
            </span>
          )}
          {!query && selectedIds.size === 0 && (
            <span className="ml-auto flex items-center gap-2">
              {/* Rows per page. A plain select: it is a choice from six
                  values, and a menu would be two clicks for the same thing. */}
              <label className="flex items-center gap-1.5">
                <span className="text-ink-muted">Show</span>
                <select
                  value={String(pageSize)}
                  aria-label="Messages per page"
                  onChange={(e) => {
                    const v = e.target.value;
                    const next: PageSize = v === 'all' ? 'all' : Number(v);
                    setPageSize(next);
                    try { window.localStorage.setItem(PAGE_SIZE_KEY, v); } catch { /* fine */ }
                    // Back to the first page: staying on "rows 900-950" while
                    // the page size becomes 500 would be a window onto
                    // nothing anybody asked for.
                    if (folder) void loadMessagesWith(folder.id, 0, next);
                  }}
                  className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                >
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                  <option value="all">All</option>
                </select>
              </label>
              {pageSize !== 'all' && (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => folder && void loadMessages(folder.id, Math.max(0, skip - pageSize))}
                    disabled={skip === 0}
                    aria-label="Newer"
                    className="rounded p-1 transition enabled:hover:bg-canvas enabled:hover:text-ink disabled:opacity-40"
                  >
                    <Icon name="chevron-left" className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => folder && void loadMessages(folder.id, skip + pageSize)}
                    disabled={skip + pageSize >= total}
                    aria-label="Older"
                    className="rounded p-1 transition enabled:hover:bg-canvas enabled:hover:text-ink disabled:opacity-40"
                  >
                    <Icon name="chevron-right" className="h-4 w-4" />
                  </button>
                </span>
              )}
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
              layout={inboxLayout}
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
          // A column: the message, then the reply under it. min-h-0 so the
          // message pane can shrink rather than pushing the composer off the
          // bottom — the flex default nobody expects.
          <div className="flex w-full min-w-0 flex-col gap-3 min-h-0">
            <div className="min-h-0 flex-1">
            <MessageView
              message={open}
              bodyLoading={openLoading}
              onBack={() => setOpen(null)}
              onReply={(m, replyMode) => startCompose(m, replyMode)}
              onDelete={(m) => void handleDelete(m.id)}
              onToggleFlag={(m) => handleToggleFlag(m.id)}
              onArchive={(m) => void handleArchive(m.id)}
              moveTargets={moveTargets}
              onMove={(m, folderId) => void handleMove(m.id, folderId)}
              canArchive={folder?.slug !== 'junk'}
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
              // THE REPLY, IN THE CONVERSATION — and now INSIDE the message's
              // own scroll container rather than beside it, so opening one
              // no longer squeezes the message into a sliver (Amit, 23 Sept:
              // "currently its divided in two sections"). Replies to some
              // OTHER message stay docked below; they have nothing on screen
              // to sit under.
              footer={inlineComposers.map((c) => (
                <Composer
                  key={c.key}
                  placement="inline"
                  replyTo={c.replyTo}
                  mode={c.mode}
                  selfAddress={mailbox.address}
                  fromAddress={mailbox.address}
                  // Without this the signature is saved, shown in settings,
                  // and never appears in a message — see the note at the
                  // docked composer below.
                  signature={boot?.signature ?? null}
                  onClose={() => setComposers((prev) => prev.filter((x) => x.key !== c.key))}
                  onSend={async (draft) => {
                    await mailApi.send(authedFetch, {
                      ...draft,
                      mailboxId,
                      inReplyToId: c.mode === 'reply' || c.mode === 'replyAll'
                        ? c.replyTo?.id : undefined,
                    });
                    void refreshFolders();
                    if (folder?.slug === 'sent') void loadMessages(folder.id, 0);
                  }}
                />
              ))}
            />
            </div>
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

      {dockedComposers.map((c, i) => (
        <Composer
          key={c.key}
          offset={i}
          right={dock.right[i]}
          minimised={dock.minimised[i]}
          onMinimisedChange={(min) => {
            setComposers((prev) => prev.map((x) => (x.key === c.key ? { ...x, min } : x)));
            // Restoring one makes it the window that stays open; the others
            // fold away to make its room if they have to.
            if (!min) setDockFocus(c.key);
          }}
          replyTo={c.replyTo}
          mode={c.mode}
          selfAddress={mailbox.address}
          fromAddress={mailbox.address}
          // ── THE SIGNATURE HAD NOWHERE TO COME FROM (Amit, 23 Sept 2026:
          //    "signature did not show on mail body").
          //
          //  The Composer has always known how to seed one — enabled vs
          //  includeOnReply, text and HTML halves, placed ABOVE the quoted
          //  reply. The bootstrap has always returned it. Nothing ever
          //  handed the prop over, so the whole feature was a settings page
          //  that wrote to a column nobody read back.
          //
          //  Both composers get it: a signature that appears on a new
          //  message and not on a reply would read as a different bug.
          signature={boot?.signature ?? null}
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
