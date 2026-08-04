'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { formatBytes, quotaPercent } from '@tatvaos/core';
import type { Folder, Session } from '@tatvaos/types';
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
  session,
  onCompose,
  onNavigate,
}: {
  folders: Folder[];
  session: Session;
  onCompose: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const pct = quotaPercent(session.mailbox.usedBytes, session.mailbox.quotaBytes);

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          T
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">TatvaOS Mail</div>
          <div className="truncate text-xs text-gray-500">{session.tenantName}</div>
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
          const href = `/mail/${f.id}`;
          const active = pathname === href;
          return (
            <li key={f.id}>
              <Link
                href={href}
                onClick={onNavigate}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-brand-50 font-semibold text-brand-800'
                    : 'text-gray-700 hover:bg-gray-100'
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

      <div className="border-t border-gray-200 p-4">
        <div className="mb-1.5 flex justify-between text-xs text-gray-500">
          <span>Storage</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className={`h-full rounded-full transition-all ${
              pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-brand-500'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1.5 text-xs text-gray-500">
          {formatBytes(session.mailbox.usedBytes)} of {formatBytes(session.mailbox.quotaBytes)}
        </div>

        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="truncate text-sm font-medium">{session.mailbox.displayName}</div>
          <div className="truncate text-xs text-gray-500">{session.mailbox.address}</div>
        </div>
      </div>
    </nav>
  );
}
