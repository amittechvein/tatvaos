'use client';

// ============================================================================
//  Blocked senders panel — list, block a new address, unblock, and a search
//  to find one in a long list. Lifted out of /mail/filters so it can be its
//  own Settings tab.
//
//  Blocked mail is filed to Junk, never rejected: nothing is lost and
//  unblocking is instant. Domain-level blocking is NOT offered here because
//  the block store holds addresses — a domain field is backend work, and a
//  box that silently blocked only the literal string would mislead.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { mailApi, type BlockedSender } from '@/lib/mail';

export function BlockedPanel() {
  const { authedFetch } = useAuth();

  const [blocked, setBlocked] = useState<BlockedSender[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setBlocked(await mailApi.blocked(authedFetch));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load blocked senders.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function block() {
    const value = address.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await mailApi.blockSender(authedFetch, value);
      setAddress('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not block that sender.');
    } finally {
      setBusy(false);
    }
  }

  async function unblock(id: string) {
    setError(null);
    try {
      await mailApi.unblockSender(authedFetch, id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unblock that sender.');
    }
  }

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? blocked.filter((b) => b.address.toLowerCase().includes(q)) : blocked;
  }, [blocked, search]);

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-ink">Blocked senders</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Mail from these addresses is filed to Junk instead of your inbox. It is never rejected,
          so nothing is lost and unblocking takes effect immediately.
        </p>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      )}

      {/* Block a new address */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void block(); }}
          placeholder="name@example.com"
          className="h-10 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-brand-400"
        />
        <button
          type="button"
          onClick={() => void block()}
          disabled={busy || address.trim().length === 0}
          className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
        >
          {busy ? 'Blocking…' : 'Block address'}
        </button>
      </div>

      {/* Search a long list */}
      {blocked.length > 8 && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search blocked addresses"
          className="mb-3 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-brand-400"
        />
      )}

      {loading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : blocked.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-4 py-8 text-center text-sm text-ink-muted">
          Nobody is blocked. Add an address above, or use &ldquo;Block&rdquo; in a message&rsquo;s ⋮ menu.
        </p>
      ) : shown.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
          No blocked address matches &ldquo;{search}&rdquo;.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {shown.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{b.address}</span>
              <button
                type="button"
                onClick={() => void unblock(b.id)}
                className="text-sm font-medium text-brand-600 hover:underline"
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
