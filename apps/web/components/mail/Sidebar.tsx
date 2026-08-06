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

export function Sidebar({
  folders,
  mailbox,
  orgName,
  onCompose,
  onNavigate,
}: {
  folders: Folder[];
  mailbox: MailMailbox;
  orgName?: string;
  onCompose: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const pct = quotaPercent(mailbox.usedBytes, mailbox.quotaBytes);

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          T
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">TatvaOS Mail</div>
          {orgName && <div className="truncate text-xs text-ink-muted">{orgName}</div>}
        </div>
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={onCompose}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700"
        >
          <Icon name="compose" className="h-4 w-4" />
          Compose
        </button>
      </div>

      <ul className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-2">
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
                    ? 'bg-brand-50 font-semibold text-brand-800'
                    : 'text-ink hover:bg-canvas'
                }`}
              >
                <Icon name={FOLDER_ICONS[f.specialUse ?? ''] ?? 'inbox'} className="h-4.5 w-4.5" />
                <span className="flex-1 truncate">{f.name}</span>
                {f.unreadCount > 0 && (
                  <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                    {f.unreadCount}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-line p-4">
        <div className="mb-1.5 flex justify-between text-xs text-ink-muted">
          <span>Storage</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
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

        <div className="mt-4 border-t border-line pt-3">
          <div className="truncate text-sm font-medium">{mailbox.displayName}</div>
          <div className="truncate text-xs text-ink-muted">{mailbox.address}</div>
        </div>
      </div>
    </nav>
  );
}
