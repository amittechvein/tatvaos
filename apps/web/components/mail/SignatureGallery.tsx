'use client';

import { SafeHtml } from '@/components/mail/SafeHtml';
import { cleanSignatureHtml } from '@/lib/signatureHtml';
import { SIGNATURE_TEMPLATES, type SignatureIdentity } from '@/lib/signatureTemplates';

/**
 * The ready-made signatures, as a grid of real previews.
 *
 * ── WHY EACH CARD IS A RENDERED FRAME ─────────────────────────────────
 *
 *  A list of names — "Accent bar", "Name on a coloured band" — tells you
 *  nothing about what you are choosing. These are LAYOUTS, and the whole
 *  reason they exist is that people cannot picture one from a description
 *  (Amit, 24 September 2026, asking for predefined structures after the
 *  rich editor shipped and left everyone at an empty box).
 *
 *  So every card renders its template through cleanSignatureHtml and
 *  SafeHtml — the same sanitiser it will be saved through and the same
 *  sandboxed frame a received message is read in. That means a card cannot
 *  show you something the sanitiser would remove: if a template is ever
 *  written with markup that does not survive, the gallery shows the damage
 *  rather than a promise.
 *
 *  ── TWO THINGS THAT WILL BITE WHOEVER EDITS THIS ───────────────────────
 *
 *  1. pointer-events-none ON THE PREVIEW. SafeHtml is an iframe, and an
 *     iframe swallows the click meant for the card behind it. Without it
 *     the cards look clickable and are not — clicking the middle of one
 *     does nothing, which is the worst kind of broken.
 *
 *  2. EACH CARD IS A DOCUMENT. Eleven previews is eleven iframes, so the
 *     caller decides when this is on screen — the settings page opens it
 *     when the signature is empty and leaves it closed otherwise.
 */
export default function SignatureGallery({
  identity,
  onPick,
  disabled,
}: {
  identity: SignatureIdentity;
  /** Called with the built HTML. The caller decides about replacing. */
  onPick: (html: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {SIGNATURE_TEMPLATES.map((t) => (
        <button
          key={t.id}
          type="button"
          data-template={t.id}
          disabled={disabled}
          onClick={() => onPick(t.build(identity))}
          className="flex flex-col rounded-md border border-line bg-canvas p-3 text-left transition hover:border-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="pointer-events-none mb-2 block max-h-28 overflow-hidden rounded bg-surface p-2">
            <SafeHtml html={cleanSignatureHtml(t.build(identity))} allowRemoteInitially />
          </span>
          <span className="flex items-center gap-2 text-sm font-medium text-ink">
            {t.label}
            {t.wantsLogo && (
              <span className="rounded bg-brand-500/10 px-1.5 py-0.5 text-[11px] font-medium text-brand-600">
                logo
              </span>
            )}
          </span>
          <span className="text-xs text-ink-muted">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}
