'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { formatBytes, quotaPercent } from '@tatvaos/core';
import type { Folder } from '@tatvaos/types';
import { folderPath, type MailMailbox } from '@/lib/mail';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';

const FOLDER_ICONS: Record<string, 'inbox' | 'send' | 'draft' | 'junk' | 'trash'> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'send',
  '\\Drafts': 'draft',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
};

// Which colour a folder's unread pill takes. Junk is a warning; everything
// else that carries unread uses the brand accent.
function pillClass(specialUse: string | null): string {
  if (specialUse === '\\Junk') return 'bg-danger text-white';
  return 'bg-brand-600 text-white';
}

// Decorative — matches the template's Labels block. No data behind these yet;
// they are styled placeholders for the eventual label feature.
const LABELS = [
  { name: 'Personal', colour: 'bg-brand-500' },
  { name: 'Work', colour: 'bg-ok' },
  { name: 'Clients', colour: 'bg-warn' },
  { name: 'Family', colour: 'bg-danger' },
];

// Decorative — the template's Online users block.
const ONLINE = [
  { name: 'Priya Nair', email: 'priya@acmesupplies.in' },
  { name: 'Rahul Mehta', email: 'rahul@techvein.com' },
  { name: 'Neha Kulkarni', email: 'neha@designstudio.co' },
];

export function Sidebar({
  folders,
  mailbox,
  displayName,
  onCompose,
  onNavigate,
}: {
  folders: Folder[];
  mailbox: MailMailbox;
  displayName: string;
  onCompose: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const pct = quotaPercent(mailbox.usedBytes, mailbox.quotaBytes);

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col overflow-hidden rounded-card border border-line bg-surface">
      {/* Compose */}
      <div className="border-b border-line p-3">
        <button
          type="button"
          onClick={onCompose}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700"
        >
          <Icon name="plus-circle" className="h-4 w-4" />
          Compose Mail
        </button>
      </div>

      {/* Account card */}
      <div className="flex items-center gap-3 border-b border-line bg-canvas px-4 py-3">
        <div className="relative">
          <Avatar address={{ name: displayName, email: mailbox.address }} size={40} />
          <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-ok" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{displayName}</p>
          <p className="truncate text-xs text-ink-muted">{mailbox.address}</p>
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-2 py-3">
        {/* Folders */}
        <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Mails
        </p>
        <ul className="space-y-0.5">
          {folders.map((f) => {
            const href = folderPath(f);
            const active = pathname === href;
            return (
              <li key={f.id}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                    active
                      ? 'bg-brand-50 font-semibold text-brand-800 dark:bg-brand-600/20 dark:text-brand-200'
                      : 'text-ink hover:bg-canvas'
                  }`}
                >
                  <Icon name={FOLDER_ICONS[f.specialUse ?? ''] ?? 'inbox'} className="h-4 w-4" />
                  <span className="flex-1 truncate">{f.name}</span>
                  {f.unreadCount > 0 && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${pillClass(f.specialUse)}`}
                    >
                      {f.unreadCount}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Settings (decorative) */}
        <p className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Settings
        </p>
        <ul className="space-y-0.5">
          <li>
            <Link
              href="/account"
              onClick={onNavigate}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink transition hover:bg-canvas"
            >
              <Icon name="settings" className="h-4 w-4" />
              <span className="flex-1 truncate">Settings</span>
            </Link>
          </li>
        </ul>

        {/* Labels (decorative) */}
        <p className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Labels
        </p>
        <ul className="space-y-0.5">
          {LABELS.map((l) => (
            <li key={l.name}>
              <span className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm text-ink">
                <span className={`h-2.5 w-2.5 rounded-full ${l.colour}`} />
                <span className="flex-1 truncate">{l.name}</span>
              </span>
            </li>
          ))}
        </ul>

        {/* Online users (decorative) */}
        <p className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Online users
        </p>
        <ul className="space-y-1">
          {ONLINE.map((u) => (
            <li key={u.email} className="flex items-center gap-3 px-2 py-1">
              <div className="relative">
                <Avatar address={u} size={28} />
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-ok" />
              </div>
              <span className="truncate text-sm text-ink">{u.name}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Storage */}
      <div className="border-t border-line px-4 py-3">
        <div className="mb-1.5 flex justify-between text-xs text-ink-muted">
          <span>Storage</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-line">
          <div
            className={`h-full rounded-full transition-all ${
              pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-brand-500'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1.5 text-xs text-ink-muted">
          {formatBytes(mailbox.usedBytes)} of {formatBytes(mailbox.quotaBytes)}
        </div>
      </div>
    </nav>
  );
}
