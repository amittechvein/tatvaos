'use client';

// ============================================================================
//  The app launcher — Google's nine-dot grid, for TatvaOS products
// ============================================================================
//
//  Product switching lives HERE, in the top-right, and nowhere else. It was a
//  coloured rail down the left for one iteration and got removed on sight:
//  two vertical bars read as chrome. A launcher behind one button costs one
//  extra click and gives the whole left edge back to the console's own
//  navigation — and it is where a decade of Google Workspace has taught
//  everyone to look for "the other apps".
//
//  Products that do not exist yet appear greyed with a "Soon" tag rather than
//  being hidden. A customer looking at this grid should see a suite with
//  products arriving, not a mail app wearing a launcher.
// ============================================================================

import Link from 'next/link';
import { useState } from 'react';
import { RAIL_PRODUCTS } from '@/lib/nav';
import { AnchoredPopover } from '@/components/ui/AnchoredPopover';
import { HEADER_LINK } from './Topbar';

/** A product's colour at partial opacity, for the tile gradient and its glow. */
function fade(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function AppLauncher() {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  // The consoles sit under a divider at the bottom, apart from the products —
  // "administer the platform" is a different kind of destination from "read
  // your mail", and mixing them makes the grid harder to scan.
  const products = RAIL_PRODUCTS.filter((p) => p.code !== 'platform' && p.code !== 'core');
  const consoles = RAIL_PRODUCTS.filter((p) => p.code === 'platform' || p.code === 'core');

  return (
    <>
      <button
        type="button"
        className={HEADER_LINK}
        aria-label="TatvaOS apps"
        title="TatvaOS apps"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {/* The nine dots. */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          {[5, 12, 19].flatMap((y) =>
            [5, 12, 19].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.9" />))}
        </svg>
      </button>

      <AnchoredPopover anchor={anchor} onClose={() => setAnchor(null)} width={316}>
        <div className="grid grid-cols-3 gap-1">
          {products.map((p) => <Tile key={p.code} p={p} onNavigate={() => setAnchor(null)} />)}
        </div>

        <div className="my-3 h-px bg-line" />

        <div className="grid grid-cols-3 gap-1">
          {consoles.map((p) => <Tile key={p.code} p={p} onNavigate={() => setAnchor(null)} />)}

          {/* Your account sits with the consoles, not the products: it is a
              place you go to manage yourself rather than a thing you use.
              It lives here because Mail's own Settings now means MAIL
              settings, so the personal hub needed a home the launcher could
              give it — the same place Google puts it. */}
          <Tile
            p={{
              code: 'account',
              label: 'Account',
              href: '/account',
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5 20c1.3-3.4 3.8-5 7-5s5.7 1.6 7 5" />
                </svg>
              ),
              live: true,
              colour: '#00cfe8',
              match: ['/account'],
            }}
            onNavigate={() => setAnchor(null)}
          />
        </div>
      </AnchoredPopover>
    </>
  );
}

function Tile({ p, onNavigate }: {
  p: (typeof RAIL_PRODUCTS)[number];
  onNavigate: () => void;
}) {
  const body = (
    <>
      <span
        className="grid h-11 w-11 place-items-center rounded-xl text-white"
        style={{
          background: `linear-gradient(135deg, ${p.colour}, ${fade(p.colour, 0.75)})`,
          boxShadow: `0 3px 8px -2px ${fade(p.colour, 0.55)}`,
        }}
      >
        {p.icon}
      </span>
      <span className="text-center text-xs font-medium leading-tight text-ink">{p.label}</span>
      {!p.live && <span className="-mt-1 text-[10px] text-ink-faint">Soon</span>}
    </>
  );

  const shared = 'flex flex-col items-center gap-1.5 rounded-xl px-1 py-3 no-underline';

  // A product with nowhere to go is not a link: it is greyed, not clickable,
  // and says why on hover rather than leading anyone to a page that is not there.
  if (!p.live) {
    return (
      <div className={`${shared} cursor-default opacity-45`} title={`${p.label} — coming soon`}>
        {body}
      </div>
    );
  }

  return (
    <Link href={p.href} onClick={onNavigate} className={`${shared} transition hover:bg-canvas`}>
      {body}
    </Link>
  );
}
