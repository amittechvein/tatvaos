/**
 * Build stamp shown on every page.
 *
 * Exists because "is what I'm looking at actually the build I just deployed?"
 * was unanswerable from the browser — a deploy that silently failed server-side
 * looked identical to one that worked, and several rounds of UI changes were
 * debugged as CSS bugs when the real problem was that the server was still on an
 * older commit. Now the commit and build time are on the screen, so the question
 * is settled at a glance.
 *
 * The values are inlined at build time by next.config.ts. The timestamp string
 * is sliced (never locale-formatted) so the server and client render the exact
 * same text — a locale format would differ between them and trip hydration.
 *
 * Deliberately pointer-events: none, so it can never intercept a click, and
 * aria-hidden so it is not announced to screen readers.
 *
 * LEGIBILITY, 8 Sept 2026. It was rgba(130,135,150,.9) on rgba(127,127,140,.14)
 * — a contrast ratio of 1.1, i.e. very nearly invisible. That is an odd thing
 * for the one element whose entire job is to be read when you are asking "did
 * my deploy land?", and for a week it was only readable by querying the DOM.
 * Now ink-muted on the surface with a hairline: about 4.8, still quiet, still
 * out of the way, but actually readable. Unobtrusive and unreadable are not
 * the same requirement.
 *
 * If this shows `unknown`, the stamp is not reaching the build — next.config.ts
 * resolves it by reading .git/HEAD inside the image, and the root .dockerignore
 * excludes .git. The fix is to pass BUILD_SHA as a build arg (resolveSha
 * already honours process.env.BUILD_SHA), not to ship .git into the image.
 */
export function BuildBadge() {
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA || 'unknown';
  const iso = process.env.NEXT_PUBLIC_BUILD_TIME || '';
  const when = iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : '';

  return (
    <div
      aria-hidden="true"
      data-build={sha}
      style={{
        position: 'fixed',
        insetInlineEnd: 6,
        insetBlockEnd: 4,
        zIndex: 9999,
        pointerEvents: 'none',
        fontSize: 10,
        lineHeight: '14px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        letterSpacing: '0.02em',
        color: 'rgb(var(--ink-muted))',
        background: 'rgb(var(--surface))',
        border: '1px solid rgb(var(--line))',
        padding: '1px 6px',
        borderRadius: 6,
        userSelect: 'none',
      }}
    >
      {sha}{when ? ` · ${when}` : ''}
    </div>
  );
}
