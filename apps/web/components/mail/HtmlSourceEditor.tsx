'use client';

/**
 * Editing a message's (or a signature's) HTML as text.
 *
 * Shared by the composer and the signature editor, which each clean the
 * source with their own rules when leaving this view (lib/composeHtml,
 * lib/signatureHtml). This component does no cleaning itself: it shows the
 * source, and it shows what the last clean REMOVED — because code that
 * vanishes without a word reads as an editor that is broken.
 */
export function HtmlSourceEditor({
  value, onChange, removed, onDismissRemoved, hint, minHeightClass = 'min-h-[220px]',
}: {
  value: string;
  onChange: (next: string) => void;
  /** Kinds of thing the last clean took out; empty hides the notice. */
  removed: string[];
  onDismissRemoved: () => void;
  /** One line under the box — what this particular HTML may not contain. */
  hint: string;
  minHeightClass?: string;
}) {
  return (
    <div className="flex grow flex-col">
      {removed.length > 0 && (
        <div role="status" className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink">
          <span className="grow">
            <strong>Some code was taken out</strong> because it is not safe or does not work in email:{' '}
            <span className="font-mono">{removed.slice(0, 8).join(', ')}{removed.length > 8 ? ` and ${removed.length - 8} more` : ''}</span>.
          </span>
          <button type="button" onClick={onDismissRemoved} aria-label="Dismiss" className="text-ink-muted hover:text-ink">×</button>
        </div>
      )}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="HTML source"
        className={`${minHeightClass} grow shrink-0 resize-none border-0 bg-canvas/60 px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none`}
      />
      <p className="px-4 pb-2 pt-1 text-[11px] text-ink-muted">{hint}</p>
    </div>
  );
}
