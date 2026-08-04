'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { mockApi } from '@tatvaos/core';
import type { Folder, Message, Session } from '@tatvaos/types';
import { Sidebar } from '@/components/mail/Sidebar';
import { MessageList } from '@/components/mail/MessageList';
import { MessageView } from '@/components/mail/MessageView';
import { Composer } from '@/components/mail/Composer';
import { Icon } from '@/components/ui/Icon';

/**
 * Three-pane on desktop, two-pane on tablet, single-pane with drill-down on
 * phones. One responsive codebase — "mobile web" is not a separate build.
 */
export default function MailPage({ params }: { params: Promise<{ folderId: string }> }) {
  const { folderId } = use(params);

  const [session, setSession] = useState<Session | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([mockApi.getSession(), mockApi.getFolders(), mockApi.getMessages(folderId)]).then(
      ([s, f, m]) => {
        if (cancelled) return;
        setSession(s);
        setFolders(f);
        setMessages(m);
        setSelectedId(null);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [folderId]);

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

  const selected = useMemo(
    () => messages.find((m) => m.id === selectedId) ?? null,
    [messages, selectedId],
  );

  const currentFolder = folders.find((f) => f.id === folderId);

  function handleSelect(id: string) {
    setSelectedId(id);
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, isRead: true } : m)));
  }

  function handleToggleFlag(id: string) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, isFlagged: !m.isFlagged } : m)));
  }

  if (loading || !session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400">Loading…</div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Sidebar — drawer below lg */}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform lg:static lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar
          folders={folders}
          session={session}
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
        className={`flex min-w-0 flex-col border-r border-gray-200 bg-white lg:w-[380px] lg:shrink-0 ${
          selected ? 'hidden lg:flex' : 'flex flex-1'
        }`}
      >
        <header className="border-b border-gray-200 px-4 py-3">
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
              className="rounded p-1 text-gray-600 hover:bg-gray-100 lg:hidden"
            >
              <Icon name="menu" className="h-5 w-5" />
            </button>
            <h1 className="text-base font-semibold">{currentFolder?.name ?? 'Mail'}</h1>
            <span className="text-sm text-gray-400">{filtered.length}</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2">
            <Icon name="search" className="h-4 w-4 shrink-0 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search mail"
              className="w-full border-0 bg-transparent p-0 text-sm outline-none placeholder:text-gray-400"
            />
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <MessageList
            messages={filtered}
            selectedId={selectedId}
            onSelect={handleSelect}
            onToggleFlag={handleToggleFlag}
          />
        </div>
      </section>

      {/* Reading pane */}
      <section className={`min-w-0 flex-1 ${selected ? 'flex' : 'hidden lg:flex'}`}>
        <div className="w-full">
          <MessageView
            message={selected}
            onBack={() => setSelectedId(null)}
            onReply={(m) => {
              setReplyTo(m);
              setComposing(true);
            }}
          />
        </div>
      </section>

      {composing && <Composer replyTo={replyTo} onClose={() => setComposing(false)} />}
    </div>
  );
}
