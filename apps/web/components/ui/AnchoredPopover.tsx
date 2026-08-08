'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A panel anchored under a trigger element — our replacement for MUI's Popover.
 *
 * Positioned `fixed` from the trigger's measured rect rather than absolutely
 * inside it. The trigger lives in YZEN's sticky header, which carries its own
 * z-index and stacking context, so an absolutely-positioned child risks being
 * clipped or painted under the rail. Fixed coordinates plus a z-index above
 * YZEN's chrome (its header is 100, its sidebar 103) sidesteps both.
 *
 * Closes on an outside click or Escape. mousedown rather than click, and the
 * trigger itself counts as "inside", so pressing the trigger to close does not
 * dismiss then instantly re-open.
 */
export function AnchoredPopover({
  anchor,
  onClose,
  children,
  width = 316,
  align = 'end',
  padded = true,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  /** 'end' right-aligns the panel with the trigger, 'start' left-aligns it. */
  align?: 'start' | 'end';
  /** Off when the content manages its own padding and needs full-bleed rows. */
  padded?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!anchor) { setPos(null); return undefined; }

    const place = () => {
      const r = anchor.getBoundingClientRect();
      const raw = align === 'end' ? r.right - width : r.left;
      // Never let it hang off a narrow viewport.
      const left = Math.max(8, Math.min(raw, window.innerWidth - width - 8));
      setPos({ top: r.bottom + 8, left });
    };

    place();
    window.addEventListener('resize', place);
    // Capture phase: the panel must follow a trigger inside any scrolling pane.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, width, align]);

  useEffect(() => {
    if (!anchor) return undefined;

    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  if (!anchor || !pos) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width, zIndex: 1200 }}
      className={`rounded-2xl border border-line bg-surface shadow-raised ${padded ? 'p-3' : 'overflow-hidden'}`}
    >
      {children}
    </div>
  );
}
