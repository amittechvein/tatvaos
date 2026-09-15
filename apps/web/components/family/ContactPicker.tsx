'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { familyApi } from '@/lib/family';

/**
 * Recipient autocomplete, backed by Family.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  DELIBERATELY NOT A REPLACEMENT FOR THE RECIPIENT FIELD.
 *
 *  It wraps the composer's own input. It reads what is being typed after the
 *  last comma, offers matches, and on selection hands back the full
 *  replacement string. The composer keeps owning its value, its parsing and
 *  its validation — so mail still sends when Family is unavailable, which is
 *  the only acceptable failure mode for a compose box.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  CONVERTED OFF MUI. Popper did the positioning; this measures the anchor and
 *  places a fixed-position list itself. Two reasons it is fixed rather than
 *  absolute: the composer is a docked, transformed container, so an absolutely
 *  positioned child would be clipped by its overflow — and wrapping the input
 *  in a relative container would change the composer's own flex layout, which
 *  this component exists to avoid touching.
 */

interface Suggestion {
  id: string;
  email: string;
  displayName: string;
  /** A colleague from core.users rather than a saved contact. */
  isColleague: boolean;
}

/** The fragment being typed: everything after the last comma or semicolon. */
function currentFragment(value: string): string {
  const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'));
  return value.slice(cut + 1).trim();
}

/** Replace that fragment, leaving earlier recipients untouched. */
function replaceFragment(value: string, email: string): string {
  const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'));
  const head = cut >= 0 ? `${value.slice(0, cut + 1)} ` : '';
  return `${head}${email}, `;
}

export function ContactPicker({ value, onPick, children }: {
  value: string;
  onPick: (next: string) => void;
  children: (
    ref: React.RefObject<HTMLInputElement | null>,
    onKeyDown: (e: React.KeyboardEvent) => void,
  ) => React.ReactNode;
}) {
  const { authedFetch } = useAuth();
  const anchor = useRef<HTMLInputElement | null>(null);

  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const fragment = currentFragment(value);

  // A slow first request must not land after a fast second one and offer
  // suggestions for text that has already been replaced.
  const token = useRef(0);

  useEffect(() => {
    if (fragment.length < 2) { setItems([]); setOpen(false); return; }

    const mine = ++token.current;
    const t = setTimeout(() => {
      familyApi.autocomplete(authedFetch, fragment, 8)
        .then((found) => {
          if (mine !== token.current) return;
          setItems(found);
          setActive(0);
          setOpen(found.length > 0);
        })
        // Silently offer nothing. An error toast over a compose box is worse
        // than no suggestions.
        .catch(() => { if (mine === token.current) { setItems([]); setOpen(false); } });
    }, 180);

    return () => clearTimeout(t);
  }, [authedFetch, fragment]);

  // Measure the input and follow it. Scroll is captured (third argument true)
  // so the list tracks the composer's own scrolling container, not just the
  // window — otherwise it detaches and floats over unrelated content.
  useEffect(() => {
    if (!open || items.length === 0) { setBox(null); return; }
    const el = anchor.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ top: r.bottom + 4, left: r.left, width: r.width });
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, items.length]);

  const choose = useCallback((s: Suggestion) => {
    onPick(replaceFragment(value, s.email));
    setOpen(false);
    setItems([]);
    anchor.current?.focus();
  }, [onPick, value]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open || items.length === 0) return;
    const chosen = items[active];
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    // Enter and Tab both commit, because both are what people press here.
    else if ((e.key === 'Enter' || e.key === 'Tab') && chosen) { e.preventDefault(); choose(chosen); }
    else if (e.key === 'Escape') { setOpen(false); }
  }, [open, items, active, choose]);

  return (
    <>
      {children(anchor, onKeyDown)}
      {open && items.length > 0 && box && (
        // list-unstyled is not decoration: Tailwind's preflight is off, so a
        // bare <ul> keeps the browser's bullets and 40px indent.
        //
        // z-index 1400 clears the composer, which sits at 1200. Tailwind's
        // scale stops at 50 and would put this behind the shell chrome.
        <ul
          className="!list-none !pl-0 bg-white rounded shadow m-0 py-1 border"
          style={{
            position: 'fixed',
            top: box.top,
            left: box.left,
            minWidth: Math.max(320, box.width),
            maxWidth: 460,
            maxHeight: 280,
            overflowY: 'auto',
            zIndex: 1400,
          }}
          role="listbox"
        >
          {items.map((s, i) => (
            <li
              key={`${s.id}-${s.email}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: the input would blur first and the
              // composer would close the list before the click landed.
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              onMouseEnter={() => setActive(i)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                background: i === active ? 'rgba(0,0,0,0.05)' : 'transparent',
              }}
            >
              <div className="!text-[0.875rem] !font-semibold">
                {s.displayName}
                {s.isColleague && (
                  <span className="!text-[0.75rem] !font-normal !text-ink-muted ms-2">colleague</span>
                )}
              </div>
              <div className="!text-[0.75rem] !text-ink-muted">{s.email}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
