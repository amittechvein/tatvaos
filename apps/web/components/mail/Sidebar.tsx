'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { formatBytes, quotaPercent } from '@tatvaos/core';
import type { Folder } from '@tatvaos/types';
import { folderPath, type MailMailbox } from '@/lib/mail';
import { Icon } from '../ui/Icon';

const FOLDER_ICONS: Record<string, 'inbox' | 'send' | 'draft' | 'junk' | 'trash'> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'send',
  '\\Drafts': 'draft',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
};

/**
 * The Gmail-shaped nav: a floating Compose pill, folders as rounded-right
 * rows with the active one filled, counts as bare numbers rather than badges.
 * Brand stays ours — the accent comes from the theme, not from Google.
 */
export function Sidebar({
  folders,
  mailbox,
  onCompose,
  onNavigate,
}: {
  folders: Folder[];
  mailbox: MailMailbox;
  onCompose: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const pct = quotaPercent(mailbox.usedBytes, mailbox.quotaBytes);

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col bg-canvas">
      <div className="px-3 pb-4 pt-3">
        <button
          type="button"
          onClick={onCompose}
          className="flex items-center gap-3 rounded-2xl bg-surface px-6 py-3.5 text-sm font-medium text-ink shadow-raised transition hover:shadow-lg"
        >
          <Icon name="compose" className="h-5 w-5 text-brand-600" />
          Compose
        </button>
      </div>

      <ul className="scroll-thin flex-1 overflow-y-auto pr-3">
        {folders.map((f) => {
          const href = folderPath(f);
          const active = pathname === href;
          return (
            <li key={f.id}>
              <Link
                href={href}
                onClick={onNavigate}
                className={`flex items-center gap-4 rounded-r-full py-1.5 pl-6 pr-4 text-sm transition ${
                  active
                    ? 'bg-brand-100 font-semibold text-brand-800 dark:bg-brand-600/25 dark:text-brand-200'
                    : 'text-ink hover:bg-surface'
                }`}
              >
                <Icon name={FOLDER_ICONS[f.specialUse ?? ''] ?? 'inbox'} className="h-4.5 w-4.5" />
                <span className="flex-1 truncate">{f.name}</span>
                {f.unreadCount > 0 && (
                  <span className={`text-xs ${active ? 'font-bold' : 'font-semibold text-ink-muted'}`}>
                    {f.unreadCount}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="px-6 py-4">
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
