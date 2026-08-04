'use client';

import { useEffect, useRef } from 'react';
import { ACCENTS, RAILS, useTheme, type ColorMode, type RailMode } from '@/lib/theme';

/**
 * The theme panel behind the gear icon.
 *
 * Scoped deliberately. The reference template also offers right-to-left
 * layout, horizontal navigation, six sidebar variants and photographic menu
 * backgrounds — those exist to demonstrate range to people evaluating a
 * template, and each one is a permanent second layout to keep working. What
 * is here is what a customer will actually use: dark mode, an accent colour,
 * a sidebar colour, and how much of the sidebar to show.
 *
 * Any of the rest can be added later; none of them should be added by default.
 */
export function Switcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    mode, setMode, accent, setAccent, rail, setRail, railMode, setRailMode, reset,
  } = useTheme();

  const panel = useRef<HTMLDivElement>(null);

  // Escape closes it. A panel that can only be dismissed by finding a small
  // button is a panel people leave open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-40 bg-black/20 transition-opacity duration-200
          ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />

      <div
        ref={panel}
        role="dialog"
        aria-label="Appearance"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 flex w-[300px] flex-col bg-surface shadow-raised
                    transition-transform duration-200 ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <header className="flex h-topbar shrink-0 items-center justify-between border-b border-line px-5">
          <h2 className="text-sm font-semibold text-ink">Appearance</h2>
          <button
            onClick={onClose}
            aria-label="Close appearance panel"
            className="rounded p-1 text-ink-muted transition hover:bg-canvas hover:text-ink"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="scroll-thin flex-1 overflow-y-auto p-5">
          <Group label="Mode">
            <div className="grid grid-cols-2 gap-2">
              {(['light', 'dark'] as ColorMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={`rounded-card border px-3 py-2 text-[13px] capitalize transition
                    ${mode === m
                      ? 'border-brand-500 bg-brand-50 font-medium text-brand-700'
                      : 'border-line text-ink-muted hover:border-ink-faint'}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </Group>

          <Group label="Accent colour">
            <Swatches options={ACCENTS} value={accent} onChange={setAccent} />
            <CustomColour value={accent} onChange={setAccent} label="Custom accent" />
          </Group>

          <Group label="Sidebar colour">
            <Swatches options={RAILS} value={rail} onChange={setRail} disabled={mode === 'dark'} />
            <CustomColour value={rail} onChange={setRail} label="Custom sidebar" disabled={mode === 'dark'} />
            {mode === 'dark' && (
              <p className="mt-2 text-xs text-ink-faint">
                In dark mode the sidebar matches the page, so this is ignored.
              </p>
            )}
          </Group>

          <Group label="Sidebar">
            <div className="space-y-2">
              {([
                ['expanded', 'Full', 'Icons and labels'],
                ['icons', 'Icons only', 'Narrow rail, labels on hover'],
                ['hidden', 'Hidden', 'Maximum room for content'],
              ] as [RailMode, string, string][]).map(([v, title, hint]) => (
                <button
                  key={v}
                  onClick={() => setRailMode(v)}
                  aria-pressed={railMode === v}
                  className={`w-full rounded-card border px-3 py-2 text-left transition
                    ${railMode === v
                      ? 'border-brand-500 bg-brand-50'
                      : 'border-line hover:border-ink-faint'}`}
                >
                  <span className={`block text-[13px] font-medium ${railMode === v ? 'text-brand-700' : 'text-ink'}`}>
                    {title}
                  </span>
                  <span className="block text-xs text-ink-muted">{hint}</span>
                </button>
              ))}
            </div>
          </Group>
        </div>

        <footer className="shrink-0 border-t border-line p-5">
          <button
            onClick={reset}
            className="w-full rounded-card border border-line px-3 py-2 text-[13px] text-ink-muted transition hover:border-ink-faint hover:text-ink"
          >
            Reset to defaults
          </button>
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Saved in this browser only. Your organisation&apos;s own branding is a
            separate setting.
          </p>
        </footer>
      </div>
    </>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2.5 text-label font-semibold uppercase text-ink-muted">{label}</h3>
      {children}
    </section>
  );
}

function Swatches({
  options, value, onChange, disabled,
}: {
  options: { name: string; hex: string }[];
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex flex-wrap gap-2 ${disabled ? 'pointer-events-none opacity-40' : ''}`}>
      {options.map((o) => (
        <button
          key={o.hex}
          onClick={() => onChange(o.hex)}
          title={o.name}
          aria-label={o.name}
          aria-pressed={value.toLowerCase() === o.hex.toLowerCase()}
          className={`h-8 w-8 rounded-full ring-offset-2 ring-offset-surface transition
            ${value.toLowerCase() === o.hex.toLowerCase() ? 'ring-2 ring-ink' : 'hover:scale-110'}`}
          style={{ backgroundColor: o.hex }}
        />
      ))}
    </div>
  );
}

/**
 * A native colour input rather than a bespoke picker. It is keyboard
 * accessible, works on touch, remembers recent choices, and is one line.
 */
function CustomColour({
  value, onChange, label, disabled,
}: {
  value: string; onChange: (hex: string) => void; label: string; disabled?: boolean;
}) {
  return (
    <label className={`mt-3 flex items-center gap-2 text-xs text-ink-muted ${disabled ? 'pointer-events-none opacity-40' : ''}`}>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent p-0.5"
      />
      Pick any colour
    </label>
  );
}
