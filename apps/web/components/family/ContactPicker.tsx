'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import Typography from '@mui/material/Typography';

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
      <Popper
        open={open && items.length > 0}
        anchorEl={anchor.current}
        placement="bottom-start"
        style={{ zIndex: 1400 }}
      >
        <Paper elevation={6} sx={{ minWidth: 320, maxWidth: 460, py: 0.5 }}>
          {items.map((s, i) => (
            <Box
              key={`${s.id}-${s.email}`}
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              onMouseEnter={() => setActive(i)}
              sx={{
                px: 1.5, py: 0.75, cursor: 'pointer',
                bgcolor: i === active ? 'action.hover' : 'transparent',
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {s.displayName}
                {s.isColleague && (
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    colleague
                  </Typography>
                )}
              </Typography>
              <Typography variant="caption" color="text.secondary">{s.email}</Typography>
            </Box>
          ))}
        </Paper>
      </Popper>
    </>
  );
}
