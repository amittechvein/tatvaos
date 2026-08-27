'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  App passwords — the credential for third-party mail clients.
//
//  LANE NOTE: Core-authored on 28 Aug 2026 as a declared exception (customer
//  waiting on external SMTP; Mail deep in the redesign). A STANDALONE page on
//  its own route so it collides with nothing — Mail: link it from your
//  settings nav when you're ready, restyle freely.
//
//  The password renders ONCE, in the response to Generate, and is never
//  retrievable afterwards. That is the API's rule; this screen's job is to
//  make the one showing count: big, monospaced, one copy button, and an
//  unmissable "this disappears when you leave" line.
// ============================================================================

interface ActiveInfo { id: string; label: string; createdAt: string; lastUsedAt: string | null }
interface Settings {
  imapHost: string; imapPort: number; imapSecurity: string;
  smtpHost: string; smtpPort: number; smtpSecurity: string; username: string;
}
interface State { address: string; active: ActiveInfo | null; settings: Settings }

export default function AppPasswordsPage() {
  const { authedFetch } = useAuth();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ password: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await authedFetch('/mail/app-password');
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not load.');
      setState(await r.json());
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function generate() {
    setBusy(true); setError(null);
    try {
      const r = await authedFetch('/mail/app-password', {
        method: 'POST', body: JSON.stringify({ label }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? 'Could not generate.');
      setFresh({ password: body.password, label: body.label });
      setLabel('');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not generate.'); }
    finally { setBusy(false); }
  }

  async function revoke() {
    setBusy(true); setError(null);
    try {
      await authedFetch('/mail/app-password', { method: 'DELETE' });
      setFresh(null);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not revoke.'); }
    finally { setBusy(false); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard denied — the text is selectable */ }
  }

  if (!state && !error) return <div className="p-6 text-sm text-ink-faint">Loading…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-ink">App passwords</h1>
        <p className="mt-1 text-sm text-ink-muted">
          For mail apps outside TatvaOS — Outlook, Thunderbird, a phone&rsquo;s mail app, or
          software that sends mail for you. Your real TatvaOS password never gets typed
          into someone else&rsquo;s software.
        </p>
      </header>

      {error && <div className="rounded-xl bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>}

      {/* The one-time reveal. */}
      {fresh && (
        <section className="rounded-card border border-brand-400 bg-brand-50 p-5 dark:bg-brand-600/15">
          <p className="text-sm font-semibold text-ink">Your new app password for &ldquo;{fresh.label}&rdquo;</p>
          <div className="mt-3 flex items-center gap-3">
            <code className="select-all rounded-lg bg-surface px-4 py-3 font-mono text-lg tracking-wider text-ink shadow-card">
              {fresh.password}
            </code>
            <button type="button" onClick={() => void copy(fresh.password)}
              className="rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-500">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-3 text-xs font-medium text-danger">
            Shown once. When you leave this page it is gone — if it is lost, generate a new
            one, and the old one stops working the moment you do.
          </p>
        </section>
      )}

      {/* Current state + actions */}
      <section className="rounded-card border border-line bg-surface p-5">
        {state?.active ? (
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-ink">{state.active.label}</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Created {new Date(state.active.createdAt).toLocaleDateString()}
                {state.active.lastUsedAt
                  ? ` · last used ${new Date(state.active.lastUsedAt).toLocaleDateString()}`
                  : ' · never used yet'}
              </p>
            </div>
            <button type="button" onClick={() => void revoke()} disabled={busy}
              className="rounded-full border border-danger/30 px-4 py-2 text-sm font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50">
              Revoke
            </button>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">No app password yet.</p>
        )}

        <div className="mt-4 flex gap-2 border-t border-line pt-4">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What is this for? e.g. Office laptop Thunderbird"
            maxLength={100}
            className="min-w-0 flex-1 rounded-xl border border-line bg-transparent px-3.5 py-2.5 text-sm text-ink outline-none focus:border-brand-500"
          />
          <button type="button" onClick={() => void generate()} disabled={busy || !label.trim()}
            className="rounded-full bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:opacity-50">
            {state?.active ? 'Replace' : 'Generate'}
          </button>
        </div>
        {state?.active && (
          <p className="mt-2 text-xs text-ink-faint">
            One app password at a time — generating a new one signs the old one out everywhere.
          </p>
        )}
      </section>

      {/* The settings block, from the API so it can never drift from truth. */}
      {state && (
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="text-sm font-semibold text-ink">Settings for your mail app</h2>
          <dl className="mt-3 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
            <dt className="text-ink-muted">Username</dt><dd className="font-mono text-ink">{state.settings.username}</dd>
            <dt className="text-ink-muted">Password</dt><dd className="text-ink">the app password above</dd>
            <dt className="text-ink-muted">Incoming (IMAP)</dt>
            <dd className="font-mono text-ink">{state.settings.imapHost} · {state.settings.imapPort} · {state.settings.imapSecurity}</dd>
            <dt className="text-ink-muted">Outgoing (SMTP)</dt>
            <dd className="font-mono text-ink">{state.settings.smtpHost} · {state.settings.smtpPort} · {state.settings.smtpSecurity}</dd>
          </dl>
        </section>
      )}
    </div>
  );
}
