'use client';

// ============================================================================
//  Mail settings — the signature, and the per-mailbox preferences after it
// ============================================================================
//
//  Deliberately PLAIN STRUCTURE, like the filters page: semantic markup and
//  existing token classes only, so the UI lane can restyle it without
//  unpicking layout decisions made in passing.
//
//  THE EDITOR IS A TEXTAREA, NOT A RICH-TEXT SURFACE, and that is a security
//  decision rather than a scoping one. A signature is appended to the HTML
//  body of every message this mailbox sends. A contentEditable that silently
//  accepts pasted markup is how a tracking pixel, a remote image beacon, or a
//  table that breaks in Outlook ends up on all of someone's outgoing mail —
//  and nobody would notice, because you don't read your own signature. Plain
//  text escaped into HTML on save is boring and correct. A real rich editor
//  can come later, with a sanitiser in front of it.
// ============================================================================

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { mailApi, type MailSignature } from '@/lib/mail';

/** Plain text -> the HTML half. Escaped first, then newlines become breaks. */
function toHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped.replace(/\r?\n/g, '<br>');
}

export default function MailSettingsPage() {
  const { authedFetch } = useAuth();

  const [text, setText] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [includeOnReply, setIncludeOnReply] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const sig = await mailApi.signature(authedFetch);
      // The plain-text half is the source of truth for the editor; the HTML
      // half is generated from it on save, never edited directly.
      setText(sig.bodyText);
      setEnabled(sig.enabled);
      setIncludeOnReply(sig.includeOnReply);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your signature.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  function edit<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setSaved(false); };
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload: MailSignature = {
        bodyText: text,
        bodyHtml: toHtml(text),
        enabled,
        includeOnReply,
      };
      await mailApi.saveSignature(authedFetch, payload);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your signature.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto p-6">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-ink">Mail settings</h1>
          <p className="text-sm text-ink-muted">Signature and message preferences for this mailbox.</p>
        </div>
        <Link href="/mail/inbox" className="text-sm font-medium text-brand-600 hover:underline">
          Back to inbox
        </Link>
        <Link href="/mail/filters" className="text-sm font-medium text-brand-600 hover:underline">
          Filters
        </Link>
      </header>

      {error && <p className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      <section className="max-w-2xl rounded-card border border-line bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink">Signature</h2>
        <p className="mb-4 text-xs text-ink-muted">
          Added to the bottom of messages sent from this mailbox. Plain text — it is escaped
          before sending, so nothing here can break the recipient&rsquo;s mail client.
        </p>

        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : (
          <>
            <label className="mb-4 block">
              <span className="mb-1.5 block text-sm font-medium text-ink">Your signature</span>
              <textarea
                value={text}
                onChange={(e) => edit(setText)(e.target.value)}
                rows={6}
                placeholder={'Amit Dadhich\nTechvein\n+91 …'}
                className="scroll-thin w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-brand-400"
              />
            </label>

            <label className="mb-2 flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => edit(setEnabled)(e.target.checked)}
                className="h-4 w-4 rounded border-line text-brand-500"
              />
              Add it to new messages
            </label>

            <label className="mb-5 flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={includeOnReply}
                onChange={(e) => edit(setIncludeOnReply)(e.target.checked)}
                disabled={!enabled}
                className="h-4 w-4 rounded border-line text-brand-500 disabled:opacity-50"
              />
              Also add it to replies and forwards
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save signature'}
              </button>
              {saved && <span className="text-sm text-ok">Saved.</span>}
            </div>

            {text.trim().length > 0 && (
              <div className="mt-5 border-t border-line pt-4">
                <p className="mb-2 text-label font-semibold uppercase text-ink-faint">Preview</p>
                <p className="whitespace-pre-wrap text-sm text-ink-muted">{text}</p>
              </div>
            )}

            <p className="mt-4 text-xs text-ink-faint">
              This signature belongs to the mailbox, not to you personally — a shared address
              signs the same way whoever is replying.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
