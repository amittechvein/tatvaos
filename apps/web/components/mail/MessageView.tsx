'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { displayName, formatBytes, formatRecipients } from '@tatvaos/core';
import type { Address, Attachment, Message } from '@tatvaos/types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { SafeHtml } from './SafeHtml';
import { SenderName } from '../family/SenderName';

/**
 * One row of the conversation strip. Deliberately the fields a strip needs and
 * no more, so this does not go stale every time the message shape grows.
 */
export interface ThreadRow {
  id: string;
  subject: string;
  snippet: string;
  // The shared Address type, not a copy of its shape: displayName() takes
  // Address, and a duplicated `name: string | null` differs from its
  // `string | undefined` just enough to fail at the call site.
  from: Address;
  sentAt: string;
  isRead: boolean;
  /** A conversation legitimately spans Inbox and Sent — say which. */
  folderName?: string | null;
}

/** An outlined icon button, matching the template's reading-pane toolbar. */
function ToolButton({
  icon,
  label,
  onClick,
  filled,
  tone = 'default',
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onClick?: () => void;
  filled?: boolean;
  tone?: 'default' | 'danger' | 'warn';
}) {
  const toneClass =
    tone === 'danger'
      ? 'hover:text-danger'
      : tone === 'warn'
        ? 'text-warn'
        : 'text-ink-muted hover:text-ink';
  // Quiet on purpose. These buttons used to each carry border + bg-surface,
  // which put TEN identical outlined boxes in one row - every action shouted
  // at the same volume, so none read as more important than any other, and
  // Delete had exactly the weight of Print. The border is gone; the hover
  // wash is the affordance. The ONE outlined control in this toolbar is
  // Reply, below - being the only box in the row is what makes it primary.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-canvas ${toneClass}`}
    >
      <Icon name={icon} filled={filled} className="h-4.5 w-4.5" />
    </button>
  );
}

/**
 * Reply, labelled. The most-used action in a mail client was an unlabelled
 * icon at the far edge of the pane, dressed identically to Delete. One
 * labelled control, and only one: a second label would start an arms race
 * that ends back at ten boxes.
 */
function ReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface pl-3 pr-3.5 text-[13px] font-medium text-ink transition hover:bg-canvas"
    >
      <Icon name="reply" className="h-4 w-4" />
      Reply
    </button>
  );
}

export function MessageView({
  message,
  bodyLoading = false,
  onBack,
  onReply,
  onDelete,
  onToggleFlag,
  onArchive,
  onMarkUnread,
  onPrint,
  onDownloadAttachment,
  onSaveAttachmentToSpace,
  onBlockSender,
  threadMessages,
  onOpenMessage,
  threadTotal,
  expanded,
  onToggleExpand,
  autoLoadImages = false,
}: {
  message: Message;
  bodyLoading?: boolean;
  onBack: () => void;
  /** Reply, reply-all, or forward — the composer opens pre-filled for each. */
  onReply: (m: Message, mode: 'reply' | 'replyAll' | 'forward') => void;
  onDelete: (m: Message) => void;
  onToggleFlag: (m: Message) => void;
  /** Junk in our folders; the template calls it Archive/Spam. */
  onArchive: (m: Message) => void;
  onMarkUnread: (m: Message) => void;
  onPrint: (m: Message) => void;
  onDownloadAttachment?: (m: Message, a: Attachment) => void;
  /**
   * Save a received attachment into the person's own Space. Resolves with
   * whether it worked and, when it did not, a sentence fit to show them.
   * Absent means the action is not offered at all — better than a button
   * that fails.
   */
  onSaveAttachmentToSpace?: (m: Message, a: Attachment)
    => Promise<{ ok: boolean; error?: string }>;
  /**
   * Block this sender. Future mail from the address is filed to Junk at
   * ingest — never refused at SMTP, which would confirm to a spammer that the
   * address is live. Absent when the caller has nothing to wire it to.
   */
  onBlockSender?: (m: Message) => void;
  /**
   * The rest of this conversation, oldest first, INCLUDING the open message.
   *
   * Passed in rather than fetched here, because everything else in this
   * component arrives as a prop and the folder page already owns loading. Undefined
   * means "not a thread, or not loaded" — both render nothing, which is the
   * honest state while it is in flight.
   */
  threadMessages?: ThreadRow[];
  /** Opening a sibling. Absent when the caller has nowhere to route it. */
  onOpenMessage?: (id: string) => void;
  /** The untruncated count. A long thread is capped server-side; saying so is
   *  better than silently showing the first N. */
  threadTotal?: number;
  /** Full-page reading: the list is hidden and the message takes the width. */
  expanded?: boolean;
  /** Absent hides the toggle — small screens are always full-page already. */
  onToggleExpand?: () => void;
  /**
   * Remote images load without asking. On for normal folders — the banner on
   * every message taxed everyone to inconvenience trackers — and OFF for
   * Junk, where auto-loading a tracking pixel confirms to a spammer that
   * the address is read.
   */
  autoLoadImages?: boolean;
}) {
  const [menu, setMenu] = useState(false);

  // Gmail's little ▾ next to "to …": the full envelope on demand — exact
  // addresses, full date, subject — without spending header space on it.
  const [details, setDetails] = useState(false);

  const isThread = !!threadMessages && threadMessages.length > 1;

  // Oldest first — a conversation reads downwards.
  const ordered = useMemo(
    () => (threadMessages ? [...threadMessages].sort(
      (a, b) => +new Date(a.sentAt) - +new Date(b.sentAt)) : []),
    [threadMessages],
  );

  // Bring the expanded message into view when a collapsed row is chosen —
  // in a long thread the row clicked and the place it expands can be a
  // screen apart.
  const openRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    openRef.current?.scrollIntoView({ block: 'nearest' });
    setDetails(false);
  }, [message.id]);

  /** One row of the details card. Flex, not CSS grid — YZEN's .grid class
   *  collides with Tailwind's and the fallout is invisible until runtime. */
  const detailRow = (label: string, value: React.ReactNode) => (
    <div className="flex gap-2">
      <span className="w-14 shrink-0 text-right text-ink-faint">{label}</span>
      <span className="min-w-0 break-words text-ink">{value}</span>
    </div>
  );

  const addressList = (list: Address[]) =>
    list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');

  // The expanded message: ONE dense identity row, Gmail-style — who, to
  // whom, when — then the body.
  const senderHeader = (
    <header className="relative flex items-center gap-3 px-5 py-3">
      <Avatar address={message.from} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <SenderName address={message.from} label={displayName(message.from)}
                      className="truncate text-sm font-semibold text-ink" />
          <span className="hidden truncate text-xs text-ink-muted sm:inline">{message.from.email}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1 text-xs text-ink-muted">
          <span className="truncate">
            to {formatRecipients(message.to)}
            {message.cc && message.cc.length > 0 && ` · cc ${formatRecipients(message.cc)}`}
          </span>
          <button
            type="button"
            onClick={() => setDetails((v) => !v)}
            aria-label="Show details"
            title="Show details"
            className="shrink-0 rounded p-0.5 text-ink-faint transition hover:bg-canvas hover:text-ink"
          >
            <Icon name="chevron-down" className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <time className="shrink-0 text-xs text-ink-muted">
        {new Date(message.sentAt).toLocaleString(undefined, {
          day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
        })}
      </time>

      {details && (
        <>
          {/* Transparent click-away layer, below the card, above the page. */}
          <div className="fixed inset-0 z-10" onClick={() => setDetails(false)} aria-hidden="true" />
          <div className="absolute left-12 top-full z-20 mt-1 max-w-[calc(100%-4rem)] space-y-1 rounded-xl border border-line bg-surface p-4 text-xs shadow-raised">
            {detailRow('from:', message.from.name
              ? `${message.from.name} <${message.from.email}>`
              : message.from.email)}
            {detailRow('to:', addressList(message.to))}
            {message.cc && message.cc.length > 0 && detailRow('cc:', addressList(message.cc))}
            {detailRow('date:', new Date(message.sentAt).toLocaleString(undefined, {
              day: 'numeric', month: 'short', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            }))}
            {detailRow('subject:', message.subject || '(no subject)')}
          </div>
        </>
      )}
    </header>
  );

  const body = (
    <div>
      {message.bodyHtml ? (
        // Keyed by message: allow-images is per MESSAGE, not per pane — without
        // the key, one "Show images" click would carry to every mail after it.
        <SafeHtml key={message.id} html={message.bodyHtml} inlineImages={message.inlineImages}
                  allowRemoteInitially={autoLoadImages} />
      ) : bodyLoading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">
          {message.bodyText ?? message.snippet}
        </pre>
      )}
    </div>
  );

  // Per attachment, because two files save independently and a single
  // "saving" flag would grey out a card nobody touched.
  const [saving, setSaving] = useState<Record<string, true>>({});
  const [saved, setSaved] = useState<Record<string, true>>({});
  const [saveError, setSaveError] = useState<Record<string, string>>({});

  async function saveToSpace(a: Attachment) {
    if (!onSaveAttachmentToSpace || saving[a.id] || saved[a.id]) return;
    setSaving((p) => ({ ...p, [a.id]: true }));
    setSaveError((p) => { const n = { ...p }; delete n[a.id]; return n; });
    try {
      const r = await onSaveAttachmentToSpace(message, a);
      if (r.ok) setSaved((p) => ({ ...p, [a.id]: true }));
      else setSaveError((p) => ({ ...p, [a.id]: r.error ?? 'It could not be saved.' }));
    } catch {
      setSaveError((p) => ({ ...p, [a.id]: 'It could not be saved. Try again.' }));
    } finally {
      setSaving((p) => { const n = { ...p }; delete n[a.id]; return n; });
    }
  }

  // A picture being SHOWN in the body is not also offered as a file. isInline
  // is true only for one the API actually sent in inlineImages, so a picture
  // too large to inline is still listed - never missing from both places.
  const files = (message.attachments ?? []).filter((a) => !a.isInline);
  const attachments = files.length > 0 ? (
    <div className="mt-6 border-t border-line pt-4">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink">
        <Icon name="attach" className="h-4 w-4 text-ink-muted" />
        {files.length} attachment
        {files.length === 1 ? '' : 's'}
      </div>
      {/* A CARD, NOT A CHIP. The chip was one big button, so the only thing an
          attachment could do was download — and "Save to Space" had nowhere to
          live. Two actions cannot nest inside one button, so the card is a
          container and the actions are its own controls. */}
      <div className="flex flex-wrap gap-3">
        {files.map((a) => (
          <div
            key={a.id}
            className="w-60 rounded-xl border border-line p-3 transition hover:border-brand-400"
          >
            <div className="flex items-start gap-2.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-600/20">
                <Icon name="attach" className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-ink" title={a.filename}>
                  {a.filename}
                </span>
                <span className="block text-[11px] text-ink-muted">{formatBytes(a.sizeBytes)}</span>
              </span>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2">
              <button
                type="button"
                onClick={() => onDownloadAttachment?.(message, a)}
                className="text-[11px] font-medium text-brand-600 hover:underline"
              >
                Download
              </button>

              {/* Offered only when the page can actually do it. A button that
                  is always there and sometimes works is worse than one that
                  appears when it will. */}
              {onSaveAttachmentToSpace && !saved[a.id] && (
                <button
                  type="button"
                  onClick={() => void saveToSpace(a)}
                  disabled={!!saving[a.id]}
                  className="text-[11px] font-medium text-brand-600 hover:underline disabled:opacity-60 disabled:no-underline"
                >
                  {saving[a.id] ? 'Saving…' : 'Save to Space'}
                </button>
              )}

              {saved[a.id] && (
                // Naming the folder, because "Saved" leaves somebody hunting.
                <span className="text-[11px] text-ok">Saved to Email attachments</span>
              )}
            </div>

            {saveError[a.id] && (
              <p className="mt-1.5 text-[11px] leading-snug text-danger">{saveError[a.id]}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  ) : null;
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface">
      {/* Toolbar — the open-message action row */}
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <ToolButton icon="back" label="Back" onClick={onBack} />
        <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <ToolButton icon="envelope" label="Mark as unread" onClick={() => onMarkUnread(message)} />
        <ToolButton icon="print" label="Print" onClick={() => onPrint(message)} />
        {/* Junk and Delete live behind their own divider, LAST in the cluster:
            both take the message away, and neither belongs adjacent to Back,
            where a hurried mis-click used to land on Delete. */}
        <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <ToolButton icon="junk" label="Move to Junk" onClick={() => onArchive(message)} />
        <ToolButton icon="trash" label="Delete" tone="danger" onClick={() => onDelete(message)} />
        <div className="ml-auto flex items-center gap-1">
          {/* Gmail's split/full-page choice, as one toggle. */}
          {onToggleExpand && (
            <span className="hidden lg:block">
              <ToolButton
                icon={expanded ? 'collapse' : 'expand'}
                label={expanded ? 'Show the message list' : 'Read full page'}
                onClick={onToggleExpand}
              />
            </span>
          )}
          <ReplyButton onClick={() => onReply(message, 'reply')} />
          <ToolButton icon="reply-all" label="Reply all" onClick={() => onReply(message, 'replyAll')} />
          <ToolButton icon="forward" label="Forward" onClick={() => onReply(message, 'forward')} />

          {/* Sender-level actions. These are deliberately behind a menu rather
              than another toolbar button: blocking someone is a decision, and a
              one-click icon next to Reply invites the mis-click. */}
          <div className="relative">
            <ToolButton icon="more" label="More" onClick={() => setMenu((v) => !v)} />
            {menu && (
              <>
                {/* Transparent click-away layer, below the menu, above the page. */}
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} aria-hidden="true" />
                <div
                  role="menu"
                  className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-surface py-1.5 text-sm shadow-raised"
                >
                  {onBlockSender && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { onBlockSender(message); setMenu(false); }}
                      className="block w-full truncate px-4 py-2 text-left text-ink hover:bg-canvas"
                    >
                      Block {message.from.email}
                    </button>
                  )}
                  <Link
                    role="menuitem"
                    href={`/mail/filters?from=${encodeURIComponent(message.from.email)}`}
                    className="block w-full px-4 py-2 text-left text-ink hover:bg-canvas"
                  >
                    Filter messages like this
                  </Link>
                  <div className="my-1 border-t border-line" />
                  <Link
                    role="menuitem"
                    href="/mail/filters"
                    className="block w-full px-4 py-2 text-left text-ink hover:bg-canvas"
                  >
                    Manage filters and blocked senders
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      </div>


      {/* Subject first, as the title of the whole view — Gmail's order. The
          old layout spent three stacked blocks (identity header, subject,
          recipients) before any body text was visible. */}
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        {/* text-lg + tracking-tight: the subject is the TITLE of this view and
            should read like one. One size step is the whole change — headline
            typography in a mail pane tips calm into shouty. */}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-ink">
          {message.subject || '(no subject)'}
        </h1>
        <ToolButton
          icon="star"
          label={message.isFlagged ? 'Unstar' : 'Star'}
          filled={message.isFlagged}
          tone={message.isFlagged ? 'warn' : 'default'}
          onClick={() => onToggleFlag(message)}
        />
      </div>

      {/* ------------------------------------------------------------------
          The conversation, Gmail's way: every message stacked in one scroll,
          oldest first. Siblings are single collapsed rows — who, snippet,
          when — and clicking one expands it here in place (the caller
          re-opens it, so its full body arrives the same way any open does).
          The first attempt was a collapsed "N messages" strip above the
          message; nobody expanded it, because a closed drawer reads as
          furniture. The conversation IS the content, so it gets the pane.
      ------------------------------------------------------------------ */}
      <div className="scroll-thin flex-1 overflow-y-auto">
        {isThread && threadTotal && threadTotal > ordered.length ? (
          <p className="border-b border-line bg-canvas/50 px-4 py-1.5 text-xs text-ink-muted">
            Showing the most recent {ordered.length} of {threadTotal} messages.
          </p>
        ) : null}

        {isThread ? (
          <ul className="list-none p-0">
            {ordered.map((t) => {
              const isOpen = t.id === message.id;
              if (!isOpen) {
                return (
                  <li key={t.id} className="border-b border-line">
                    <button
                      type="button"
                      disabled={!onOpenMessage}
                      onClick={() => onOpenMessage?.(t.id)}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition hover:bg-canvas/70"
                    >
                      <Avatar address={t.from} size={30} />
                      <span className={`w-36 shrink-0 truncate text-sm ${t.isRead ? 'text-ink-muted' : 'font-semibold text-ink'}`}>
                        {displayName(t.from)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                        {t.snippet}
                      </span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {new Date(t.sentAt).toLocaleDateString(undefined,
                          { day: 'numeric', month: 'short' })}
                        {t.folderName ? ` · ${t.folderName}` : ''}
                      </span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={t.id} ref={openRef} className="border-b border-line">
                  {senderHeader}
                  <div className="px-6 py-5">
                    {body}
                    {attachments}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <>
            {senderHeader}
            <div className="px-6 py-5">
              {body}
              {attachments}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
