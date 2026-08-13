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

/**
 * The details a sample signature fills in for you.
 *
 * `email` is the MAILBOX address, never the sign-in email. Those are commonly
 * different - someone signs in as a person and sends as a mailbox - and a
 * signature quietly advertising the wrong address is the kind of error nobody
 * proofreads, because you never read your own signature.
 */
interface Identity {
  name: string;
  email: string;
  org: string;
}

/**
 * Starting points, not a house style.
 *
 * Square-bracket placeholders are deliberate: they are obviously unfinished,
 * so a half-edited sample looks wrong at a glance rather than going out
 * looking deliberate. Anything we actually know is filled in already.
 */
const SAMPLES: { id: string; label: string; hint: string; build: (i: Identity) => string }[] = [
  {
    id: 'name',
    label: 'Just your name',
    hint: 'For internal mail, where everyone already knows who you are.',
    build: (i) => i.name,
  },
  {
    id: 'role',
    label: 'Name and role',
    hint: 'The usual choice.',
    build: (i) => `${i.name}\n[Your role]\n${i.org}`,
  },
  {
    id: 'contact',
    label: 'Full contact',
    hint: 'For mail that leaves the organisation.',
    build: (i) => `${i.name}\n[Your role] | ${i.org}\n${i.email}\n[Phone]`,
  },
  {
    id: 'closing',
    label: 'With a sign-off',
    hint: 'Adds the closing line, so you stop typing it every time.',
    build: (i) => `Warm regards,\n\n${i.name}\n[Your role] | ${i.org}\n${i.email}`,
  },
];

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
  const { authedFetch, user, accounts } = useAuth();

  const [text, setText] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [includeOnReply, setIncludeOnReply] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  /** A sample waiting on "replace what I've written?". Null when nothing is. */
  const [pending, setPending] = useState<string | null>(null);

  const identity: Identity = {
    name: user?.displayName ?? '[Your name]',
    // The mailbox address if we have it. Falling back to the sign-in email is
    // a last resort and can be wrong, which is why the samples are editable
    // and the preview sits right underneath.
    email: address ?? user?.email ?? '[your.name@example.com]',
    org: accounts.find((a) => a.active)?.organisation ?? '[Your organisation]',
  };

  const load = useCallback(async () => {
    try {
      // Bootstrap alongside the signature, purely for the mailbox address the
      // samples fill in. It fails quietly: a missing address costs a
      // placeholder in a sample, and is no reason to fail the whole page.
      void mailApi
        .bootstrap(authedFetch)
        .then((b) => setAddress(b.mailbox?.address ?? null))
        .catch(() => {});

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

  /**
   * Applying a sample REPLACES the editor, so when there is already something
   * in it we ask first. Wiping a signature somebody wrote, because they
   * clicked a card to see what it looked like, is a small betrayal and an
   * easy one to avoid.
   */
  function applySample(sample: string) {
    if (text.trim().length === 0) {
      setText(sample);
      setSaved(false);
      return;
    }
    setPending(sample);
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

            <div className="mb-5">
              <p className="mb-1 text-sm font-medium text-ink">Start from a sample</p>
              <p className="mb-2.5 text-xs text-ink-muted">
                Fills the box above with your name, address and organisation already in
                place. Everything stays editable, and anything in [square brackets] is
                waiting for you.
              </p>

              <div className="flex flex-wrap gap-2">
                {SAMPLES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    title={s.hint}
                    onClick={() => applySample(s.build(identity))}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-ink transition hover:border-brand-400"
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {pending !== null && (
                <div className="mt-3 rounded-md border border-line bg-canvas p-3">
                  <p className="mb-2 text-sm text-ink">
                    Replace what you have written with this sample?
                  </p>
                  <pre className="scroll-thin mb-3 overflow-x-auto whitespace-pre-wrap text-sm text-ink-muted">
                    {pending}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => { setText(pending); setPending(null); setSaved(false); }}
                      className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-600"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => setPending(null)}
                      className="rounded-md border border-line px-3 py-1.5 text-sm text-ink transition hover:border-brand-400"
                    >
                      Keep mine
                    </button>
                  </div>
                </div>
              )}
            </div>

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
