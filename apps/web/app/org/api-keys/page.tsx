'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Mail API keys — the credential an organisation's own software uses to send
//  through POST /api/v1/mail/send.
//
//  Shaped on mail/settings/app-passwords, which solved the same problem: a
//  secret that renders ONCE, in the response to Create, and is never
//  retrievable afterwards. This screen's job is to make that one showing
//  count - big, monospaced, one copy button, and an unmissable line saying it
//  disappears when you leave.
//
//  Unlike app passwords there can be MANY active keys: a website and a
//  billing job are different credentials with different revocation
//  lifetimes. So creating one does not revoke another.
// ============================================================================

interface KeyRow {
  id: string; label: string; keyPrefix: string;
  createdAt: string; lastUsedAt: string | null;
}

export default function ApiKeysPage() {
  const { authedFetch } = useAuth();
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await authedFetch('/mail/api-keys');
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not load.');
      setKeys((await r.json()).keys);
    } catch (e) { setError((e as Error).message); }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true); setError(null); setCopied(false);
    try {
      const r = await authedFetch('/mail/api-keys', {
        method: 'POST', body: JSON.stringify({ label }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b?.error ?? 'Could not create the key.');
      setFresh({ key: b.key, label: b.label });
      setLabel('');
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const revoke = async (id: string) => {
    setBusy(true); setError(null);
    try {
      const r = await authedFetch(`/mail/api-keys/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not revoke.');
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold text-ink">Mail API keys</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-faint">
        For your own software to send mail through TatvaOS. The sender address
        must be a mailbox on a domain you have verified.
      </p>

      {error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          {error}
        </p>
      )}

      {/* The one showing. Deliberately loud, deliberately not dismissible by
          accident, and deliberately gone on reload - because it is gone. */}
      {fresh && (
        <div className="mt-4 rounded-lg border border-accent bg-accent/5 p-4">
          <p className="text-sm font-semibold text-ink">
            Your new key for “{fresh.label}”
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            Copy it now. It is shown once and cannot be retrieved — if you lose
            it, revoke this key and create another.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-line bg-surface px-3 py-2 font-mono text-sm text-ink">
              {fresh.key}
            </code>
            <button
              type="button"
              onClick={() => { void navigator.clipboard.writeText(fresh.key); setCopied(true); }}
              className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-surface"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-sm text-ink">What is this key for?</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Website contact form"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>
        <button
          type="button"
          disabled={busy || label.trim().length === 0}
          onClick={() => void create()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </div>

      <h2 className="mb-2 mt-8 text-sm font-semibold text-ink">Active keys</h2>
      {keys === null ? (
        <p className="text-xs text-ink-faint">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="text-xs text-ink-faint">No keys yet.</p>
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-3 p-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate text-ink">{k.label}</p>
                <p className="font-mono text-xs text-ink-faint">
                  {k.keyPrefix}…
                  {/* NULL means never used, and it can be read that way -
                      this column has a writer, unlike the one removed from
                      the app-password store for lacking one. */}
                  {' · '}
                  {k.lastUsedAt
                    ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                    : 'never used'}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void revoke(k.id)}
                className="text-xs text-danger hover:underline"
              >
                revoke
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Says exactly what revoking does and no more. Mail already handed to
          Postfix is not recalled, and a button that implies otherwise is the
          kind of half-true this codebase has spent a fortnight removing. */}
      <p className="mt-3 max-w-prose text-xs text-ink-faint">
        Revoking stops new requests immediately. Mail already accepted for
        delivery is not recalled.
      </p>
    </div>
  );
}
